# ACP Session Bridge

把 Claude Code 和 Gemini 连起来的本地桥接工具，复用本机已登录的 Antigravity CLI（`agy`）调用 Gemini。在 Claude Code 里输入 `/gemini`，就能让 Gemini 评审刚讨论的方案或代码，接着追问，或另开一个会话听取独立意见。

[English README](./README.md) · [下载 v0.3.1](https://github.com/ummmme/acp-session-bridge/releases/tag/v0.3.1)

```text
/gemini 看看刚才的方案：用总点击次数除以会话数作为点击率，有什么问题？
/gemini 把刚才的反例换成一组具体数字。
/gemini new 从测试角度独立评审这个公式：点击率 = 总点击次数 / 会话数。
```

## 主要功能

- **对话内发起评审**：在 Claude Code 里直接用 `/gemini` 提问，Claude 会传递相关背景，Gemini 也可以读取你授权的项目文件，无需切终端复制粘贴。
- **会话延续**：在同一个 Claude Code 对话、同一个项目里连续提问会自动续聊；Gemini 答完一轮后保持空闲等待追问，关闭 Gemini 会话不会影响 Claude Code。
- **项目内多线并行**：用 `/gemini new` 另开独立评审，会话按 `A`、`B` 依次编号，随时通过 `/gemini list` 查看、`/gemini use` 切换。
- **其他助手**：除 `agy` 外，也可以接入其他支持 ACP 协议的本地编码助手。

## 前置条件

- 已安装并可正常使用的 [Claude Code](https://code.claude.com/docs/en/quickstart)
- 本机已安装并登录 **Antigravity CLI**（命令名 `agy`）：
  - 安装：[Antigravity CLI 官网](https://antigravity.google/product/antigravity-cli)
  - 登录：[官方登录说明](https://antigravity.google/docs/install)
- 使用 Node ZIP 或从源码构建时，需要 Node.js **24.12.0** 或更新版本；原生包自带运行时。

在系统终端执行下面的命令确认 `agy` 支持 ACP 桥接：

```sh
agy help acp
```

看到 `Usage: agy acp` 和帮助信息即可继续。如果尚未登录 Google 账号，先运行 `agy acp --login`。

## 安装与配置

> 以下命令在**系统终端**执行；`/gemini` 相关命令在 **Claude Code 对话框**输入。Windows 用户可直接查看[Windows 安装](#windows-安装)。

### 1. 下载并解压到固定目录

在 [v0.3.1 Releases](https://github.com/ummmme/acp-session-bridge/releases/tag/v0.3.1) 的 **Assets** 中下载对应平台的压缩包：

| 平台 | 压缩包 |
| --- | --- |
| Apple 芯片 Mac（M 系列） | `acp-mcp-0.3.1-macos-arm64.tar.gz` |
| Intel Mac | `acp-mcp-0.3.1-node.zip`（需 Node.js >= 24.12.0） |
| Linux x86_64 | `acp-mcp-0.3.1-linux-x86_64.tar.gz` |
| Windows x86_64 | `acp-mcp-0.3.1-windows-x86_64.zip` |

<details>
<summary>可选：核对 SHA-256 校验文件</summary>

在下载目录执行，确保压缩包和同名 `.sha256` 文件放在一起。

```sh
# macOS（Intel Mac 请替换为 Node ZIP 对应的 .sha256 文件名）
shasum -a 256 -c acp-mcp-0.3.1-macos-arm64.tar.gz.sha256
```

```sh
# Linux
sha256sum -c acp-mcp-0.3.1-linux-x86_64.tar.gz.sha256
```

输出 `OK` 即校验通过。

</details>

将压缩包解压到一个**固定目录**，并在终端进入该目录（目录下应能看到 `skills/`）。Claude Code 会从这个路径启动服务，注册后移动或删除目录会导致连接失败。

macOS 原生包未做 Apple 公证；如果系统阻止启动，改用 `acp-mcp-0.3.1-node.zip`。

### 2. 安装 Skill 并配置 `agy`

发行包包含两个 Skill：`gemini` 提供 `/gemini` 命令，`acp-mcp` 指导 Claude 调用其他本地 ACP 编码助手。在解压目录执行安装（若已有同名 Skill 会跳过，避免误覆盖）：

```sh
mkdir -p "$HOME/.claude/skills"
for name in acp-mcp gemini; do
  dest="$HOME/.claude/skills/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '已存在，请先比较再升级：%s\n' "$dest"
  else
    cp -R "skills/$name" "$dest"
  fi
done
```

接着运行 `command -v agy` 获取绝对路径，在个人主目录新建 `~/.acp-mcp.json`，将 `command` 替换为实际路径（如果文件已存在，保留原内容，只合并 `agents.local-agy` 一项）：

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

### 3. 注册 MCP 服务

仍在解压目录内，根据下载的包选择对应命令执行。

macOS / Linux 原生包：

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  "$PWD/acp-mcp" --config "$HOME/.acp-mcp.json"
```

Node ZIP：

```sh
claude mcp add --scope user --transport stdio acp-session-bridge -- \
  "$(command -v node)" "$PWD/acp-mcp.mjs" --config "$HOME/.acp-mcp.json"
```

检查连接状态：

```sh
claude mcp get acp-session-bridge
```

看到 **`Status: ✔ Connected`** 即注册成功。

### Windows 安装

<details>
<summary>展开 Windows x86_64 的 PowerShell 步骤</summary>

先完成「前置条件」检查。在 PowerShell 中进入下载目录，如需核对完整性：

```powershell
$archive = 'acp-mcp-0.3.1-windows-x86_64.zip'
$expected = ((Get-Content "$archive.sha256" -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw 'SHA-256 校验失败' }
```

解压到固定目录并进入（应能看到 `acp-mcp.exe` 和 `skills`），将 `skills\acp-mcp` 和 `skills\gemini` 复制到 `$HOME\.claude\skills\`（已有同名目录先备份比较）。

运行 `(Get-Command agy).Source` 获取路径，在主目录新建 `.acp-mcp.json`（格式同上），把路径中的 `\` 写成 `/`（如 `C:/Tools/agy.exe`）以避免 JSON 转义问题。已有配置文件时只合并 `local-agy`。

注册并检查服务：

```powershell
$bridge = (Resolve-Path '.\acp-mcp.exe').Path
$config = (Join-Path $HOME '.acp-mcp.json')
claude mcp add --scope user --transport stdio acp-session-bridge -- "$bridge" --config "$config"
claude mcp get acp-session-bridge
```

看到 `Connected` 后继续下面的首次验证。

</details>

## 首次验证

在任意项目目录新开一个 Claude Code 会话，在**同一个对话框**里依次输入两轮测试：

```text
/gemini 记住本次讨论的代号“青竹”，只回复收到。
/gemini 让 Gemini 回答上一轮我给它的代号是什么，提问时不要把代号发给它。
```

首次使用若提示选择模型，从 `agy` 实际列出的 Gemini 型号里选一个即可。第二轮正确返回 **“青竹”**，说明桥接和会话延续均已跑通。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `/gemini <问题>` | 在当前项目的活跃会话中提问或追问；首次调用自动创建会话 |
| `/gemini new <问题>` | 另开一个独立会话（不带入旧会话上下文），按 `A`、`B` 依次编号 |
| `/gemini list` | 查看当前项目有哪些会话，以及哪个是当前活跃会话 |
| `/gemini use <标签>` | 切换到指定会话（如 `/gemini use A`），下一句 `/gemini` 会接着该会话聊 |
| `/gemini close [标签]` | 关闭空闲会话（如 `/gemini close B`，省略标签时关闭当前空闲会话）；如果正在回答或等待审批，任务会保留 |
| `/gemini config set server <名称>` | 指向自定义名称注册的 MCP 服务 |

## 文件与路径

| 路径 | 作用 |
| --- | --- |
| `<解压目录>/acp-mcp`（或 `acp-mcp.mjs`） | MCP 桥接服务本体，负责管理 ACP 进程与多轮会话 |
| `~/.claude/skills/gemini/` | 提供 `/gemini` 交互命令、项目会话与模型偏好管理 |
| `~/.claude/skills/acp-mcp/` | 通用 Skill，指导 Claude 发现模型、委派任务与处理权限 |
| `~/.acp-mcp.json` | 助手配置文件，定义 `local-agy` 等本地 ACP 助手的启动命令与参数 |

## 数据与权限边界

发给 Gemini 的问题、Claude 整理的相关上下文，以及 Gemini 读取的文件内容，都可能发送给模型提供方。请只授权本次任务需要的材料。

- 评审前明确指定允许读取的文件或 diff 范围，避免传入密钥或无关仓库。
- `--sandbox` 仅代表传递给 `agy acp` 的启动参数；如果源码必须强制只读，请在操作系统层面提供只读工作区。

## 常见问题

**输入 `/gemini` 没反应或提示找不到命令**：确认 `~/.claude/skills/gemini/SKILL.md` 存在，然后新开一个 Claude Code 会话试试 `/gemini list`。

**找不到服务，或服务显示未连接**：先用 `claude mcp list` 查看实际注册名。例如，注册名是 `gemini-agy`，就运行 `claude mcp get gemini-agy`。若显示 `Connected`，在 Claude Code 里输入 `/gemini config set server gemini-agy`，让 Skill 使用该服务。若实际注册的服务显示未连接，再检查解压目录是否被移动或删除，以及注册命令是否指向安装的可执行文件或 Node 包。

**服务已连接，但 Gemini 没有回复**：核对 `~/.acp-mcp.json` 中 `command` 路径是否正确，在终端确认 `agy` 登录状态正常；若提示模型不可用，查看当前账号实际可选的 Gemini 型号。

## 开发者与扩展

桥接服务可执行文件名为 `acp-mcp`，其他支持 MCP 的客户端也可以直接接入，通过 ACP 调用本机编码助手。每个服务进程默认可托管 **20 个会话**：

- 一次性任务：调用 `run_task`
- 多轮任务：调用 `start_session` 和 `prompt`

从源码构建与运行（需要 Node.js **>= 24.12.0**）：

```sh
npm ci
npm run build
```

构建后，Skill 位于 `.agents/skills/`，注册 MCP 服务时使用 `node` 和 `dist/acp-mcp.mjs` 的绝对路径。

相关文档与源码入口：
- [通用 Skill](.agents/skills/acp-mcp/SKILL.md) · [Gemini Skill](.agents/skills/gemini/SKILL.md)
- [MCP 工具与参数定义](src/mcp/server.ts) · [助手配置结构](src/agents/config.ts)
- [发布工作流](.github/workflows/release.yml) · [版本记录](CHANGELOG.md)

## 许可

本项目基于 [kxress/acp-mcp](https://github.com/kxress/acp-mcp)，遵循 [WTFPL v2](LICENSE)。
