# 言落 · 技术文档

> 更新：2026-07-22。产品入口与截图见根目录 [`../README.md`](../README.md)。

所有设计 / 架构 / 发版文档集中在本目录。不要再拆 `docs/`。

## 产品 / UI（改界面先读）

| 文档 | 用途 |
|------|------|
| [`DESIGN.md`](./DESIGN.md) | 品牌 · 视觉 · IA · 动效（Jobs 原则已并入） |
| [`design/v3/`](./design/v3/README.md) | 页面设计稿（HTML 可预览）+ 规格 md |
| [`screenshots/`](./screenshots/) | README 用产品态截图（出自 v3 稿） |
| [`architecture-local-first.md`](./architecture-local-first.md) | 本地真相 · 乐观更新 · 动效边界 |
| [`design-agent-summon.md`](./design-agent-summon.md) | Fn+Space 派活召唤 |
| [`design-hud-confirm-learn.md`](./design-hud-confirm-learn.md) | Fn / ⇧Fn 确认再贴 · 改字即学 |

Cursor：`.cursor/rules/jobs-design.mdc` · `local-first.mdc` · `streaming-asr-vad.mdc`。

## 流式 ASR + VAD

**S0–S4 已齐**：段内增量 KV · VAD/硬顶切段 · 跨段 prefix · 动态 RoPE · PCM drain · 边界去重；Silero 为 optional feature。

| 文档 | 用途 |
|------|------|
| [`ROADMAP-streaming-asr-vad.md`](./ROADMAP-streaming-asr-vad.md) | 阶段权威 |
| [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md) | 架构说明 |

```bash
cd src-tauri && cargo test --features qwen-local --lib audio::vad::tests
# Silero: --features qwen-local,silero-vad
```

## 发版 / 编译

| 文档 | 用途 |
|------|------|
| [`RELEASE.md`](./RELEASE.md) | 版本同步 · tag · 多平台产物 · 应用内更新 |
| [`BUILD.md`](./BUILD.md) | Metal / mlx-c / cmake 踩坑 |

## 改进计划

| 文档 | 用途 |
|------|------|
| [`plan/refine-and-distill-improvement.md`](./plan/refine-and-distill-improvement.md) | LLM 纠错 + 词库提炼 |
| [`plan/refine-eval.md`](./plan/refine-eval.md) | refine few-shot 评测笔记 |
