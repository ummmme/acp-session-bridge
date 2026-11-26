import { test } from "node:test";
import process from "node:process";
import { SessionManager } from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const fixturePath = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
  .pathname;
const absoluteFixturePath =
  process.platform === "win32"
    ? decodeURIComponent(fixturePath.replace(/^\//, ""))
    : fixturePath;
const agents = {
  fake: {
    command: process.execPath,
    args: [absoluteFixturePath],
  },
};

function harness() {
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  return { manager, server };
}

test("start_session hands off operator approval without waiting for completion", async () => {
  const { manager, server } = harness();
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "fake",
        permissionPolicy: "operator",
        prompt: "permission",
      }).response,
    );
    const handoff = result.result as Record<string, unknown>;
    const pendingPermissions = handoff.pendingPermissions as Array<{
      id: string;
    }>;
    if (
      handoff.state !== "running" ||
      typeof handoff.promptId !== "string" ||
      !Array.isArray(pendingPermissions) ||
      pendingPermissions.length !== 1 ||
      typeof result.sessionId !== "string"
    ) {
      throw new Error(
        `Unexpected start_session handoff: ${JSON.stringify(result)}`,
      );
    }
    if (!manager.hasSession(String(result.sessionId))) {
      throw new Error(
        "start_session closed the session during approval handoff",
      );
    }
    // The approval is already queued; no future event is needed to return the wait.
    const sid = String(result.sessionId);
    const guard = AbortSignal.timeout(2000);
    const immediate = await manager.waitPrompt(
      sid,
      handoff.promptId,
      10_000,
      true,
      guard,
    );
    if (guard.aborted || immediate.state !== "running")
      throw new Error("Expected immediate pending approval");
    const resolved = parseToolResult(
      await mcp.callTool("resolve_permission", {
        sessionId: result.sessionId,
        permissionId: pendingPermissions[0].id,
        optionId: "reject",
      }).response,
    );
    if (resolved.resolved !== true)
      throw new Error("Approval was not resolved");
    const snapshot = manager.getSessionSnapshot(String(result.sessionId));
    if (!snapshot.prompt) throw new Error("Prompt disappeared after handoff");
    const completed = await manager.waitForPromptCompletion(
      String(result.sessionId),
      snapshot.prompt.id,
    );
    if (completed.state !== "completed") {
      throw new Error(
        `Prompt did not complete after approval: ${completed.state}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

test("prompt wait=true hands off operator approval and keeps the session live", async () => {
  const { manager, server } = harness();
  const mcp = await connectMcp(server);
  try {
    const started = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "fake",
        permissionPolicy: "operator",
      }).response,
    );
    const sessionId = String(started.sessionId);
    const handoff = parseToolResult(
      await mcp.callTool("prompt", {
        sessionId,
        text: "permission",
        wait: true,
      }).response,
    );
    const pendingPermissions = handoff.pendingPermissions as Array<{
      id: string;
    }>;
    if (
      handoff.state !== "running" ||
      handoff.sessionId !== sessionId ||
      typeof handoff.promptId !== "string" ||
      !Array.isArray(pendingPermissions) ||
      pendingPermissions.length !== 1
    ) {
      throw new Error(`Unexpected prompt handoff: ${JSON.stringify(handoff)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!manager.hasSession(sessionId)) {
      throw new Error("Unanswered approval closed the managed session");
    }
    await mcp.callTool("resolve_permission", {
      sessionId,
      permissionId: pendingPermissions[0].id,
      optionId: "reject",
    }).response;
    const snapshot = manager.getSessionSnapshot(sessionId);
    if (!snapshot.prompt) throw new Error("Prompt disappeared after handoff");
    const completed = await manager.waitForPromptCompletion(
      sessionId,
      snapshot.prompt.id,
    );
    if (completed.state !== "completed") {
      throw new Error(
        `Prompt did not complete after approval: ${completed.state}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

async function waitUntil(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for session state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("signalled cancellation settles prompt waits and cleans up owned sessions", async () => {
  const { manager, server } = harness();
  const mcp = await connectMcp(server);
  try {
    const started = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "fake",
        permissionPolicy: "operator",
      }).response,
    );
    const sessionId = String(started.sessionId);
    const promptRequest = mcp.callTool("prompt", {
      sessionId,
      text: "wait",
      wait: true,
    });
    await waitUntil(
      () => manager.getSessionSnapshot(sessionId).prompt?.state === "running",
    );
    await mcp.cancel(promptRequest.id);
    await waitUntil(
      () => manager.getSessionSnapshot(sessionId).prompt?.state === "cancelled",
    );
    const prompt = manager.getSessionSnapshot(sessionId).prompt;
    if (
      !prompt ||
      prompt.state !== "cancelled" ||
      !manager.hasSession(sessionId)
    ) {
      throw new Error(
        "Prompt cancellation did not settle while retaining its session",
      );
    }

    const startRequest = mcp.callTool("start_session", {
      agentId: "fake",
      prompt: "wait",
    });
    await waitUntil(() =>
      manager
        .listSessionSnapshots()
        .some((s) => s.id !== sessionId && s.promptActive),
    );
    await mcp.cancel(startRequest.id);
    await waitUntil(() => manager.sessionCount === 1);
    if (manager.sessionCount !== 1) {
      throw new Error(
        "Cancelled start_session did not clean up its owned session",
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
