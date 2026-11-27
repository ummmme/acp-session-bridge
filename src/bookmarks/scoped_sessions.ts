import {
  acquireExecutionLease,
  ExecutionLeaseError,
  type ExecutionLease,
} from "../runtime/execution_lease.ts";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { AgentDefinition } from "../agents/config.ts";
import { join, win32 } from "node:path";
import { resolveConversationScope, type ConversationScope } from "./scope.ts";
import { ScopeStore, type ScopeBook } from "./store.ts";
import { recoverTurn, type TurnBookmark, type Owner } from "./turn.ts";
import type { TurnBinding } from "./turn_journal.ts";

type Entry = ScopeBook["sessions"][string];
type Effective = {
  model: string;
  thoughtConfig: { configId: string; value: string } | null;
};
export interface SessionReservation {
  key: string;
  label: string;
  owner: Owner;
  entry: Entry;
  previous: Entry | null;
  lease: ExecutionLease;
}
export class ScopeConflict extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new ScopeConflict(code);
};
function sameOwner(a: Owner, b: Owner) {
  return a.ownerEpoch === b.ownerEpoch && a.ownerId === b.ownerId;
}
function nextLabel(n: number) {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
function findLabel(book: ScopeBook, target?: string) {
  const key = target ?? book.currentLabel;
  if (!key) return fail("no_current_session");
  if (Object.hasOwn(book.sessions, key)) return key;
  return (
    Object.keys(book.sessions).find((l) => book.sessions[l].name === key) ??
    fail("unknown_session_label")
  );
}
function validName(name: string) {
  return (
    name.trim() === name &&
    name.length > 0 &&
    name.length <= 120 &&
    !/^[A-Z]+$/.test(name) &&
    !/[\p{Cc}]/u.test(name) &&
    !["new", "list", "use", "close", "status", "rename", "config"].includes(
      name.toLowerCase(),
    )
  );
}
function assertName(book: ScopeBook, name: string, except?: string) {
  if (!validName(name)) fail("invalid_session_name");
  if (
    Object.keys(book.sessions).some(
      (l) => l !== except && book.sessions[l].name === name,
    )
  )
    fail("session_name_conflict");
}
function owned(book: ScopeBook, r: SessionReservation) {
  const e = book.sessions[r.label];
  if (!e || !sameOwner(e.owner, r.owner)) return fail("stale_owner");
  return e;
}

async function acquire(scopeKey: string, label: string, directory: string) {
  const key = createHash("sha256")
    .update(scopeKey + "\0" + label)
    .digest("hex");
  try {
    return await acquireExecutionLease(key, "execution", directory);
  } catch (error) {
    if (error instanceof ExecutionLeaseError && error.code === "busy")
      fail("session_occupied");
    throw error;
  }
}
function canRecover(e: Entry) {
  if (
    e.childPid === null ||
    (e.status === "offline" &&
      (e.childPid === undefined || process.platform === "win32"))
  )
    return true;
  if (!e.childPid || (process.platform === "win32" && !e.directWindowsAgent))
    return false;
  // Also protect agents that close fd 3. PID reuse keeps the session busy.
  try {
    process.kill(process.platform === "win32" ? e.childPid : -e.childPid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
/** Persisted live/resuming owners are never stolen based on a PID or elapsed time. */
export class ScopedSessions {
  readonly store: ScopeStore;
  private readonly instance = randomUUID();
  constructor(
    store = new ScopeStore(
      join(homedir(), ".local", "state", "acp-session-bridge", "scopes"),
    ),
  ) {
    this.store = store;
  }
  scope(clientConversationId: string, cwd: string, projectRoot?: string) {
    return resolveConversationScope({ clientConversationId, cwd, projectRoot });
  }
  async lookup(scope: ConversationScope, target?: string, id?: string) {
    const b = await this.store.read(scope.scopeKey);
    if (!b) return fail("no_current_session");
    if (id && target === undefined) {
      target = Object.keys(b.sessions).find(
        (label) => b.sessions[label].sessionId === id,
      );
      if (!target) fail("session_identity_mismatch");
    }
    const label = findLabel(b, target);
    if (id && b.sessions[label].sessionId !== id)
      fail("session_identity_mismatch");
    return {
      label,
      current: b.currentLabel === label,
      entry: b.sessions[label],
    };
  }
  async reserveNew(
    scope: ConversationScope,
    agentId: string,
    name?: string,
  ): Promise<SessionReservation> {
    let label = "";
    const owner = { ownerId: this.instance, ownerEpoch: 1 };
    let lease: ExecutionLease | undefined;
    try {
      const b = await this.store.update(scope.scopeKey, async (b) => {
        b.clientConversationId = scope.clientConversationId;
        b.projectRoot = scope.projectRoot;
        if (name !== undefined) assertName(b, name);
        let n = 0;
        do {
          label = nextLabel(n++);
        } while (Object.hasOwn(b.sessions, label));
        lease = await acquire(scope.scopeKey, label, this.store.dir);
        b.sessions[label] = {
          childPid: null,
          bridgePid: process.pid,
          updatedAt: Date.now(),
          owner,
          agentId,
          sessionCwd: scope.sessionCwd,
          acpSessionId: null,
          sessionId: null,
          status: "resuming",
          name: name ?? null,
          model: null,
          thoughtLevel: null,
          thoughtConfig: null,
          afterSequence: 0,
          lastPrompt: null,
        };
        return b;
      });
      return {
        key: scope.scopeKey,
        label,
        owner,
        entry: b.sessions[label],
        previous: null,
        lease: lease!,
      };
    } catch (error) {
      await lease?.close();
      throw error;
    }
  }
  async reserveLoad(
    scope: ConversationScope,
    agentId: string,
    target?: string,
    expectedAcpId?: string,
  ): Promise<SessionReservation> {
    let label = "";
    let previous: Entry | null = null;
    let lease: ExecutionLease | undefined;
    try {
      const b = await this.store.update(scope.scopeKey, async (b) => {
        b.clientConversationId = scope.clientConversationId;
        b.projectRoot = scope.projectRoot;
        label = findLabel(b, target);
        const e = b.sessions[label];
        if (
          e.agentId !== agentId ||
          (expectedAcpId !== undefined && expectedAcpId !== e.acpSessionId)
        )
          fail("session_identity_mismatch");
        if (e.status === "closed") fail("session_closed");
        lease = await acquire(scope.scopeKey, label, this.store.dir);
        if (!canRecover(e)) fail("session_occupied");
        if (!e.acpSessionId || !e.model || (e.thoughtLevel && !e.thoughtConfig))
          fail("unverified_bookmark");
        previous = structuredClone(e);
        e.owner = {
          ownerId: this.instance,
          ownerEpoch: e.owner.ownerEpoch + 1,
        };
        e.bridgePid = process.pid;
        e.updatedAt = Date.now();
        e.childPid = null;
        e.status = "resuming";
        return b;
      });
      const entry = b.sessions[label];
      return {
        key: scope.scopeKey,
        label,
        owner: entry.owner,
        entry,
        previous,
        lease: lease!,
      };
    } catch (error) {
      await lease?.close();
      throw error;
    }
  }
  launchOptions(r: SessionReservation | undefined, agent: AgentDefinition) {
    if (!r) return {};
    return {
      leaseFd: r.lease.childStdio,
      beforeInitialize: async (pid: number | undefined) => {
        if (!pid) fail("unverified_child");
        await this.store.update(r.key, (b) => {
          const e = owned(b, r);
          if (e.status !== "resuming") fail("stale_owner");
          e.childPid = pid;
          if (process.platform === "win32")
            e.directWindowsAgent =
              win32.basename(agent.command).toLowerCase() === "agy.exe" &&
              agent.args[0] === "acp";
          return b;
        });
      },
    };
  }
  async rename(
    scope: ConversationScope,
    target: string | undefined,
    name: string,
  ) {
    const b = await this.store.update(scope.scopeKey, (b) => {
      const label = findLabel(b, target);
      assertName(b, name, label);
      b.sessions[label].name = name;
      return b;
    });
    return { label: findLabel(b, name), name };
  }
  async closeOffline(scope: ConversationScope, target?: string) {
    let label = "";
    await this.store.update(scope.scopeKey, (b) => {
      label = findLabel(b, target);
      const e = b.sessions[label];
      if (e.status !== "offline" && e.status !== "closed")
        fail("session_occupied");
      e.status = "closed";
      if (b.currentLabel === label) b.currentLabel = null;
      return b;
    });
    return { closed: true, label };
  }
  async activated(
    r: SessionReservation,
    session: { id: string; agentId: string; cwd: string; acpSessionId: string },
    effective: Effective,
  ): Promise<TurnBinding> {
    await this.store.update(r.key, (b) => {
      const e = owned(b, r);
      if (
        e.status !== "resuming" ||
        e.agentId !== session.agentId ||
        e.sessionCwd !== session.cwd ||
        (e.acpSessionId && e.acpSessionId !== session.acpSessionId)
      )
        fail("session_identity_mismatch");
      if (!effective.model) fail("unverified_bookmark");
      e.status = "live";
      e.sessionId = session.id;
      e.acpSessionId = session.acpSessionId;
      e.model = effective.model;
      e.thoughtConfig = effective.thoughtConfig;
      e.thoughtLevel = effective.thoughtConfig?.value ?? null;
      e.afterSequence = 0;
      e.lastPrompt = recoverTurn(e.lastPrompt);
      b.currentLabel = r.label;
      return b;
    });
    return {
      scopeKey: r.key,
      label: r.label,
      owner: r.owner,
      sessionId: session.id,
    };
  }
  async rollback(r: SessionReservation) {
    try {
      await this.store.update(r.key, (b) => {
        const e = owned(b, r);
        if (e.status !== "resuming") fail("stale_reservation");
        if (r.previous) b.sessions[r.label] = { ...r.previous, owner: r.owner };
        else e.status = "closed";
        return b;
      });
    } finally {
      await r.lease.close();
    }
  }
  async detach(
    r: SessionReservation,
    id: string,
    explicit: boolean,
    lastTurn?: TurnBookmark,
  ) {
    try {
      await this.store.update(r.key, (b) => {
        const e = owned(b, r);
        e.updatedAt = Date.now();
        if (e.sessionId !== id || e.status !== "live") fail("stale_owner");
        e.status = explicit ? "closed" : "offline";
        // Retain the last handle for read-only tombstone lookup.
        e.lastPrompt =
          lastTurn && lastTurn.promptId === e.lastPrompt?.promptId
            ? lastTurn
            : recoverTurn(e.lastPrompt);
        if (explicit && b.currentLabel === r.label) b.currentLabel = null;
        return b;
      });
    } finally {
      await r.lease.close();
    }
  }
  async selectLive(scope: ConversationScope, label: string, id: string) {
    await this.store.update(scope.scopeKey, (b) => {
      const e = b.sessions[label];
      if (
        !e ||
        e.status !== "live" ||
        e.owner.ownerId !== this.instance ||
        e.sessionId !== id
      )
        fail("stale_owner");
      b.currentLabel = label;
      return b;
    });
  }
  isOwnedHere(entry: Entry) {
    return entry.owner.ownerId === this.instance;
  }
}
