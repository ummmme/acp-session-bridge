# ACP Session Bridge

A local bridge that connects Claude Code to Gemini using your existing Antigravity CLI (`agy`) sign-in. Type `/gemini` to get a second opinion on a plan or code change, ask follow-up questions in the same session, or start a separate review without losing the first conversation.

[Download v0.3.1](https://github.com/ummmme/acp-session-bridge/releases/tag/v0.3.1) · [中文 README](./README.zh.md)

```text
/gemini Review the plan we just discussed: what's wrong with defining CTR as total clicks divided by sessions?
/gemini Turn that counterexample into a concrete set of numbers.
/gemini new Independently review this formula from a QA perspective: CTR = total clicks / sessions.
```

## Features

- **In-chat reviews**: Invoke `/gemini` directly inside Claude Code. Claude passes along the relevant context, and Gemini can read the project files you authorize—no terminal switching or manual copy-pasting.
- **Session continuity**: Follow-up prompts in the same Claude Code conversation and project automatically continue the active Gemini session. Gemini stays idle between turns; closing a Gemini session does not close Claude Code.
- **Multiple threads per project**: Use `/gemini new` to start an independent review thread. Sessions are labeled `A`, `B`, etc., and can be listed with `/gemini list` or switched with `/gemini use`.
- **Other ACP agents**: Beyond `agy`, the bridge can connect to other local coding agents that speak the ACP protocol.

## Prerequisites

- A working [Claude Code](https://code.claude.com/docs/en/quickstart) installation
- **Antigravity CLI** (`agy`) installed and signed in locally:
  - Install: [Antigravity CLI](https://antigravity.google/product/antigravity-cli)
  - Sign in: [Official login guide](https://antigravity.google/docs/install)
- Node.js **24.12.0** or later if using the Node ZIP or building from source (native bundles include the runtime).

Verify in your terminal that `agy` supports ACP:

```sh
agy help acp
```

You should see `Usage: agy acp` and help output. If you haven't signed in with your Google account yet, run `agy acp --login`.

## Installation & Setup

> Run setup commands in your **system terminal**, and enter `/gemini` commands in the **Claude Code chat input**. Windows users can jump to [Windows Setup](#windows-setup).

### 1. Download and extract to a permanent directory

Download the matching archive from the **Assets** section of [v0.3.1 Releases](https://github.com/ummmme/acp-session-bridge/releases/tag/v0.3.1):

| Platform | Archive |
| --- | --- |
| Apple Silicon Mac (M-series) | `acp-mcp-0.3.1-macos-arm64.tar.gz` |
| Intel Mac | `acp-mcp-0.3.1-node.zip` (requires Node.js >= 24.12.0) |
| Linux x86_64 | `acp-mcp-0.3.1-linux-x86_64.tar.gz` |
| Windows x86_64 | `acp-mcp-0.3.1-windows-x86_64.zip` |

<details>
<summary>Optional: Verify the SHA-256 checksum</summary>

Run this in your download directory with the archive and its matching `.sha256` file side by side.

```sh
# macOS (for Intel Mac, substitute the Node ZIP .sha256 filename)
shasum -a 256 -c acp-mcp-0.3.1-macos-arm64.tar.gz.sha256
```

```sh
# Linux
sha256sum -c acp-mcp-0.3.1-linux-x86_64.tar.gz.sha256
```

Confirm the output ends with `OK`.

</details>

Extract the archive to a **permanent directory** and `cd` into it (you should see `skills/` inside). Claude Code launches the server from this path—moving or deleting the directory later will break the connection.

The macOS native binary is not Apple-notarized; if macOS blocks it from running, use `acp-mcp-0.3.1-node.zip` instead.

### 2. Install Skills and configure `agy`

The release includes two Skills: `gemini` provides the `/gemini` command, and `acp-mcp` guides Claude when working with other local ACP agents. From the extracted directory, run (existing Skills are skipped to prevent accidental overwrites):

```sh
mkdir -p "$HOME/.claude/skills"
for name in acp-mcp gemini; do
  dest="$HOME/.claude/skills/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf 'Already exists—compare before upgrading: %s\n' "$dest"
  else
    cp -R "skills/$name" "$dest"
  fi
done
```

Next, run `command -v agy` to get its absolute path. Create `~/.acp-mcp.json` in your home directory and replace `command` with the actual path (if the file already exists, keep your existing entries and merge only `agents.local-agy`):

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

### 3. Register the MCP server

Still in the extracted directory, run the command matching your package.

macOS / Linux native bundle:

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  "$PWD/acp-mcp" --config "$HOME/.acp-mcp.json"
```

Node ZIP:

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  "$(command -v node)" "$PWD/acp-mcp.mjs" --config "$HOME/.acp-mcp.json"
```

Check the connection status:

```sh
claude mcp get acp-session-bridge
```

Seeing **`Status: ✔ Connected`** confirms registration succeeded.

### Windows Setup

<details>
<summary>Expand Windows x86_64 PowerShell steps</summary>

Complete the Prerequisites check first. In PowerShell, `cd` into your download directory and optionally verify the checksum:

```powershell
$archive = 'acp-mcp-0.3.1-windows-x86_64.zip'
$expected = ((Get-Content "$archive.sha256" -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw 'SHA-256 verification failed' }
```

Extract to a permanent directory and `cd` into it (you should see `acp-mcp.exe` and `skills`). Copy `skills\acp-mcp` and `skills\gemini` into `$HOME\.claude\skills\` (back up and compare first if those directories already exist).

Run `(Get-Command agy).Source` to find `agy`. Create `.acp-mcp.json` in your home directory using the JSON structure from step 2, replacing `\` with `/` in the path (for example, `C:/Tools/agy.exe`) to avoid JSON escaping issues. If the file already exists, merge only `local-agy`.

Register and verify the server:

```powershell
$bridge = (Resolve-Path '.\acp-mcp.exe').Path
$config = (Join-Path $HOME '.acp-mcp.json')
claude mcp add --scope user --transport stdio acp-session-bridge -- "$bridge" --config "$config"
claude mcp get acp-session-bridge
```

Once it shows `Connected`, proceed to the verification step below.

</details>

## First-Run Verification

Start a new Claude Code session in any project directory and send these two prompts in the **same conversation**:

```text
/gemini Remember the codename "Bamboo" for this discussion. Reply with "OK" only.
/gemini Ask Gemini what codename I gave it in the previous turn. Don't include the codename in your question.
```

If prompted to choose a model on first use, pick one of the Gemini models listed by `agy`. Getting **"Bamboo"** back on the second turn confirms that both the bridge and session continuity are working.

## Command Reference

| Command | Behavior |
| --- | --- |
| `/gemini <prompt>` | Ask or follow up in the active project session; creates a session on first use |
| `/gemini new <prompt>` | Start a fresh, independent session without prior context (labeled `A`, `B`, ...) |
| `/gemini list` | List sessions in the current project and show which one is active |
| `/gemini use <label>` | Switch to a session (e.g., `/gemini use A`); the next `/gemini` prompt continues it |
| `/gemini close [label]` | Close an idle session (e.g., `/gemini close B`, or omit `[label]` to close the current idle session); active or pending-approval runs are kept |
| `/gemini config set server <name>` | Point the Skill to an MCP server registered under a custom name |

**v0.4 development build:** `claude --resume` followed by `/gemini <question>` restores the selected thread for that Claude conversation and project. `/gemini rename B QA-review` names a thread; `/gemini status` shows its saved or live state without waking the agent. If the previous answer was interrupted, check its effects before confirming a new question. The bridge never resends the old prompt.

## Files & Paths

| Path | Purpose |
| --- | --- |
| `<install-dir>/acp-mcp` (or `acp-mcp.mjs`) | MCP bridge server that manages ACP processes and multi-turn sessions |
| `~/.claude/skills/gemini/` | Provides `/gemini` commands, project session tracking, and model preferences |
| `~/.claude/skills/acp-mcp/` | Generic Skill for model discovery, task delegation, and permission handling |
| `~/.acp-mcp.json` | Agent config defining launch commands and arguments for `local-agy` and other ACP agents |

## Data & Permission Boundaries

Prompts sent to Gemini, relevant context provided by Claude, and the contents of files Gemini reads may be sent to the model provider. Authorize only the materials needed for the task.

- Explicitly scope the files or diff range before starting a review; avoid passing secrets or unrelated repositories.
- `--sandbox` is simply a flag forwarded to `agy acp`. When source code must stay strictly read-only, enforce it at the OS level with a read-only workspace.

## Troubleshooting

**`/gemini` does nothing or is not recognized**: Confirm that `~/.claude/skills/gemini/SKILL.md` exists, then open a new Claude Code session and try `/gemini list`.

**The server is missing or disconnected**: Run `claude mcp list` to find the name you registered. For example, if it is `gemini-agy`, run `claude mcp get gemini-agy`. If it shows `Connected`, use `/gemini config set server gemini-agy` inside Claude Code to select it. If the registered server is disconnected, check that the extracted directory still exists and that the registered command points to the installed executable or Node bundle.

**Connected, but Gemini returns no reply**: Double-check the `command` path in `~/.acp-mcp.json` and confirm `agy` is logged in from your terminal. If a model is unavailable, check which Gemini models are enabled for your account.

## Developers & Extensions

The bridge executable is named `acp-mcp`. Any MCP-compatible client can connect to it to drive local ACP coding agents. Each server process hosts up to **20 sessions** by default:

- One-shot tasks: `run_task`
- Multi-turn tasks: `start_session` and `prompt`

Build from source (requires Node.js **>= 24.12.0**):

```sh
npm ci
npm run build
```

After building, Skills live under `.agents/skills/`. Register the MCP server using `node` and the absolute path to `dist/acp-mcp.mjs`.

Docs & source pointers:
- [Generic Skill](.agents/skills/acp-mcp/SKILL.md) · [Gemini Skill](.agents/skills/gemini/SKILL.md)
- [MCP Tools & Schema](src/mcp/server.ts) · [Agent Config](src/agents/config.ts)
- [Release Workflow](.github/workflows/release.yml) · [Changelog](CHANGELOG.md)

## License

Based on [kxress/acp-mcp](https://github.com/kxress/acp-mcp), released under [WTFPL v2](LICENSE).
