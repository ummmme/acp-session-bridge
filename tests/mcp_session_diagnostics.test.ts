import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

async function withMcpSession(
  check: (
    mcp: Awaited<ReturnType<typeof connectMcp>>,
    sessionId: string,
  ) => Promise<void>,
) {
  const agents = {
    fake: {
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("./fixtures/fake_acp_v2_agent.ts", import.meta.url),
        ),
      ],
      acpProtocol: "v2" as const,
    },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseToolResult(await mcp.callTool(name, args).response);
  try {
    const { sessionId } = await call("start_session", {
      agentId: "fake",
      cwd: process.cwd(),
    });
    await check(mcp, sessionId as string);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
}

test("session tools include accumulated text by default and omit it on request", async () => {
  await withMcpSession(async (mcp, sessionId) => {
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      parseToolResult(
        await mcp.callTool(name, { sessionId, ...args }).response,
      );
    await call("prompt", { text: "snapshot" });

    const sessionDefault = (await call("get_session")) as {
      prompt: Record<string, unknown>;
    };
    const eventsDefault = (await call("get_events")) as {
      prompt: Record<string, unknown>;
    };
    equal(sessionDefault.prompt.text, "replacement");
    equal(eventsDefault.prompt.text, "replacement");

    const sessionWithoutText = (await call("get_session", {
      includePromptText: false,
    })) as { prompt: Record<string, unknown> };
    const eventsWithoutText = (await call("get_events", {
      includePromptText: false,
    })) as { prompt: Record<string, unknown> };
    ok(!Object.hasOwn(sessionWithoutText.prompt, "text"));
    ok(!Object.hasOwn(eventsWithoutText.prompt, "text"));
  });
});

test("failed session tools return actionable sanitized diagnostics", async () => {
  await withMcpSession(async (mcp, sessionId) => {
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      parseToolResult(
        await mcp.callTool(name, { sessionId, ...args }).response,
      );
    const promptResult = (await call("prompt", { text: "error" })) as {
      state: string;
      error?: string;
      errorCode?: number;
    };
    equal(promptResult.state, "failed");
    equal(promptResult.errorCode, -32042);
    equal(
      promptResult.error,
      "The ACP provider failed to complete the prompt. Check its authentication and configuration, inspect provider logs, then retry.",
    );

    const session = (await call("get_session")) as {
      prompt: Record<string, unknown>;
    };
    const events = (await call("get_events", {
      includeRaw: true,
    })) as {
      prompt: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    for (const prompt of [session.prompt, events.prompt]) {
      equal(prompt.state, "failed");
      equal(prompt.errorCode, -32042);
      equal(
        prompt.error,
        "The ACP provider failed to complete the prompt. Check its authentication and configuration, inspect provider logs, then retry.",
      );
      ok(!Object.hasOwn(prompt, "errorData"));
    }

    const diagnostics = [session.prompt, events.prompt].map((prompt) => ({
      error: prompt.error,
      errorCode: prompt.errorCode,
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics);
    ok(!serializedDiagnostics.includes("fixture prompt error"));
    ok(!serializedDiagnostics.includes('"kind":"test"'));
    const serializedEvents = JSON.stringify(events.events);
    ok(!serializedEvents.includes("fixture prompt error"));
    ok(!serializedEvents.includes('"kind":"test"'));
    const failureEvent = events.events.find(
      (event) =>
        event.kind === "state_update" &&
        (event.update as { stopReason?: string })?.stopReason === "error",
    );
    ok(failureEvent);
    equal(
      (failureEvent.update as { error: { message: string } }).error.message,
      promptResult.error,
    );
    const rawParams = failureEvent.raw as {
      _meta: { fixture: string };
      update: { error: { message: string; data?: unknown } };
    };
    equal(rawParams._meta.fixture, "fake-v2");
    equal(rawParams.update.error.message, promptResult.error);
    ok(!Object.hasOwn(rawParams.update.error, "data"));
    const eventsWithoutRaw = (await call("get_events")) as {
      events: Array<Record<string, unknown>>;
    };
    const failureWithoutRaw = eventsWithoutRaw.events.find(
      (event) => event.kind === "state_update",
    );
    ok(failureWithoutRaw);
    ok(!Object.hasOwn(failureWithoutRaw, "raw"));
    ok(events.events.some((event) => Object.hasOwn(event, "raw")));
  });
});

test("managed failures use the profile selected when the session was launched", async () => {
  const manager = new SessionManager({});
  const server = createMcpServer({}, manager, {
    resolveConfiguration: async () => ({
      sources: [],
      cwd: process.cwd(),
      explicit: false,
      agents: {
        late: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("./fixtures/fake_acp_agent.ts", import.meta.url),
            ),
          ],
          failureClassifier: "opencode",
        },
      },
    }),
  });
  const mcp = await connectMcp(server);
  const call = async (name: string, args: Record<string, unknown>) =>
    parseToolResult(await mcp.callTool(name, args).response);
  try {
    const { sessionId } = await call("start_session", { agentId: "late" });
    const turn = await call("prompt", {
      sessionId,
      text: "rate limit failure",
    });
    const session = await call("get_session", { sessionId });
    const events = await call("get_events", { sessionId });
    for (const prompt of [turn, session.prompt, events.prompt] as Array<
      Record<string, unknown>
    >) {
      equal(prompt.state, "failed");
      ok(String(prompt.error).includes("rate limit or quota"));
      ok(
        !JSON.stringify(prompt).includes(
          "PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL",
        ),
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

test("initial start-session prompt failure returns sanitized diagnostics", async () => {
  await withMcpSession(async (mcp) => {
    const result = (await parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "fake",
        cwd: process.cwd(),
        prompt: "error",
      }).response,
    )) as {
      result: Record<string, unknown>;
    };
    equal(result.result.state, "failed");
    equal(result.result.errorCode, -32042);
    equal(
      result.result.error,
      "The ACP provider failed to complete the prompt. Check its authentication and configuration, inspect provider logs, then retry.",
    );
    ok(!Object.hasOwn(result.result, "errorData"));
    const serialized = JSON.stringify(result.result);
    ok(!serialized.includes("fixture prompt error"));
    ok(!serialized.includes('"kind":"test"'));
  });
});

test("asynchronous prompt failures stay sanitized and local errors stay actionable", async () => {
  await withMcpSession(async (mcp, sessionId) => {
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      parseToolResult(
        await mcp.callTool(name, { sessionId, ...args }).response,
      );
    const initial = (await call("prompt", {
      text: "error",
      wait: false,
    })) as { state: string };
    ok(["running", "failed"].includes(initial.state));

    let snapshot = (await call("get_session")) as {
      prompt: Record<string, unknown>;
    };
    for (let attempt = 0; attempt < 50; attempt++) {
      if (snapshot.prompt.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = (await call("get_session")) as {
        prompt: Record<string, unknown>;
      };
    }
    equal(snapshot.prompt.state, "failed");
    equal(snapshot.prompt.errorCode, -32042);
    ok(!JSON.stringify(snapshot.prompt).includes("fixture prompt error"));

    const localError = await mcp.callTool("prompt", {
      sessionId: "missing-session",
      text: "error",
    }).response;
    ok(JSON.stringify(localError).includes("Unknown session: missing-session"));
  });
});
