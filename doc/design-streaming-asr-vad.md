# 设计：高性能流式 ASR + VAD

> 状态: 设计稿（未实现）  
> 创建: 2026-07-12  
> 取代 / 收敛: `todo-streaming-asr.md`（历史背景）、`todo-vad-segmentation.md`（问题陈述）、`incremental-kv-cache-investigation.md`（已验证基线）

## 1. 目标与非目标

### 目标

- **任意时长录音**：会议 / 讲座（30min+）不因 RoPE / KV 爆掉。
- **实时性稳定**：partial 延迟不随总录音时长线性恶化。
- **内存有界**：decoder KV、embed cache、mel cache 按「当前段」上限，不按「整场录音」增长。
- **质量不降**：段内结果与离线转写对齐；段间边界可调、可验证。
- **复用已验证路径**：段内继续用增量 KV（chunk-local encoder + cached embeds + merged prefill）。

### 非目标（本设计不包含）

- 不改模型权重 / 不训新 VAD 模型为首发依赖。
- 不做跨设备分布式推理。
- 不把 Python vLLM 路径搬进产品（产品路径 = MLX Rust）。
- 不做「无限长单段」真增量（RoPE 无限表）；用 **VAD 切段重置** 解决长时。

---

## 2. 现状基线（已落地，勿回退）

| 能力 | 状态 | 位置 |
|------|------|------|
| 段内增量 mel / encoder embed cache | ✅ | `qwen3_asr_rs` mel + inference |
| 段内 decoder KV truncate + incremental prefill | ✅ | `streaming_incremental_prefill` |
| chunk-local attention（流式稳定性） | ✅ | `audio_encoder.set_chunk_local(true)` |
| rollback prefix（边界抖动控制） | ✅ | `rollback_tokens` / `unfixed_chunk_num` |
| asr-cli mlx-worker 流式循环 | ✅ | `transcription/mod.rs` `StartStreaming` |
| 生产 VAD 分段 | ❌ | 无；RMS 仅 HUD |
| 跨段上下文 | ❌ | 单 `StreamingState` 贯穿整场 |
| RoPE 表 | ⚠️ 固定 4096 ≈ **~3min** 硬顶 | `init_streaming` `max_positions` |

**关键事实**：`todo-streaming-asr.md` 里「全量重转 O(n²)」已过时。当前产品路径是 **O(段长)** 增量 KV；崩溃点是 **整场当作一段** 导致 RoPE/KV/prefix 失控（见 partial #623 / 241s broadcast 错误）。

---

## 3. 问题模型

```
整场录音（单调增长）
  ├─ audio tokens ≈ 13/s
  ├─ KV ≈ O(audio + text)
  ├─ rollback prefix ≈ O(已识别文本)
  └─ cos/sin[0..4096)  →  pos_start + total_new > 4096  → MLX broadcast 崩溃
```

单靠抬 `max_positions` 只能推迟崩溃，不能解决：

- 长会议 KV 到 GB 级
- attention 扫更长 cache → decode 变慢
- prefix 越来越长 → 每次 prefill 变重

**结论**：高性能 = **段内增量 + 段间重置**，不是无限加长单段。

---

## 4. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        asr-cli (Tauri)                          │
│  AudioRecorder ──pcm──► SessionOrchestrator                     │
│                           │                                     │
│                           ├─ VadGate (能量 / WebRTC)             │
│                           ├─ SegmentClock (开/关段、硬超时)       │
│                           └─ mlx-worker 命令                    │
│                                │                                │
│                     StartSegment / FeedAudio / CommitSegment    │
│                                ▼                                │
│                     qwen3_asr_rs::AsrInference                  │
│                     StreamingState (per segment)                │
│                     incremental mel / encoder / KV              │
└─────────────────────────────────────────────────────────────────┘
           │ partial / committed / final
           ▼
        HUD + transcript-viewer
```

### 两层时间尺度

| 尺度 | 触发 | 作用 |
|------|------|------|
| **Tick**（~0.5–1.0s，现有 `chunk_sec`） | 段内新音频 ≥ chunk | `streaming_transcribe_partial` |
| **Segment**（VAD / 硬超时） | 静音确认 / max_seg | `finish` 当前段 → `init_streaming` 新段 |

段内：保持现有高性能增量路径。  
段间：drop `StreamingState`，释放 KV / embeds / mel / RoPE 游标。

---

## 5. 核心设计：Segmented Incremental Streaming

### 5.1 会话状态机

```
Idle
  │ start_recording
  ▼
Listening (可选：跳过前导静音)
  │ speech_onset
  ▼
