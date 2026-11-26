import { test } from "node:test";
import process from "node:process";
import * as nodeFs from "#fs";
import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import {
  DEFAULT_MAX_MANAGED_SESSIONS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  SessionManager,
} from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function fakeFixturePath() {
  const path = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
    .pathname;
  return process.platform === "win32"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

async function waitForRetirement(manager: SessionManager, sessionId: string) {
  const deadline = Date.now() + 5000;
  while (manager.hasSession(sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (manager.hasSession(sessionId)) {
    throw new Error(`Session did not exit: ${sessionId}`);
  }
}

test("requested cwd is shared by the ACP session and child process", async () => {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-requested-cwd-" });
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fakeFixturePath(), "--report-cwd"],
    },
  });
  try {
    const session = await manager.start("fake", cwd);
    const report = JSON.parse(
      String(
        session.configOptions.find((option) => option.id === "cwd-report")
          ?.currentValue,
      ),
    ) as { processCwd: string; sessionCwd: string };
    const requestedRealPath = await nodeFs.realpath(cwd);
    if (
      (await nodeFs.realpath(report.processCwd)) !== requestedRealPath ||
      (await nodeFs.realpath(report.sessionCwd)) !== requestedRealPath
    ) {
      throw new Error(`Requested cwd diverged: ${JSON.stringify(report)}`);
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(cwd, { recursive: true });
  }
});

test("session query APIs return detached snapshots", async () => {
  const manager = rawFixtureManager();
  try {
    const session = await manager.start("raw", process.cwd());
    const snapshot = manager.getSessionSnapshot(session.id);
    const listed = manager.listSessionSnapshots();
    (snapshot.configOptions as Array<Record<string, unknown>>).push({
      id: "caller-mutation",
    });
    (listed[0].capabilities as Record<string, unknown>).callerMutation = true;
    if (
      manager
        .getSessionSnapshot(session.id)
        .configOptions.some((option) => option.id === "caller-mutation") ||
      "callerMutation" in
        (manager.getSessionSnapshot(session.id).capabilities as object)
    ) {
      throw new Error("A caller mutation changed manager-owned session state");
    }
    if (manager.sessionCount !== 1 || !manager.hasSession(session.id)) {
      throw new Error("Read-only session queries changed manager capacity");
    }
  } finally {
    await manager.closeAll();
  }
});

function rawFixtureManager() {
  return new SessionManager({
    raw: {
      command: process.execPath,
      args: ["tests/fixtures/raw_wire_acp_agent.ts"],
    },
  });
}

