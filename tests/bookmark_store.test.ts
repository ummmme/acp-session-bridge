import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  recordTurnState,
  reserveAndDispatch,
} from "../src/bookmarks/turn_journal.ts";
import { ScopeStore, type ScopeBook } from "../src/bookmarks/store.ts";

const run = promisify(execFile);
const key = "a".repeat(64);
const owner = { ownerId: "P1", ownerEpoch: 1 };
const session: ScopeBook["sessions"][string] = {
  agentId: "fixture",
  sessionCwd: "/fixture",
  acpSessionId: "downstream",
  sessionId: "handle",
  owner,
  status: "live",
  model: "model",
  thoughtLevel: null,
  name: null,
  afterSequence: 0,
  lastPrompt: { promptId: "P_old", state: "outcome_unknown" },
};
const storeUrl = new URL("../src/bookmarks/store.ts", import.meta.url).href;
const turnUrl = new URL("../src/bookmarks/turn.ts", import.meta.url).href;

async function temp(check: (dir: string, store: ScopeStore) => Promise<void>) {
  const tmp = await mkdtemp(join(tmpdir(), "acp-bookmark-"));
  const dir = join(tmp, "scopes");
  try {
    await check(dir, new ScopeStore(dir));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test("reading a missing bookmark has no side effects; writes use private files and narrow schema", async () =>
  temp(async (dir, store) => {
    assert.equal(await store.read(key), null);
    await assert.rejects(stat(dir), { code: "ENOENT" });
    await assert.rejects(
      store.update("../scope", (x) => x),
      { code: "invalid_bookmark" },
    );
    const saved = await store.update(key, (x) => ({
      ...x,
      currentLabel: "A",
      sessions: { A: session },
    }));
    assert.equal(saved.revision, 1);
    const path = join(dir, key + ".json");
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    await assert.rejects(
      store.update(key, (x) => ({
        ...x,
        sessions: { A: { ...session, text: "secret" } },
      })),
      { code: "invalid_bookmark" },
    );
    assert.deepEqual(await store.read(key), saved);
    await writeFile(path, "{broken");
    await assert.rejects(
      store.update(key, (x) => x),
      { code: "invalid_bookmark" },
    );
    assert.equal(await readFile(path, "utf8"), "{broken");
    assert.deepEqual(await readdir(dir), [key + ".json"]);
  }));

test("two OS processes cannot both consume the same unknown outcome", async () =>
  temp(async (dir, store) => {
    await store.update(key, (x) => ({
      ...x,
      currentLabel: "A",
      sessions: { A: session },
    }));
    const code = `import {ScopeStore} from ${JSON.stringify(storeUrl)};import {reserveTurn} from ${JSON.stringify(turnUrl)};
  const [dir,key]=process.argv.slice(1); const s=new ScopeStore(dir);try {
    await s.update(key,b=>{const a=b.sessions.A;a.lastPrompt=reserveTurn(a,a.owner,'P_old');return b});
    console.log('authorized');
  } catch(e) {if(!['scope_busy','stale_acknowledgement'].includes(e.code))throw e;console.log('refused');}`;
    const both = await Promise.all(
      [0, 1].map(() =>
        run(process.execPath, ["--input-type=module", "-e", code, dir, key], {
          timeout: 10000,
        }),
      ),
    );
    assert.deepEqual(both.map((r) => r.stdout.trim()).sort(), [
      "authorized",
      "refused",
    ]);
    const after = await store.read(key);
    assert.equal(after?.revision, 2);
    assert.equal(after?.sessions.A.lastPrompt?.state, "pending_send");
    assert.notEqual(after?.sessions.A.lastPrompt?.promptId, "P_old");
  }));

test("dispatch occurs only after a durable reservation; failed settlement leaves the turn unresolved", async () =>
  temp(async (dir, store) => {
    await store.update(key, (b) => ({
      ...b,
      currentLabel: "A",
      sessions: { A: session },
    }));
    const binding = { scopeKey: key, label: "A", sessionId: "handle", owner };
    let sends = 0;
    const lock = join(dir, key + ".lock");
    await writeFile(lock, "foreign", { mode: 0o600 });
    await assert.rejects(
      reserveAndDispatch(
        store,
        binding,
        () => {
          sends++;
        },
        "P_old",
      ),
      { code: "scope_busy" },
    );
    assert.equal(sends, 0);
    await rm(lock);
    const reply = await reserveAndDispatch(
      store,
      binding,
      async (promptId) => {
        assert.deepEqual((await store.read(key))?.sessions.A.lastPrompt, {
          promptId,
          state: "pending_send",
        });
        sends++;
        return { promptId, text: "fixture completed reply" };
      },
      "P_old",
    );
    assert.equal(sends, 1);
    await writeFile(lock, "foreign", { mode: 0o600 });
    const persistence = await recordTurnState(
      store,
      binding,
      reply.promptId,
      "completed",
    );
    assert.deepEqual(persistence, { saved: false, errorCode: "scope_busy" });
    assert.equal(reply.text, "fixture completed reply");
    assert.equal(
      (await store.read(key))?.sessions.A.lastPrompt?.state,
      "pending_send",
    );
    await rm(lock);
    assert.deepEqual(
      await recordTurnState(store, binding, reply.promptId, "completed"),
      { saved: true, revision: 3 },
    );
    assert.deepEqual(
      await recordTurnState(store, binding, reply.promptId, "running"),
      { saved: false, errorCode: "stale_turn_update" },
    );
    assert.equal((await store.read(key))?.revision, 3);
    assert.ok(
      !(await readFile(join(dir, key + ".json"), "utf8")).includes(reply.text),
    );
  }));

test("a scope lock of unknown ownership is preserved", async () =>
  temp(async (dir, store) => {
    await store.update(key, (b) => b);
    const path = join(dir, key + ".lock");
    await writeFile(path, "unverified-owner", { mode: 0o600 });
    await assert.rejects(
      store.update(key, (b) => b),
      { code: "scope_busy" },
    );
    assert.equal(await readFile(path, "utf8"), "unverified-owner");
    assert.equal((await store.read(key))?.revision, 1);
  }));

test("a crashed transaction releases the kernel guard and retains the last revision", async () =>
  temp(async (dir, store) => {
    await store.update(key, (b) => b);
    const code = `import {ScopeStore} from ${JSON.stringify(storeUrl)}; await new ScopeStore(process.argv[1]).update(process.argv[2],()=>process.exit(0));`;
    await run(process.execPath, ["--input-type=module", "-e", code, dir, key], {
      timeout: 5000,
    });
    assert.ok((await readdir(dir)).includes(key + ".lock"));
    assert.equal((await store.update(key, (b) => b)).revision, 2);
    assert.deepEqual(await readdir(dir), [key + ".json"]);
  }));

test("legacy metadata is read without writing, then only the mutated scope is imported", async () =>
  temp(async (dir, store) => {
    const root = join(dir, "..", "project"),
      conversation = "old-conversation",
      scopeKey = createHash("sha256")
        .update(conversation + "\0" + root)
        .digest("hex");
    const entry = {
      cwd: root,
      agentId: "fake",
      model: "pro",
      thoughtLevel: "high",
      thoughtConfigId: "thought_level",
    };
    const original = JSON.stringify({
      scopes: [
        {
          projectRoot: root,
          clientConversationId: conversation,
          current: "B",
          sessions: {
            A: { ...entry, status: "closed", acpSessionId: "origA" },
            B: {
              ...entry,
              status: "offline",
              acpSessionId: "origB",
              promptId: "P1",
            },
          },
        },
      ],
    });
    const legacy = join(dir, "..", "gemini-sessions.json");
    await writeFile(legacy, original, { mode: 0o600 });
    const read = await store.read(scopeKey);
    assert.equal(read?.currentLabel, "B");
    assert.equal(read?.sessions.A.status, "closed");
    assert.equal(read?.sessions.B.acpSessionId, "origB");
    await assert.rejects(stat(dir), { code: "ENOENT" });
    await store.update(scopeKey, (b) => {
      b.sessions.B.name = "QA review";
      return b;
    });
    assert.equal(await readFile(legacy, "utf8"), original);
    assert.deepEqual(await readdir(dir), [scopeKey + ".json"]);
  }));
