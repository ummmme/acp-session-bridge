import { randomUUID } from "node:crypto";

export interface Owner {
  ownerId: string;
  ownerEpoch: number;
}

export type TurnState =
  | "pending_send"
  | "running"
  | "cancel_requested"
  | "outcome_unknown"
  | "completed"
  | "cancelled"
  | "not_sent"
  | "failed_confirmed";

export interface TurnBookmark {
  promptId: string;
  state: TurnState;
}

export interface OwnedTurn {
  owner: Owner;
  lastPrompt: TurnBookmark | null;
}

export class TurnConflict extends Error {
  readonly code:
    | "stale_owner"
    | "turn_busy"
    | "outcome_unknown"
    | "stale_acknowledgement";
  readonly promptId?: string;
  constructor(code: TurnConflict["code"], promptId?: string) {
    super(code);
    this.code = code;
    this.promptId = promptId;
  }
}

function sameOwner(actual: Owner, expected: Owner): boolean {
  return (
    actual.ownerId === expected.ownerId &&
    actual.ownerEpoch === expected.ownerEpoch
  );
}

/** Called on the latest disk record inside the store's scope transaction. */
export function reserveTurn(
  record: OwnedTurn,
  owner: Owner,
  acknowledgeUnknownOutcomeForPromptId?: string,
): TurnBookmark {
  if (!sameOwner(record.owner, owner)) throw new TurnConflict("stale_owner");
  const previous = record.lastPrompt;
  if (
    acknowledgeUnknownOutcomeForPromptId !== undefined &&
    (previous?.state !== "outcome_unknown" ||
      previous.promptId !== acknowledgeUnknownOutcomeForPromptId)
  ) {
    throw new TurnConflict("stale_acknowledgement");
  }
  if (
    previous?.state === "outcome_unknown" &&
    acknowledgeUnknownOutcomeForPromptId === undefined
  ) {
    throw new TurnConflict("outcome_unknown", previous.promptId);
  }
  if (
    previous &&
    ["pending_send", "running", "cancel_requested"].includes(previous.state)
  ) {
    throw new TurnConflict("turn_busy", previous.promptId);
  }
  return { promptId: randomUUID(), state: "pending_send" };
}

/** Only after taking exclusive ownership and ruling out a live executor. */
export function recoverTurn(turn: TurnBookmark | null): TurnBookmark | null {
  if (!turn) return null;
  if (["pending_send", "running", "cancel_requested"].includes(turn.state)) {
    return { promptId: turn.promptId, state: "outcome_unknown" };
  }
  return { ...turn };
}

const transitions: Record<TurnState, readonly TurnState[]> = {
  // A terminal notification can arrive before the running update is persisted.
  pending_send: [
    "running",
    "cancel_requested",
    "completed",
    "cancelled",
    "not_sent",
    "outcome_unknown",
    "failed_confirmed",
  ],
  running: [
    "cancel_requested",
    "completed",
    "cancelled",
    "outcome_unknown",
    "failed_confirmed",
  ],
  cancel_requested: [
    "completed",
    "cancelled",
    "outcome_unknown",
    "failed_confirmed",
  ],
  outcome_unknown: [],
  completed: [],
  cancelled: [],
  not_sent: [],
  failed_confirmed: [],
};

/** null means a stale, duplicate or out-of-order callback must not write. */
export function advanceTurn(
  record: OwnedTurn,
  owner: Owner,
  promptId: string,
  state: TurnState,
): TurnBookmark | null {
  const previous = record.lastPrompt;
  if (
    !sameOwner(record.owner, owner) ||
    !previous ||
    previous.promptId !== promptId ||
    !transitions[previous.state].includes(state)
  )
    return null;
  return { promptId, state };
}
