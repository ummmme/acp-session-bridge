import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BookmarkError, ScopeStore } from "../src/bookmarks/store.ts";
import { resolveConversationScope } from "../src/bookmarks/scope.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/fake_scoped_session_agent.ts", import.meta.url),
);

type ToolEnvelope = {
  result?: {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
};

function agentDefinition(
  stateFile: string,
  promptFile: string,
  allowedModels = ["flash", "pro"],
) {
  return {
    command: process.execPath,
    args: [fixture],
    env: {
      ACP_SCOPED_FIXTURE_STATE: stateFile,
      ACP_SCOPED_FIXTURE_PROMPTS: promptFile,
    },
    modelConfigId: "model",
    models: {
      allowedModels,
      thinkingEffort: {
        configOption: "thought_level",
        values: { low: "low", high: "high" },
      },
    },
  };
}

function harness(
  agents: Record<string, ReturnType<typeof agentDefinition>>,
  store: ScopeStore,
) {
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager, { bookmarkStore: store });
  return { manager, server };
}

function tool(
  mcp: Awaited<ReturnType<typeof connectMcp>>,
  name: string,
  args: Record<string, unknown>,
) {
  return mcp.callTool(name, args).response;
}

function failed(response: unknown) {
  const envelope = response as ToolEnvelope;
  assert.equal(envelope.result?.isError, true, JSON.stringify(response));
  return (
    envelope.result?.content?.map((part) => part.text ?? "").join("\n") ?? ""
  );
}

async function promptLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function localSession() {
  const temp = await mkdtemp(join(tmpdir(), "acp-scoped-local-"));
  const audit = join(temp, "audit"),
    prompts = join(temp, "prompts");
  const definition = agentDefinition(join(temp, "state"), prompts);
  const store = new ScopeStore(join(temp, "scopes"));
  const fake = {
    ...definition,
    env: { ...definition.env, ACP_SCOPED_FIXTURE_AUDIT: audit },
  };
  const { server, manager } = harness({ fake }, store);
  const mcp = await connectMcp(server);
  const scope = { cwd: temp, clientConversationId: "local-recovery-test" };
  const { scopeKey } = await resolveConversationScope(scope);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseToolResult(await tool(mcp, name, { ...scope, ...args }));
  const start = () => call("start_session", { agentId: "fake", model: "pro" });
  const close = async () => {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await rm(temp, { recursive: true, force: true });
  };
  return { store, call, start, close, manager, audit, prompts, scopeKey };
}

test(
  "load waits for an exiting local owner and resumes its downstream session once",
  { timeout: 15000 },
  async () => {
    const s = await localSession();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      const a = await s.start();
      const [spawn] = await promptLines(s.audit);
      assert.match(spawn, /^spawn [1-9]\d*$/);
      const update = s.store.update.bind(s.store);
      let first = true;
      s.store.update = async (key, mutate) => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return update(key, mutate);
      };
      process.kill(Number(spawn.split(" ")[1]), "SIGKILL");
      await entered.promise;
      assert.ok(s.manager.getSessionSnapshot(String(a.sessionId)).processExit);
      const lookup = Promise.withResolvers<void>();
      const read = s.store.read.bind(s.store);
      s.store.read = async (key) => {
        const b = await read(key);
        lookup.resolve();
        return b;
      };
      const loading = s.call("load_session", { agentId: "fake" });
      await lookup.promise;
      const [list, status] = await Promise.all([
        s.call("list_sessions"),
        s.call("get_session", { includePromptText: false }),
      ]);
      assert.deepEqual(await promptLines(s.audit), [spawn]);
      release.resolve();
      const restored = await loading;
      assert.notEqual(restored.sessionId, a.sessionId);
      assert.equal(restored.acpSessionId, a.acpSessionId);
      assert.equal((list[0] as { status: string }).status, "retiring");
      assert.equal(status.status, "retiring");
      assert.equal(
        (await promptLines(s.audit)).filter((line) => line.startsWith("load "))
          .length,
        1,
      );
      assert.deepEqual(await promptLines(s.prompts), []);
    } finally {
      release.resolve();
      await s.close();
    }
  },
);

