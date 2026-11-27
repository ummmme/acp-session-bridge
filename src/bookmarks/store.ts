import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import type { TurnState } from "./turn.ts";

import {
  acquireExecutionLease,
  ExecutionLeaseError,
} from "../runtime/execution_lease.ts";

import { readLegacyScope } from "./legacy.ts";

const id = z.string().min(1).max(4096);
const label = z.string().regex(/^[A-Z]+$/);
const turn = z.strictObject({
  promptId: id,
  state: z.enum([
    "pending_send",
    "running",
    "cancel_requested",
    "outcome_unknown",
    "completed",
    "cancelled",
    "not_sent",
    "failed_confirmed",
  ] satisfies TurnState[]),
});
const entry = z.strictObject({
  agentId: id,
  sessionCwd: id,
  acpSessionId: id.nullable(),
  sessionId: id.nullable(),
  owner: z.strictObject({
    ownerId: id,
    ownerEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  bridgePid: z.number().int().positive().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  directWindowsAgent: z.boolean().optional(),
  childPid: z.number().int().positive().nullable().optional(),
  status: z.enum(["resuming", "live", "offline", "closed"]),
  model: id.nullable(),
  thoughtLevel: id.nullable(),
  thoughtConfig: z
    .strictObject({ configId: id, value: id })
    .nullable()
    .optional(),
  name: id.nullable(),
  afterSequence: z.number().int().nonnegative(),
  lastPrompt: turn.nullable(),
});
const book = z
  .strictObject({
    schemaVersion: z.literal(1),
    clientConversationId: id.optional(),
    projectRoot: id.optional(),
    scopeKey: z.string().regex(/^[0-9a-f]{64}$/),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currentLabel: label.nullable(),
    sessions: z.record(label, entry),
  })
  .refine(
    (value) =>
      value.currentLabel === null ||
      (!!value.sessions[value.currentLabel] &&
        value.sessions[value.currentLabel].status !== "closed"),
  );
export type ScopeBook = z.infer<typeof book>;
export class BookmarkError extends Error {
  readonly code:
    | "invalid_bookmark"
    | "scope_busy"
    | "bookmark_io"
    | "unsafe_state_directory";
  constructor(code: BookmarkError["code"]) {
    super(code);
    this.code = code;
  }
}
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function checkHash(key: string) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new BookmarkError("invalid_bookmark");
}
async function privateDirectory(dir: string, create: boolean) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (
    !st.isDirectory() ||
    (process.platform !== "win32" &&
      ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))
  )
    throw new BookmarkError("unsafe_state_directory");
}
function validate(value: unknown, key: string): ScopeBook {
  const parsed = book.safeParse(value);
  if (!parsed.success || parsed.data.scopeKey !== key)
    throw new BookmarkError("invalid_bookmark");
  const { projectRoot, clientConversationId } = parsed.data;
  if (projectRoot !== undefined || clientConversationId !== undefined) {
    if (
      !projectRoot ||
      !clientConversationId ||
      createHash("sha256")
        .update(clientConversationId + "\0" + projectRoot)
        .digest("hex") !== key
    )
      throw new BookmarkError("invalid_bookmark");
  }
  return parsed.data;
}
async function readRecord(
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
      throw new BookmarkError("invalid_bookmark");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errno(error, "ENOENT")) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BookmarkError("invalid_bookmark");
  }
  return validate(value, key);
}

