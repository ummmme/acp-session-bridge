import { BookmarkError, type ScopeBook, type ScopeStore } from "./store.ts";
import {
  advanceTurn,
  type Owner,
  reserveTurn,
  TurnConflict,
  type TurnState,
} from "./turn.ts";

/** The coordinator must retain the session execution lease across reservation and dispatch. */
export interface TurnBinding {
  scopeKey: string;
  label: string;
  sessionId: string;
  owner: Owner;
}

function liveEntry(book: ScopeBook, binding: TurnBinding) {
  const entry = book.sessions[binding.label];
  if (
    !entry ||
    entry.status !== "live" ||
    entry.sessionId !== binding.sessionId
  )
    throw new TurnConflict("stale_owner");
  return entry;
}

export async function reserveAndDispatch<T>(
  store: ScopeStore,
  binding: TurnBinding,
  dispatch: (promptId: string) => T,
  acknowledge?: string,
): Promise<T> {
  const saved = await store.update(binding.scopeKey, (draft) => {
    const entry = liveEntry(draft, binding);
    entry.lastPrompt = reserveTurn(entry, binding.owner, acknowledge);
    return draft;
  });
  // If the downstream call throws, recovery must still treat the reservation as unresolved.
  return dispatch(saved.sessions[binding.label].lastPrompt!.promptId);
}

export type BookmarkPersistence =
  | { saved: true; revision: number }
  | { saved: false; errorCode: string };

export async function recordTurnState(
  store: ScopeStore,
  binding: TurnBinding,
  promptId: string,
  state: TurnState,
  afterSequence?: number,
): Promise<BookmarkPersistence> {
  try {
    const saved = await store.update(binding.scopeKey, (draft) => {
      const entry = liveEntry(draft, binding);
      const next = advanceTurn(entry, binding.owner, promptId, state);
      if (!next) throw new StaleUpdate();
      entry.lastPrompt = next;
      if (afterSequence !== undefined)
        entry.afterSequence = Math.max(entry.afterSequence, afterSequence);
      entry.updatedAt = Date.now();
      return draft;
    });
    return { saved: true, revision: saved.revision };
  } catch (error) {
    if (error instanceof StaleUpdate) {
      // rename may already have succeeded when a later directory sync failed.
      const book = await store.read(binding.scopeKey),
        entry = book?.sessions[binding.label];
      if (
        book &&
        entry?.status === "live" &&
        entry.sessionId === binding.sessionId &&
        entry.owner.ownerEpoch === binding.owner.ownerEpoch &&
        entry.owner.ownerId === binding.owner.ownerId &&
        entry.lastPrompt?.promptId === promptId &&
        entry.lastPrompt.state === state
      )
        return { saved: true, revision: book.revision };
      return { saved: false, errorCode: "stale_turn_update" };
    }
    if (error instanceof TurnConflict || error instanceof BookmarkError)
      return { saved: false, errorCode: error.code };
    throw error;
  }
}
class StaleUpdate extends Error {}
