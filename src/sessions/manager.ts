import process from "node:process";
import { realpath } from "#fs";
import {
  canonicalAgentId,
  type AgentDefinition,
  type AgentMap,
} from "../agents/config.ts";
import type {
  AgentModelPolicy,
  ModelSize,
  ThinkingEffort,
} from "../models/policy.ts";
import { AcpDisconnectError } from "../acp/protocol.ts";
import { createProtocolDriver } from "../acp/driver_factory.ts";
import type {
  AcpPermissionRequest,
  AcpProtocol,
  NormalizedAcpUpdate,
  ProtocolDriver,
} from "../acp/protocol.ts";
import { startAgent, stopAgent } from "../runtime/process.ts";

interface ManagedSession {
  id: string;
  agentId: string;
  agentDefinition: AgentDefinition;
  cwd: string;
  acpSessionId: string;
  acpSessionKey: string;
  acpProtocol: AcpProtocol;
  driver: ProtocolDriver;
  process: Awaited<ReturnType<typeof startAgent>>;
  promptActive: boolean;
  capabilities: unknown;
  authMethods: unknown;
  configOptions: Array<Record<string, unknown>>;
  modes: Record<string, unknown> | undefined;
  prompt?: PromptRecord;
  events: SessionEvent[];
  eventSizes: number[];
  eventBytes: number;
  nextSequence: number;
  droppedThrough: number;
  permissionPolicy: PermissionPolicy;
  modelSelection?: {
    model: string;
    modelSize?: ModelSize;
    thinkingEffort?: ThinkingEffort;
  };
  pendingPermissions: Map<string, PendingPermission>;
  permissionLease?: ReturnType<typeof setTimeout>;
  processExit?: { code: number; signal: NodeJS.Signals | null };
  retired?: boolean;
}

interface SessionTombstone {
  snapshot: SessionSnapshot;
  events: SessionEvent[];
  droppedThrough: number;
  bytes: number;
}

export interface SessionEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  update: unknown;
  raw: unknown;
}

interface PromptRecord {
  id: string;
  state: "running" | "completed" | "cancelled" | "failed";
  text: string;
  messageText: Map<string, string>;
  messageOrder: string[];
  lastActivityAt: number;
  activityVersion: number;
  activityWaiters: Set<() => void>;
  stopReason?: string;
  error?: string;
  errorCode?: number;
  errorData?: unknown;
  connectionClosed?: boolean;
  done: Promise<void>;
}

export type PermissionPolicy =
  | "read_only"
  | "operator"
  | "allow_all"
  | "deny_all";

export interface SessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly implementation?: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly acpProtocol: AcpProtocol;
  readonly promptActive: boolean;
  readonly capabilities: unknown;
  readonly authMethods: unknown;
  readonly configOptions: Array<Record<string, unknown>>;
  readonly modes: Record<string, unknown> | undefined;
  readonly permissionPolicy: PermissionPolicy;
  readonly modelConfigId?: string;
  readonly models?: AgentModelPolicy;
  readonly modelSelection?: {
    readonly model: string;
    readonly modelSize?: ModelSize;
    readonly thinkingEffort?: ThinkingEffort;
  };
  readonly pendingPermissions: Array<{
    id: string;
    toolCall: unknown;
    options: Array<{ optionId: string; kind: string; name: string }>;
  }>;
  readonly failureClassifier?: string;
  readonly prompt?: {
    id: string;
    state: PromptRecord["state"];
    text: string;
    textTruncated?: boolean;
    stopReason?: string;
    error?: string;
    errorCode?: number;
    errorData?: unknown;
  };
  readonly nextSequence: number;
  readonly processExit?: { code: number; signal: NodeJS.Signals | null };
}

export interface PromptHandle {
  readonly id: string;
  readonly state: PromptRecord["state"];
  readonly text: string;
  readonly stopReason?: string;
  readonly error?: string;
  readonly errorCode?: number;
  readonly errorData?: unknown;
  readonly lastActivityAt: number;
  readonly activityVersion: number;
  readonly done: Promise<void>;
}

export interface SessionLaunchOptions {
  agentDefinition?: AgentDefinition;
}

type PendingPermissionSnapshot = SessionSnapshot["pendingPermissions"][number];

type ConfigOptionWaiter = {
  predicate: (options: Array<Record<string, unknown>>) => boolean;
  finish: (options: Array<Record<string, unknown>>) => void;
};

type EventWaiter = {
  afterSequence: number;
  includeThoughts: boolean;
  finish: () => void;
};

function configOptionsFromUpdate(
  event: NormalizedAcpUpdate,
): Array<Record<string, unknown>> | undefined {
  if (event.kind !== "config_option_update") return undefined;
  if (!event.update || typeof event.update !== "object") return undefined;
  const options = (event.update as { configOptions?: unknown }).configOptions;
  if (
    !Array.isArray(options) ||
    !options.every((option) => option !== null && typeof option === "object")
  )
    return undefined;
  return options as Array<Record<string, unknown>>;
}

export const DEFAULT_SESSION_START_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_MANAGED_SESSIONS = 20;
export const DEFAULT_MAX_SESSION_TOMBSTONES = 100;
export const DEFAULT_MAX_SESSION_TOMBSTONE_BYTES = 16 * 1024 * 1024;
const MAX_TOMBSTONE_PROMPT_TEXT_CHARS = 64 * 1024;

