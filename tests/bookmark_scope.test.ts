import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import * as nodeFs from "#fs";
import { resolveConversationScope } from "../src/bookmarks/scope.ts";

async function writeMarker(directory: string, filename: string) {
  await nodeFs.mkdir(directory, { recursive: true });
  await nodeFs.writeText(join(directory, filename), "{}");
}

async function rejects(task: () => Promise<unknown>, message: string) {
  let failed = false;
  try {
    await task();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(message);
}

test("Git root wins over nested config and session cwd remains canonical", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-git-" });
  const root = join(temp, "repo");
  const nested = join(root, "nested");
  const deep = join(nested, "deep");
  try {
    await nodeFs.mkdir(join(root, ".git"), { recursive: true });
    await writeMarker(nested, ".acp-mcp.json");
    await nodeFs.mkdir(deep, { recursive: true });
    const canonicalRoot = await nodeFs.realpath(root);
    const canonicalDeep = await nodeFs.realpath(deep);
    const scope = await resolveConversationScope({
      clientConversationId: "host-session:opaque/with punctuation?",
      cwd: deep,
    });
    const expectedKey = createHash("sha256")
      .update("host-session:opaque/with punctuation?")
      .update("\0")
      .update(canonicalRoot)
      .digest("hex");
    if (
      scope.projectRoot !== canonicalRoot ||
      scope.sessionCwd !== canonicalDeep ||
      scope.scopeKey !== expectedKey
    )
      throw new Error(`Unexpected scope: ${JSON.stringify(scope)}`);
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});

test("native worktree .git files scope independently from the main checkout", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-worktrees-" });
  const main = join(temp, "main");
  const worktreeA = join(temp, "worktree-a");
  const worktreeB = join(temp, "worktree-b");
  try {
    await nodeFs.mkdir(join(main, ".git"), { recursive: true });
    await nodeFs.mkdir(worktreeA, { recursive: true });
    await nodeFs.mkdir(worktreeB, { recursive: true });
    await nodeFs.writeText(
      join(worktreeA, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "a")}\n`,
    );
    await nodeFs.writeText(
      join(worktreeB, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "b")}\n`,
    );
    const a = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: worktreeA,
    });
    const b = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: worktreeB,
    });
    if (
      a.projectRoot !== (await nodeFs.realpath(worktreeA)) ||
      b.projectRoot !== (await nodeFs.realpath(worktreeB)) ||
      a.scopeKey === b.scopeKey
    )
      throw new Error("Separate worktrees shared a conversation scope");
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});

test("non-Git config markers are nearest and user config does not scope siblings", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-config-" });
  const home = join(temp, "home");
  const project = join(home, "projects");
  const first = join(project, "alpha");
  const second = join(project, "beta");
  const nested = join(first, "nested");
  try {
    await writeMarker(home, ".acp-mcp.json");
    await nodeFs.mkdir(first, { recursive: true });
    await nodeFs.mkdir(second, { recursive: true });
    const a = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: first,
      homeDirectory: home,
    });
    const b = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: second,
      homeDirectory: home,
    });
    const canonicalFirst = await nodeFs.realpath(first);
    const canonicalSecond = await nodeFs.realpath(second);
    if (
      a.projectRoot !== canonicalFirst ||
      b.projectRoot !== canonicalSecond ||
      a.scopeKey === b.scopeKey
    )
      throw new Error("Home config caused sibling projects to share scope");

    await writeMarker(project, ".acp-mcp.json");
    await nodeFs.mkdir(nested, { recursive: true });
    const nestedScope = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: nested,
      homeDirectory: home,
    });
    if (nestedScope.projectRoot !== (await nodeFs.realpath(project)))
      throw new Error("Nearest non-home project config was not selected");
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});

test("symlink cwd resolves to its real project and preserves its real session cwd", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-symlink-" });
  const root = join(temp, "repo");
  const realSubdirectory = join(root, "subdir");
  const link = join(temp, "alias");
  try {
    await nodeFs.mkdir(join(root, ".git"), { recursive: true });
    await nodeFs.mkdir(realSubdirectory, { recursive: true });
    await nodeFs.symlink(realSubdirectory, link, "dir");
    const scope = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: link,
    });
    const canonicalRoot = await nodeFs.realpath(root);
    const canonicalSubdirectory = await nodeFs.realpath(realSubdirectory);
    if (
      scope.projectRoot !== canonicalRoot ||
      scope.sessionCwd !== canonicalSubdirectory
    )
      throw new Error(
        `Symlink paths were not canonicalized: ${JSON.stringify(scope)}`,
      );
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});

test("explicit and launch roots require an ancestor and are used without markers", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-explicit-" });
  const root = join(temp, "project");
  const child = join(root, "subdir");
  const sibling = join(temp, "sibling");
  try {
    await nodeFs.mkdir(child, { recursive: true });
    await nodeFs.mkdir(sibling, { recursive: true });
    const explicit = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: child,
      projectRoot: root,
    });
    const launch = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: child,
      launchRoot: root,
    });
    const fallback = await resolveConversationScope({
      clientConversationId: "conversation",
      cwd: child,
    });
    const canonicalRoot = await nodeFs.realpath(root);
    if (
      explicit.projectRoot !== canonicalRoot ||
      launch.projectRoot !== canonicalRoot ||
      fallback.projectRoot !== (await nodeFs.realpath(child))
    )
      throw new Error("Incorrect project root fallback order");
    await rejects(
      () =>
        resolveConversationScope({
          clientConversationId: "conversation",
          cwd: child,
          projectRoot: sibling,
        }),
      "Unrelated explicit project root was accepted",
    );
    await rejects(
      () =>
        resolveConversationScope({
          clientConversationId: "conversation",
          cwd: child,
          launchRoot: sibling,
        }),
      "Unrelated launch root was accepted",
    );
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});

test("conversation ids reject missing and placeholder values but accept opaque ids", async () => {
  const temp = await nodeFs.makeTempDir({ prefix: "scope-identifiers-" });
  try {
    for (const id of [
      "",
      " ",
      "$" + "{CLAUDE_SESSION_ID}",
      "$CLAUDE_SESSION_ID",
      "$" + "{OTHER_ID}",
      "unknown",
      "bad\nvalue",
    ]) {
      await rejects(
        () => resolveConversationScope({ clientConversationId: id, cwd: temp }),
        `Invalid conversation id was accepted: ${JSON.stringify(id)}`,
      );
    }
    const valid = "session-id:not-a-uuid/opaque+value";
    const scope = await resolveConversationScope({
      clientConversationId: valid,
      cwd: temp,
    });
    if (scope.clientConversationId !== valid)
      throw new Error("Opaque id was changed");
    await rejects(
      () =>
        resolveConversationScope({
          clientConversationId: valid,
          cwd: "relative",
        }),
      "Relative cwd was accepted",
    );
  } finally {
    await nodeFs.removePath(temp, { recursive: true });
  }
});
