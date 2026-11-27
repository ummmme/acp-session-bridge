import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

function bridge(home: string, config: string) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "--config",
      config,
    ],
    {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const done = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let id = 0;
  async function request(method: string, params: Record<string, unknown>) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n",
    );
    for (;;) {
      const line = await lines.next();
      assert.ok(!line.done, "early bridge exit");
      const response = JSON.parse(line.value);
      if (response.id === id) {
        assert.ok(!response.error, JSON.stringify(response.error));
        return response.result;
      }
    }
  }
  return {
    child,
    done,
    init: async () => {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "scoped-test", version: "1" },
        capabilities: {},
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
    },
    call: async (name: string, args: Record<string, unknown>) => {
      const r = await request("tools/call", { name, arguments: args });
      const text = r.content[0].text;
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    },
    close: async () => {
      child.stdin.end();
      await done;
    },
  };
}

test(
  "independent bridges restore B at its original cwd; paused and orphaned executors prevent even spawn",
  { timeout: 30000 },
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "acp-stdio-bookmarks-")),
    );
    const project = join(home, "project"),
      sub = join(project, "sub"),
      hold = join(home, "hold"),
      audit = join(home, "audit");
    const conf = join(home, "config.json");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(sub);
    await writeFile(hold, "");
    const fixture = new URL(
      "./fixtures/fake_scoped_session_agent.ts",
      import.meta.url,
    );
    let command = process.execPath,
      args = [fileURLToPath(fixture)];
    if (process.platform === "win32") {
      // Match the direct native launch shape using only the local Node fixture.
      command = join(home, "agy.exe");
      await copyFile(process.execPath, command);
      args = ["acp"];
      await writeFile(
        join(sub, "acp"),
        `import(${JSON.stringify(fixture.href)})`,
      );
    }
    await writeFile(
      conf,
      JSON.stringify({
        agents: {
          fake: {
            command,
            args,
            env: {
              ACP_SCOPED_FIXTURE_HOLD: hold,
              ACP_SCOPED_FIXTURE_AUDIT: audit,
              ACP_SCOPED_FIXTURE_STATE: join(home, "fixture-state"),
            },
            modelConfigId: "model",
          },
        },
      }),
    );
    const scope = { clientConversationId: randomUUID(), cwd: sub },
      load = { ...scope, cwd: project, agentId: "fake" };
    const p1 = bridge(home, conf),
      p2 = bridge(home, conf),
      p3 = bridge(home, conf),
      p4 = bridge(home, conf);
    try {
      await Promise.all([p1.init(), p2.init(), p3.init(), p4.init()]);
      const codeA = randomUUID(),
        codeB = randomUUID();
      const start = {
        ...scope,
        agentId: "fake",
        model: "pro",
        config: { thought_level: "high" },
        thoughtConfigId: "thought_level",
      };
      const a = await p1.call("start_session", {
        ...start,
        prompt: `remember:${codeA}`,
      });
      const b = await p1.call("start_session", {
        ...start,
        prompt: `remember:${codeB}`,
      });
      await p1.close();
      const restored = await p2.call("load_session", load);
      assert.equal(restored.label, "B");
      assert.equal(restored.acpSessionId, b.acpSessionId);
      assert.notEqual(restored.sessionId, b.sessionId);
      const recalled = await p2.call("prompt", {
        sessionId: restored.sessionId,
        text: "recall",
        clientConversationId: scope.clientConversationId,
      });
      assert.equal(recalled.text, codeB);
      const events = await p2.call("get_events", {
        ...scope,
        afterSequence: 0,
      });
      assert.ok(events.events.length);
      const renamed = await p2.call("rename_session", {
        ...scope,
        target: "B",
        name: "QA review",
      });
      assert.equal(renamed.label, "B");
      const selected = await p2.call("load_session", { ...load, target: "A" });
      assert.equal(selected.acpSessionId, a.acpSessionId);
      assert.equal(
        (
          await p2.call("prompt", {
            sessionId: selected.sessionId,
            text: "recall",
          })
        ).text,
        codeA,
      );
      await p2.call("load_session", { ...load, target: "QA review" });
      await p2.call("close_session", { ...scope, target: "A", ifIdle: true });
      const status = await p2.call("get_session", {
        ...scope,
        includePromptText: false,
      });
      assert.equal(status.label, "B");
      const before = await readFile(audit, "utf8");
      assert.ok(before.includes(`load ${b.acpSessionId} ${sub}`));
      if (process.platform !== "win32") p2.child.kill("SIGSTOP");
      await assert.rejects(p3.call("load_session", load), /session_occupied/);
      assert.equal(await readFile(audit, "utf8"), before);
      p2.child.kill("SIGKILL");
      await p2.done;
      await assert.rejects(p3.call("load_session", load), /session_occupied/);
      assert.equal(await readFile(audit, "utf8"), before);
      await unlink(hold);
      {
        const deadline = Date.now() + 5000;
        for (;;) {
          const attempts = await Promise.allSettled([
            p3.call("load_session", load),
            p4.call("load_session", load),
          ]);
          const winners = attempts.filter((r) => r.status === "fulfilled");
          for (const r of attempts)
            if (r.status === "rejected")
              assert.match(String(r.reason), /session_occupied|scope_busy/);
          if (winners.length) {
            assert.equal(winners.length, 1);
            assert.equal(winners[0].value.acpSessionId, b.acpSessionId);
            break;
          }
          assert.ok(Date.now() < deadline, "old child remained occupied");
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(
          (await readFile(audit, "utf8"))
            .slice(before.length)
            .split("\n")
            .filter((l) => l.startsWith("load ")).length,
          1,
        );
      }
    } finally {
      await rm(hold, { force: true });
      for (const p of [p1, p2, p3, p4]) {
        if (p.child.exitCode === null && p.child.signalCode === null) {
          if (process.platform !== "win32") p.child.kill("SIGCONT");
          await p.close();
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);