test("read and reuse show the matching in-memory terminal state after a failed save without writing or prompting", async () => {
  const s = await localSession();
  try {
    const a = await s.start();
    const update = s.store.update.bind(s.store);
    s.store.update = (key, mutate) =>
      update(key, async (b) => {
        const next = await mutate(b);
        if (next.sessions.A?.lastPrompt?.state === "completed")
          throw new BookmarkError("bookmark_io");
        return next;
      });
    const p = await s.call("prompt", {
      sessionId: a.sessionId,
      text: "one question",
    });
    const warning = { saved: false, errorCode: "bookmark_io" };
    assert.deepEqual(p.bookmarkPersistence, warning);
    const before = await s.store.read(s.scopeKey);
    assert.equal(before?.sessions.A.lastPrompt?.state, "running");
    const list = await s.call("list_sessions"),
      status = await s.call("get_session", { includePromptText: false }),
      reused = await s.call("load_session", { agentId: "fake" });
    for (const view of [list[0] as Record<string, unknown>, status, reused]) {
      assert.deepEqual(view.lastPrompt, {
        promptId: p.promptId,
        state: "completed",
      });
      assert.deepEqual(view.bookmarkPersistence, warning);
    }
    assert.equal(reused.sessionId, a.sessionId);
    assert.deepEqual(await s.store.read(s.scopeKey), before);
    assert.deepEqual(await promptLines(s.prompts), [
      `${a.acpSessionId}\tone question`,
    ]);
  } finally {
    await s.close();
  }
});

