import type { TurnBookmark } from "../bookmarks/turn.ts";
import type { AgentDefinition } from "../agents/config.ts";
import { isModelAllowed } from "../models/policy.ts";
import { discoverAdvertisedModels } from "../models/discovery.ts";
import { extractVerifiedRawThoughtConfig } from "../models/resume_verification.ts";
import type { SessionManager, SessionSnapshot } from "../sessions/manager.ts";
import type { ScopeBook, ScopeStore } from "../bookmarks/store.ts";
import type { ConversationScope } from "../bookmarks/scope.ts";

import {
  ScopedSessions,
  ScopeConflict,
  type SessionReservation,
} from "../bookmarks/scoped_sessions.ts";

type Entry = ScopeBook["sessions"][string];

function observedTurn(entry: Entry, snapshot?: SessionSnapshot) {
  const prompt = snapshot?.prompt;
  const terminal = prompt?.settledTurn;
  if (
    snapshot?.id === entry.sessionId &&
    prompt &&
    terminal &&
    prompt.id === entry.lastPrompt?.promptId &&
    terminal.owner.ownerId === entry.owner.ownerId &&
    terminal.owner.ownerEpoch === entry.owner.ownerEpoch
  ) {
    return {
      lastPrompt: { promptId: prompt.id, state: terminal.state },
      bookmarkPersistence:
        prompt.bookmarkPersistence?.saved === false
          ? prompt.bookmarkPersistence
          : undefined,
    };
  }
  return { lastPrompt: entry.lastPrompt };
}

export class ScopedBindings {
  readonly sessions: ScopedSessions;
  private readonly handles = new Map<
    string,
    {
      conversation: string;
      reservation: SessionReservation;
      explicitClose: boolean;
      saveError?: string;
    }
  >();
  constructor(store?: ScopeStore) {
    this.sessions = new ScopedSessions(store);
  }
  checkHandle(id: string, conversation?: string) {
    if (
      conversation !== undefined &&
      this.handles.get(id)?.conversation !== conversation
    )
      throw new ScopeConflict("session_identity_mismatch");
  }
  markExplicit(id: string) {
    const h = this.handles.get(id);
    if (h) h.explicitClose = true;
    return h;
  }
  localSnapshot(manager: SessionManager, entry: Entry) {
    if (entry.sessionId && this.sessions.isOwnedHere(entry)) {
      try {
        return manager.getSessionSnapshot(entry.sessionId);
      } catch {
        /* expired tombstone */
      }
    }
  }

  describe(manager: SessionManager, entry: Entry, snapshot?: SessionSnapshot) {
    const retiring = snapshot && manager.teardownTask(snapshot.id);
    let status: string = entry.status;
    if (retiring) status = "retiring";
    else if (!snapshot && status === "live") status = "owner_unverified";
    else if (snapshot && !snapshot.processExit) {
      status = snapshot.pendingPermissions.length
        ? "awaiting_approval"
        : snapshot.promptActive
          ? "running"
          : "idle";
    }
    return {
      name: entry.name,
      agentId: entry.agentId,
      acpSessionId: entry.acpSessionId,
      cwd: entry.sessionCwd,
      model: entry.model,
      thoughtConfig: entry.thoughtConfig,
      source: !snapshot
        ? "bookmark"
        : snapshot.processExit && !retiring
          ? "tombstone"
          : "live",
      status,
      ...observedTurn(entry, snapshot),
    };
  }

  async observe(
    manager: SessionManager,
    conversation: string,
    cwd: string,
    root?: string,
    target?: string,
    id?: string,
    settle = false,
  ) {
    const scope = await this.sessions.scope(conversation, cwd, root);
    const { label, entry, current } = await this.sessions.lookup(
      scope,
      target,
      id,
    );
    let snapshot = this.localSnapshot(manager, entry);
    if (settle && snapshot && !manager.teardownTask(snapshot.id))
      snapshot = await manager.settledSnapshot(snapshot.id);
    return {
      label,
      current,
      ...this.describe(manager, entry, snapshot),
      afterSequence: entry.afterSequence,
      snapshot,
    };
  }

