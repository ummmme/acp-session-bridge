import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import {
  agent,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

type SavedSession = { model: string; thought: string; code?: string };

const app = agent({ name: "scoped-session-fixture" });
const audit = process.env.ACP_SCOPED_FIXTURE_AUDIT;
if (audit) await appendFile(audit, `spawn ${process.pid}\n`);
const hold = process.env.ACP_SCOPED_FIXTURE_HOLD;
const keepAlive = hold
  ? setInterval(() => {
      void access(hold).catch(() => clearInterval(keepAlive));
    }, 25)
  : undefined;
const active = new Map<string, SavedSession>();

function statePath() {
  const path = process.env.ACP_SCOPED_FIXTURE_STATE;
  if (!path) throw new Error("ACP_SCOPED_FIXTURE_STATE is required");
  return path;
}

async function readState(): Promise<Record<string, SavedSession>> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as Record<
      string,
      SavedSession
    >;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
}

async function saveSession(sessionId: string, value: SavedSession) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const saved = await readState();
  saved[sessionId] = value;
  await writeFile(path, JSON.stringify(saved));
}

async function recordPrompt(sessionId: string, prompt: string) {
  const marker = process.env.ACP_SCOPED_FIXTURE_PROMPTS;
  if (!marker) return;
  await appendFile(marker, `${sessionId}\t${prompt}\n`);
}

function optionSnapshot(value: SavedSession): SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: value.model,
      options: [
        { value: "flash", name: "Flash" },
        { value: "pro", name: "Pro" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought level",
      category: "thought_level",
      type: "select" as const,
      currentValue: value.thought,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

app.onRequest("initialize", () => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
}));

app.onRequest("session/new", async () => {
  const sessionId = `scoped-${crypto.randomUUID()}`;
  const initial = { model: "flash", thought: "low" };
  active.set(sessionId, initial);
  await saveSession(sessionId, initial);
  return { sessionId, configOptions: optionSnapshot(initial) };
});

app.onRequest("session/load", async ({ params }) => {
  const sessionId = (params as { sessionId: string }).sessionId;
  if (audit) await appendFile(audit, `load ${sessionId} ${process.cwd()}\n`);
  const value = (await readState())[sessionId];
  if (!value) throw new Error(`Unknown fixture session: ${sessionId}`);
  active.set(sessionId, value);
  return { sessionId, configOptions: optionSnapshot(value) };
});

app.onRequest("session/set_config_option", async ({ params }) => {
  const { sessionId, configId, value } = params as {
    sessionId: string;
    configId: string;
    value: string;
  };
  const current = active.get(sessionId);
  if (!current) throw new Error(`Unknown active fixture session: ${sessionId}`);
  const updated =
    configId === "model"
      ? { ...current, model: value }
      : configId === "thought_level"
        ? { ...current, thought: value }
        : current;
  active.set(sessionId, updated);
  await saveSession(sessionId, updated);
  return { configOptions: optionSnapshot(updated) };
});

app.onRequest("session/prompt", async ({ params, client }) => {
  const sessionId = (params as { sessionId: string }).sessionId;
  const text = (
    params as { prompt: Array<{ type: string; text?: string }> }
  ).prompt
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
  const value = active.get(sessionId);
  if (!value) throw new Error(`Unknown active fixture session: ${sessionId}`);
  await recordPrompt(sessionId, text);
  if (text.startsWith("remember:")) {
    value.code = text.slice(9);
    await saveSession(sessionId, value);
  }
  const answer =
    text === "recall"
      ? (value.code ?? "unknown")
      : `context=${sessionId}; model=${value.model}; thought=${value.thought}; prompt=${text}`;
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: answer },
    },
  });
  return { stopReason: "end_turn" };
});

app.onRequest("session/close", () => {
  clearInterval(keepAlive);
  return {};
});

const transport = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
await app.connect(transport);