interface PendingPermission {
  id: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
  resolve: (value: {
    outcome:
      | { outcome: "selected"; optionId: string }
      | {
          outcome: "cancelled";
        };
  }) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly tombstones = new Map<string, SessionTombstone>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly acpSessionOwners = new Map<
    string,
    ManagedSession | symbol
  >();
  private readonly configOptionWaiters = new Map<
    string,
    Set<ConfigOptionWaiter>
  >();
  private readonly eventWaiters = new Map<string, Set<EventWaiter>>();
  private agents: AgentMap;
  private readonly startupTimeoutMs: number;
  private readonly closeRequestTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly maxTombstones: number;
  private readonly maxTombstoneBytes: number;
  private tombstoneBytes = 0;
  private occupiedSlots = 0;

  constructor(
    agents: AgentMap,
    startupTimeoutMs = DEFAULT_SESSION_START_TIMEOUT_MS,
    closeRequestTimeoutMs = DEFAULT_SESSION_CLOSE_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_MANAGED_SESSIONS,
    maxTombstones = DEFAULT_MAX_SESSION_TOMBSTONES,
    maxTombstoneBytes = DEFAULT_MAX_SESSION_TOMBSTONE_BYTES,
  ) {
    this.agents = agents;
    this.startupTimeoutMs = startupTimeoutMs;
    this.closeRequestTimeoutMs = closeRequestTimeoutMs;
    this.maxSessions = maxSessions;
    this.maxTombstones = Math.max(0, Math.floor(maxTombstones));
    this.maxTombstoneBytes = Math.max(0, Math.floor(maxTombstoneBytes));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  listSessionSnapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) =>
      this.sessionSnapshot(session),
    );
  }

  getSessionSnapshot(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (session) return this.sessionSnapshot(session);
    const tombstone = this.tombstones.get(id);
    if (!tombstone) throw new Error(`Unknown session: ${id}`);
    return structuredClone(tombstone.snapshot);
  }

  recordModelSelection(
    sessionId: string,
    selection:
      | {
          model: string;
          modelSize?: ModelSize;
          thinkingEffort?: ThinkingEffort;
        }
      | undefined,
  ): void {
    const session = this.requireSession(sessionId);
    session.modelSelection = selection ? { ...selection } : undefined;
  }

  getPromptHandle(sessionId: string, promptId: string): PromptHandle {
    return this.promptHandle(this.requirePrompt(sessionId, promptId));
  }

  private sessionSnapshot(session: ManagedSession): SessionSnapshot {
    return {
      id: session.id,
      agentId: session.agentId,
      implementation: session.agentDefinition.implementation,
      cwd: session.cwd,
      acpSessionId: session.acpSessionId,
      acpProtocol: session.acpProtocol,
      promptActive: session.promptActive,
      capabilities: structuredClone(session.capabilities),
      authMethods: structuredClone(session.authMethods),
      configOptions: structuredClone(session.configOptions),
      modes: structuredClone(session.modes),
      permissionPolicy: session.permissionPolicy,
      failureClassifier: session.agentDefinition.failureClassifier,
      modelConfigId: session.agentDefinition.modelConfigId,
      models: session.agentDefinition.models
        ? structuredClone(session.agentDefinition.models)
        : undefined,
      modelSelection: session.modelSelection
        ? { ...session.modelSelection }
        : undefined,
      pendingPermissions: [...session.pendingPermissions.values()].map(
        (pending) => ({
          id: pending.id,
          toolCall: structuredClone(pending.toolCall),
          options: structuredClone(pending.options),
        }),
      ),
      prompt: session.prompt
        ? {
            id: session.prompt.id,
            state: session.prompt.state,
            text: session.prompt.text,
            stopReason: session.prompt.stopReason,
            error: session.prompt.error,
            errorCode: session.prompt.errorCode,
            errorData: structuredClone(session.prompt.errorData),
          }
        : undefined,
      nextSequence: session.nextSequence,
      processExit: session.processExit ? { ...session.processExit } : undefined,
    };
  }

  private promptHandle(prompt: PromptRecord): PromptHandle {
    return {
      get id() {
        return prompt.id;
      },
      get state() {
        return prompt.state;
      },
      get text() {
        return prompt.text;
      },
      get stopReason() {
        return prompt.stopReason;
      },
      get error() {
        return prompt.error;
      },
      get errorCode() {
        return prompt.errorCode;
      },
      get errorData() {
        return structuredClone(prompt.errorData);
      },
      get lastActivityAt() {
        return prompt.lastActivityAt;
      },
      get activityVersion() {
        return prompt.activityVersion;
      },
      done: prompt.done,
    };
  }

  private acpSessionKey(
    agentId: string,
    cwd: string,
    acpSessionId: string,
  ): string {
    return JSON.stringify([agentId, cwd, acpSessionId]);
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) {
      if (this.tombstones.has(id))
        throw new Error(`Session process has exited: ${id}`);
      throw new Error(`Unknown session: ${id}`);
    }
    if (this.closingSessions.has(id))
      throw new Error(`Session is closing: ${id}`);
    return session;
  }

  private requirePrompt(sessionId: string, promptId: string): PromptRecord {
    const prompt = this.requireSession(sessionId).prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    return prompt;
  }

  private clearPermissionLease(session: ManagedSession): void {
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
  }

  private cancelPendingPermissions(session: ManagedSession): void {
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
  }

  start(
    agentId: string,
    cwd = process.cwd(),
    config: Record<string, string> = {},
    modeId?: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.launch(
      agentId,
      cwd,
      config,
      modeId,
      permissionPolicy,
      undefined,
      options,
    ).then((session) => this.sessionSnapshot(session));
  }

  load(
    agentId: string,
    acpSessionId: string,
    cwd: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.launch(
      agentId,
      cwd,
      {},
      undefined,
      permissionPolicy,
      acpSessionId,
      options,
    ).then((session) => this.sessionSnapshot(session));
  }

  private async launch(
    agentId: string,
    cwd: string,
    config: Record<string, string>,
    modeId: string | undefined,
    permissionPolicy: PermissionPolicy,
    loadSessionId?: string,
    options: SessionLaunchOptions = {},
  ): Promise<ManagedSession> {
    if (this.occupiedSlots >= this.maxSessions) {
      throw new Error(`Active session limit (${this.maxSessions}) reached`);
    }
    this.occupiedSlots++;
    const launchOwner = Symbol("ACP session launch");
    let loadKey: string | undefined;
    try {
      const canonicalCwd = await realpath(cwd);
      const canonicalId = canonicalAgentId(agentId);
      if (loadSessionId) {
        loadKey = this.acpSessionKey(canonicalId, canonicalCwd, loadSessionId);
        const owner = this.acpSessionOwners.get(loadKey);
        if (owner !== undefined) {
          if (typeof owner !== "symbol" && !this.sessions.has(owner.id)) {
            throw new Error(
              `ACP session is closing: ${loadSessionId}; retry shortly`,
            );
          }
          throw new Error(`ACP session ID already managed: ${loadSessionId}`);
        }
        this.acpSessionOwners.set(loadKey, launchOwner);
      }
      return await this.launchReserved(
        agentId,
        canonicalCwd,
        config,
        modeId,
        permissionPolicy,
        loadSessionId,
        options,
        launchOwner,
        loadKey,
      );
    } catch (error) {
      this.occupiedSlots--;
      if (loadKey && this.acpSessionOwners.get(loadKey) === launchOwner) {
        this.acpSessionOwners.delete(loadKey);
      }
      throw error;
    }
  }

  private async launchReserved(
    agentId: string,
    cwd: string,
    config: Record<string, string>,
    modeId: string | undefined,
    permissionPolicy: PermissionPolicy,
    loadSessionId: string | undefined,
    options: SessionLaunchOptions,
    launchOwner: symbol,
    loadKey: string | undefined,
  ): Promise<ManagedSession> {
    const canonicalId = canonicalAgentId(agentId);
    const def =
      options.agentDefinition ??
      this.agents[canonicalId] ??
      this.agents[agentId];
    if (!def) throw new Error(`Unknown agent: ${canonicalId}`);
    const protocol = def.acpProtocol ?? "v1";
    if (def.supportedProtocols && !def.supportedProtocols.includes(protocol)) {
      throw new Error(
        `Agent profile '${canonicalId}' does not confirm ACP ${protocol} support`,
      );
    }
    const launchDefinition = {
      ...def,
      env: { ...def.protocolEnv?.[protocol], ...def.env },
    };
    const process = await startAgent(launchDefinition, cwd);
    const earlyUpdates: NormalizedAcpUpdate[] = [];
    let reservedAcpKey = loadKey;
    let managedSession: ManagedSession | undefined;
    let launchFailed = false;
    const reserveAcpId = (acpSessionId: string) => {
      const key = this.acpSessionKey(canonicalId, cwd, acpSessionId);
      if (this.acpSessionOwners.has(key)) {
        throw new Error(`ACP session ID already managed: ${acpSessionId}`);
      }
      reservedAcpKey = key;
      this.acpSessionOwners.set(key, launchOwner);
      return key;
    };
    let wakeStartupUpdate: (() => void) | undefined;
    const driver = createProtocolDriver(protocol, def, process, {
      update: (update) => {
        if (managedSession) {
          if (
            managedSession.acpSessionId === update.sessionId &&
            this.sessions.get(managedSession.id) === managedSession
          ) {
            this.receiveUpdate(managedSession, update);
          }
          return;
        }
        earlyUpdates.push(update);
        wakeStartupUpdate?.();
      },
      permission: (request) => {
        if (
          !managedSession ||
          managedSession.acpSessionId !== request.sessionId
        ) {
          return Promise.resolve({
            outcome: { outcome: "cancelled" as const },
          });
        }
        return this.requestPermission(managedSession, request);
      },
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startup = async () => {
        const initialized = await driver.initialize();
        if (launchFailed) {
          throw new Error("ACP session startup already failed");
        }
        const sessionResponse = loadSessionId
          ? await driver.resumeSession(loadSessionId, cwd)
          : await driver.newSession(cwd);
        const acpId = sessionResponse.sessionId;
        if (launchFailed) {
          throw new Error("ACP session startup already failed");
        }
        const acpKey = this.acpSessionKey(canonicalId, cwd, acpId);
        if (reservedAcpKey === undefined) {
          reserveAcpId(acpId);
        } else if (reservedAcpKey !== acpKey) {
          throw new Error(`ACP resumed session ID mismatch: ${acpId}`);
        }
        let configOptions = [...sessionResponse.configOptions];
        let configOptionsEarlyUpdateCursor = 0;
        let appliedEarlyUpdates = 0;
        const applyEarlyConfigUpdates = () => {
          for (
            ;
            appliedEarlyUpdates < earlyUpdates.length;
            appliedEarlyUpdates++
          ) {
            const update = earlyUpdates[appliedEarlyUpdates];
            const options = configOptionsFromUpdate(update);
            if (options) configOptions = options;
          }
        };
        let modes = sessionResponse.modes;
        const modelConfigIds = new Set(
          configOptions.flatMap((option) => {
            const id = typeof option.id === "string" ? option.id : undefined;
            if (
              id &&
              (option.category === "model" ||
                ((option.category === undefined || option.category === null) &&
                  id === def.modelConfigId))
            )
              return [id];
            return [];
          }),
        );
        const desired = Object.entries(config).sort(
          ([a], [b]) =>
            Number(modelConfigIds.has(b)) - Number(modelConfigIds.has(a)),
        );
        for (const [configId, value] of desired) {
          applyEarlyConfigUpdates();
          let option = configOptions.find((item) => item.id === configId);
          while (!option && configOptions.length) {
            const received = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(false);
              }, DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS);
              const wake = () => {
                clearTimeout(timer);
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(true);
              };
              wakeStartupUpdate = wake;
            });
            if (!received) break;
            applyEarlyConfigUpdates();
            option = configOptions.find((item) => item.id === configId);
          }
          if (!option && configOptions.length) {
            throw new Error(`Unknown config option: ${configId}`);
          }
          if (option?.type === "select" && Array.isArray(option.options)) {
            const values = (
              option.options as Array<Record<string, unknown>>
            ).flatMap((entry) =>
              Array.isArray(entry.options)
                ? (entry.options as Array<Record<string, unknown>>)
                : [entry],
            );
            if (
              values.length &&
              !values.some((entry) => entry.value === value)
            ) {
              throw new Error(
                `Invalid value '${value}' for config option '${configId}'`,
              );
            }
          }
          configOptions = await driver.setConfigOption(
            acpId,
            configId,
            value,
            option,
          );
          configOptionsEarlyUpdateCursor = earlyUpdates.length;
        }
        if (modeId) {
          modes =
            (await driver.setMode(acpId, modeId, configOptions, modes)) ??
            modes;
        }
        return {
          initialized,
          sessionResponse,
          configOptions,
          modes,
          configOptionsEarlyUpdateCursor,
        };
      };
      const timedOut = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => {
          const error = new Error(
            `ACP session startup timed out after ${this.startupTimeoutMs}ms`,
          );
          driver.closeConnection(error);
          reject(error);
        }, this.startupTimeoutMs);
      });
      const {
        initialized,
        sessionResponse,
        configOptions,
        modes,
        configOptionsEarlyUpdateCursor,
      } = await Promise.race([startup(), timedOut]);
      const acpId = sessionResponse.sessionId;
      const acpKey = this.acpSessionKey(canonicalId, cwd, acpId);
      if (
        reservedAcpKey !== acpKey ||
        this.acpSessionOwners.get(acpKey) !== launchOwner
      ) {
        throw new Error(`ACP session ownership was lost: ${acpId}`);
      }
      const session: ManagedSession = {
        id: crypto.randomUUID(),
        agentId: canonicalId,
        agentDefinition: def,
        cwd,
        acpSessionId: acpId,
        acpSessionKey: acpKey,
        acpProtocol: driver.protocol,
        driver,
        process,
        promptActive: false,
        capabilities: initialized.capabilities,
        authMethods: initialized.authMethods,
        configOptions,
        modes,
        events: [],
        eventSizes: [],
        eventBytes: 2,
        nextSequence: 1,
        droppedThrough: 0,
        permissionPolicy,
        pendingPermissions: new Map(),
      };
      this.acpSessionOwners.set(acpKey, session);
      managedSession = session;
      this.sessions.set(session.id, session);
      void process.child.status.then(
        ({ code, signal }) => this.handleProcessExit(session, code, signal),
        () => this.handleProcessExit(session, -1, null),
      );
      for (const [index, update] of earlyUpdates.entries()) {
        if (update.sessionId === acpId) {
          this.receiveUpdate(
            session,
            update,
            index >= configOptionsEarlyUpdateCursor,
          );
        }
      }
      return session;
    } catch (error) {
      launchFailed = true;
      driver.closeConnection(error);
      try {
        await stopAgent(process.child, 1000);
      } finally {
        if (
          reservedAcpKey !== undefined &&
          this.acpSessionOwners.get(reservedAcpKey) === launchOwner
        ) {
          this.acpSessionOwners.delete(reservedAcpKey);
        }
      }
      throw new Error(
        `Could not start ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
    }
  }

  beginPrompt(sessionId: string, text: string): PromptHandle {
    const session = this.requireSession(sessionId);
    if (session.promptActive) {
      throw new Error("A prompt is already active for this session");
    }
    session.promptActive = true;
    const record: PromptRecord = {
      id: crypto.randomUUID(),
      state: "running",
      text: "",
      messageText: new Map(),
      messageOrder: [],
      lastActivityAt: performance.now(),
      activityVersion: 0,
      activityWaiters: new Set(),
      done: Promise.resolve(),
    };
    session.prompt = record;
    record.done = this.consumePrompt(session, record, text);
    return this.promptHandle(record);
  }

  waitForPromptActivity(
    sessionId: string,
    promptId: string,
    activityVersion: number,
  ): { promise: Promise<void>; cancel: () => void } {
    const prompt = this.requirePrompt(sessionId, promptId);
    if (
      prompt.state !== "running" ||
      prompt.activityVersion !== activityVersion
    ) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const waiter = () => {
      prompt.activityWaiters.delete(waiter);
      resolve();
    };
    prompt.activityWaiters.add(waiter);
    return {
      promise,
      cancel: () => prompt.activityWaiters.delete(waiter),
    };
  }

  waitForPromptCompletion(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const prompt = this.requirePrompt(sessionId, promptId);
    return prompt.done.then(() => this.promptHandle(prompt));
  }

  private wakePromptActivityWaiters(session: ManagedSession): void {
    const prompt = session.prompt;
    if (!prompt) return;
    for (const waiter of [...prompt.activityWaiters]) waiter();
  }

  private recordPromptActivity(session: ManagedSession): void {
    const prompt = session.prompt;
    if (!prompt || prompt.state !== "running") return;
    prompt.lastActivityAt = performance.now();
    prompt.activityVersion++;
    this.wakePromptActivityWaiters(session);
  }

  private async consumePrompt(
    session: ManagedSession,
    record: PromptRecord,
    text: string,
  ): Promise<void> {
    try {
      const stopReason = await session.driver.prompt(
        session.acpSessionId,
        text,
      );
      if (record.state === "running") {
        record.stopReason = stopReason;
        record.state = stopReason === "cancelled" ? "cancelled" : "completed";
      } else if (record.state === "cancelled" && stopReason === "cancelled") {
        record.stopReason = stopReason;
      }
    } catch (error) {
      if (error instanceof AcpDisconnectError) {
        record.connectionClosed = true;
        const exit = await this.waitForProcessExitAfterDisconnect(session);
        if (exit) this.handleProcessExit(session, exit.code, exit.signal);
      }
      if (record.state === "running") {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
        )
          record.errorCode = error.code;
        if (error && typeof error === "object" && "data" in error) {
          record.errorData = error.data;
        }
      }
    } finally {
      session.promptActive = false;
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
      this.wakePromptActivityWaiters(session);
      this.notifyEventWaiters(session.id);
    }
  }

  async waitPrompt(
    sessionId: string,
    promptId: string,
    waitMs: number,
    stopOnPermission = false,
    signal?: AbortSignal,
  ): Promise<PromptHandle> {
    const session = this.requireSession(sessionId);
    const prompt = this.requirePrompt(sessionId, promptId);
    const deadline = Number.isFinite(waitMs)
      ? performance.now() + Math.max(0, waitMs)
      : Number.POSITIVE_INFINITY;
    while (prompt.state === "running" && !signal?.aborted) {
      if (stopOnPermission && session.pendingPermissions.size) break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let activity:
        | ReturnType<SessionManager["waitForPromptActivity"]>
        | undefined;
      try {
        const outcomes: Array<Promise<"timeout" | "activity" | "aborted">> = [];
        if (Number.isFinite(remaining)) {
          outcomes.push(
            new Promise((resolve) => {
              timer = setTimeout(() => resolve("timeout"), remaining);
            }),
          );
        }
        activity = this.waitForPromptActivity(
          sessionId,
          promptId,
          prompt.activityVersion,
        );
        outcomes.push(activity.promise.then(() => "activity"));
        if (signal) {
          outcomes.push(
            new Promise((resolve) => {
              abort = () => resolve("aborted");
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) resolve("aborted");
            }),
          );
        }
        const outcome = await Promise.race(outcomes);
        if (outcome !== "activity") break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && abort) signal.removeEventListener("abort", abort);
        activity?.cancel();
      }
    }
    return this.promptHandle(prompt);
  }

  async cancelPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const session = this.requireSession(sessionId);
    const prompt = this.requirePrompt(sessionId, promptId);
    if (prompt.state === "running") {
      prompt.state = "cancelled";
      for (const waiter of [...prompt.activityWaiters]) waiter();
      this.notifyEventWaiters(sessionId);
      this.cancelPendingPermissions(session);
      this.clearPermissionLease(session);
      await session.driver.cancel(session.acpSessionId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          prompt.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.promptHandle(prompt);
  }

  private hasVisibleEventAfter(
    session: ManagedSession,
    afterSequence: number,
    includeThoughts: boolean,
  ): boolean {
    return (
      session.droppedThrough > afterSequence ||
      session.events.some(
        (event) =>
          event.sequence > afterSequence &&
          (includeThoughts || !event.kind.toLowerCase().includes("thought")),
      )
    );
  }

  waitForVisibleEvent(
    sessionId: string,
    afterSequence: number,
    waitMs: number,
    includeThoughts = false,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (
      waitMs <= 0 ||
      (session.prompt !== undefined && session.prompt.state !== "running") ||
      session.pendingPermissions.size > 0 ||
      this.hasVisibleEventAfter(session, afterSequence, includeThoughts)
    )
      return Promise.resolve();

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiters = this.eventWaiters.get(sessionId);
      if (!waiters) {
        waiters = new Set();
        this.eventWaiters.set(sessionId, waiters);
      }
      const waiter: EventWaiter = {
        afterSequence,
        includeThoughts,
        finish: () => {
          if (!waiters!.delete(waiter)) return;
          if (timer !== undefined) clearTimeout(timer);
          if (waiters!.size === 0) this.eventWaiters.delete(sessionId);
          resolve();
        },
      };
      waiters.add(waiter);
      timer = setTimeout(waiter.finish, waitMs);
    });
  }

  notifyEventWaiters(sessionId: string): void {
    for (const waiter of [...(this.eventWaiters.get(sessionId) ?? [])])
      waiter.finish();
  }

  private notifyVisibleEventWaiters(session: ManagedSession): void {
    const event = session.events.at(-1);
    for (const waiter of [...(this.eventWaiters.get(session.id) ?? [])]) {
      const visible =
        session.droppedThrough > waiter.afterSequence ||
        (event !== undefined &&
          event.sequence > waiter.afterSequence &&
          (waiter.includeThoughts ||
            !event.kind.toLowerCase().includes("thought")));
      if (visible) waiter.finish();
    }
  }

  getEvents(sessionId: string, afterSequence = 0, limit = 100) {
    const session = this.sessions.get(sessionId);
    const tombstone = this.tombstones.get(sessionId);
    if (!session && !tombstone)
      throw new Error(`Unknown session: ${sessionId}`);
    const allEvents = session?.events ?? tombstone!.events;
    const droppedThrough = session?.droppedThrough ?? tombstone!.droppedThrough;
    const events = allEvents
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.max(1, Math.min(limit, 500)));
    const prompt = session?.prompt
      ? {
          id: session.prompt.id,
          state: session.prompt.state,
          text: session.prompt.text,
          stopReason: session.prompt.stopReason,
        }
      : tombstone?.snapshot.prompt
        ? {
            id: tombstone.snapshot.prompt.id,
            state: tombstone.snapshot.prompt.state,
            text: tombstone.snapshot.prompt.text,
            textTruncated: tombstone.snapshot.prompt.textTruncated,
            stopReason: tombstone.snapshot.prompt.stopReason,
          }
        : undefined;
    return {
      events: events.map((event) => structuredClone(event)),
      nextSequence:
        events.at(-1)?.sequence ?? Math.max(afterSequence, droppedThrough),
      gap: afterSequence < droppedThrough,
      prompt,
    };
  }

  private appendEvent(
    session: ManagedSession,
    kind: string,
    update: unknown,
    raw: unknown,
  ): void {
    const event: SessionEvent = {
      sequence: session.nextSequence++,
      timestamp: new Date().toISOString(),
      kind,
      update,
      raw,
    };
    const eventSize = Buffer.byteLength(JSON.stringify(event));
    session.events.push(event);
    session.eventSizes.push(eventSize);
    session.eventBytes += eventSize + (session.events.length > 1 ? 1 : 0);
    while (
      session.events.length > 1000 ||
      session.eventBytes > 4 * 1024 * 1024
    ) {
      const removed = session.events.shift();
      const removedSize = session.eventSizes.shift();
      if (removed && removedSize !== undefined) {
        session.eventBytes -= removedSize + (session.events.length > 0 ? 1 : 0);
        session.droppedThrough = removed.sequence;
      }
    }
    this.notifyVisibleEventWaiters(session);
  }

  private receiveUpdate(
    session: ManagedSession,
    updateEvent: NormalizedAcpUpdate,
    applyConfigOptions = true,
  ) {
    this.recordPromptActivity(session);
    const configOptions = configOptionsFromUpdate(updateEvent);
    if (configOptions && applyConfigOptions) {
      session.configOptions = configOptions;
      this.notifyConfigOptionWaiters(session);
    }
    this.appendEvent(
      session,
      updateEvent.kind,
      updateEvent.update,
      updateEvent.raw,
    );
    if (session.prompt?.state === "running" && updateEvent.text) {
      const prompt = session.prompt;
      const messageId = updateEvent.text.messageId;
      if (!messageId) {
        prompt.text += updateEvent.text.text;
      } else {
        if (!prompt.messageText.has(messageId)) {
          prompt.messageOrder.push(messageId);
        }
        const previous = prompt.messageText.get(messageId) ?? "";
        prompt.messageText.set(
          messageId,
          updateEvent.text.replace
            ? updateEvent.text.text
            : previous + updateEvent.text.text,
        );
        prompt.text = prompt.messageOrder
          .map((id) => prompt.messageText.get(id) ?? "")
          .join("");
      }
    }
    if (updateEvent.stopReason && session.prompt?.state === "running") {
      session.prompt.stopReason = updateEvent.stopReason;
      if (updateEvent.stopReason === "cancelled") {
        session.prompt.state = "cancelled";
      } else if (updateEvent.error) {
        session.prompt.state = "failed";
        session.prompt.error =
          updateEvent.error?.message ?? "ACP prompt failed";
        session.prompt.errorCode = updateEvent.error?.code;
        session.prompt.errorData = updateEvent.error?.data;
      } else {
        session.prompt.state = "completed";
      }
      session.promptActive = false;
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
      this.wakePromptActivityWaiters(session);
    }
  }

  waitForConfigOptions(
    sessionId: string,
    predicate: (options: Array<Record<string, unknown>>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const session = this.requireSession(sessionId);
    if (predicate(structuredClone(session.configOptions)) || timeoutMs <= 0) {
      return Promise.resolve(structuredClone(session.configOptions));
    }
    return new Promise((resolve) => {
      const waiters = this.configOptionWaiters.get(sessionId) ?? new Set();
      this.configOptionWaiters.set(sessionId, waiters);
      let abort: (() => void) | undefined;
      const waiter: ConfigOptionWaiter = {
        predicate,
        finish: (options) => {
          clearTimeout(timer);
          if (signal && abort) signal.removeEventListener("abort", abort);
          waiters.delete(waiter);
          if (waiters.size === 0) this.configOptionWaiters.delete(sessionId);
          resolve(structuredClone(options));
        },
      };
      const timer = setTimeout(
        () => waiter.finish(session.configOptions),
        timeoutMs,
      );
      if (signal) {
        abort = () => waiter.finish(session.configOptions);
        signal.addEventListener("abort", abort, { once: true });
      }
      if (signal?.aborted) {
        waiter.finish(session.configOptions);
      } else {
        waiters.add(waiter);
      }
    });
  }

  private notifyConfigOptionWaiters(session: ManagedSession): void {
    const waiters = this.configOptionWaiters.get(session.id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(structuredClone(session.configOptions))) {
        waiter.finish(session.configOptions);
      }
    }
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason?: string; text: string; promptId?: string }> {
    const prompt = this.beginPrompt(sessionId, text);
    await prompt.done;
    if (prompt.state === "failed") {
      throw new Error(prompt.error ?? "Prompt failed");
    }
    return { stopReason: prompt.stopReason, text: prompt.text };
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.requireSession(sessionId);
    const option = session.configOptions.find((item) => item.id === configId);
    if (!option && session.configOptions.length) {
      throw new Error(`Unknown config option: ${configId}`);
    }
    if (option?.type === "select" && Array.isArray(option.options)) {
      const values = (option.options as Array<Record<string, unknown>>).flatMap(
        (entry) =>
          Array.isArray(entry.options)
            ? (entry.options as Array<Record<string, unknown>>)
            : [entry],
      );
      if (values.length && !values.some((entry) => entry.value === value)) {
        throw new Error(
          `Invalid value '${value}' for config option '${configId}'`,
        );
      }
    }
    session.configOptions = await session.driver.setConfigOption(
      session.acpSessionId,
      configId,
      value,
      option,
    );
    if (
      option?.category === "model" ||
      configId === session.agentDefinition.modelConfigId ||
      configId === session.agentDefinition.models?.thinkingEffort?.configOption
    )
      session.modelSelection = undefined;
    return structuredClone(session.configOptions);
  }

  async setMode(sessionId: string, modeId: string) {
    const session = this.requireSession(sessionId);
    session.modes = await session.driver.setMode(
      session.acpSessionId,
      modeId,
      session.configOptions,
      session.modes,
    );
    return structuredClone(session.modes);
  }

  private async requestPermission(
    session: ManagedSession,
    params: AcpPermissionRequest,
  ) {
    const options = params.options ?? [];
    const choose = (kind: string) =>
      options.find((option) => option.kind === kind);
    if (
      session.acpSessionId !== params.sessionId ||
      this.sessions.get(session.id) !== session
    ) {
      return { outcome: { outcome: "cancelled" as const } };
    }
    const policy = session.permissionPolicy;
    this.recordPromptActivity(session);
    const requestId = crypto.randomUUID();
    const raw = {
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options,
    };
    this.appendEvent(session, "permission_request", { requestId, ...raw }, raw);
    if (policy === "operator") {
      return await new Promise<{
        outcome:
          | { outcome: "selected"; optionId: string }
          | {
              outcome: "cancelled";
            };
      }>((resolve) => {
        session.pendingPermissions.set(requestId, {
          id: requestId,
          toolCall: params.toolCall,
          options,
          resolve,
        });
        this.recordPromptActivity(session);
        this.notifyEventWaiters(session.id);
      });
    }
    const kind = (params.toolCall as { kind?: string | null } | undefined)
      ?.kind;
    const permit =
      policy === "allow_all" ||
      (policy === "read_only" &&
        ["read", "search", "fetch", "think"].includes(kind ?? ""));
    const option = permit
      ? (choose("allow_once") ?? choose("allow_always"))
      : (choose("reject_once") ?? choose("reject_always"));
    return {
      outcome: option
        ? { outcome: "selected" as const, optionId: option.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  beginPermissionContinuation(
    sessionId: string,
    leaseTimeoutMs: number,
  ): PendingPermissionSnapshot | undefined {
    const session = this.requireSession(sessionId);
    if (session.prompt?.state !== "running") return undefined;
    const pending = session.pendingPermissions.values().next().value as
      | PendingPermission
      | undefined;
    if (!pending) return undefined;

    this.clearPermissionLease(session);
    session.permissionLease = setTimeout(() => {
      session.permissionLease = undefined;
      const current = this.sessions.get(sessionId);
      if (
        current !== session ||
        current.prompt?.state !== "running" ||
        !current.pendingPermissions.has(pending.id)
      )
        return;
      void this.close(sessionId).catch(() => undefined);
    }, leaseTimeoutMs);

    return {
      id: pending.id,
      toolCall: structuredClone(pending.toolCall),
      options: structuredClone(pending.options),
    };
  }

  resolvePermission(sessionId: string, permissionId: string, optionId: string) {
    const session = this.requireSession(sessionId);
    const pending = session.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown permission request: ${permissionId}`);
    }
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`Invalid permission option: ${optionId}`);
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(permissionId);
    this.clearPermissionLease(session);
    return { permissionId, optionId, resolved: true };
  }

  private async waitForProcessExitAfterDisconnect(
    session: ManagedSession,
  ): Promise<{ code: number; signal: NodeJS.Signals | null } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.process.child.status.then(
          ({ code, signal }) => ({ code, signal }),
          () => ({ code: -1, signal: null }),
        ),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 500);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private handleProcessExit(
    session: ManagedSession,
    code: number,
    signal: NodeJS.Signals | null,
  ): void {
    if (session.processExit) return;
    const exit = {
      code: Number.isSafeInteger(code) ? code : -1,
      signal: typeof signal === "string" ? signal : null,
    };
    session.processExit = exit;
    this.appendEvent(session, "process_exited", exit, exit);

    const prompt = session.prompt;
    const interrupted =
      prompt?.state === "running" ||
      (prompt?.state === "failed" && prompt.connectionClosed === true);
    if (prompt && interrupted) {
      prompt.state = "failed";
      prompt.stopReason = "process_exited";
      prompt.error = "The ACP agent process exited unexpectedly.";
      prompt.errorCode = undefined;
      prompt.errorData = undefined;
      session.promptActive = false;
      this.wakePromptActivityWaiters(session);
    }
    this.clearPermissionLease(session);
    this.cancelPendingPermissions(session);
    try {
      session.driver.closeConnection(new Error("ACP agent process exited"));
    } catch {
      /* The process exit remains authoritative. */
    }
    if (this.closingSessions.has(session.id)) {
      this.notifyEventWaiters(session.id);
    } else {
      this.retireSession(session);
    }
  }

  private createTombstone(
    session: ManagedSession,
  ): SessionTombstone | undefined {
    if (!this.maxTombstones || !this.maxTombstoneBytes) return undefined;
    const last = session.prompt;
    const snapshot: SessionSnapshot = {
      id: session.id,
      agentId: session.agentId,
      cwd: session.cwd,
      acpSessionId: session.acpSessionId,
      acpProtocol: session.acpProtocol,
      processExit: session.processExit,
      permissionPolicy: session.permissionPolicy,
      capabilities: {},
      authMethods: [],
      configOptions: [],
      modes: undefined,
      promptActive: false,
      pendingPermissions: [],
      nextSequence: session.nextSequence,
      prompt: last && {
        id: last.id,
        state: last.state,
        stopReason: last.stopReason,
        text: last.text.slice(0, MAX_TOMBSTONE_PROMPT_TEXT_CHARS),
        errorCode: last.errorCode,
        ...(last.text.length > MAX_TOMBSTONE_PROMPT_TEXT_CHARS
          ? { textTruncated: true }
          : {}),
      },
    };
    // Keep the exit event only: a cursor before it must see a history gap.
    const events = session.events.slice(-1);
    const droppedThrough = (events[0]?.sequence ?? session.nextSequence) - 1;
    const encode = () => JSON.stringify({ snapshot, events, droppedThrough });
    let encoded = encode();
    if (
      Buffer.byteLength(encoded) + 64 > this.maxTombstoneBytes &&
      snapshot.prompt?.text
    ) {
      snapshot.prompt.text = "";
      snapshot.prompt.textTruncated = true;
      encoded = encode();
    }
    const bytes = Buffer.byteLength(encoded) + 64;
    // A sliced prefix must not keep the original multi-megabyte reply alive.
    return bytes <= this.maxTombstoneBytes
      ? { ...JSON.parse(encoded), bytes }
      : undefined;
  }

  private storeTombstone(session: ManagedSession): void {
    const previous = this.tombstones.get(session.id);
    if (previous) this.tombstoneBytes -= previous.bytes;
    this.tombstones.delete(session.id);
    const tombstone = this.createTombstone(session);
    if (!tombstone) return;
    this.tombstones.set(session.id, tombstone);
    this.tombstoneBytes += tombstone.bytes;
    while (
      this.tombstones.size > this.maxTombstones ||
      this.tombstoneBytes > this.maxTombstoneBytes
    ) {
      const oldestId = this.tombstones.keys().next().value as
        | string
        | undefined;
      if (oldestId === undefined) break;
      const oldest = this.tombstones.get(oldestId);
      this.tombstones.delete(oldestId);
      if (oldest) this.tombstoneBytes -= oldest.bytes;
    }
  }

  private retireSession(session: ManagedSession): void {
    if (!session.retired) {
      session.retired = true;
      if (this.sessions.get(session.id) === session) {
        this.sessions.delete(session.id);
        this.occupiedSlots = Math.max(0, this.occupiedSlots - 1);
      }
    }
    this.storeTombstone(session);
    if (this.acpSessionOwners.get(session.acpSessionKey) === session) {
      this.acpSessionOwners.delete(session.acpSessionKey);
    }
    this.notifyEventWaiters(session.id);
  }

  async closeIfIdle(id: string): Promise<boolean> {
    if (this.tombstones.has(id) || this.closingSessions.has(id)) {
      await this.close(id);
      return true;
    }
    const session = this.requireSession(id);
    if (
      session.promptActive ||
      session.prompt?.state === "running" ||
      session.pendingPermissions.size > 0
    )
      return false;
    await this.close(id);
    return true;
  }

  close(id: string): Promise<void> {
    const activeClose = this.closingSessions.get(id);
    if (activeClose) return activeClose;
    const session = this.sessions.get(id);
    if (!session) {
      const record = this.tombstones.get(id);
      if (record) {
        this.tombstones.delete(id);
        this.tombstoneBytes -= record.bytes;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unknown session: ${id}`));
    }

    const promptCancellation =
      session.prompt?.state === "running"
        ? this.cancelPrompt(id, session.prompt.id).catch(() => undefined)
        : Promise.resolve();
    this.notifyEventWaiters(id);
    const closing = this.finishClose(session, promptCancellation);
    this.closingSessions.set(id, closing);
    void closing.then(
      () => {
        if (this.closingSessions.get(id) === closing)
          this.closingSessions.delete(id);
      },
      () => {
        if (this.closingSessions.get(id) === closing)
          this.closingSessions.delete(id);
      },
    );
    return closing;
  }

  private async finishClose(
    session: ManagedSession,
    promptCancellation: Promise<unknown>,
  ): Promise<void> {
    try {
      await promptCancellation;
      this.clearPermissionLease(session);
      for (const waiter of [
        ...(this.configOptionWaiters.get(session.id) ?? []),
      ]) {
        waiter.finish(session.configOptions);
      }
      this.cancelPendingPermissions(session);
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const closeRequest = session.driver
        .closeSession(session.acpSessionId)
        .catch(() => undefined);
      try {
        await Promise.race([
          closeRequest,
          new Promise<void>((resolve) => {
            closeTimer = setTimeout(resolve, this.closeRequestTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      }
      session.driver.closeConnection();
      await stopAgent(session.process.child, 5000);
    } finally {
      if (this.sessions.get(session.id) === session) {
        this.sessions.delete(session.id);
        this.occupiedSlots = Math.max(0, this.occupiedSlots - 1);
      }
      if (this.acpSessionOwners.get(session.acpSessionKey) === session) {
        this.acpSessionOwners.delete(session.acpSessionKey);
      }
      this.notifyEventWaiters(session.id);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([
      ...[...this.sessions.keys()].map((id) => this.close(id)),
      ...this.closingSessions.values(),
    ]);
  }
}