ActiveSegment ──tick──► partial(in_flight)
  │ silence_confirmed | hard_cap | stop
  ▼
CommitSegment ──► append committed text
  │ more audio?
  ├─ yes → Listening / ActiveSegment
  └─ no  → Finalizing → Idle
```

### 5.2 段生命周期（后端）

1. **Open**：`state = init_streaming(lang, rollback)`；记录 `seg_start_sample`。
2. **Feed**：只把 `[seg_start .. now]`（或段内 ring）喂给 `streaming_transcribe_partial`；**禁止**再把整场 0..N 当一段喂（今日 bug 源）。
3. **Partial emit**：`committed_text + " " + in_flight_text`（或结构化事件，见 §8）。
4. **Commit**：
   - `streaming_transcribe`（allow tail）收尾当前段；
   - 结果写入 `committed_segments[]`；
   - `drop(state)`；
   - 可选：下一段 open 时带 **跨段 prefix**（§6）。
5. **Hard cap**：即使无静音，段长 ≥ `max_segment_sec`（建议 90–120s）强制切，避免再撞 RoPE。

### 5.3 音频切片契约（关键）

今日 worker 每次 `get_audio_snapshot()` 拿 **全量** buffer，依赖引擎内部 cache 假装增量——RoPE 仍按全局位置累加。

新契约：

```text
segment_pcm = recorder.samples[seg_start_sample .. current]
engine.streaming_transcribe_partial(segment_pcm, &mut seg_state)
```

- `seg_start_sample` 在 Commit / Open 时更新。
- Recorder 仍可保留整场 PCM（final align / 导出），但 **推理窗口 = 当前段**。
- 可选后续：committed 段 PCM 落盘 / 压缩，热路径只保留「当前段 + 小 overlap」。

### 5.4 Overlap（边界质量）

切段时保留尾部 overlap，避免词被切断：

| 参数 | 建议默认 | 含义 |
|------|----------|------|
| `overlap_ms` | 200–400 | Commit 后下一段从 `boundary - overlap` 起 |
| `min_segment_ms` | 800–1200 | 过短不切，避免碎段 |
| `commit_hold_ms` | 250–400 | 静音需持续这么久才确认 |

Overlap 区间允许被两段都「看见」；最终文本用 **committed 拼接**，不以 overlap 双写。若两段在 overlap 处重复，用简单去重（后缀匹配）或强制 aligner 后处理（P2）。

---

## 6. 跨段上下文（质量）

段间重置会丢掉 decoder 语境。两种策略，按阶段启用：

### P0：独立段（先保证稳）

- 每段 `force_language` 继承会话语言。
- 无文本 prefix。
- 验收：长录音不崩、延迟稳定；允许段首偶发弱语境。

### P1：Committed text prefix（推荐终态）

下一段 `init_streaming` 后，把上一句（或最近 N 字）作为 **文本 prefix** 注入（类似现有 rollback，但是跨段、只读 committed）：

```text
[pre_audio][audio_seg][post_audio][lang?][cross_seg_prefix] → decode
```

约束：

- prefix 长度 capped（如 ≤ 64–128 tokens），避免再次拖垮 prefill。
- 只用 **已 commit** 文本，不用 in-flight（防锁定错误）。
- 与段内 `rollback_tokens` 正交：跨段 prefix 稳定；段内仍 rollback 尾部 K。

引擎侧可新增显式 API（比偷偷塞进 `StreamingState` 更清晰）：

```rust
// qwen3_asr_rs（示意）
inf.init_streaming_with_context(lang, rollback, Some(cross_seg_prefix));
```

---

## 7. VAD 设计

### 7.1 选型

| 方案 | 延迟 | 依赖 | 抗噪 | 首发建议 |
|------|------|------|------|----------|
| 能量 / RMS 门限 | 极低 | 无 | 差 | **P0 可跑通** |
| WebRTC VAD | 低 | `webrtc-vad` | 中 | **P0/P1 默认** |
| Silero | 中 | 额外模型 | 好 | P2 可选 |

**推荐路径**：抽象 `VadBackend` trait → 默认 WebRTC；保留 Energy 作 fallback / 测试；Silero 后置。

### 7.2 接口（asr-cli）

```rust
trait VadBackend {
    fn push(&mut self, pcm_16k: &[f32]) -> VadEvent;
}

enum VadEvent {
    Silence,
    Speech,
    // 由 SegmentClock 合成，不要求 VAD 直接给边界
}