  async reuse(
    manager: SessionManager,
    scope: ConversationScope,
    label: string,
    entry: Entry,
    current: boolean,
    definitionFor: () => Promise<AgentDefinition | undefined>,
  ) {
    const id = entry.sessionId;
    if (!id || entry.status !== "live" || !this.sessions.isOwnedHere(entry))
      return;
    // reserveLoad re-reads the same label under lock once the old owner releases it.
    const retiring = async () => {
      await manager.teardownTask(id);
      return undefined;
    };
    if (manager.teardownTask(id)) return retiring();
    if (!manager.hasSession(id)) return;
    const definition = await definitionFor();
    let live = manager.reusableSnapshot(id);
    if (!live) return retiring();
    this.checkHandle(id, scope.clientConversationId);
    if (
      this.handles.get(id)?.reservation.owner.ownerEpoch !==
      entry.owner.ownerEpoch
    )
      throw new ScopeConflict("stale_owner");
    if (
      live.acpSessionId !== entry.acpSessionId ||
      live.cwd !== entry.sessionCwd
    )
      throw new ScopeConflict("session_identity_mismatch");
    if (!definition) throw new ScopeConflict("unknown_bookmark_agent");
    this.assertSelection(live, definition, entry);
    if (!current) {
      try {
        await this.sessions.selectLive(scope, label, id);
      } catch (error) {
        if (
          error instanceof ScopeConflict &&
          error.code === "stale_owner" &&
          !manager.reusableSnapshot(id)
        )
          return retiring();
        throw error;
      }
      live = manager.reusableSnapshot(id);
      if (!live) return retiring();
      this.assertSelection(live, definition, entry);
    }
    return {
      sessionId: id,
      acpSessionId: live.acpSessionId,
      agentId: live.agentId,
      acpProtocol: live.acpProtocol,
      configOptions: live.configOptions,
      modes: live.modes,
      label,
      reused: true,
      promptActive: live.promptActive,
      promptId: live.prompt?.id,
      ...observedTurn(entry, live),
      name: entry.name,
    };
  }
  assertSelection(
    snap: SessionSnapshot,
    agent: AgentDefinition,
    expected: {
      model: string | null;
      thoughtConfig?: { configId: string; value: string } | null;
    },
  ) {
    const model = discoverAdvertisedModels(snap.configOptions, agent).find(
      (m) => m.selected,
    );
    const thought = expected.thoughtConfig;
    if (
      !model ||
      model.id !== expected.model ||
      !isModelAllowed(agent.models ?? {}, model.id) ||
      (thought &&
        extractVerifiedRawThoughtConfig(snap.configOptions, thought.configId)
          ?.value !== thought.value)
    )
      throw new ScopeConflict("session_configuration_mismatch");
  }
  async configurationChanged(
    manager: SessionManager,
    id: string,
    configId: string,
  ) {
    const h = this.handles.get(id);
    if (!h) return;
    const snap = manager.getSessionSnapshot(id);
    const model = discoverAdvertisedModels(snap.configOptions, {
      command: "",
      args: [],
      modelConfigId: snap.modelConfigId,
    }).find((m) => m.selected);
    if (!model || !isModelAllowed(snap.models ?? {}, model.id))
      throw new ScopeConflict("unverified_bookmark");
    const r = h.reservation;
    const saved = await this.sessions.store.update(r.key, (b) => {
      const e = b.sessions[r.label];
      if (
        !e ||
        e.owner.ownerId !== r.owner.ownerId ||
        e.owner.ownerEpoch !== r.owner.ownerEpoch ||
        e.sessionId !== id ||
        e.status !== "live"
      )
        throw new ScopeConflict("stale_owner");
      const thoughtId =
        e.thoughtConfig?.configId ??
        (configId === "thought_level" ||
        configId === snap.models?.thinkingEffort?.configOption
          ? configId
          : undefined);
      const thought =
        thoughtId &&
        extractVerifiedRawThoughtConfig(snap.configOptions, thoughtId);
      if (thoughtId && !thought)
        throw new ScopeConflict("unverified_thought_config");
      e.model = model.id;
      e.thoughtConfig = thought || null;
      e.thoughtLevel = e.thoughtConfig?.value ?? null;
      return b;
    });
    r.entry = saved.sessions[r.label];
    manager.recordModelSelection(id, { model: model.id });
  }
  async activate(
    manager: SessionManager,
    conversation: string,
    r: SessionReservation,
    session: SessionSnapshot,
    agent: AgentDefinition,
    thoughtId?: string,
  ) {
    const snap = manager.getSessionSnapshot(session.id);
    const model = discoverAdvertisedModels(snap.configOptions, agent).find(
      (o) => o.selected,
    );
    if (!model || !isModelAllowed(agent.models ?? {}, model.id))
      throw new ScopeConflict("unverified_bookmark");
    const thoughtConfig = thoughtId
      ? extractVerifiedRawThoughtConfig(snap.configOptions, thoughtId)
      : undefined;
    if (thoughtId && !thoughtConfig)
      throw new ScopeConflict("unverified_thought_config");
    const binding = await this.sessions.activated(r, snap, {
      model: model.id,
      thoughtConfig: thoughtConfig ?? null,
    });
    r.entry.model = model.id;
    r.entry.thoughtConfig = thoughtConfig ?? null;
    manager.recordModelSelection(snap.id, {
      ...snap.modelSelection,
      model: model.id,
    });
    const local: {
      conversation: string;
      reservation: SessionReservation;
      explicitClose: boolean;
      saveError?: string;
    } = { conversation, reservation: r, explicitClose: false };
    const retire = async (lastTurn?: TurnBookmark) => {
      try {
        await this.sessions.detach(
          r,
          session.id,
          local.explicitClose,
          lastTurn,
        );
      } catch {
        local.saveError = "bookmark_detach_failed";
      } finally {
        this.handles.delete(session.id);
      }
    };
    try {
      manager.bindSessionJournal(
        session.id,
        this.sessions.store,
        binding,
        retire,
        () =>
          this.assertSelection(
            manager.getSessionSnapshot(session.id),
            agent,
            r.entry,
          ),
      );
      this.handles.set(session.id, local);
    } catch (error) {
      await manager.close(session.id).catch(() => {});
      await retire();
      throw error;
    }
  }
}
