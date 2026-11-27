import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/execution_lease_process.ts", import.meta.url),
);

type FixtureResult = { process: ChildProcess; line: Promise<string> };

function startFixture(scopeKey: string): FixtureResult {
  const child = spawn(process.execPath, [fixture, scopeKey], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdout) throw new Error("fixture stdout was not piped");
  const lines = createInterface({ input: child.stdout });
  const line = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fixture startup timeout")),
      8000,
    );
    lines.once("line", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0)
        reject(new Error(`fixture exited before readiness (${code})`));
    });
  });
  return { process: child, line };
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForProcessExit(child);
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture child ${pid} did not exit`);
}

function childPidFrom(line: string): number {
  const match = /^READY (\d+)$/.exec(line);
  assert.ok(match, `expected READY line, got ${line}`);
  return Number(match[1]);
}

function stopKnownChild(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
    ) {
      throw error;
    }
  }
}

test("execution lease follows the managed child's real lifetime across owner death", async () => {
  const key = createHash("sha256").update(randomUUID()).digest("hex");
  const p1 = startFixture(key);
  let childPid: number | undefined;
  let takeover: FixtureResult | undefined;
  try {
    const ready = await p1.line;
    assert.match(ready, /^READY \d+$/);
    childPid = childPidFrom(ready);
    const ownerPid = p1.process.pid;
    const managedChildPid = childPid;
    assert.ok(ownerPid);

    if (process.platform !== "win32") process.kill(ownerPid, "SIGSTOP");
    const pausedP2 = startFixture(key);
    assert.equal(await pausedP2.line, "BUSY busy");
    await waitForProcessExit(pausedP2.process);

    if (process.platform !== "win32") process.kill(ownerPid, "SIGCONT");
    await stopProcess(p1.process);
    assert.doesNotThrow(() => process.kill(managedChildPid, 0));

    const orphanedP2 = startFixture(key);
    assert.equal(await orphanedP2.line, "BUSY busy");
    await waitForProcessExit(orphanedP2.process);

    stopKnownChild(managedChildPid);
    await waitForPidExit(managedChildPid);
    childPid = undefined;

    const contenders = [startFixture(key), startFixture(key)];
    const outcomes = await Promise.all(
      contenders.map((candidate) => candidate.line),
    );
    assert.equal(
      outcomes.filter((line) => line.startsWith("READY ")).length,
      1,
    );
    assert.equal(outcomes.filter((line) => line === "BUSY busy").length, 1);
    const winnerIndex = outcomes.findIndex((line) => line.startsWith("READY "));
    const winnerOutcome = outcomes[winnerIndex];
    const winner = contenders[winnerIndex];
    assert.ok(winnerOutcome);
    assert.ok(winner);
    takeover = winner;
    const winnerPid = childPidFrom(winnerOutcome);
    stopKnownChild(winnerPid);
    await stopProcess(takeover.process);
    takeover = undefined;
  } finally {
    if (takeover) await stopProcess(takeover.process);
    if (p1.process.exitCode === null && p1.process.signalCode === null) {
      await stopProcess(p1.process);
    }
    stopKnownChild(childPid);
    if (childPid !== undefined)
      await waitForPidExit(childPid).catch(() => undefined);
  }
});