async function acquireTransactionLock(path: string) {
  const key = createHash("sha256").update(path).digest("hex");
  let guard: Awaited<ReturnType<typeof acquireExecutionLease>> | undefined;
  for (const delay of [0, 5, 15, 30, 60, 100, 200]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      guard = await acquireExecutionLease(key, "transaction");
      break;
    } catch (error) {
      if (!(error instanceof ExecutionLeaseError && error.code === "busy"))
        throw new BookmarkError("bookmark_io");
    }
  }
  if (!guard) throw new BookmarkError("scope_busy");
  // Only guarded writers publish this marker. The kernel serializes removal
  // with acquisition, including when the previous writer died before unlink.
  const marker = `acp-scope-lock-v1:${key}:`;
  const tmp = `${path}.${randomUUID()}`;
  try {
    try {
      const st = await lstat(path);
      if (
        !st.isFile() ||
        st.size > 256 ||
        !new RegExp(`^${marker}[1-9][0-9]*:[0-9]+$`).test(
          await readFile(path, "utf8"),
        )
      )
        throw new BookmarkError("scope_busy");
      await unlink(path);
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
    const file = await open(tmp, "wx", 0o600);
    try {
      try {
        await file.writeFile(`${marker}${process.pid}:${Date.now()}`);
      } finally {
        await file.close();
      }
      await link(tmp, path);
    } finally {
      await unlink(tmp);
    }
    return guard;
  } catch (error) {
    await guard.close();
    throw error instanceof BookmarkError
      ? error
      : new BookmarkError("bookmark_io");
  }
}

/** A scope transaction serializes bookmark writes. It does not confer ownership of an ACP process. */
export class ScopeStore {
  readonly dir: string;
  constructor(dir: string) {
    if (!isAbsolute(dir)) throw new BookmarkError("unsafe_state_directory");
    this.dir = dir;
  }
  private async legacy(key: string) {
    try {
      const candidate = await readLegacyScope(
        join(dirname(this.dir), "gemini-sessions.json"),
        key,
      );
      return candidate ? validate(candidate, key) : null;
    } catch {
      throw new BookmarkError("invalid_bookmark");
    }
  }
  async read(key: string): Promise<ScopeBook | null> {
    checkHash(key);
    try {
      await privateDirectory(this.dir, false);
      return (
        (await readRecord(join(this.dir, `${key}.json`), key)) ??
        (await this.legacy(key))
      );
    } catch (error) {
      if (errno(error, "ENOENT")) return this.legacy(key);
      if (error instanceof BookmarkError) throw error;
      throw new BookmarkError("bookmark_io");
    }
  }
  async update(
    key: string,
    mutate: (draft: ScopeBook) => ScopeBook | Promise<ScopeBook>,
  ): Promise<ScopeBook> {
    checkHash(key);
    const path = join(this.dir, `${key}.json`),
      lockPath = join(this.dir, `${key}.lock`);
    try {
      await privateDirectory(this.dir, true);
    } catch (error) {
      if (error instanceof BookmarkError) throw error;
      throw new BookmarkError("bookmark_io");
    }
    const lock = await acquireTransactionLock(lockPath);
    let saved: ScopeBook;
    let releaseFailed = false;
    try {
      let current: ScopeBook | null;
      try {
        current = (await readRecord(path, key)) ?? (await this.legacy(key));
      } catch (error) {
        if (error instanceof BookmarkError) throw error;
        throw new BookmarkError("bookmark_io");
      }
      const draft = current ?? {
        schemaVersion: 1,
        scopeKey: key,
        revision: 0,
        currentLabel: null,
        sessions: {},
      };
      const revision = draft.revision + 1;
      const updated = validate({ ...(await mutate(draft)), revision }, key);
      const tmp = `${path}.tmp.${randomUUID()}`;
      try {
        const file = await open(tmp, "wx", 0o600);
        try {
          try {
            await file.writeFile(JSON.stringify(updated));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(tmp, path);
        } catch (error) {
          await unlink(tmp).catch(() => {});
          throw error;
        }
        if (process.platform !== "win32") {
          const dir = await open(this.dir, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
        saved = updated;
      } catch {
        throw new BookmarkError("bookmark_io");
      }
    } finally {
      try {
        try {
          await unlink(lockPath);
        } finally {
          await lock.close();
        }
      } catch {
        releaseFailed = true;
      }
    }
    if (releaseFailed) throw new BookmarkError("bookmark_io");
    return saved;
  }
}
