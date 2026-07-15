# HUD 确认再贴 + 改字即学

> 权威：本文件。UI 服从 [`design-jobs.md`](./design-jobs.md)；数据流服从 [`architecture-local-first.md`](./architecture-local-first.md)。

## 一句话

Fn / ⇧Fn 识别完后 **HUD 停住可编辑**；再按 Fn（或 Enter）才粘贴确认稿。改过字 → 默认进学习待确认；未改直接确认 → 不学。

## 热键

| 时机 | 动作 |
|------|------|
| idle → Fn / ⇧Fn | 开始录音（同前） |
| recording → 松开 Fn | 停录 → 进 **editing**（不粘贴） |
| editing → Fn / Enter | 粘贴确认稿 → 写 history → 关 HUD |
| editing → Esc | 取消：不贴、不写 history |

Agent（Fn+Space）不变：editing → Enter 派发，不走本流程。

## 学习信号

- **仅** `session_mode=fn`（转写）且确认稿 trim ≠ 识别稿 trim：
  - history：`raw_text`=识别稿，`user_text`/`text`=确认稿，`quality_rating=bad`，`learn_status=suggested`
  - 主窗收 `learn-from-hud` → diff 候选项进 `pendingLearn`（静默；LLM 页待确认）
- ⇧Fn 翻译：同样确认再贴；改译稿 **不** 进 ASR 学习列表。

## 实现要点

- Backend：`PendingHudConfirm`；`finalize_successful_result` 对 fn/translate 进 editing；`confirm_floating_transcript` / `cancel_floating_transcript`
- Hotkey：editing 时 Fn → `hud-confirm-request`；Esc → `hud-cancel-request`
- HUD：非 agent editing 用 textarea；学习无 HUD 文案（Jobs：确认态一事 = 改/确认文字）

## 非目标

- 不自动跑 distill LLM
- 不改文件页转写 / Agent 派发
