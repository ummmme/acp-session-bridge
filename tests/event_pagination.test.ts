import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

type Page = {
  events: Array<{ sequence: number; kind: string }>;
  nextSequence: number;
  gap: boolean;
};

type Session = {
  prompt(text: string): Promise<unknown>;
  events(
    cursor?: number,
    limit?: number,
    thoughts?: boolean,
    waitMs?: number,
  ): Promise<Page>;
};

async function withSession(check: (session: Session) => Promise<void>) {
  const agents = {
    raw: {
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("./fixtures/raw_wire_acp_agent.ts", import.meta.url),
        ),
      ],
    },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  const call = async (name: string, args: Record<string, unknown>) =>
    parseToolResult(await mcp.callTool(name, args).response);
  try {
    const { sessionId } = await call("start_session", {
      agentId: "raw",
      cwd: process.cwd(),
    });
    await check({
      prompt: (text) => call("prompt", { sessionId, text, wait: true }),
      events: async (
        afterSequence = 0,
        limit = 100,
        includeThoughts = false,
        waitMs = 0,
      ) =>
        (await call("get_events", {
          sessionId,
          afterSequence,
          limit,
          waitMs,
          includeThoughts,
        })) as Page,
    });
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
}

async function drain(
  session: Session,
  first: Page,
  limit: number,
  thoughts = false,
) {
  const events = [...first.events];
  let page = first;
  for (let attempts = 0; attempts < 2000; attempts++) {
    const next = await session.events(page.nextSequence, limit, thoughts);
    if (next.nextSequence === page.nextSequence) {
      equal(next.events, []);
      return events;
    }
    if (next.nextSequence < page.nextSequence || next.gap) {
      throw new Error(
        "Reading a retained page lost progress or reported a new gap",
      );
    }
    events.push(...next.events);
    page = next;
  }
  throw new Error("The event reader did not reach the end of the journal");
}

test("MCP pagination replays the journal across appends and hidden thought pages", async () => {
  await withSession(async (session) => {
    const empty = await session.events();
    equal([empty.events, empty.nextSequence, empty.gap], [[], 0, false]);
    await session.prompt("delegate isolation");
    const first = await session.events(0, 1);
    await session.prompt("followup");
    const complete = await session.events(0, 500, true);
    const visible = complete.events.filter(
      (event) => event.kind !== "agent_thought_chunk",
    );
    equal(await drain(session, first, 1), visible);
    equal(
      await drain(session, await session.events(0, 3, true), 3, true),
      complete.events,
    );
  });
});

async function pollWithEarlyWake(session: Session, promptText: string) {
  const pending = session.events(0, 100, false, 15_000);
  await session.prompt(promptText);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Poll slept through the prompt")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("MCP get_events long-polls past hidden events until visible output", async () => {
  await withSession(async (session) => {
    const start = performance.now();
    const page = await pollWithEarlyWake(session, "long poll hidden");
    equal(
      page.events.map((event) => event.kind),
      ["agent_message_chunk"],
    );
    ok(page.nextSequence >= 2);
    ok(performance.now() - start >= 80);
  });
});

test("MCP get_events advances hidden cursor when terminal prompt wakes the poll", async () => {
  await withSession(async (session) => {
    const start = performance.now();
    const page = await pollWithEarlyWake(session, "hidden only");
    equal(page.events, []);
    equal(page.nextSequence, 1);
    ok(performance.now() - start >= 80);
  });
});

test("MCP pagination recovers retained events and UTF-8 byte-cap gaps", async () => {
  for (const prompt of ["event burst", "oversized event"]) {
    await withSession(async (session) => {
      await session.prompt(prompt);
      const first = await session.events(0, 1);
      equal(first.gap, true);
      if (!first.nextSequence) {
        throw new Error("The cursor did not advance past the gap");
      }
      const retained = await drain(session, first, 100);
      if (prompt === "event burst") {
        const start = retained[0]?.sequence;
        if (!(start > 1)) {
          throw new Error("Expected the retained suffix after eviction");
        }
        equal(
          retained.map((event) => event.sequence),
          Array.from({ length: 1005 - start + 1 }, (_, index) => start + index),
        );
      } else {
        equal(retained, []);
      }
      await session.prompt("after gap");
      const cursor = retained.at(-1)?.sequence ?? first.nextSequence;
      const appended = await drain(session, await session.events(cursor, 1), 1);
      equal(
        appended.map((event) => event.kind),
        ["agent_message_chunk", "future_update", "agent_message_chunk"],
      );
    });
  }
});
