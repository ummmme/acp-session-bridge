import { strict as assert } from "node:assert";
import process from "node:process";
import { resolve } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { SessionManager } from "../src/sessions/manager.ts";

const fixturePath = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
  .pathname;
const absoluteFixturePath =
  process.platform === "win32"
    ? decodeURIComponent(fixturePath.replace(/^\//, ""))
    : fixturePath;

function managerForResumeTests() {
  return new SessionManager({
    fake: {
      command: process.execPath,
      args: [absoluteFixturePath],
    },
  });
}

test("concurrent resumes reject duplicate downstream IDs and preserve callback ownership", async () => {
  const manager = managerForResumeTests();
  try {
    const results = await Promise.allSettled([
      manager.load("fake", "shared-downstream-session", process.cwd()),
      manager.load("fake", "shared-downstream-session", process.cwd()),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const [winner] = fulfilled;
    const [duplicate] = rejected;

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(winner);
    assert.ok(duplicate);
    assert.equal(winner.status, "fulfilled");
    assert.equal(duplicate.status, "rejected");
    assert.match(String(duplicate.reason), /ACP session ID already managed/);
    assert.equal(manager.sessionCount, 1);

    const response = await manager.prompt(winner.value.id, "owned prompt");
    assert.equal(response.text, "fake reply");
    const events = manager.getEvents(winner.value.id).events;
    assert.equal(events.length, 1);
    assert.equal(
      (events[0].raw as { sessionId: string }).sessionId,
      "shared-downstream-session",
    );
  } finally {
    await manager.closeAll();
  }
});

test("closing a resumed session releases its downstream ID for a later resume", async () => {
  const manager = managerForResumeTests();
  try {
    const first = await manager.load(
      "fake",
      "reusable-downstream-session",
      process.cwd(),
    );
    await manager.close(first.id);
    assert.equal(manager.sessionCount, 0);

    const replacement = await manager.load(
      "fake",
      "reusable-downstream-session",
      process.cwd(),
    );
    assert.equal(replacement.acpSessionId, "reusable-downstream-session");
    const response = await manager.prompt(replacement.id, "replacement prompt");
    assert.equal(response.text, "fake reply");
  } finally {
    await manager.closeAll();
  }
});

test("a project alias and its real directory share one resume slot", async () => {
  const manager = managerForResumeTests();
  const temp = await mkdtemp(resolve(tmpdir(), "acp-resume-alias-"));
  try {
    const alias = resolve(temp, "project");
    await symlink(
      process.cwd(),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const active = await manager.load("fake", "work", alias);
    await assert.rejects(
      manager.load("fake", "work", process.cwd()),
      /already managed/,
    );
    assert.equal(await manager.closeIfIdle(active.id), true);
    const resumed = await manager.load("fake", "work", process.cwd());
    assert.ok(manager.hasSession(resumed.id));
  } finally {
    await manager.closeAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("duplicate ownership is scoped by agent and normalized cwd", async () => {
  const definition = {
    command: process.execPath,
    args: [absoluteFixturePath],
  };
  const manager = new SessionManager({
    fake: definition,
    other: definition,
  });
  const cwd = process.cwd();
  try {
    const fakeSession = await manager.load(
      "fake",
      "shared-downstream-session",
      cwd,
      "deny_all",
    );
    const otherAgentSession = await manager.load(
      "other",
      "shared-downstream-session",
      cwd,
      "operator",
    );
    assert.equal(fakeSession.acpSessionId, otherAgentSession.acpSessionId);

    await assert.rejects(
      manager.load("fake", "shared-downstream-session", resolve(cwd, ".")),
      /ACP session ID already managed/,
    );
    const otherCwdSession = await manager.load(
      "fake",
      "shared-downstream-session",
      resolve(cwd, ".."),
    );
    assert.equal(otherCwdSession.acpSessionId, fakeSession.acpSessionId);
    assert.equal(manager.sessionCount, 3);

    const operatorPrompt = manager.beginPrompt(
      otherAgentSession.id,
      "permission",
    );
    assert.equal(await manager.closeIfIdle(otherAgentSession.id), false);
    assert.ok(manager.hasSession(otherAgentSession.id));
    for (
      let i = 0;
      i < 100 &&
      manager.getSessionSnapshot(otherAgentSession.id).pendingPermissions
        .length === 0;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = manager.getSessionSnapshot(otherAgentSession.id)
      .pendingPermissions[0];
    assert.ok(pending, "permission callback stayed with its owning connection");
    assert.equal(await manager.closeIfIdle(otherAgentSession.id), false);
    assert.equal(
      manager.getSessionSnapshot(otherAgentSession.id).pendingPermissions[0]
        ?.id,
      pending.id,
    );
    assert.equal(
      manager.getSessionSnapshot(fakeSession.id).pendingPermissions.length,
      0,
    );
    manager.resolvePermission(otherAgentSession.id, pending.id, "allow");
    await operatorPrompt.done;
    assert.equal(operatorPrompt.text, "allow");

    await Promise.all([
      manager.prompt(fakeSession.id, "fake agent connection"),
      manager.prompt(otherCwdSession.id, "other cwd connection"),
    ]);
    for (const session of [fakeSession, otherAgentSession, otherCwdSession]) {
      const events = manager.getEvents(session.id).events;
      const messageEvents = events.filter(
        (event) => event.kind === "agent_message_chunk",
      );
      const permissionEvents = events.filter(
        (event) => event.kind === "permission_request",
      );
      assert.equal(messageEvents.length, 1);
      assert.equal(
        permissionEvents.length,
        session === otherAgentSession ? 1 : 0,
      );
      assert.ok(
        events.every(
          (event) =>
            (event.raw as { sessionId: string }).sessionId ===
            session.acpSessionId,
        ),
      );
    }
  } finally {
    await manager.closeAll();
  }
});
