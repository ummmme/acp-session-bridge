import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer } from "../src/mcp/server.ts";
import { extractVerifiedRawThoughtConfig } from "../src/models/resume_verification.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const agent = {
  command: process.execPath,
  args: [
    fileURLToPath(
      new URL("./fixtures/fake_load_config_agent.ts", import.meta.url),
    ),
  ],
  modelConfigId: "model",
  models: {
    allowedModels: ["flash", "pro"],
    thinkingEffort: {
      configOption: "thought_level",
      values: { low: "low", high: "high" },
    },
  },
};

async function withServer(
  check: (
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    manager: SessionManager,
  ) => Promise<void>,
) {
  const agents = { fake: agent };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  const call = async (name: string, args: Record<string, unknown>) =>
    parseToolResult(await mcp.callTool(name, args).response);
  try {
    await check(call, manager);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
}

test("load_session waits for exact model and thought value, then restores both", async () => {
  await withServer(async (call) => {
    const loaded = (await call("load_session", {
      agentId: "fake",
      acpSessionId: "fixture-session",
      cwd: process.cwd(),
      model: "pro",
      thinkingEffort: "high",
    })) as {
      sessionId: string;
      configOptions: Array<{ id: string; currentValue?: unknown }>;
    };
    equal(
      loaded.configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "pro",
    );
    equal(
      loaded.configOptions.find((option) => option.id === "thought_level")
        ?.currentValue,
      "high",
    );
    ok(loaded.sessionId);
  });
});

test("recovery rejects forbidden or missing models without sending, releases the handle, and permits a later load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-resume-check-"));
  const agents = {
    fake: {
      ...agent,
      env: { ACP_TEST_LOAD_PROMPT_MARKER: join(dir, "sent") },
      models: { ...agent.models, allowedModels: ["flash", "pro", "missing"] },
    },
  };
  const manager = new SessionManager(agents, undefined, undefined, 1),
    server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  const load = (model: string) =>
    mcp.callTool("load_session", {
      agentId: "fake",
      cwd: dir,
      acpSessionId: "same-downstream",
      model,
    }).response;
  try {
    for (const [model, message] of [
      ["blocked", "denied"],
      ["missing", "Could not verify"],
    ]) {
      const r = (await load(model)) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      equal(r.result.isError, true);
      ok(r.result.content[0].text.includes(message));
      equal(manager.sessionCount, 0);
    }
    ok(parseToolResult(await load("pro")).sessionId);
    equal(await readdir(dir), []);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("load_session accepts exact raw thought config and keeps omitted verification opt-in", async () => {
  await withServer(async (call) => {
    const rawConfigLoad = (await call("load_session", {
      agentId: "fake",
      acpSessionId: "fixture-raw-config",
      cwd: process.cwd(),
      model: "pro",
      config: { thought_level: "high" },
    })) as { configOptions: Array<{ id: string; currentValue?: unknown }> };
    equal(
      rawConfigLoad.configOptions.find(
        (option) => option.id === "thought_level",
      )?.currentValue,
      "high",
    );

    const legacyLoad = (await call("load_session", {
      agentId: "fake",
      acpSessionId: "fixture-legacy",
      cwd: process.cwd(),
    })) as { configOptions: Array<{ id: string; currentValue?: unknown }> };
    equal(
      legacyLoad.configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "flash",
    );
    equal(
      legacyLoad.configOptions.find((option) => option.id === "thought_level")
        ?.currentValue,
      "low",
    );
  });
});

test("load_session extracts and verifies a model from config without a model field", async () => {
  await withServer(async (call, manager) => {
    const loaded = (await call("load_session", {
      agentId: "fake",
      acpSessionId: "fixture-config-model-only",
      cwd: process.cwd(),
      config: { thought_level: "high", model: "pro" },
    })) as { sessionId: string; configOptions: Array<Record<string, unknown>> };
    equal(
      loaded.configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "pro",
    );
    equal(
      manager.getSessionSnapshot(loaded.sessionId).modelSelection?.model,
      "pro",
    );
    equal(
      extractVerifiedRawThoughtConfig(loaded.configOptions, "thought_level"),
      { configId: "thought_level", value: "high" },
    );
  });
});

test("load_session preflights model/config conflicts before applying config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-resume-conflict-"));
  const agents = {
    fake: {
      ...agent,
      env: { ACP_TEST_LOAD_CONFIG_MARKER: join(dir, "set-config") },
    },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const response = (await mcp.callTool("load_session", {
      agentId: "fake",
      cwd: dir,
      acpSessionId: "fixture-config-conflict",
      model: "flash",
      config: { thought_level: "high", model: "pro" },
    }).response) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    equal(response.result.isError, true);
    ok(response.result.content[0].text.includes("conflicts"));
    equal(manager.sessionCount, 0);
    equal(await readdir(dir), []);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw thought extraction requires a verified select option", () => {
  equal(
    extractVerifiedRawThoughtConfig(
      [
        {
          id: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "low" }, { value: "high" }],
        },
        {
          id: "mode",
          type: "select",
          currentValue: "code",
          options: [{ value: "code" }],
        },
      ],
      "thought_level",
    ),
    { configId: "thought_level", value: "high" },
  );
  equal(
    extractVerifiedRawThoughtConfig(
      [
        {
          id: "thought_level",
          type: "select",
          currentValue: "max",
          options: [{ value: "low" }],
        },
      ],
      "thought_level",
    ),
    undefined,
  );
  equal(
    extractVerifiedRawThoughtConfig(
      [
        {
          id: "mode",
          type: "select",
          currentValue: "code",
          options: [{ value: "code" }],
        },
      ],
      "thought_level",
    ),
    undefined,
  );
});

test("provider-native thought config can appear only after switching model, in either key order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-raw-order-"));
  const agents = {
    fake: {
      ...agent,
      models: { allowedModels: ["flash", "pro"] },
      env: {
        ACP_TEST_THOUGHT_AFTER_MODEL: "yes",
        ACP_TEST_LOAD_CONFIG_MARKER: join(dir, "writes"),
        ACP_TEST_LOAD_PROMPT_MARKER: join(dir, "sent"),
      },
    },
  };
  const manager = new SessionManager(agents),
    server = createMcpServer(agents, manager),
    mcp = await connectMcp(server);
  try {
    for (const [index, config] of [
      { thought_level: "high", model: "pro" },
      { model: "pro", thought_level: "high" },
    ].entries()) {
      const result = parseToolResult(
        await mcp.callTool("load_session", {
          agentId: "fake",
          cwd: dir,
          acpSessionId: `test-${index}`,
          config,
        }).response,
      );
      equal(
        extractVerifiedRawThoughtConfig(
          result.configOptions as Array<Record<string, unknown>>,
          "thought_level",
        ),
        { configId: "thought_level", value: "high" },
      );
    }
    equal(
      await readFile(join(dir, "writes"), "utf8"),
      "model=pro\nthought_level=high\nmodel=pro\nthought_level=high\n",
    );
    equal(await readdir(dir), ["writes"]);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
