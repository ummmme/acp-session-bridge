# ACP Session Bridge

Use a local coding agent from an MCP client and keep the conversation open for follow-up questions. For example, Claude Code can ask Gemini to review a diff through Antigravity CLI, inspect the result, and ask about a specific finding in the same session.

```text
Claude Code (MCP client) ──MCP──> acp-mcp ──ACP──> agy acp ──> Gemini
```

This is a fork of [kxress/acp-mcp](https://github.com/kxress/acp-mcp). The server and build artifact retain the name `acp-mcp`. The host decides what to delegate; the downstream agent supplies the models, credentials, and tools.

## Quick start: Claude Code and Antigravity CLI

**Prerequisites:** Node.js 24.12.0 or newer, npm, Claude Code, and an installed, authenticated `agy` with the `acp` subcommand. The shell commands below are for macOS or Linux.

**1. Build this fork.** Keep the checkout in a stable location: Claude Code will launch the bundle from that directory.

```sh
git clone https://github.com/ummmme/acp-session-bridge.git
cd acp-session-bridge
npm ci
npm run build
node dist/acp-mcp.mjs --version
```

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

**3. Register and verify the bridge.** Run this from the checkout you built. `--scope user` makes the server available across projects; `--config` selects the exact configuration file instead of merging repository configuration.

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  "$(command -v node)" "$PWD/dist/acp-mcp.mjs" --config "$HOME/.acp-mcp.json"
claude mcp get acp-session-bridge
```

`Connected` verifies the MCP connection. In Claude Code, ask **“Use `acp-session-bridge` to list the models advertised by `local-agy`.”** A model list verifies the downstream ACP connection as well. Select the model from that list: the interactive CLI and ACP interface can offer different choices.

Other MCP hosts can use the same stdio command and arguments. To connect a different agent, choose a [built-in profile](src/agents/registry_profiles.ts) or configure its stdio executable in the trusted configuration file. Install and authenticate each downstream agent separately.

## One question or an ongoing review?

| Need | MCP tools | What to keep |
| --- | --- | --- |
| One answer | `run_task` with `agentId`, `cwd`, and `task` | The returned result |
| Follow-up questions, progress, or approvals | `start_session`, then `prompt` and `get_events` | The bridge `sessionId` and downstream `acpSessionId` |

For an ongoing review:

1. Call `start_session` with `agentId: "local-agy"`, an absolute project `cwd`, and `permissionPolicy: "operator"` if the host will handle approvals. Leave out the initial prompt so the caller obtains both session IDs before work begins.
2. Call `prompt` with the **bridge** `sessionId`, the review instructions in `text`, and `wait: false`. Save the returned `promptId`.
3. Poll `get_events`. Pass each `nextSequence` back as `afterSequence`, even when the visible event list is empty. Check the matching prompt snapshot for its terminal state and stop reason. With `operator`, inspect pending requests via `get_session` and pass an offered option ID to `resolve_permission`.
4. An `end_turn` finishes the answer. Stop polling and keep the session for the next question. Use `close_session` when finished with the **session**; closing a running session can cancel its prompt.

The bridge on `master` supports **eight managed sessions per server process**. `list_sessions` shows the handles owned by that process. After a bridge restart, use the downstream `acpSessionId`, agent ID, and original working directory with `load_session` if the downstream agent supports resumption.

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
