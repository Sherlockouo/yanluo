# ROADMAP：流式 ASR + VAD（以后会话以本文为准）

> **权威路线图**。新会话做流式 / VAD / 长录音相关工作时，先读本文 + [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)。  
> 索引：[`README.md`](./README.md)。  
> 原则：**对齐终态、相关能力融合交付、每阶段可独立上线、不打无终态意义的临时 patch。**

## 终态（不要偏移）

```
段内：增量 mel / encoder cache / decoder KV（已验证）
段间：VAD（或硬顶）切段 → 重置 StreamingState → 有界内存 / RoPE
跨段：committed text prefix（短、只读已提交）保语境
产品：committed + active 连续字幕；任意时长不崩、延迟不随 T 恶化
```

**禁止**：只靠无限加大 RoPE 撑整场；把 VAD 塞进 `qwen3_asr_rs`；为了「先能跑」回退到全量重转 O(T²)。

## 阶段划分（融合点已标出）

| 阶段 | 交付物（可独立 ship） | 必须融合做（不要拆成无终态的半成品） | 状态 |
|------|----------------------|--------------------------------------|------|
| **S0 止血** | 长录音不崩；RoPE 护栏；按段切片契约 | RoPE↑ + `ensure_rope_span` + **按段 PCM 窗口** | ✅ 2026-07-12 |
| **S1 可切段** | Energy VAD + hard-cap + overlap + 段重置 + `PartialResult` | 切段 + reset + 事件一起上 | ✅ 2026-07-12 |
| **S1.1 切段质量** | hysteresis；防碎段 | 调参 + hysteresis + min_segment/overlap 同批 | ✅ 2026-07-12 |
| **S2 语境** | 跨段 text prefix + commit→translate | prefix API + worker 注入 | ✅ 2026-07-12 |
| **S3 抗噪 VAD** | WebRTC 默认；Energy fallback；Silero feature | `VadBackend` + 可切换 | ✅ 2026-07-13 |
| **S4 打磨** | ASR 页 VAD；HUD 分色；动态 RoPE；PCM ring；边界去重 | 产品 + 引擎 polish | ✅ 2026-07-13 |

### 每阶段「完成」定义

- **S0–S2**：见历史；已交付。
- **S3**：噪声下误切下降；backend 可切换（webrtc/energy/silero）。
- **S4**：ASR 页可调；HUD committed/active；RoPE 可按需扩到 16k；热路径按段拷贝 + drain 归档；段边界文本后缀去重。

## 已落地事实（勿当 TODO）

| 项 | 落点 |
|----|------|
| RoPE 8192 起步 + 按需扩到 16384 | `qwen3_asr_rs` `ensure_rope_span` |
| Energy / WebRTC / Silero(`silero-vad`) | `audio/vad.rs` `make_vad` |
| 按段 PCM + drain 归档 + final 拼接 | `recorder` + `transcription` |
| 边界文本去重 | `append_segment_text` |
| ASR 页 + HUD 分色 | `asr-page.tsx` / `asr-hud.tsx` |

## 模块边界

| 层 | 职责 |
|----|------|
| `qwen3_asr_rs` | 段内增量；RoPE 护栏/扩表；`init_streaming_with_context` |
| `asr-cli` `audio/vad.rs` | VadBackend + SegmentClock |
| `asr-cli` `transcription` | 切片 / commit / drain / 事件 |
| UI | committed+active；勿前端切段 |

## 验证

```bash
cd asr-cli/src-tauri && cargo test --features qwen-local --lib audio::vad::tests
# Silero（可选，拉 ONNX Runtime）:
cargo test --features qwen-local,silero-vad --lib audio::vad::tests
```

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-12 | S0–S2 |
| 2026-07-13 | S3 WebRTC；S4 产品面 |
| 2026-07-13 | **可选 polish 全交**：动态 RoPE、PCM ring/drain、边界去重、Silero feature |
