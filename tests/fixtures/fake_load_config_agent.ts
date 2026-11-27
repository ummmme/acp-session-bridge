import {
  agent,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { appendFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

const app = agent({ name: "fake-load-config-agent" });
let activeOptions: Array<Record<string, unknown>> = [];
let loadedSessionId = "";

function wireOptions(): SessionConfigOption[] {
  return activeOptions as unknown as SessionConfigOption[];
}

function notifyConfig(client: {
  notify: (method: string, params: unknown) => Promise<unknown>;
}) {
  void client.notify("session/update", {
    sessionId: loadedSessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: wireOptions(),
    },
  });
}

app.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
}));
app.onRequest("session/load", ({ params, client }) => {
  loadedSessionId = (params as { sessionId: string }).sessionId;
  activeOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "flash",
      options: [{ value: "flash", name: "Flash" }],
    },
    {
      id: "thought_level",
      name: "Thought level",
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    },
  ];
  if (process.env.ACP_TEST_THOUGHT_AFTER_MODEL)
    activeOptions = activeOptions.filter((o) => o.id !== "thought_level");
  setTimeout(() => {
    activeOptions = activeOptions.map((option) =>
      option.id === "model"
        ? {
            ...option,
            options: [
              ...(option.options as unknown[]),
              { value: "pro", name: "Pro" },
            ],
          }
        : option,
    );
    notifyConfig(client);
  }, 25);
  return { sessionId: loadedSessionId, configOptions: wireOptions() };
});
app.onRequest("session/set_config_option", async ({ params, client }) => {
  const { configId, value } = params as { configId: string; value: string };
  const marker = process.env.ACP_TEST_LOAD_CONFIG_MARKER;
  if (marker) await appendFile(marker, `${configId}=${value}\n`);
  if (configId === "model" && value === "pro") {
    if (!activeOptions.some((o) => o.id === "thought_level"))
      activeOptions.push({
        id: "thought_level",
        name: "Thought level",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      });
    activeOptions = activeOptions.map((option) =>
      option.id === "model"
        ? { ...option, currentValue: "pro" }
        : option.id === "thought_level"
          ? { ...option, currentValue: "low" }
          : option,
    );
    setTimeout(() => {
      activeOptions = activeOptions.map((option) =>
        option.id === "thought_level"
          ? {
              ...option,
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            }
          : option,
      );
      notifyConfig(client);
    }, 25);
  } else {
    activeOptions = activeOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option,
    );
  }
  return { configOptions: wireOptions() };
});
app.onRequest("session/prompt", async () => {
  const marker = process.env.ACP_TEST_LOAD_PROMPT_MARKER;
  if (marker) await appendFile(marker, "prompt\n");
  return { stopReason: "end_turn" };
});
app.onRequest("session/close", () => ({}));

const transport = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
await app.connect(transport);
