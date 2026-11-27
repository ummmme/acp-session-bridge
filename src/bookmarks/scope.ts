import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import * as nodeFs from "#fs";

const CONVERSATION_ID_PLACEHOLDERS = new Set([
  "$" + "{CLAUDE_SESSION_ID}",
  "$CLAUDE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "undefined",
  "null",
  "unknown",
]);

export interface ConversationScopeInput {
  /** Opaque, stable identifier supplied by the client conversation host. */
  clientConversationId: string;
  /** Directory used by the caller for this operation. */
  cwd: string;
  /** Optional explicit project root, which must contain cwd. */
  projectRoot?: string;
  /** Optional stable launch root, used after filesystem markers are checked. */
  launchRoot?: string;
  /** Optional home directory used to exclude the user-level config marker. */
  homeDirectory?: string;
}

export interface ConversationScope {
  clientConversationId: string;
  /** Canonical project identity used with clientConversationId for the key. */
  projectRoot: string;
  /** Canonical working directory, preserved separately from projectRoot. */
  sessionCwd: string;
  /** SHA-256 of clientConversationId + NUL + projectRoot. */
  scopeKey: string;
}

export class InvalidConversationId extends TypeError {
  readonly code = "invalid_client_conversation_id";
  constructor() {
    super("invalid_client_conversation_id");
  }
}

function validateConversationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    CONVERSATION_ID_PLACEHOLDERS.has(value) ||
    /^\$\{[^}]+\}$/u.test(value)
  ) {
    throw new InvalidConversationId();
  }
}

function validatePathInput(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isAncestor(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === "" ||
    (!isAbsolute(fromParent) &&
      fromParent !== ".." &&
      !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

async function canonicalDirectory(path: string, name: string): Promise<string> {
  validatePathInput(path, name);
  const canonical = await nodeFs.realpath(path);
  const info = await nodeFs.stat(canonical);
  if (!info.isDirectory()) throw new TypeError(`${name} must be a directory`);
  return canonical;
}

async function markerType(directory: string, name: string) {
  try {
    const info = await nodeFs.lstat(resolve(directory, name));
    if (info.isSymbolicLink()) return false;
    return name === ".git"
      ? info.isDirectory() || info.isFile()
      : info.isFile();
  } catch (error) {
    if (
      nodeFs.isErrorCode(error, "ENOENT") ||
      nodeFs.isErrorCode(error, "ENOTDIR")
    )
      return false;
    throw error;
  }
}

async function nearestGitRoot(cwd: string): Promise<string | undefined> {
  let current = cwd;
  for (;;) {
    if (await markerType(current, ".git")) return current;
    const parent = dirname(current);
    if (samePath(parent, current)) return undefined;
    current = parent;
  }
}

async function nearestProjectConfigRoot(
  cwd: string,
  homeDirectory?: string,
): Promise<string | undefined> {
  let current = cwd;
  for (;;) {
    if (
      (!homeDirectory || !samePath(current, homeDirectory)) &&
      (await markerType(current, ".acp-mcp.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (samePath(parent, current)) return undefined;
    current = parent;
  }
}

/**
 * Resolve and validate a conversation's project scope using filesystem reads
 * only. Git metadata takes priority over project config markers; otherwise an
 * explicit project root, launch root, or canonical cwd provides the fallback.
 */
export async function resolveConversationScope(
  input: ConversationScopeInput,
): Promise<ConversationScope> {
  if (!input || typeof input !== "object")
    throw new TypeError("Scope input must be an object");
  validateConversationId(input.clientConversationId);
  validatePathInput(input.cwd, "cwd");
  if (input.projectRoot !== undefined)
    validatePathInput(input.projectRoot, "projectRoot");
  if (input.launchRoot !== undefined)
    validatePathInput(input.launchRoot, "launchRoot");
  if (input.homeDirectory !== undefined)
    validatePathInput(input.homeDirectory, "homeDirectory");

  const sessionCwd = await canonicalDirectory(input.cwd, "cwd");
  const homeDirectory = await canonicalDirectory(
    input.homeDirectory ?? homedir(),
    "homeDirectory",
  );
  const explicitRoot =
    input.projectRoot === undefined
      ? undefined
      : await canonicalDirectory(input.projectRoot, "projectRoot");
  const launchRoot =
    input.launchRoot === undefined
      ? undefined
      : await canonicalDirectory(input.launchRoot, "launchRoot");
  if (explicitRoot && !isAncestor(explicitRoot, sessionCwd)) {
    throw new TypeError("projectRoot must be an ancestor of cwd");
  }
  if (launchRoot && !isAncestor(launchRoot, sessionCwd)) {
    throw new TypeError("launchRoot must be an ancestor of cwd");
  }

  const gitRoot = await nearestGitRoot(sessionCwd);
  const configRoot = gitRoot
    ? undefined
    : await nearestProjectConfigRoot(sessionCwd, homeDirectory);
  const projectRoot =
    gitRoot ?? configRoot ?? explicitRoot ?? launchRoot ?? sessionCwd;

  const scopeKey = createHash("sha256")
    .update(input.clientConversationId)
    .update("\0")
    .update(projectRoot)
    .digest("hex");
  return {
    clientConversationId: input.clientConversationId,
    projectRoot,
    sessionCwd,
    scopeKey,
  };
}