test("journals unknown raw updates in order and keeps the connection usable", async () => {
  const manager = rawFixtureManager();
  const server = createMcpServer({}, manager);
  const mcp = await connectMcp(server);
  try {
    const session = await manager.start("raw", process.cwd());
    const response = await manager.prompt(session.id, "raw wire");
    if (response.text !== "raw reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    const events = manager.getEvents(session.id).events;
    if (events.length !== 3) {
      throw new Error(`Expected three routed updates, got ${events.length}`);
    }
    if (
      events.map((event) => event.kind).join(",") !==
      "agent_message_chunk,future_update,agent_message_chunk"
    ) {
      throw new Error("Raw updates were not journaled in arrival order");
    }
    if (
      (events[1].update as { detail?: { retained?: boolean } }).detail
        ?.retained !== true
    ) {
      throw new Error("Unknown update details were not retained");
    }
    const raw = events[1].raw;
    if (
      JSON.stringify(raw) !==
      JSON.stringify({
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: "future_update",
          detail: { retained: true },
        },
        _meta: { fixture: "raw-wire", ordinal: 2 },
        ordinal: 2,
      })
    ) {
      throw new Error(
        "Original raw params, unknown detail, or metadata changed",
      );
    }
    const replay = parseToolResult(
      await mcp.callTool("get_events", {
        sessionId: session.id,
        includeRaw: true,
      }).response,
    );
    deepStrictEqual(
      replay.events,
      events,
      "MCP changed journal contents, update order, or raw metadata",
    );
    (events[1].update as { detail: { retained: boolean } }).detail.retained =
      false;
    const reread = manager.getEvents(session.id).events[1].update as {
      detail: { retained: boolean };
    };
    if (!reread.detail.retained) {
      throw new Error("Mutating an event query changed the manager journal");
    }
    const followup = await manager.prompt(session.id, "followup");
    if (followup.text !== "raw reply" || followup.stopReason !== "end_turn") {
      throw new Error(
        "Unknown update disrupted the next prompt in the same session",
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

test("routes raw updates to each managed session", async () => {
  const manager = rawFixtureManager();
  try {
    const [first, second] = await Promise.all([
      manager.start("raw", process.cwd()),
      manager.start("raw", process.cwd()),
    ]);
    await Promise.all([
      manager.prompt(first.id, "first"),
      manager.prompt(second.id, "second"),
    ]);
    for (const session of [first, second]) {
      const events = manager.getEvents(session.id).events;
      if (
        events.length !== 3 ||
        events.some(
          (event) =>
            (event.raw as { sessionId: string }).sessionId !==
            session.acpSessionId,
        )
      ) {
        throw new Error(
          `Updates were misrouted for session ${session.acpSessionId}`,
        );
      }
    }
  } finally {
    await manager.closeAll();
  }
});

test("starts a fake ACP agent and returns streamed prompt text", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: ["tests/fixtures/fake_acp_agent.ts"],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const response = await manager.prompt(session.id, "hello");
    if (response.text !== "fake reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    if (response.stopReason !== "end_turn") {
      throw new Error(`Unexpected stop reason: ${response.stopReason}`);
    }
    const journal = manager.getEvents(session.id);
    if (
      journal.events.length !== 1 ||
      journal.events[0].kind !== "agent_message_chunk"
    )
      throw new Error("Expected one normalized text event");
    if (!journal.events[0].raw) {
      throw new Error("Expected original ACP notification to be retained");
    }
  } finally {
    await manager.closeAll();
  }
});

test("polls and cancels an asynchronous prompt", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: ["tests/fixtures/fake_acp_agent.ts"],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    const pending = await manager.waitPrompt(session.id, prompt.id, 0);
    if (pending.state !== "running") {
      throw new Error(`Expected running prompt, got ${pending.state}`);
    }
    const cancelled = await manager.cancelPrompt(session.id, prompt.id);
    if (cancelled.state !== "cancelled") {
      throw new Error(`Expected cancelled prompt, got ${cancelled.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("cancellation remains authoritative if the prompt then errors", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fakeFixturePath()],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "cancel then fail");
    const cancelled = await manager.cancelPrompt(session.id, prompt.id);
    await prompt.done;
    if (cancelled.state !== "cancelled" || prompt.state !== "cancelled") {
      throw new Error(`Prompt failure overwrote cancellation: ${prompt.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("late ACP output after cancellation is journaled but cannot complete the prompt", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fakeFixturePath()],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "cancel then late update");
    await manager.cancelPrompt(session.id, prompt.id);
    await prompt.done;
    const journal = manager.getEvents(session.id);
    if (
      prompt.state !== "cancelled" ||
      prompt.text ||
      !journal.events.some((event) => event.kind === "agent_message_chunk")
    ) {
      throw new Error(
        `Late output changed cancelled state: ${JSON.stringify({
          state: prompt.state,
          text: prompt.text,
          events: journal.events.map((event) => event.kind),
        })}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

test("closing an active session cancels its prompt before cleanup", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fakeFixturePath()],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    await manager.close(session.id);
    await prompt.done;
    if (prompt.state !== "cancelled" || manager.sessionCount !== 0) {
      throw new Error(
        `Active close did not cancel/remove the session: ${prompt.state}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

test("cancelling after completed prompt preserves completion", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fakeFixturePath()],
    },
  });
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "hello");
    await prompt.done;
    const result = await manager.cancelPrompt(session.id, prompt.id);
    if (result.state !== "completed" || result.stopReason !== "end_turn") {
      throw new Error(`Late cancellation rewrote completion: ${result.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("closed sessions release capacity while active sessions are retained", async () => {
  if (DEFAULT_MAX_MANAGED_SESSIONS !== 20) {
    throw new Error(
      `Production session capacity changed: ${DEFAULT_MAX_MANAGED_SESSIONS}`,
    );
  }
  const manager = new SessionManager(
    {
      fake: {
        command: process.execPath,
        args: ["tests/fixtures/raw_wire_acp_agent.ts"],
      },
    },
    undefined,
    undefined,
    2,
  );
  const sessionCount = () => manager.sessionCount;
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => manager.start("fake", process.cwd())),
    );
    const opened = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const rejectedStart = results.find((r) => r.status === "rejected");
    if (
      opened.length !== 2 ||
      !String(rejectedStart?.reason).includes(
        "Active session limit (2) reached",
      )
    ) {
      throw new Error(
        "Concurrent starts did not enforce the two-slot test limit",
      );
    }
    const [first, second] = opened;
    if (sessionCount() !== 2) {
      throw new Error("The test session capacity was not filled");
    }

    let rejected = false;
    try {
      await manager.start("missing-agent", process.cwd());
    } catch (error) {
      rejected = String(error).includes("Active session limit (2) reached");
    }
    if (!rejected || sessionCount() !== 2) {
      throw new Error("Capacity was not rejected before agent lookup/startup");
    }

    await manager.close(first.id);
    if (sessionCount() !== 1) {
      throw new Error("Closing a session did not release capacity");
    }
    const replacement = await manager.start("fake", process.cwd());
    if (sessionCount() !== 2) {
      throw new Error("A closed session continued to consume capacity");
    }
    await manager.close(replacement.id);
    await manager.close(second.id);
    if (sessionCount() !== 0) {
      throw new Error("Capacity test did not clean up all sessions");
    }
  } finally {
    await manager.closeAll();
  }
});

test("a hung ACP session/close cannot block child cleanup", async () => {
  const manager = new SessionManager(
    {
      fake: {
        command: process.execPath,
        args: [fakeFixturePath(), "--session-close-hang"],
      },
    },
    DEFAULT_SESSION_START_TIMEOUT_MS,
    40,
  );
  try {
    const session = await manager.start("fake", process.cwd());
    const startedAt = performance.now();
    await manager.close(session.id);
    if (performance.now() - startedAt > 1_000 || manager.sessionCount !== 0) {
      throw new Error("Hung session/close blocked cleanup or retained state");
    }
  } finally {
    await manager.closeAll();
  }
});

test("holds operator permission until an advertised choice is resolved", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: ["tests/fixtures/fake_acp_agent.ts"],
    },
  });
  try {
    const session = await manager.start(
      "fake",
      process.cwd(),
      {},
      undefined,
      "operator",
    );
    const prompt = manager.beginPrompt(session.id, "permission");
    for (
      let i = 0;
      i < 100 &&
      manager.getSessionSnapshot(session.id).pendingPermissions.length === 0;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = manager.getSessionSnapshot(session.id)
      .pendingPermissions[0];
    if (!pending) throw new Error("Permission request was not exposed");
    manager.resolvePermission(session.id, pending.id, "reject");
    await prompt.done;
    if (prompt.text !== "reject") {
      throw new Error(`Unexpected permission response text: ${prompt.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("loads a session when the fake agent advertises support", async () => {
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: ["tests/fixtures/fake_acp_agent.ts"],
    },
  });
  try {
    const session = await manager.load(
      "fake",
      "existing-session",
      process.cwd(),
    );
    if (session.acpSessionId !== "existing-session") {
      throw new Error("Loaded session ID was not retained");
    }
    const result = await manager.prompt(session.id, "hello");
    if (result.text !== "fake reply") {
      throw new Error(`Unexpected loaded session response: ${result.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("advertises and uses ACP boolean configuration options", async () => {
  const manager = new SessionManager({
    bool: {
      command: process.execPath,
      args: ["tests/fixtures/fake_acp_agent.ts", "--advertise-bool"],
    },
  });
  try {
    const session = await manager.start("bool", process.cwd(), {
      "use-fast-mode": "true",
    });
    const fastMode = session.configOptions.find(
      (option) => option.id === "use-fast-mode",
    );
    if (fastMode?.currentValue !== true) {
      throw new Error("String config value was not sent as an ACP boolean");
    }
    const updated = await manager.setConfigOption(
      session.id,
      "use-fast-mode",
      "false",
    );
    if (
      updated.find((option) => option.id === "use-fast-mode")?.currentValue !==
      false
    ) {
      throw new Error("Interactive boolean config update did not reach ACP");
    }
  } finally {
    await manager.closeAll();
  }
});

test("agent process exit leaves safe diagnostics and rejects old handles", async () => {
  const manager = new SessionManager({
    fake: { command: process.execPath, args: [fakeFixturePath()] },
  });
  try {
    const session = await manager.load(
      "fake",
      "recoverable-acp-session",
      process.cwd(),
    );
    const prompt = manager.beginPrompt(session.id, "process crash");
    await prompt.done;
    await waitForRetirement(manager, session.id);

    const snapshot = manager.getSessionSnapshot(session.id);
    deepStrictEqual(snapshot.prompt?.state, "failed");
    deepStrictEqual(snapshot.prompt?.stopReason, "process_exited");
    deepStrictEqual(snapshot.processExit, { code: 17, signal: null });
    const events = manager.getEvents(session.id).events;
    const exited = events.find((event) => event.kind === "process_exited");
    ok(exited);
    deepStrictEqual(exited.update, { code: 17, signal: null });
    deepStrictEqual(exited.raw, { code: 17, signal: null });
    ok(!JSON.stringify(events).includes("PRIVATE_FAILURE_SENTINEL"));

    for (const [id, message] of [
      [session.id, `Session process has exited: ${session.id}`],
      ["missing-session", "Unknown session: missing-session"],
    ]) {
      throws(() => manager.beginPrompt(id, "stale write"), { message });
      await rejects(manager.setMode(id, "plan"), { message });
      await rejects(manager.setConfigOption(id, "model", "test"), { message });
      throws(() => manager.resolvePermission(id, "request", "reject"), {
        message,
      });
    }
    const resumed = await manager.load(
      "fake",
      session.acpSessionId,
      process.cwd(),
    );
    await manager.close(resumed.id);
  } finally {
    await manager.closeAll();
  }
});

for (const [task, expectedState, expectedReason] of [
  ["process crash", "failed", "process_exited"],
  ["large response then exit", "completed", "end_turn"],
]) {
  test(`B completes its original turn while A exits: ${task}`, async () => {
    const manager = new SessionManager({
      fake: { command: process.execPath, args: [fakeFixturePath()] },
    });
    try {
      const a = await manager.start("fake", process.cwd());
      const b = await manager.start(
        "fake",
        process.cwd(),
        {},
        undefined,
        "operator",
      );
      // Keep B's real ACP request in flight until A's exit has been observed.
      const bTurn = manager.beginPrompt(b.id, "permission");
      await manager.waitPrompt(b.id, bTurn.id, 5000, true);
      const [approval] = manager.getSessionSnapshot(b.id).pendingPermissions;
      ok(approval);

      const aTurn = manager.beginPrompt(a.id, task);
      await waitForRetirement(manager, a.id);
      const aResult = manager.getSessionSnapshot(a.id);
      deepStrictEqual(aResult.processExit?.code, 17);
      deepStrictEqual(
        [aResult.prompt?.id, aResult.prompt?.state, aResult.prompt?.stopReason],
        [aTurn.id, expectedState, expectedReason],
      );
      const bLive = manager.getSessionSnapshot(b.id);
      deepStrictEqual(
        [bLive.prompt?.id, bLive.prompt?.state],
        [bTurn.id, "running"],
      );
      deepStrictEqual(bLive.pendingPermissions, [approval]);
      manager.resolvePermission(b.id, approval.id, "reject");
      const bResult = await manager.waitPrompt(b.id, bTurn.id, 5000);
      deepStrictEqual(
        [bResult.id, bResult.state, bResult.stopReason, bResult.text],
        [bTurn.id, "completed", "end_turn", "reject"],
      );
    } finally {
      await manager.closeAll();
    }
  });
}

test("tombstones bound aggregate bytes and mark a capped prompt answer", async () => {
  const manager = new SessionManager(
    { fake: { command: process.execPath, args: [fakeFixturePath()] } },
    undefined,
    undefined,
    2,
    10,
    100 * 1024,
  );
  const retainedIds: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const session = await manager.start("fake", process.cwd());
      retainedIds.push(session.id);
      const prompt = manager.beginPrompt(
        session.id,
        "large response then exit",
      );
      await prompt.done;
      await waitForRetirement(manager, session.id);
      const snapshot = manager.getSessionSnapshot(session.id);
      deepStrictEqual(snapshot.prompt?.state, "completed");
      deepStrictEqual(snapshot.prompt?.stopReason, "end_turn");
      deepStrictEqual(snapshot.processExit, { code: 17, signal: null });
      ok(snapshot.prompt?.textTruncated);
      ok((snapshot.prompt?.text.length ?? Infinity) <= 64 * 1024);
      deepStrictEqual(snapshot.prompt?.errorData, undefined);
    }
    let evicted = false;
    try {
      manager.getSessionSnapshot(retainedIds[0]);
    } catch {
      evicted = true;
    }
    ok(evicted, "the aggregate tombstone-byte limit should evict old records");
    const newest = manager.getSessionSnapshot(retainedIds[1]);
    deepStrictEqual(newest.prompt?.state, "completed");
    ok(
      manager
        .getEvents(retainedIds[1])
        .events.some((event) => event.kind === "process_exited"),
    );
  } finally {
    await manager.closeAll();
  }
});

test("tombstone count is bounded and concurrent close retains capacity until teardown", async () => {
  const manager = new SessionManager(
    {
      fake: {
        command: process.execPath,
        args: [fakeFixturePath(), "--session-close-delay-ms=250"],
      },
    },
    undefined,
    1000,
    1,
    2,
  );
  try {
    const exited: string[] = [];
    for (let index = 0; index < 3; index++) {
      const session = await manager.start("fake", process.cwd());
      exited.push(session.id);
      await manager.beginPrompt(session.id, "process crash").done;
      await waitForRetirement(manager, session.id);
    }
    let countEvicted = false;
    try {
      manager.getEvents(exited[0]);
    } catch {
      countEvicted = true;
    }
    ok(countEvicted);
    ok(
      manager
        .getEvents(exited[2])
        .events.some((event) => event.kind === "process_exited"),
    );

    const session = await manager.start("fake", process.cwd());
    const firstClose = manager.close(session.id);
    const secondClose = manager.close(session.id);
    deepStrictEqual(firstClose, secondClose);
    await new Promise((resolve) => setTimeout(resolve, 30));
    deepStrictEqual(manager.sessionCount, 1);
    const atCapacity = await Promise.allSettled([
      manager.start("fake", process.cwd()),
    ]);
    deepStrictEqual(atCapacity[0].status, "rejected");
    await Promise.all([firstClose, secondClose]);
    deepStrictEqual(manager.sessionCount, 0);
    let closeRemovedHandle = false;
    try {
      manager.getSessionSnapshot(session.id);
    } catch {
      closeRemovedHandle = true;
    }
    ok(closeRemovedHandle, "explicit close must not retain a tombstone");
  } finally {
    await manager.closeAll();
  }
});

test("MCP exposes exited sessions through get_session and get_events", async () => {
  const agents = {
    fake: { command: process.execPath, args: [fakeFixturePath()] },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const started = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "fake",
        cwd: process.cwd(),
      }).response,
    ) as { sessionId: string };
    await mcp.callTool("prompt", {
      sessionId: started.sessionId,
      text: "process crash",
    }).response;
    await waitForRetirement(manager, started.sessionId);

    const session = parseToolResult(
      await mcp.callTool("get_session", { sessionId: started.sessionId })
        .response,
    ) as {
      prompt: { state: string; stopReason?: string };
      processExit: { code: number; signal: string | null };
    };
    deepStrictEqual(session.processExit, { code: 17, signal: null });
    deepStrictEqual(session.prompt.state, "failed");
    deepStrictEqual(session.prompt.stopReason, "process_exited");

    const journal = parseToolResult(
      await mcp.callTool("get_events", { sessionId: started.sessionId })
        .response,
    ) as { events: Array<{ kind: string; update: unknown }> };
    ok(
      journal.events.some(
        (event) =>
          event.kind === "process_exited" &&
          JSON.stringify(event.update) ===
            JSON.stringify({ code: 17, signal: null }),
      ),
    );
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
