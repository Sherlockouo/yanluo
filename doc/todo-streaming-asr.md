# TODO: 流式 ASR 优化

> 状态:历史文档（段内增量 KV 已落地；长时方案见新设计）
> 创建时间:2026-07-04
> **现行设计**：[`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)
> 关联仓库:`qwen3_asr_rs_fork`(Rust ASR 引擎)、`Qwen3-ASR`(Python 官方仓库)

## 背景

当前 `asr-cli` 的流式识别实现是**全量重转**模式:timer 线程每 2 秒拿当前累积的全部音频,从头重新跑 encoder + decoder,emit `partial-result` 事件。

```rust
// 当前实现 (lib.rs timer 线程)
let samples = recorder.0.get_samples();  // 从头到现在的全部样本
worker_tx.send(Transcribe { samples, is_final: false });
```

### 问题

复杂度 O(n²),录音越长越慢:

```
t=2s:  转写 2s  → ~0.5s
t=4s:  转写 4s  → ~1.0s
t=6s:  转写 6s  → ~1.6s
t=10s: 转写 10s → ~2.6s
t=30s: 转写 30s → ~8s   ← partial 严重滞后
```

到后期 partial 转写时间 > 间隔时间,结果堆积滞后,完全失去实时性。

---

## Python 官方仓库的流式实现

Python 仓库 (`Qwen3-ASR`) 有流式 API,但有关键限制。

### API

```python
# qwen_asr/inference/qwen3_asr.py
state = asr.init_streaming_state(
    unfixed_chunk_num=2,   # 前 N 个 chunk 不用 prefix
    unfixed_token_num=5,   # 回退最后 K 个 token 作为 prefix
    chunk_size_sec=2.0,    # chunk 大小
)
asr.streaming_transcribe(chunk, state)    # 喂增量音频
asr.finish_streaming_transcribe(state)     # 收尾(处理尾部不足一个 chunk 的音频)
```

### 限制

- **仅支持 vLLM backend**,不支持 transformers backend
- 不支持时间戳(forced aligner)
- 不支持 batch inference

### 核心算法 (`streaming_transcribe`, L657-765)

```python
# 每次凑够一个 chunk_size_sec 的音频:
state.audio_accum = np.concatenate([state.audio_accum, chunk])  # 追加到累积音频
prompt = state.prompt_raw + prefix    # prefix 来自之前的转写结果(回退 K 个 token)
inp = {"prompt": prompt, "multi_modal_data": {"audio": [state.audio_accum]}}
outputs = self.model.generate([inp], ...)  # 重新跑全部累积音频!
```

### 关键发现

**Python 的"流式"本质上也是每次重新跑全量累积音频**,没有 KV cache 跨 chunk 复用。O(n²) 复杂度与当前 Rust 实现相同。

Python 版本的优势在于:

1. **Prefix prompt 策略**:用之前的转写结果作为生成前缀,减少边界抖动
   - `chunk_id < unfixed_chunk_num` 时:prefix = ""(前几个 chunk 不用前缀,因为模型还没稳定)
   - `chunk_id >= unfixed_chunk_num` 时:从累积文本中回退 `unfixed_token_num` 个 token 作为 prefix
   - 回退是为了让模型有机会"重新考虑"边界处的 token

2. **vLLM prefix caching**:vLLM 会自动缓存相同 prompt 前缀的 KV,避免重复计算 prompt 部分(但 audio encoder 部分仍然全量重算)

### 参数语义

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `unfixed_chunk_num` | 2 | 前 N 个 chunk 不使用之前的转写结果作为 prefix(模型刚开始,结果不稳定) |
| `unfixed_token_num` | 5 | 回退最后 K 个 token,给模型重新生成边界 token 的机会,减少抖动 |
| `chunk_size_sec` | 2.0 | 每个 chunk 的秒数,音频累积到一个 chunk 后触发一次转写 |

---

## Rust 仓库现状

Rust 仓库 (`qwen3_asr_rs_fork`) **没有流式 API**,只有 `transcribe()` 一次性转写。

### 已有基础设施

- `KvCache` 结构体:支持 prefill + 增量 decode(但仅限单次转写内,不跨 chunk)
- `TextDecoder::forward()`:支持 past_len 和 causal mask
- `AudioEncoder`:Whisper-style,chunk-based Conv2d 处理(内部 chunk,非流式 chunk)

### 缺失的部分

- 没有 `init_streaming_state` / `streaming_transcribe` / `finish_streaming_transcribe` 对应接口
- 没有 prefix prompt 构建逻辑(当前 `build_prompt` 不支持追加前缀文本)
- 没有 KV cache 跨 chunk 复用机制
- tokenizer 没有 `encode` + `decode` 用于 prefix 回退(需确认)

### `inference.rs` 关键代码位置

- `AsrInference::load()` (L30-86):模型加载
- `transcribe()` (L89-215):一次性转写,包含完整 pipeline
- `build_prompt()` (L217-259):构建输入 token 序列,当前不支持 prefix 文本
- `parse_asr_output()` (L271-300):解析 `language Xxx<asr_text>...` 格式输出

---

## 可行方案

### 方案 A:复刻 Python prefix prompt 流式(全量重转 + prefix)

**原理**:完全复刻 Python `streaming_transcribe` 的逻辑,每次跑全量累积音频,但用之前的转写结果(回退 K 个 token)作为 prefix prompt。

**改动范围**:`qwen3_asr_rs_fork` 新增流式 API + `asr-cli` 接入

**实现步骤**:

1. 在 `qwen3_asr_rs_fork/src/inference.rs` 新增:
   ```rust
   pub struct StreamingState {
       chunk_size_samples: usize,
       unfixed_chunk_num: usize,
       unfixed_token_num: usize,
       chunk_id: usize,
       buffer: Vec<f32>,           // 未凑够一个 chunk 的样本
       audio_accum: Vec<f32>,      // 累积音频
       prompt_raw: Vec<i64>,       // 基础 prompt token
       force_language: Option<String>,
       raw_decoded: String,        // 累积的原始解码文本
       language: String,
       text: String,
   }

   impl AsrInference {
       pub fn init_streaming_state(&self, ...) -> StreamingState { ... }
       pub fn streaming_transcribe(&self, pcm: &[f32], state: &mut StreamingState) { ... }
       pub fn finish_streaming_transcribe(&self, state: &mut StreamingState) { ... }
   }
   ```

2. `streaming_transcribe` 核心逻辑:
   - 追加 pcm 到 buffer
   - 凑够一个 chunk → 追加到 audio_accum
   - 构建 prefix:`chunk_id < unfixed_chunk_num` → "",否则回退 K 个 token
   - 用 `audio_accum` 全量跑 encoder + decoder
   - 解析输出,更新 `raw_decoded` / `language` / `text`

3. `build_prompt` 需要支持追加 prefix 文本:
   ```rust
   fn build_prompt_with_prefix(&self, num_audio_tokens: usize, language: Option<&str>, prefix: &str) -> ...
   ```

4. `asr-cli/src-tauri/src/lib.rs` 改为调用流式 API:
   - Worker 线程持有 `StreamingState`
   - Timer 线程每 2s 发送增量音频(而非全量)
   - Worker 调用 `streaming_transcribe`,emit `partial-result`

**复杂度**:O(n²)(和 Python 一样)
**优点**:行为与官方 Python 一致,可预期;prefix 减少边界抖动
**缺点**:长音频仍然越来越慢

---

### 方案 B:VAD 分段独立转写

**原理**:用能量 VAD 检测静音段,把音频切成完整句子,每句独立转写,结果顺序拼接。

**改动范围**:`asr-cli` 后端(不改 `qwen3_asr_rs_fork`)

**实现步骤**:

1. `AudioRecorder` 或单独的 VAD 模块:
   ```rust
   struct VadSegmenter {
       energy_threshold: f32,     // 静音能量阈值
       min_silence_ms: usize,     // 最小静音时长触发分段(如 300ms)
       min_segment_ms: usize,     // 最小句子长度(如 500ms)
       // ...
   }
   ```

2. 检测逻辑:
   - 计算短时能量(窗 20-30ms)
   - 能量低于阈值持续 > min_silence_ms → 标记分段边界
   - 分出一段完整音频 → 发给 worker 转写

3. Worker 转写每段后,emit `partial-result`(追加到已有文本)
4. `stop_recording` 转写最后未结束的尾段

**复杂度**:O(n)(每段独立转写,无重复计算)
**优点**:性能好,天然适合人说话的停顿节奏
**缺点**:句子中间无停顿时无法分段;分段处可能丢字(词被截断)

---

### 方案 C:VAD 分段 + prefix prompt(推荐)

**原理**:方案 A + B 的组合。VAD 分段解决 O(n²),prefix prompt 解决分段后的上下文连贯性。

**改动范围**:`qwen3_asr_rs_fork` 新增带 prefix 的转写 API + `asr-cli` 加 VAD

**实现步骤**:

1. `qwen3_asr_rs_fork` 新增:
   ```rust
   impl AsrInference {
       /// 转写音频,可选 prefix 文本作为上下文
       pub fn transcribe_with_prefix(
           &self,
           samples: &[f32],
           language: Option<&str>,
           prefix: &str,
       ) -> Result<TranscribeResult> { ... }
   }
   ```
   基于 `transcribe()` 改造,`build_prompt` 支持 prefix。

2. `asr-cli` 加 VAD 分段:
   - VAD 检测到完整句子 → 发给 worker
   - Worker 调用 `transcribe_with_prefix(samples, lang, &previous_text)`
   - 上一句的转写结果作为 prefix,保持上下文
   - 结果追加到 `partial-result`

**复杂度**:O(n)
**优点**:性能好 + 上下文连贯
**缺点**:实现量最大;prefix 在分段场景下的效果需调参验证

---

### 方案 D:真增量 KV cache 复用(理论最优,难度最高)

**原理**:复用 encoder 和 decoder 的 KV cache,只处理新增的音频帧。

**改动范围**:深度改造 `qwen3_asr_rs_fork` 的 encoder / decoder / inference

**实现步骤**(概念性):

1. Encoder 增量化:
   - 保留上次 encoder 的输出和中间状态
   - 新 chunk 只计算新增 mel 帧 → 编码 → 追加到已有 audio_embeds
   - 问题:Conv2d 有感受野,边界处需要 overlap;block-diagonal attention mask 需要调整

2. Decoder KV cache 复用:
   - 保留上次 prefill 的 KV cache
   - 新 chunk 的 audio tokens 追加到已有 cache 后面
   - 问题:prompt 中的 AUDIO_PAD 数量变化,prompt 结构改变;MRoPE position 需要连续递增
   - 如果用 prefix prompt,prefix 部分的 KV 可以复用,但 audio 部分的 KV 需要重新计算(因为音频变了)

3. 推理流程:
   ```
   chunk 1: full prefill (audio_1) → decode → KV cache_1
   chunk 2: incremental prefill (audio_2 appended) → extend KV cache → decode
   ...
   ```

**复杂度**:O(n)(理论最优)
**优点**:真正的实时流式,无重复计算
**缺点**:
- 工作量极大,需要改 encoder / decoder / inference 多个模块
- seq2seq 模型的 KV cache 复用在音频模态上没有成熟方案
- 音频 token 边界、MRoPE position、attention mask 都需要重新设计
- 风险高,容易引入数值错误导致转写质量下降

---

## 方案对比

| 方案 | 复杂度 | 实现量 | 准确率 | 实时性 | 风险 |
|------|--------|--------|--------|--------|------|
| A. prefix prompt 全量重转 | O(n²) | 中 | 高(与官方一致) | 差(长音频) | 低 |
| B. VAD 分段 | O(n) | 中 | 中(边界可能丢字) | 好 | 低 |
| **C. VAD + prefix(推荐)** | **O(n)** | **大** | **高** | **好** | **中** |
| D. 真增量 KV cache | O(n) | 极大 | 高 | 极好 | 高 |

## 推荐路径

1. **短期(方案 A)**:先复刻 Python prefix prompt,解决边界抖动问题。虽然仍是 O(n²),但短音频(< 15s)体验已经不错
2. **中期(方案 C)**:加 VAD 分段,解决长音频性能问题。VAD 分段 + prefix 是最终目标
3. **长期(方案 D)**:如果需要极致实时性(如会议记录),考虑真增量。但这需要深入改造模型推理代码,建议先在上游 Python 仓库验证可行性

## 相关文件

| 文件 | 说明 |
|------|------|
| `qwen3_asr_rs_fork/src/inference.rs` | Rust ASR 引擎,需新增流式 API |
| `qwen3_asr_rs_fork/src/text_decoder.rs` | KV cache 实现,方案 D 需改造 |
| `qwen3_asr_rs_fork/src/audio_encoder.rs` | Whisper encoder,方案 D 需改造 |
| `Qwen3-ASR/qwen_asr/inference/qwen3_asr.py` | Python 流式实现参考(L584-830) |
| `asr-cli/src-tauri/src/lib.rs` | Tauri 后端,需接入流式 API |
| `asr-cli/src-tauri/src/audio_recorder.rs` | 音频录制,方案 B/C 需加 VAD |
