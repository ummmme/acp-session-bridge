import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { BookmarkError, ScopeStore } from "../src/bookmarks/store.ts";
import type { TurnBinding } from "../src/bookmarks/turn_journal.ts";
import { SessionManager } from "../src/sessions/manager.ts";

const scopeKey = "b".repeat(64);
const owner = { ownerId: "fixture-owner", ownerEpoch: 1 };

function fixturePath(protocol: "v1" | "v2") {
  const file = protocol === "v1" ? "fake_acp_agent.ts" : "fake_acp_v2_agent.ts";
  const path = new URL(`./fixtures/${file}`, import.meta.url).pathname;
  return process.platform === "win32"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

async function setup(protocol: "v1" | "v2", onRetired?: () => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), "acp-bookmark-manager-"));
  const store = new ScopeStore(join(temp, "state"));
  const manager = new SessionManager({
    fake: {
      command: process.execPath,
      args: [fixturePath(protocol)],
      acpProtocol: protocol,
    },
  });
  const session = await manager.start("fake", process.cwd());
  await store.update(scopeKey, (book) => ({
    ...book,
    currentLabel: "A",
    sessions: {
      A: {
        agentId: "fake",
        sessionCwd: session.cwd,
        acpSessionId: session.acpSessionId,
        sessionId: session.id,
        owner,
        status: "live",
        model: null,
        thoughtLevel: null,
        name: null,
        afterSequence: 0,
        lastPrompt: null,
      },
    },
  }));
  const binding: TurnBinding = {
    scopeKey,
    label: "A",
    sessionId: session.id,
    owner,
  };
  manager.bindSessionJournal(session.id, store, binding, onRetired);
  return { temp, store, manager, session, binding };
}

async function cleanup(
  setupResult: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  await setupResult.manager.closeAll();
  await rm(setupResult.temp, { recursive: true, force: true });
}

test("managed prompt reserves once and settles its exact prompt ID", async () => {
  const state = await setup("v1");
  try {
    assert.throws(
      () => state.manager.beginPrompt(state.session.id, "empty response"),
      /sendManagedPrompt/,
    );
    await assert.rejects(
      state.manager.prompt(state.session.id, "empty response"),
      /sendManagedPrompt/,
    );
    const prompt = await state.manager.sendManagedPrompt(
      state.session.id,
      "empty response",
    );
    await prompt.done;
    const saved = await state.store.read(scopeKey);
    assert.deepEqual(saved?.sessions.A?.lastPrompt, {
      promptId: prompt.id,
      state: "completed",
    });
    assert.deepEqual(prompt.bookmarkPersistence, {
      saved: true,
      revision: 4,
    });
    assert.deepEqual(
      state.manager.getSessionSnapshot(state.session.id).prompt
        ?.bookmarkPersistence,
      prompt.bookmarkPersistence,
    );
  } finally {
    await cleanup(state);
  }
});

test("confirmed ACP terminal errors persist failed_confirmed", async () => {
  const state = await setup("v2");
  try {
    const prompt = await state.manager.sendManagedPrompt(
      state.session.id,
      "error",
    );
    await prompt.done;
    assert.equal(prompt.state, "failed");
    assert.deepEqual(
      (await state.store.read(scopeKey))?.sessions.A?.lastPrompt,
      {
        promptId: prompt.id,
        state: "failed_confirmed",
      },
    );
  } finally {
    await cleanup(state);
  }
});

test("an acknowledged cancellation settles cancelled, not cancel_requested", async () => {
  const state = await setup("v2");
  try {
    const prompt = await state.manager.sendManagedPrompt(
      state.session.id,
      "wait",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await state.manager.cancelPrompt(state.session.id, prompt.id);
    await prompt.done;
    assert.equal(prompt.state, "cancelled");
    assert.deepEqual(
      (await state.store.read(scopeKey))?.sessions.A?.lastPrompt,
      {
        promptId: prompt.id,
        state: "cancelled",
      },
    );
  } finally {
    await cleanup(state);
  }
});

test("retirement callback failures do not mask reply text", async () => {
  let retired = false;
  const state = await setup("v2", async () => {
    retired = true;
    throw new Error("metadata write failed");
  });
  try {
    const prompt = await state.manager.sendManagedPrompt(
      state.session.id,
      "ordinary response",
    );
    await prompt.done;
    assert.equal(prompt.text, "v2 reply");
    await state.manager.close(state.session.id);
    assert.equal(retired, true);
    assert.deepEqual(prompt.bookmarkPersistence, {
      saved: false,
      errorCode: "retirement_callback_failed",
    });
  } finally {
    await cleanup(state);
  }
});

test("transport exit persists outcome_unknown", async () => {
  let retired = false;
  const state = await setup("v2", async () => {
    retired = true;
  });
  try {
    const prompt = await state.manager.sendManagedPrompt(
      state.session.id,
      "exit after ack",
    );
    await prompt.done;
    const deadline = Date.now() + 2000;
    while (state.manager.hasSession(state.session.id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(retired, true);
    assert.equal(prompt.state, "failed");
    assert.deepEqual(
      (await state.store.read(scopeKey))?.sessions.A?.lastPrompt,
      {
        promptId: prompt.id,
        state: "outcome_unknown",
      },
    );
  } finally {
    await cleanup(state);
  }
});

test("a failed terminal save delivers the full answer and the next question repairs the same turn first", async () => {
  const s = await setup("v2");
  let injected = false;
  const update = s.store.update.bind(s.store);
  s.store.update = (key, mutate) =>
    update(key, async (b) => {
      const updated = await mutate(b);
      if (!injected && updated.sessions.A?.lastPrompt?.state === "completed") {
        injected = true;
        throw new BookmarkError("bookmark_io");
      }
      return updated;
    });
  try {
    const p = await s.manager.sendManagedPrompt(
      s.session.id,
      "ordinary response",
    );
    await p.done;
    assert.equal(p.text, "v2 reply");
    assert.deepEqual(p.bookmarkPersistence, {
      saved: false,
      errorCode: "bookmark_io",
    });
    assert.equal(
      (await s.store.read(scopeKey))?.sessions.A.lastPrompt?.state,
      "running",
    );
    const next = await s.manager.sendManagedPrompt(
      s.session.id,
      "second question",
    );
    await next.done;
    assert.notEqual(p.id, next.id);
    assert.equal(p.bookmarkPersistence?.saved, true);
    assert.equal(
      (await s.store.read(scopeKey))?.sessions.A.lastPrompt?.promptId,
      next.id,
    );
  } finally {
    await cleanup(s);
  }
});