struct SegmentClock {
    min_silence: Duration,   // e.g. 400ms
    commit_hold: Duration,   // e.g. 300ms after candidate
    min_segment: Duration,   // e.g. 1.0s
    max_segment: Duration,   // e.g. 90s  hard cap
    overlap: Duration,       // e.g. 300ms
}
```

`SegmentClock` 消费逐帧/逐窗 VAD 标签，输出：

- `OnSpeechStart { sample }`
- `OnCommit { end_sample }`（静音确认且过 min_segment）
- `OnHardCut { end_sample }`（触顶 max_segment）

### 7.3 与 audio meter 关系

- HUD RMS（`recent_rms` / bands）**继续只服务 UI**。
- VAD 跑在 worker 或 recorder 旁路线程，**不要**和 60Hz UI pump 耦合。
- 可用同一 PCM 源，但决策状态机独立。

### 7.4 难例

| 场景 | 策略 |
|------|------|
| 思维停顿 < hold | 不切 |
| 长时间无停顿 | hard cap 强制切 + overlap |
| 音乐 / 风扇噪声 | WebRTC 模式偏 aggressive；可调灵敏度 |
| 双人抢话 | 本阶段不特殊处理；按能量连续语音切 |
| 段首静音 | Listening 跳过，不 open 空段 |

---

## 8. 产品事件与 UI

### 8.1 事件模型（替换「整场一个 string」）

```ts
type PartialPayload = {
  committed: string;   // 已提交段落拼接
  active: string;      // 当前段 in-flight
  segment_index: number;
  // 可选：segment_id, is_final_segment
};
```

- HUD：一行展示 `committed + active`（active 可略强调）；不必上复杂卡片。
- `transcript-viewer`：committed 按段落盘；final 时整场拼接 + 可选 ForcedAligner。
- Translate 模式：对 **commit 边界** 触发稳定翻译；active 可节流或不译（避免抖）。

### 8.2 Final

`stop_recording`：

1. Commit 当前 active（若有语音）。
2. 拼接 `committed_segments`。
3. 可选：对整场 PCM 跑 ForcedAligner（现有路径），时间戳相对整场。
4. emit `transcription-result`。

---

## 9. 模块边界与改动面

### 9.1 `qwen3_asr_rs`（引擎）

| 项 | 动作 |
|----|------|
| 段内 incremental API | **保持** |
| `max_positions` | 提到可覆盖 `max_segment_sec`（如 120s → ~2k+；建议 **8192** 作段内安全垫） |
| `init_streaming_with_context` | P1 新增 |
| 防御断言 | `pos_start + total_new <= cos.len` → 清晰错误（非 MLX broadcast） |
| 依赖接入 | asr-cli 今日用 git `feat/forced-aligner`；联调期建议 **path 依赖本地** `../../qwen3_asr_rs`，合入后再推 git |

### 9.2 `asr-cli`（编排）

| 项 | 动作 |
|----|------|
| `VadBackend` + `SegmentClock` | 新建 `audio/vad.rs` 或 `transcription/segment.rs` |
| `mlx_worker` StartStreaming 循环 | 改为段生命周期；**按段切片 PCM** |
| `AppConfig` | 增加 VAD / max_segment / overlap 参数 |
| `PartialResult` | 扩展 committed/active |
| TranslateStreamState | 在 Commit 时推进，不在每个 tick 锁死 |

### 9.3 明确不放引擎里的东西

- VAD 决策、录音缓冲策略、HUD 文案 → **asr-cli**。
- 引擎只保证：给定一段 PCM + StreamingState，增量正确且可重置。

---

## 10. 性能模型

设：

- \(T\) = 整场时长  
- \(S\) = 平均段长（VAD 后，目标 5–30s，硬顶 90s）  
- \(C\) = tick 间隔（`chunk_sec`，~1s）

| 方案 | Prefill/Decode 成本 | KV 峰值 | 长时稳定性 |
|------|---------------------|---------|------------|
| 旧全量重转 | \(O(T^2)\) | \(O(T)\) | 差 |
| 今日单段增量 | \(O(T)\) 但常数随 T 升 | \(O(T)\) | RoPE ~3min 崩 |
| **本设计** | \(O(T)\)，常数 ≈ \(O(S)\) | \(O(S)\) | 任意 T |

段内仍用已测最优参数作默认：

- `chunk_sec ≈ 1.0`
- `rollback_tokens ≈ 5`（引擎侧实测甜点；app 默认今日为 2，应对齐基准）
- `unfixed_chunk_num = 2`
- `max_new_tokens = 32`

目标 SLO（M 系列，本地 MLX）：

| 指标 | 目标 |
|------|------|
| partial 端到端 | p95 < 1.5 × `chunk_sec` |
| 30min 会话 KV 峰值 | ≤ 单段 120s 量级（~数百 MB 级，非 GB 线性涨） |
| 崩溃 | 0（RoPE / broadcast） |
| 段边界词错误 | 相对无 VAD 离线 WER 增量可控（P1 prefix 后收紧） |

---

## 11. 配置面（建议默认）

```toml
# 示意；落入 AppConfig
chunk_size_sec = 1.0
unfixed_token_num = 5          # 对齐引擎基准，替换当前默认 2
vad_backend = "webrtc"         # or "energy"
vad_aggression = 2             # webrtc 0..=3
min_silence_ms = 400
commit_hold_ms = 300
min_segment_ms = 1000
max_segment_sec = 90
overlap_ms = 300
cross_segment_prefix_tokens = 64  # P1；P0 = 0
```

---

## 12. 分阶段交付

### Phase 0 — 止血 + 契约（小，但不是「抬常量糊弄」）

1. Worker **按逻辑段切片**（即使先用 **硬超时分段** 代替真 VAD）：每 `max_segment_sec` reset `StreamingState`。
2. RoPE `max_positions` ≥ 覆盖 max_segment + prefix 安全垫（8192）。
3. narrow 前断言 → 可读错误。
4. 验收：录 10min+ 不崩；内存曲线锯齿状（段末回落）。

### Phase 1 — WebRTC VAD + 事件模型

1. `VadBackend` + `SegmentClock` 接入 worker。
2. `PartialPayload { committed, active }`；HUD / viewer 适配。
3. overlap + min/max 段参数可配。
4. 验收：自然说话停顿处切段；碎段率低；partial 流畅。

### Phase 2 — 跨段 prefix + 质量

1. `init_streaming_with_context`。
2. Commit 驱动 translate。
3. 边界回归集（中英、快速连读、长停顿）。
4. 验收：边界 WER / 主观质量 ≥ 单段长音频（在可跑长度内）。

### Phase 3 — 可选增强

- Silero backend。
- committed PCM 冷存储 / 热路径 ring。
- 动态 RoPE（彻底去掉段内表上限焦虑）。
- 双缓冲：Commit 时下一段 onset 已缓冲的 PCM 无缝接上。

---

## 13. 测试与验证

| 层级 | 内容 |
|------|------|
| 引擎单测 | 已有 `test_streaming`：段内 offline == incremental 保持绿 |
| 段重置测 | 人为 2 段拼接；第二段 `init_streaming` 后结果独立正确 |
| RoPE 护栏 | 构造 `pos_start + total_new > max` 必返回清晰 Err |
| VAD 单测 | 合成 tone + silence；onset/commit 样本点误差 < 1 窗 |
| E2E | 10min 真人语音：无崩、HUD committed/active、final 文本完整 |
| 性能 | 对比「无切段」vs「切段」：RSS 峰值、partial 延迟曲线 |

回归资产：固定 wav + 期望切点（可人工标）；CI 跑短音频，长音频作本地/nightly。

---

## 14. 风险与决策记录

| 风险 | 缓解 |
|------|------|
| 切段丢词 | overlap + min_segment + P1 prefix |
| 切太碎 | min_silence / min_segment；aggression 可调 |
| 永不静音 | hard cap 必做（Phase 0） |
| git vs path 分叉 | 联调 path；API 稳定后推 `feat/forced-aligner` |
| 文档过时 | 以本文为源；旧 TODO 仅作历史 |

### 已拍板（设计默认）

1. **段内增量 KV + 段间 reset**，不走「只加大 RoPE 撑整场」。
2. **VAD 在 asr-cli**；引擎保持纯推理。
3. **Hard cap 与 VAD 同时存在**（cap 是正确性护栏）。
4. **P0 可无跨段 prefix**；P1 再上。
5. **首发 VAD = WebRTC**（Energy 可作测试双轨）。

### 待实现时确认

- app 默认 `unfixed_token_num` 是否从 2 → 5（建议是）。
- ForcedAligner：按段对齐还是整场一次（建议 final 整场一次，简单）。
- Translate：是否仅在 commit 时调用 LLM（建议是）。

---

## 15. 与旧文档关系

| 文档 | 关系 |
|------|------|
| `incremental-kv-cache-investigation.md` | **基线证据**：段内方案已验证，本文直接依赖 |
| `todo-vad-segmentation.md` | 问题与直觉方案正确；细节由本文取代 |
| `todo-streaming-asr.md` | 历史：方案 A 过时；方案 C ≈ 本文 P1；方案 D 段内已做 |

---

## 16. 一句话

**把一场录音拆成「短而稳的增量流式段」：段内吃透已验证的 O(S) KV 增量，段间用 VAD（+硬顶）重置状态；产品看到的是连续字幕，系统看到的是有界会话。**
