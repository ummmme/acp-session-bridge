import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import {
  acquireExecutionLease,
  type ExecutionLease,
} from "../../src/runtime/execution_lease.ts";

async function runP1(scopeKey: string): Promise<void> {
  let lease: ExecutionLease;
  try {
    lease = await acquireExecutionLease(scopeKey, "execution", tmpdir());
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "helper_failed";
    process.stdout.write(`BUSY ${code}\n`);
    process.exitCode = 2;
    return;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "child"],
    {
      // Exercise an independently living child even when the OS reaps ordinary children.
      detached: true,
      stdio: ["ignore", "pipe", "inherit", lease.childStdio],
      windowsHide: true,
    },
  );
  if (!child.stdout) throw new Error("fixture child stdout was not piped");

  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child startup timeout")),
      5000,
    );
    lines.once("line", (line) => {
      clearTimeout(timer);
      if (line !== "CHILD_READY") reject(new Error("invalid child fixture"));
      else resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error("child exited early"));
    });
  });
  process.stdout.write(`READY ${child.pid ?? "unknown"}\n`);
  process.stdin.resume();
}

function runChild(): void {
  process.stdout.write("CHILD_READY\n");
  const keepAlive = setInterval(() => {}, 60_000);
  process.once("SIGTERM", () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
}

if (process.argv[2] === "child") runChild();
else void runP1(process.argv[2] ?? "");
