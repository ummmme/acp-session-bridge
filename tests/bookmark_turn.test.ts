import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceTurn,
  recoverTurn,
  reserveTurn,
  type OwnedTurn,
  type TurnState,
} from "../src/bookmarks/turn.ts";

const owner = { ownerId: "bridge-a", ownerEpoch: 1 };
const old = "prompt-old";
function record(state: TurnState): OwnedTurn {
  return { owner, lastPrompt: { promptId: old, state } };
}

test("an unknown outcome requires an acknowledgement for that exact turn", () => {
  const entry = record("outcome_unknown");
  assert.throws(() => reserveTurn(entry, owner), {
    code: "outcome_unknown",
    promptId: old,
  });
  assert.throws(() => reserveTurn(entry, owner, "other"), {
    code: "stale_acknowledgement",
  });
  const next = reserveTurn(entry, owner, old);
  assert.notEqual(next.promptId, old);
  assert.equal(next.state, "pending_send");
  const restarted = { ...entry, lastPrompt: recoverTurn(next) };
  assert.equal(restarted.lastPrompt?.state, "outcome_unknown");
  assert.throws(() => reserveTurn(restarted, owner, old), {
    code: "stale_acknowledgement",
  });
});

test("reserved, running and unconfirmed cancellations block another send", () => {
  for (const state of [
    "pending_send",
    "running",
    "cancel_requested",
  ] as const) {
    assert.throws(() => reserveTurn(record(state), owner), {
      code: "turn_busy",
      promptId: old,
    });
    assert.deepEqual(recoverTurn(record(state).lastPrompt), {
      promptId: old,
      state: "outcome_unknown",
    });
  }
  for (const state of ["cancelled", "completed", "not_sent"] as const) {
    assert.equal(recoverTurn(record(state).lastPrompt)?.state, state);
    assert.equal(reserveTurn(record(state), owner).state, "pending_send");
  }
});

test("late callbacks cannot revert a settled turn or another owner's record", () => {
  for (const stale of [
    { ...owner, ownerId: "another" },
    { ...owner, ownerEpoch: 0 },
  ]) {
    assert.throws(() => reserveTurn(record("completed"), stale), {
      code: "stale_owner",
    });
    assert.equal(advanceTurn(record("running"), stale, old, "completed"), null);
  }
  assert.equal(
    advanceTurn(record("running"), owner, "other", "completed"),
    null,
  );
  assert.equal(advanceTurn(record("completed"), owner, old, "running"), null);
  assert.equal(
    advanceTurn(record("cancel_requested"), owner, old, "running"),
    null,
  );
  assert.deepEqual(
    advanceTurn(record("cancel_requested"), owner, old, "cancelled"),
    { promptId: old, state: "cancelled" },
  );
  assert.equal(advanceTurn(record("running"), owner, old, "not_sent"), null);
});
