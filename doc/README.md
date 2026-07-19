# asr-cli 技术文档索引

> 更新：2026-07-19。

## 产品 / 架构（每次改 UI 或功能先读）

| 文档 | 用途 |
|------|------|
| [`DESIGN.md`](./DESIGN.md) | **品牌 + 视觉 + IA + 交互/动效（言落）** — 改 UI 先读（Jobs 原则已并入） |
| [`design/v3/`](./design/v3/README.md) | **v3 页面设计稿**（HTML 可预览）— theme.html 双主题概念 + 各页稿 |
| [`architecture-local-first.md`](./architecture-local-first.md) | Local-first：本地真相、乐观更新、合成层动效 |
| [`design-agent-summon.md`](./design-agent-summon.md) | Fn+Space Agent 召唤：Claude/Codex 后台派发 |
| [`design-hud-confirm-learn.md`](./design-hud-confirm-learn.md) | Fn/⇧Fn 确认再贴 + 改字即学 |
| [`Sell-it.md`](./Sell-it.md) | 怎么卖：谁付钱、说什么、别说什么 |

Cursor 强制规则：`.cursor/rules/jobs-design.mdc` · `.cursor/rules/local-first.mdc`（`alwaysApply`）。

## 流式 ASR + VAD

**S0–S4 已齐**：段内增量 KV + WebRTC VAD + 跨段 prefix + ASR 页调参 + HUD 分色 + 动态 RoPE + PCM ring/drain + 边界去重；Silero 为 optional feature。

权威：[`ROADMAP-streaming-asr-vad.md`](./ROADMAP-streaming-asr-vad.md) · [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)

```bash
cd asr-cli/src-tauri && cargo test --features qwen-local --lib audio::vad::tests
# Silero: --features qwen-local,silero-vad
```

## 改进计划

- [`plan/refine-and-distill-improvement.md`](./plan/refine-and-distill-improvement.md) — LLM 纠错 + 主动提炼词库优化
