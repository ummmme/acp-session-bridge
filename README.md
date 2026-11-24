# ACP Session Bridge

Use a local coding agent from an MCP client and keep the conversation open for follow-up questions. For example, Claude Code can ask Gemini to review a diff through Antigravity CLI, inspect the result, and ask about a specific finding in the same session.

```text
Claude Code (MCP client) ──MCP──> acp-mcp ──ACP──> agy acp ──> Gemini
```

This is a fork of [kxress/acp-mcp](https://github.com/kxress/acp-mcp). The server and build artifact retain the name `acp-mcp`. The host decides what to delegate; the downstream agent supplies the models, credentials, and tools.

## Quick start: Claude Code and Antigravity CLI

**Install the server and the two Skills from the same 0.3.0 package.** The service provides MCP tools; the [`acp-mcp` Skill](.agents/skills/acp-mcp/SKILL.md) explains how to use them with any ACP agent, and [`gemini`](.agents/skills/gemini/SKILL.md) adds project-scoped follow-ups and session commands in Claude Code. Automation clients can also call the tools directly.

**Prerequisites:** Claude Code and an authenticated `agy` with the `acp` subcommand. The Node package requires Node.js 24.12.0 or newer; the native executable includes its runtime. These shell examples use macOS or Linux.

**1. Extract a package into a new, stable directory.** Download the Node ZIP or a native archive for your platform from [Releases](https://github.com/ummmme/acp-session-bridge/releases) or a [successful candidate build](https://github.com/ummmme/acp-session-bridge/actions/workflows/release.yml). Verify its SHA-256, then run the commands below from the extracted archive root. Each package contains `skills/acp-mcp/SKILL.md` and `skills/gemini/SKILL.md`.

```sh
# Node ZIP:
node ./acp-mcp.mjs --version
# Native archive instead: ./acp-mcp --version (acp-mcp.exe on Windows)
```

Install both Skills in your Claude Code user directory. On first install:

```sh
mkdir -p "$HOME/.claude/skills"
for name in acp-mcp gemini; do
  dest="$HOME/.claude/skills/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf 'Already installed: %s. Compare and back up before upgrading.\n' "$dest"
  else
    cp -R "skills/$name" "$dest"
  fi
done
```

For a source checkout, run `npm ci && npm run build` and use `dist/acp-mcp.mjs` and `.agents/skills/` in place of the archive paths. On Windows, copy both skill directories into `%USERPROFILE%\.claude\skills\` and register the absolute path to `acp-mcp.exe` or the Node bundle.

**2. Configure the agent.** Find the executable with `command -v agy`. In `~/.acp-mcp.json`, add the following entry under `agents` (preserve any existing entries). Replace the example path with the absolute path printed by your shell.

```json
{
  "agents": {
    "local-agy": {
      "command": "/absolute/path/to/agy",
      "args": ["acp", "--sandbox"],
      "acpProtocol": "v1"
    }
  }
}
```

This launches `agy acp` directly. The built-in `antigravity-acp` profile is a different launch route. Its optional `implementation: "agy"` uses a separate adapter that skips tool permission prompts.

**3. Register and verify the bridge.** From the extracted Node archive, register the server with the same name the Gemini Skill will use. Keep this directory after registration. `--scope user` makes the server available across projects; `--config` selects only the specified configuration file.

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  “$(command -v node)” “$PWD/acp-mcp.mjs” --config “$HOME/.acp-mcp.json”
claude mcp get acp-session-bridge
```

For the native archive, use `”$PWD/acp-mcp” --config “$HOME/.acp-mcp.json”` after `--` instead. `Connected` verifies the bridge. Open Claude Code in a project, start with `/gemini list`, then try `/gemini new Remember the test word cedar` followed by `/gemini Which word did I give you?`. A returned answer from the same session verifies the downstream connection. `/gemini new` opens another session without closing the first; `/gemini use A` switches back and `/gemini close A` closes it only when idle.

If you already registered the service under another name, keep that registration and configure the Skill to use it. The optional personal file `~/.config/acp-session-bridge/gemini.json` holds the MCP server name, agent ID, and your preferred model (selected from the agent's live model catalog). Do not put credentials there.

Other MCP hosts can use the same stdio command and arguments. To connect a different agent, choose a [built-in profile](src/agents/registry_profiles.ts) or configure its stdio executable in the trusted configuration file. Install and authenticate each downstream agent separately.

## One question or an ongoing review?

| Need | MCP tools | What to keep |
| --- | --- | --- |
| One answer | `run_task` with `agentId`, `cwd`, and `task` | The returned result |
| Follow-up questions, progress, or approvals | `start_session`, then `prompt` and `get_events` | The bridge `sessionId` and downstream `acpSessionId` |

For an ongoing review:

1. Call `start_session` with `agentId: "local-agy"`, an absolute project `cwd`, and `permissionPolicy: "operator"` if the host will handle approvals. Leave out the initial prompt so the caller obtains both session IDs before work begins.
2. Call `prompt` with the **bridge** `sessionId`, the review instructions in `text`, and `wait: false`. Save the returned `promptId`.
3. Poll `get_events` with `includePromptText: false`. Use `get_session` with the same flag to check approvals without repeating the full answer. Pass each `nextSequence` back as `afterSequence`, even on empty pages. Use an offered option ID to resolve each pending permission request.
4. For the matching `promptId`, `completed` with `end_turn` finishes the answer. Read `get_session` once with `includePromptText: true` and stop polling. Use `close_session` with `ifIdle: true` for manual cleanup: `closed: false, reason: "busy"` preserves running work and pending approvals. Omitting the guard retains the cancel-and-close behavior.

The default limit is **20 managed sessions per server process**, including sessions starting up or shutting down. Finishing a turn keeps its session available. `list_sessions` shows the active handles; reuse one instead of loading the same downstream session twice. After a bridge restart, use the downstream `acpSessionId`, agent ID, and original workspace with `load_session` if the agent supports resumption.

## Configuration and permissions

- **Project policy:** Without `--config`, the bridge merges the home `.acp-mcp.json` with project files from outer to inner directories. A new or resumed session captures the effective configuration. Executables, arguments, environment variables, and protocol selection belong in trusted home or explicit configuration.
- **Model choice:** Explicit selections take precedence over configured and downstream defaults. Model allow/deny rules still apply. Use `list_models` to discover live choices and `get_session` to check an active session's configuration.
- **File access:** `permissionPolicy` controls how the bridge answers **ACP permission requests**. The child runs with the operating-system privileges of its launcher and may read or write files directly. Use an OS-enforced read-only workspace for reviews that must never change source files.
- **Diagnostics:** `node dist/acp-mcp.mjs doctor --json` checks local configuration and launch prerequisites offline. For login, quota, or model availability, check the downstream agent. Keep event logs private: they may contain prompts, file paths, or tool output.

## Checks, builds, and releases

```sh
npm run check         # TypeScript
npm test              # Test suite
npm run lint
npm run format:check
npm run build         # dist/acp-mcp.mjs
```

The [GitHub Actions workflow](.github/workflows/release.yml) runs on pushes to `master` or `v*` tags, and on manual dispatch. It checks and builds the Node package and produces standalone executables for **Windows x86_64, Linux x86_64, and macOS ARM64**. Native builds use Node.js 26; the JavaScript bundle runs with Node.js 24.12.0 or newer.

Download build artifacts from a successful [Actions run](https://github.com/ummmme/acp-session-bridge/actions/workflows/release.yml). A push to `master` or a manual build produces artifacts without publishing a release. A matching version tag push publishes the [release](https://github.com/ummmme/acp-session-bridge/releases) after the build jobs pass. Check the archive's SHA-256 before installing; the macOS executable is unsigned and not notarized.

## Reference

- [MCP tools and input schemas](src/mcp/server.ts)
- [Maintained agent definitions](src/agents/config.ts) and [registry profiles](src/agents/registry_profiles.ts)
- [Upstream v0.2.6 reference](https://github.com/kxress/acp-mcp/blob/v0.2.6/README.md) — native installation, normalized model sizes and effort, ACP v2, and host-specific configuration
- [Changelog](CHANGELOG.md) · [License: WTFPL v2](LICENSE)
