import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import type { ScopeBook } from "./store.ts";
import { recoverTurn } from "./turn.ts";

const text = z.string().min(1);
const pointer = z
  .string()
  .regex(/^[A-Z]+$/)
  .nullable();
const legacyEntry = z.object({
  label: pointer.unwrap().optional(),
  name: text.nullish(),
  agentId: text,
  cwd: text.optional(),
  sessionCwd: text.optional(),
  acpSessionId: text.nullable(),
  model: text.nullable(),
  thoughtLevel: text.nullish(),
  thoughtConfigId: text.nullish(),
  status: z.enum([
    "live",
    "idle",
    "running",
    "offline",
    "closed",
    "completed",
    "awaiting_approval",
  ]),
  promptId: text.nullish(),
  lastPrompt: z
    .object({
      promptId: text,
      state: z.enum([
        "pending_send",
        "running",
        "cancel_requested",
        "outcome_unknown",
        "completed",
        "cancelled",
        "not_sent",
        "failed_confirmed",
      ]),
    })
    .nullish(),
});
const group = z.object({
  clientConversationId: text,
  projectRoot: text.refine(isAbsolute),
  current: pointer.optional(),
  currentLabel: pointer.optional(),
  sessions: z.union([z.record(z.string(), legacyEntry), z.array(legacyEntry)]),
});

/** Older Skills wrote JSON, without a versioned wire schema. Import only explicitly identified scopes. */
export async function readLegacyScope(
  path: string,
  key: string,
): Promise<ScopeBook | null> {
  let raw: string;
  try {
    const st = await lstat(path);
    if (
      !st.isFile() ||
      (process.platform !== "win32" &&
        ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))
    )
      throw new Error("unsafe_legacy_bookmark");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const doc = JSON.parse(raw);
  let source = doc.scopes ?? (doc.clientConversationId ? [doc] : doc);
  if (doc.conversations !== undefined) {
    if (doc.scopes !== undefined || doc.clientConversationId !== undefined)
      throw new Error("ambiguous_legacy_scope");
    const nested = z
      .record(
        text,
        z.object({ projects: z.record(text, z.record(text, z.unknown())) }),
      )
      .parse(doc.conversations);
    source = Object.entries(nested).flatMap(([clientConversationId, c]) =>
      Object.entries(c.projects).map(([projectRoot, metadata]) => {
        if (
          (metadata.clientConversationId !== undefined &&
            metadata.clientConversationId !== clientConversationId) ||
          (metadata.projectRoot !== undefined &&
            metadata.projectRoot !== projectRoot)
        )
          throw new Error("ambiguous_legacy_scope");
        return { ...metadata, clientConversationId, projectRoot };
      }),
    );
  }
  const groups = z
    .union([
      z.array(group),
      z.record(z.string(), group).transform((groups) => Object.values(groups)),
    ])
    .parse(source);
  const matches = groups.filter(
    (g) =>
      createHash("sha256")
        .update(g.clientConversationId + "\0" + g.projectRoot)
        .digest("hex") === key,
  );
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("ambiguous_legacy_scope");
  const g = matches[0];
  if (
    g.current !== undefined &&
    g.currentLabel !== undefined &&
    g.current !== g.currentLabel
  )
    throw new Error("ambiguous_legacy_pointer");
  const sessions: ScopeBook["sessions"] = {};
  for (const [index, e] of Object.entries<z.infer<typeof legacyEntry>>(
    g.sessions,
  )) {
    const label = Array.isArray(g.sessions) ? e.label : index;
    const cwd = e.sessionCwd ?? e.cwd;
    if (
      !label ||
      !/^[A-Z]+$/.test(label) ||
      (e.label && e.label !== label) ||
      Object.hasOwn(sessions, label) ||
      !cwd ||
      !isAbsolute(cwd)
    )
      throw new Error("invalid_legacy_entry");
    sessions[label] = {
      agentId: e.agentId,
      sessionCwd: cwd,
      acpSessionId: e.acpSessionId,
      sessionId: null,
      owner: { ownerId: "legacy", ownerEpoch: 1 },
      status:
        e.status === "closed" || e.status === "offline" ? e.status : "live",
      model: e.model,
      thoughtLevel: e.thoughtLevel ?? null,
      thoughtConfig:
        e.thoughtConfigId && e.thoughtLevel
          ? { configId: e.thoughtConfigId, value: e.thoughtLevel }
          : null,
      afterSequence: 0,
      name: e.name ?? null,
      lastPrompt: recoverTurn(
        e.lastPrompt ??
          (e.promptId
            ? {
                promptId: e.promptId,
                state:
                  e.status === "completed" ? "completed" : "outcome_unknown",
              }
            : null),
      ),
    };
  }
  return {
    schemaVersion: 1,
    revision: 0,
    scopeKey: key,
    clientConversationId: g.clientConversationId,
    projectRoot: g.projectRoot,
    sessions,
    currentLabel: g.currentLabel ?? g.current ?? null,
  };
}
