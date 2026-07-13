# asr-cli 技术文档索引

> 更新：2026-07-13。

**S0–S4 已齐**：段内增量 KV + WebRTC VAD + 跨段 prefix + ASR 页调参 + HUD 分色 + 动态 RoPE + PCM ring/drain + 边界去重；Silero 为 optional feature。

权威：[`ROADMAP-streaming-asr-vad.md`](./ROADMAP-streaming-asr-vad.md) · [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)

```bash
cd asr-cli/src-tauri && cargo test --features qwen-local --lib audio::vad::tests
# Silero: --features qwen-local,silero-vad
```
