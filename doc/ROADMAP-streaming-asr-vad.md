# ROADMAP：流式 ASR + VAD（以后会话以本文为准）

> **权威路线图**。新会话做流式 / VAD / 长录音相关工作时，先读本文 + [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)。  
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
| **S0 止血** | 长录音不崩；RoPE 护栏；按段切片契约 | RoPE↑ + `ensure_rope_span` + **按段 PCM 窗口**（缺一切仍会崩或假增量） | ✅ 2026-07-12 |
| **S1 可切段** | Energy VAD + hard-cap + overlap + 段重置 + `PartialResult{committed,active}` | 切段决策 + 引擎 reset + 事件模型一起上；否则要么崩要么 UI 假连续 | ✅ 2026-07-12（质量默认偏激进，见 S1.1） |
| **S1.1 切段质量** | 不伤识别的切段默认；hysteresis；防碎段 | **调参 + hysteresis + min_segment/overlap** 同批；单改阈值不够 | ✅ 2026-07-12 |
| **S2 语境** | 跨段 text prefix（cap tokens）+ commit 驱动 translate | prefix API + worker 注入 + 边界回归；不做「无 cap 的无限 prefix」 | ✅ 2026-07-12 |
| **S3 抗噪 VAD** | WebRTC（或 Silero）backend，Energy 作 fallback | `VadBackend` trait 已有则只换实现；与 SegmentClock 契约不变 | ⬜ |
| **S4 打磨** | 动态 RoPE / ring buffer / 边界去重 / 设置页暴露 VAD | 可选；不阻塞 S2/S3 | ⬜ |

### 每阶段「完成」定义

- **S0**：录 10min+ 无 RoPE/broadcast；日志按段窗口而非整场 0..N。
- **S1**：静音/硬顶会 `commit` + `init_streaming`；HUD `text = committed+active`；内存锯齿回落。
- **S1.1**：思维停顿（~0.5–0.8s）不误切；短段碎片明显减少；同音频主观质量 ≥ 切段前短会话。
- **S2**：段首不再「失忆」；边界 WER 可接受；translate 在 commit 边界推进。
- **S3**：风扇/键盘噪声下误切率下降；API/配置可切换 backend。
- **S4**：运维/高级用户可调；无必做项。

## 已知质量坑（S1 → S1.1）

终端曾见：`chunk=0.3s rollback=2`（用户 config 覆盖默认）+ Energy 阈值偏高 + 静音仅 ~700ms 即 commit。

会导致：

1. **过早 VAD 断开**：气口/轻声被当成静音 → 半句提交 → 下段冷启动失语境。  
2. **碎段**：`min_segment=1s` 太短，模型尚未稳住就 freeze。  
3. **过密 partial**：`chunk_sec=0.3` 假设抖动大（与切段正交，但叠加深恶化体感）。  
4. **无跨段 prefix**（S2）：切得越碎，失忆越严重。

**S1.1 对策（融合）**：hysteresis 能量门 + 更长静音/hold + 更大 min_segment/overlap + worker 侧对过小 `chunk_sec` / 过小 rollback 做安全下限并打日志。

## 模块边界（会话中勿反转）

| 层 | 职责 |
|----|------|
| `qwen3_asr_rs` | 段内增量推理；RoPE 护栏；日后 `init_streaming_with_context` |
| `asr-cli` `audio/vad.rs` | VAD + SegmentClock |
| `asr-cli` `transcription/mod.rs` | 编排：切片 / commit / reset / 事件 |
| UI | 消费 `committed`+`active`；勿在前端做切段 |

联调：`asr-cli` 用 path `../../qwen3_asr_rs`；稳定后推 git `feat/forced-aligner` 再改回。

## 新会话开工清单

1. 读本文状态表，确认当前阶段。  
2. 读 `design-streaming-asr-vad.md` 架构约束。  
3. 改切段/流式时跑：`cargo test --features qwen-local --lib audio::vad::tests`。  
4. 手动看 mlx-worker 日志：`segment #N open/commit`、窗口秒数、是否疯狂 commit。  
5. 不把 S2/S3 的活拆成「先随便切、以后再修准确度」——准确度是 S1.1/S2 的交付标准，不是事后补丁。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-12 | S0+S1 落地；本文建立；启动 S1.1（质量默认 + hysteresis） |
| 2026-07-12 | S1.1 完成；**S2 完成**：`init_streaming_with_context` + worker 注入 capped committed prefix + `notify_asr_committed` |
