# Agent Summon (Fn+Space)

> 权威：本文件。UI 服从 [`design-jobs.md`](./design-jobs.md)；数据流服从 [`architecture-local-first.md`](./architecture-local-first.md)。

## 一句话

全局 **Fn+Space** → **原有 floating HUD** 上语音派活；外挂文件 / `@目录`；识别后可编辑；Enter 派发 Claude / Codex / Pi。

## 热键

- 默认：`hotkey_agent` = Fn + Space。
- **第一次**：显示 floating HUD（`intention=agent`）+ 开始录音。
- **再按**（录音中）：停录 → 进入 **editing**（可改文本）。
- **Enter** / 发送：`dispatch_agent`。
- Esc：取消录音 / 关 HUD（仅 agent 态）。
- 抑制本次 Fn 松开的转写粘贴。

### HUD 内快捷键（agent 态）

| Key | Action |
|-----|--------|
| `⌘.` | 打开 Agent 选择（独立窗口，HUD 上方） |
| `⌘/` | 打开工作目录选择（独立窗口，HUD 上方） |
| `↑↓ Enter Esc` | 在打开的菜单里移动 / 选中 / 关闭 |
| `⌘V` / `Ctrl+V` | 从剪贴板粘贴文件或图片为附件 |
| Enter（editing） | 派发 |

## HUD（同一 `floating` webview）

- 复用 ASR capsule；**不**另开 `agent-hud`。
- Agent / cwd 菜单 = 独立 `floating-agent-menu` 窗口，位于 HUD **上方外侧**（非 HUD 内嵌）。
  - NonactivatingPanel、**无 vibrancy**、**不 set_focus**（避免空列表 / 双击）。
  - 实心 CSS 面板；`agent-picker` 事件 + `get_agent_picker` 同步。
- Agent 态：
  - **上**：两个 pill — 左 Agent（读 `agent_profiles`）· 右工作目录（`agent_cwd_history`，首项 `+`）
  - **中胶囊**：bars · **附件 Chip 缩略图（文字前）** · 文本 · `@` 目录 · 📎 文件 · 停录 / 发送
  - 点 Chip → **系统默认应用打开**（`open_path_in_system`：macOS/Windows/Linux；禁止 HUD 内 Modal / 另开预览窗）
  - 默认 cwd = `{app_data}/agent`（自动创建）；历史写入 `agent_cwd_history`
- **新 session 录音**：清空上一轮 ASR 文本（`committed`/`active`/`text`）。
- 识别完成后 `state=editing`：用户改字再派发（不自动派发）。

## 配置

- `agent_profiles[]`：`{ id, name, kind, bin, model }` — **本源**，只在 `/agent` 页头「配置」CRUD。空 `bin` → `which <kind>`（全局 `agent_*_bin` 仅 fallback，UI 不展示）。
- `agent_profile_id`：当前默认；HUD pill 与派发用。
- `kind`：`claude` | `codex` | `pi`。设置页不设 Agent 配置 tab。

## 派发

| Agent | CLI |
|-------|-----|
| Claude | `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --add-dir <cwd> […] -- <prompt>`。`--add-dir` 变参会吞 prompt → 必须 `--`。图片靠 path + Read（parent 在 `--add-dir`）。 |
| Codex | `codex exec --json -C <cwd> -s workspace-write [--skip-git-repo-check] [-i <image>…] -- <prompt>`；stdin=null。图片必须 `-i`，不可只塞 path 进 prompt。非 git → 自动 `--skip-git-repo-check` 并记入 `agent_trusted_dirs`（派发即授权；**禁止**在 IPC 路径弹 blocking 对话框） |
| Pi | `pi -p --mode json --approve [--model <id>] [--session <id>] [@files…] <prompt>`；cwd = job cwd；stdin=null。首行 `type:session` 捕 `session_id`；`tool_execution_*` / `message_end` → timeline。续聊 `--session`。 |

- `mode=agent`：不粘贴、不写 ASR history。
- 事件：`agent-transcription-result` → floating 进编辑态。
- 派发后：关 HUD → 主窗 → `open-agent-job` → `/agent/:id`。
- 持久化：`agent-jobs.json`。

## ASR 注意

- **Qwen**：录音中 dual-emit `partial-result` → floating（与 `audio-level` 同模式）。
- **Apple**：录音中只有音量条；停录后 batch 出字。`floating-status` 合并时不得抹掉已有 committed/active/text（同 session）；**新 session 必须清**。

## Agent 页

- `/agent`：任务列表（无框行 + 状态色点）· 底栏输入派活 · 模型 Select · 页头「配置」/「召唤」。
- `/agent` 配置：profile CRUD（名称 / CLI / 模型 / 路径 + which 探测）；**无**独立「CLI 路径」区。
- `/agent/:id`：任务详情
  - **时间线** `events[]`：user / assistant / tool / tool_result / status / error — 全量写入 `agent-jobs.json`。
  - **对话式 UI**：user 右气泡 · assistant 左无框 MD · tool / tool_result 薄边卡片可折叠（运行中默认开，结束后默认收）。Streamdown 全量 MD；tool JSON 解析失败 → 原命令。
  - **session_id**：Claude 首轮 `--session-id`；流里也可捕获。Codex 从 JSON 捕获 `session_id`/`thread_id`。Pi 从 `type:session` 捕 `id`。
  - **续聊**：底部输入 → `continue_agent_job`；无 session 时底栏可开新任务。发送钮 accent。
  - 底栏 **模型 Select** = CLI 底层模型（`claude --model` / `codex -m` / `pi --model`），**不是**切 Agent 类型。Agent 类型仍由 profile / HUD 选。
  - **模型列表**：磁盘缓存 `agent-models.json`；启动后后台刷新（TTL 6h）；源：Claude 别名静态 · Codex `~/.codex/models_cache.json` · `pi --list-models`。配置页「模型」强制刷新；事件 `agent-models-updated`。

## 非目标

- 不接 OpenAI refine LLM。
- 不用 `claude --bg`。
- 不单独第二 HUD 窗口（agent/cwd 菜单窗除外）。
- 不另起 SQL DB；`agent-jobs.json` 即本地真相。
- 不接 Pi 交互 TUI / RPC。模型下拉走缓存刷新，非每次同步跑全量 list。
