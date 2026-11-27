import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = process.env.ACP_TEST_CLAUDE_CLI;
const run = promisify(execFile);
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Exercise the installed host and bundled MCP over stdio, without provider credentials.
// A deterministic loopback model selects tools; the fixture ACP alone remembers the codes.
test(
  "Claude --resume expands the same Skill identity and recalls B through the bundled bridge",
  { skip: !cli, timeout: 150000 },
  async () => {
    const temp = await realpath(
        await mkdtemp(join(tmpdir(), "acp-claude-resume-")),
      ),
      project = join(temp, "project"),
      home = join(temp, "home"),
      cfg = join(home, ".claude"),
      skill = join(project, ".claude", "skills", "gemini");
    const session = randomUUID(),
      codes = [randomUUID(), randomUUID()];
    const agentConfig = join(temp, "agents.json"),
      mcp = join(temp, "mcp.json"),
      audit = join(temp, "audit"),
      prompts = join(temp, "prompts");
    let phase = 0,
      step = 0,
      expanded = "",
      handle = "",
      fault = "";
    const endpoint = createServer(async (req, res) => {
      try {
        if (!req.url?.includes("/messages")) {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const q = JSON.parse(body);
        if (req.url.includes("count_tokens")) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end('{"input_tokens":20}');
          return;
        }
        // Search only the newest invocation: earlier Skill expansions also occur in resumed history.
        const message = [...q.messages]
          .reverse()
          .find(
            (m) =>
              m.role === "user" &&
              JSON.stringify(m.content).includes(
                "The host conversation ID for this invocation is",
              ),
          );
        const match =
          message &&
          /The host conversation ID for this invocation is `([^`]+)`/.exec(
            JSON.stringify(message.content),
          );
        assert.equal(
          match?.[1],
          session,
          "Skill identity missing or unexpanded",
        );
        expanded = match![1];
        const scope = { clientConversationId: expanded, cwd: project };
        const resultMessage = [...q.messages]
          .reverse()
          .find(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b: { type?: string }) => b.type === "tool_result",
              ),
          );
        const recent = JSON.stringify(resultMessage?.content ?? []);
        const blocks = [];
        if (step === 0) {
          blocks.push({
            type: "tool_use",
            id: `toolu_${randomUUID()}`,
            name:
              phase < 2
                ? "mcp__fixture__start_session"
                : "mcp__fixture__load_session",
            input:
              phase < 2
                ? {
                    ...scope,
                    agentId: "fake",
                    model: "pro",
                    thoughtConfigId: "thought_level",
                    config: { thought_level: "high" },
                    permissionPolicy: "operator",
                  }
                : { ...scope, agentId: "fake", permissionPolicy: "operator" },
          });
        } else if (step === 1) {
          const h = recent
            .replace(/\\/g, "")
            .match(/"sessionId"\s*:\s*"([\w-]+)"/);
          assert.ok(h, `Missing MCP handle: ${recent.slice(-800)}`);
          handle = h[1];
          blocks.push({
            type: "tool_use",
            id: `toolu_${randomUUID()}`,
            name: "mcp__fixture__prompt",
            input: {
              sessionId: handle,
              clientConversationId: expanded,
              wait: true,
              text: phase < 2 ? `remember:${codes[phase]}` : "recall",
            },
          });
        } else {
          assert.ok(
            recent.includes(codes[Math.min(phase, 1)]),
            `Missing downstream answer: ${recent.slice(-800)}`,
          );
          blocks.push({ type: "text", text: "verified synthetic reply" });
        }
        step++;
        const messageId = `msg_${randomUUID()}`;
        const stop = blocks[0].type === "text" ? "end_turn" : "tool_use";
        const envelope = {
          id: messageId,
          type: "message",
          role: "assistant",
          model: q.model,
          content: blocks,
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 8 },
        };
        if (!q.stream) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(envelope));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, data: object) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        event("message_start", {
          message: { ...envelope, content: [], stop_reason: null },
        });
        for (const [index, block] of blocks.entries()) {
          const tool = block.type === "tool_use";
          event("content_block_start", {
            index,
            content_block: tool
              ? { ...block, input: {} }
              : { type: "text", text: "" },
          });
          event("content_block_delta", {
            index,
            delta: tool
              ? {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                }
              : { type: "text_delta", text: block.text },
          });
          event("content_block_stop", { index });
        }
        event("message_delta", {
          delta: { stop_reason: stop, stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        event("message_stop", {});
        res.end();
      } catch (e) {
        fault = String(e);
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: fault },
          }),
        );
      }
    });
    try {
      await mkdir(skill, { recursive: true });
      await mkdir(cfg, { recursive: true });
      await mkdir(join(project, ".git"));
      await copyFile(
        source("../.agents/skills/gemini/SKILL.md"),
        join(skill, "SKILL.md"),
      );
      await writeFile(
        agentConfig,
        JSON.stringify({
          agents: {
            fake: {
              command: process.execPath,
              args: [source("./fixtures/fake_scoped_session_agent.ts")],
              modelConfigId: "model",
              env: {
                ACP_SCOPED_FIXTURE_STATE: join(temp, "downstream"),
                ACP_SCOPED_FIXTURE_AUDIT: audit,
                ACP_SCOPED_FIXTURE_PROMPTS: prompts,
              },
            },
          },
        }),
      );
      await writeFile(
        mcp,
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [source("../dist/acp-mcp.mjs"), "--config", agentConfig],
              env: { HOME: home, USERPROFILE: home },
            },
          },
        }),
      );
      await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
      const address = endpoint.address();
      assert.ok(address && typeof address !== "string");
      for (phase = 0; phase < 3; phase++) {
        step = 0;
        expanded = "";
        const args = [
          "-p",
          "--output-format",
          "json",
          "--model",
          "sonnet",
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--mcp-config",
          mcp,
          "--allowedTools",
          "mcp__fixture__start_session,mcp__fixture__load_session,mcp__fixture__prompt",
          "--tools",
          "",
          phase ? "--resume" : "--session-id",
          session,
          "--",
          phase < 2 ? `/gemini new remember:${codes[phase]}` : "/gemini recall",
        ];
        const result: { stdout: string } = await run(cli!, args, {
          cwd: project,
          timeout: 40000,
          env: {
            HOME: home,
            USERPROFILE: home,
            PATH: process.env.PATH,
            CLAUDE_CONFIG_DIR: cfg,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            ANTHROPIC_API_KEY: "local-synthetic-key",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            ENABLE_TOOL_SEARCH: "false",
          },
        }).catch((e) => {
          throw new Error(
            `${fault} ${e.stdout ?? ""} ${e.stderr ?? ""}`.slice(-1600),
          );
        });
        assert.equal(fault, "");
        assert.equal(step, 3, result.stdout.slice(-600));
        assert.equal(expanded, session);
      }
      const lines = (await readFile(prompts, "utf8"))
        .trim()
        .split("\n")
        .map((l) => l.split("\t"));
      assert.equal(lines.length, 3);
      assert.notEqual(lines[0][0], lines[1][0]);
      assert.deepEqual(lines[2], [lines[1][0], "recall"]);
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((r) => endpoint.close(() => r()));
      await rm(temp, { recursive: true, force: true });
    }
  },
);