test("scoped sessions persist A/B identity, config and turn context across manager restart", async () => {
  const temp = await mkdtemp(join(tmpdir(), "acp-scoped-flow-"));
  const projectRoot = join(temp, "project");
  await mkdir(projectRoot);
  const stateFile = join(temp, "fake-agent-state.json");
  const promptFile = join(temp, "fake-agent-prompts.log");
  const store = new ScopeStore(join(temp, "scopes"));
  const clientConversationId = "claude-conversation-test-42";
  const cwd = projectRoot;
  const agentId = "fake";
  const agents = { fake: agentDefinition(stateFile, promptFile) };
  const first = harness(agents, store);
  const firstMcp = await connectMcp(first.server);
  let second: ReturnType<typeof harness> | undefined;
  let secondMcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    const a = parseToolResult(
      await tool(firstMcp, "start_session", {
        agentId,
        cwd,
        clientConversationId,
        projectRoot,
        sessionName: "Design A",
        thoughtConfigId: "thought_level",
        model: "pro",
        config: { thought_level: "high" },
        prompt: "A first design question",
      }),
    ) as {
      sessionId: string;
      acpSessionId: string;
      result: { text: string; state: string };
    };
    assert.ok(a.sessionId);
    assert.ok(a.acpSessionId);
    assert.match(a.result.text, new RegExp(`context=${a.acpSessionId}`));
    assert.match(a.result.text, /model=pro; thought=high/);
    assert.match(a.result.text, /A first design question/);

    const b = parseToolResult(
      await tool(firstMcp, "start_session", {
        agentId,
        cwd,
        clientConversationId,
        projectRoot,
        sessionName: "Design B",
        thoughtConfigId: "thought_level",
        model: "flash",
        config: { thought_level: "low" },
      }),
    ) as { sessionId: string; acpSessionId: string };
    assert.ok(b.sessionId);
    assert.ok(b.acpSessionId);
    assert.notEqual(b.acpSessionId, a.acpSessionId);
    assert.deepEqual(await promptLines(promptFile), [
      `${a.acpSessionId}\tA first design question`,
    ]);

    const selectedA = parseToolResult(
      await tool(firstMcp, "load_session", {
        clientConversationId,
        projectRoot,
        agentId,
        cwd,
        target: "A",
      }),
    ) as { sessionId: string; acpSessionId: string };
    assert.equal(selectedA.sessionId, a.sessionId);
    assert.equal(selectedA.acpSessionId, a.acpSessionId);

    const closeB = parseToolResult(
      await tool(firstMcp, "close_session", {
        sessionId: b.sessionId,
        ifIdle: true,
      }),
    ) as { closed: boolean };
    assert.equal(closeB.closed, true);

    const scope = await resolveConversationScope({
      clientConversationId,
      cwd,
      projectRoot,
    });
    const afterCloseB = await store.read(scope.scopeKey);
    assert.equal(afterCloseB?.currentLabel, "A");
    assert.equal(afterCloseB?.sessions.B?.status, "closed");

    second = harness(agents, store);
    secondMcp = await connectMcp(second.server);
    const occupied = await tool(secondMcp, "load_session", {
      clientConversationId,
      projectRoot,
      agentId,
      cwd,
    });
    assert.match(failed(occupied), /occupied|live|resuming/i);
    assert.equal(second.manager.sessionCount, 0);

    await firstMcp.close();
    await first.manager.closeAll();
    await first.server.close();
    const offline = await store.read(scope.scopeKey);
    assert.equal(offline?.currentLabel, "A");
    assert.equal(offline?.sessions.A?.status, "offline");

    await secondMcp.close();
    await second.manager.closeAll();
    await second.server.close();
    second = harness(
      { fake: agentDefinition(stateFile, promptFile, ["flash"]) },
      store,
    );
    secondMcp = await connectMcp(second.server);
    const denied = await tool(secondMcp, "load_session", {
      clientConversationId,
      projectRoot,
      agentId,
      cwd,
    });
    assert.match(failed(denied), /denied|policy/i);
    assert.equal(second.manager.sessionCount, 0);
    const rolledBack = await store.read(scope.scopeKey);
    assert.equal(rolledBack?.currentLabel, "A");
    assert.equal(rolledBack?.sessions.A?.status, "offline");

    await secondMcp.close();
    await second.manager.closeAll();
    await second.server.close();
    second = harness(agents, store);
    secondMcp = await connectMcp(second.server);
    const beforeResumePrompt = await promptLines(promptFile);
    const restored = parseToolResult(
      await tool(secondMcp, "load_session", {
        clientConversationId,
        projectRoot,
        agentId,
        cwd,
      }),
    ) as {
      sessionId: string;
      acpSessionId: string;
      configOptions: Array<{ id: string; currentValue?: unknown }>;
    };
    assert.notEqual(restored.sessionId, a.sessionId);
    assert.equal(restored.acpSessionId, a.acpSessionId);
    assert.equal(
      restored.configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "pro",
    );
    assert.equal(
      restored.configOptions.find((option) => option.id === "thought_level")
        ?.currentValue,
      "high",
    );
    assert.deepEqual(await promptLines(promptFile), beforeResumePrompt);

    const followup = parseToolResult(
      await tool(secondMcp, "prompt", {
        sessionId: restored.sessionId,
        text: "A resumed follow-up",
        wait: true,
      }),
    ) as { text: string; state: string };
    assert.match(followup.text, new RegExp(`context=${a.acpSessionId}`));
    assert.match(followup.text, /model=pro; thought=high/);
    assert.match(followup.text, /A resumed follow-up/);
    assert.deepEqual(await promptLines(promptFile), [
      `${a.acpSessionId}\tA first design question`,
      `${a.acpSessionId}\tA resumed follow-up`,
    ]);

    const turnDeadline = Date.now() + 2_000;
    let settled = await store.read(scope.scopeKey);
    while (
      settled?.sessions.A?.lastPrompt?.state !== "completed" &&
      Date.now() < turnDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled = await store.read(scope.scopeKey);
    }
    assert.equal(settled?.currentLabel, "A");
    assert.equal(settled?.sessions.A?.status, "live");
    assert.equal(settled?.sessions.A?.lastPrompt?.state, "completed");
  } finally {
    await firstMcp.close().catch(() => undefined);
    await first.manager.closeAll();
    await first.server.close();
    if (secondMcp) await secondMcp.close().catch(() => undefined);
    if (second) {
      await second.manager.closeAll();
      await second.server.close();
    }
    await rm(temp, { recursive: true, force: true });
  }
});
