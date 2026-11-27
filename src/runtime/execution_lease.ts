import { constants } from "node:fs";
import { open, lstat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import process from "node:process";

const PORT_RANGE_START = 49152;
const PORT_RANGE_SIZE = 16384;

type ServerWithHandle = Server & {
  _handle?: { fd?: number } | null;
};

export type ExecutionLeaseErrorCode =
  | "unsupported_platform"
  | "unsupported_runtime"
  | "invalid_scope_key"
  | "busy"
  | "listener_failed";

export class ExecutionLeaseError extends Error {
  readonly code: ExecutionLeaseErrorCode;

  constructor(code: ExecutionLeaseErrorCode) {
    super(`Execution lease ${code.replaceAll("_", " ")}`);
    this.name = "ExecutionLeaseError";
    this.code = code;
  }
}

/**
 * An opt-in, kernel-backed process-lifetime lease for one opaque scope hash.
 *
 * The owner binds an exclusive loopback listener and exposes its listening fd
 * for duplication into the managed ACP process's stdio[3]. The caller must use
 * that exact fd when spawning the ACP process. The caller may then close this
 * lease: the duplicated child descriptor keeps the same bound listener alive
 * until the ACP process exits. If the owner process dies first, the child's fd
 * continues to reserve the port. No PID liveness checks or stale-state deletion
 * participate in ownership.
 *
 * POSIX launch also records the child's process group before ACP initialization:
 * a child may explicitly close inherited fds. Windows duplicates a regular
 * delete-on-last-close file handle instead of passing a Winsock descriptor.
 */
export class ExecutionLease {
  private closed = false;
  private readonly server: Server;
  private readonly listeningFd: number;

  private readonly file?: FileHandle;
  constructor(server: Server, listeningFd: number, file?: FileHandle) {
    this.file = file;
    this.server = server;
    this.listeningFd = listeningFd;
  }

  /** Pass this numeric fd as stdio entry 3 when spawning the managed ACP child. */
  get childStdio(): number {
    if (this.closed) throw new ExecutionLeaseError("listener_failed");
    return this.listeningFd;
  }

  /**
   * Close this process's listener reference. An inherited child fd, when present,
   * keeps the kernel-bound listener reserved until the child exits.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.file?.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error) reject(new ExecutionLeaseError("listener_failed"));
          else resolve();
        });
      });
    }
  }
}

function validateScopeKey(scopeKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(scopeKey)) {
    throw new ExecutionLeaseError("invalid_scope_key");
  }
}

/**
 * Deterministically maps an opaque scope hash to a loopback port. Hash collisions
 * fail closed as contention; they can never grant two owners.
 */
function portForScope(scopeKey: string): number {
  const digest = createHash("sha256")
    .update("acp-mcp-execution-lease\0")
    .update(scopeKey)
    .digest();
  return PORT_RANGE_START + (digest.readUInt32BE(0) % PORT_RANGE_SIZE);
}

function listeningFd(server: Server): number {
  const handle = (server as ServerWithHandle)._handle;
  const fd = handle?.fd;
  if (!Number.isInteger(fd) || fd === undefined || fd < 0) {
    throw new ExecutionLeaseError("unsupported_runtime");
  }
  return fd;
}

// libuv's Windows UV_FS_O_TEMPORARY is the CRT _O_TEMPORARY (0x0040).
// Verify deletion on this filesystem before publishing any Windows lease.
const checkedDirectories = new Set<string>();
async function windowsLeaseFile(dir: string, key: string) {
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | 0x0040;
  if (!checkedDirectories.has(dir)) {
    const probe = join(dir, `.delete-on-close-${randomUUID()}`);
    await (await open(probe, flags, 0o600)).close();
    try {
      await lstat(probe);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      checkedDirectories.add(dir);
    }
    if (!checkedDirectories.has(dir)) {
      await unlink(probe);
      throw new ExecutionLeaseError("unsupported_runtime");
    }
  }
  try {
    return await open(join(dir, key + ".exec"), flags, 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(String(error.code))
    )
      throw new ExecutionLeaseError("busy");
    throw error;
  }
}

/** Acquire an opt-in lease before starting the managed ACP process. */
export async function acquireExecutionLease(
  scopeKey: string,
  purpose: "execution" | "transaction" = "execution",
  stateDirectory?: string,
): Promise<ExecutionLease> {
  validateScopeKey(scopeKey);

  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(
          new ExecutionLeaseError(
            error.code === "EADDRINUSE" ? "busy" : "listener_failed",
          ),
        );
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: "127.0.0.1",
        port:
          portForScope(scopeKey) -
          (purpose === "transaction" ? PORT_RANGE_SIZE : 0),
        exclusive: true,
      });
    });

    try {
      if (purpose === "transaction") return new ExecutionLease(server, -1);
      if (process.platform === "win32") {
        if (!stateDirectory)
          throw new ExecutionLeaseError("unsupported_runtime");
        const file = await windowsLeaseFile(stateDirectory, scopeKey);
        return new ExecutionLease(server, file.fd, file);
      }
      return new ExecutionLease(server, listeningFd(server));
    } catch (error) {
      await new Promise<void>((r) => server.close(() => r()));
      throw error;
    }
  } catch (error) {
    if (error instanceof ExecutionLeaseError) throw error;
    throw new ExecutionLeaseError("listener_failed");
  }
}
