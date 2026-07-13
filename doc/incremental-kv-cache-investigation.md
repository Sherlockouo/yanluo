# Incremental KV Cache 调查报告

> 本文是 **段内增量 KV 的验证基线**（已落地）。长录音 / VAD 分段的产品架构与阶段见 [`ROADMAP-streaming-asr-vad.md`](./ROADMAP-streaming-asr-vad.md)、[`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)；索引 [`README.md`](./README.md)。

## 目标

在 `qwen3_asr_rs_fork` 中实现真正的 O(n) 增量流式 ASR：复用 decoder 的 KV cache，每次只 prefill 新增的音频 token，而非每次重新 prefill 全部音频（O(n²)）。

## 结论

**增量 KV cache 方案已验证可行**，需要三个关键修改：
1. 强制 chunk-local attention（编码器稳定性）
2. cached audio embeddings（消除数值漂移）
3. 合并 new audio + post-audio 为单次 forward（消除 post-audio K 差异）

三个测试音频全部通过（offline == incremental）。

**注意**：chunk-local attention 对中文 ASR 可能有微小影响（样本测试中 "宽森" → "宽窄"，但两者都不完全正确）。英文不受影响。建议流式模式开启，离线模式关闭。

当前性能 speedup=1.0x（无加速），因为 encoder 每次重新编码全部 mel。要实现真正加速需要只编码新增 mel frames。

## 调查过程

### 初始假设（错误）

最初假设问题是音频编码器的 **tail-chunk instability**：当音频增长时，尾部零填充的 chunk 变成完整 chunk，其 token 数变化，导致之前位置的 embeddings 改变。

### 日志验证（推翻假设）

在 `mel.rs`, `audio_encoder.rs`, `inference.rs` 中添加了详细日志，运行 `test_streaming` 测试：

```
[mel] samples=32000 padded_len=32000 hop=160 n_fft=400
[mel] stft_frames=201 final_frames=200
[encoder] num_frames=200 chunk_size=100 num_full_chunks=2 tail_frames=0 num_chunks=2
[encoder] chunk_valid_tokens=[13, 13] total_tokens=26
```

关键发现：**mel frames 总是对齐到 100 的倍数**（200, 400, 600, 800），所以 **tail_frames 始终为 0**。没有 tail chunk，每个 chunk 都是完整的，产生 13 个 token。delta 始终为 26。

这完全推翻了 tail-chunk 假设。之前缓存的音频 embeddings 应该在不同迭代间是相同的。

### KV cache 对比实验

在 `streaming_incremental_prefill` 后，额外做一次 fresh full prefill，对比两者的 logits 和 K cache：

```
[verify] logits_max_diff=2.7e0 k_cache_max_diff=1.4e2 inc_argmax=11528 fresh_argmax=11528
[verify] layer0 K seg diffs: pre_audio=0.000e0 old_audio=1.4e2 total=1.4e2
```

关键发现：
- **pre_audio 段（位置 0..8）diff=0** — 完全一致
- **old_audio 段（位置 9..35）diff=146** — 巨大差异

### 分段隔离实验

#### 实验 1：truncate 后立即对比

在 `truncate` 之后、新 prefill 之前，对比 truncated K cache 与 fresh prefill：

```
[verify-trunc] pre_diff=0.000e0 old_audio_diff=1.462e2 all_diff=1.462e2
```

truncate 后，旧音频位置就已经错了。

#### 实验 2：decode 后对比

在 decode 循环之后，对比 state KV cache 与 fresh prefill：

```
chunk 1: pre_diff=0 audio_diff=0 post_diff=0 all_prefill_diff=0  ✅
chunk 2: pre_diff=0 audio_diff=146 post_diff=2.9 all_prefill_diff=146  ❌
```

chunk 1（full prefill + decode）后，KV cache 完全正确。chunk 2（incremental）后，音频位置出错。

#### 实验 3：short vs long fresh prefill

对比 26-token fresh prefill 和 52-token fresh prefill 的 K cache（位置 9..35）：

```
short_vs_long pre=0.000e0 audio=0.000e0
```

K 值与序列长度无关（causal attention 下 K 只依赖当前位置输入）。这是正确的。

#### 实验 4：state K vs short fresh K

对比 truncated state K（来自 chunk 1 prefill）与 26-token fresh prefill K（用 chunk 2 的编码器输出的前 26 个 token）：

```
state_vs_short_audio=1.462e2
```

不一致！

### 决定性实验：编码器输出稳定性

直接对比编码器输出：用 200 mel frames 编码的前 26 个 token vs 用 400 mel frames 编码的前 26 个 token：

```
[verify-encoder] old_audio=26 embed_diff=8.833e-2
[verify-encoder] old_audio=52 embed_diff=6.490e-2
[verify-encoder] old_audio=78 embed_diff=5.141e-2
```

**编码器输出不稳定！** diff=0.088 不是数值精度（应 ~1e-7），而是根本性的数学差异。

## 根因

**音频编码器的 transformer 层使用 full attention**（当 chunk 数 ≤ `chunks_per_window` = 8 时，`build_window_mask` 返回 `None`）。

在 `audio_encoder.rs` 的 `build_window_mask` 中：
```rust
if chunks_per_window == 0 || chunk_token_counts.len() <= chunks_per_window {
    return None; // full attention
}
```

`chunks_per_window = n_window_infer / chunk_size = 800 / 100 = 8`。

对于 ≤ 8 个 chunk 的音频（≤ 8 秒），编码器使用 full attention。这意味着：
- 2s 音频（26 tokens）：token 0 关注 token 0..25
- 4s 音频（52 tokens）：token 0 关注 token 0..51
- 8s 音频（104 tokens）：token 0 关注 token 0..103

token 0 的 embedding 随音频增长而改变，因为 attention 的 key/value 集扩大了。

**增量 KV cache 假设之前位置的 audio embeddings 不变**，但 full attention 导致它们会随音频增长而改变。这就是增量 prefill 失败的根因。

### Python 参考实现确认

Python 的流式实现（`qwen3_asr.py` L724-728）每次都重新 feed 全部音频：
```python
state.audio_accum = np.concatenate([state.audio_accum, chunk], axis=0)
inp = {"prompt": prompt, "multi_modal_data": {"audio": [state.audio_accum]}}
```

Python 的流式是 O(n²) 的，不做 KV cache 复用。vLLM 的 prefix caching 只加速文本 prompt 部分（约 12 个 token），音频部分每次都重新编码 + 重新 prefill。

## 可行方案

### 方案 B + cached embeddings + merged prefill（已验证 ✅）

**三个关键修改让增量 KV cache 正确工作：**

#### 修改 1：强制 chunk-local attention（编码器稳定性）

修改 `audio_encoder.rs` 的 `build_window_mask`，通过 `ASR_FORCE_CHUNK_LOCAL=1` 环境变量强制每个 chunk 独立 attention（block-diagonal mask，`chunks_per_window=1`）。

这让编码器输出在音频增长时保持稳定（embed_diff 从 0.088 降到 1.8e-7）。

#### 修改 2：cached audio embeddings（消除数值漂移）

在 `StreamingState` 中保存上一次的 `audio_embeds`。每次 incremental prefill 时，用 `cat([cached[:old_audio], new[old_audio:]], 0)` 构建稳定 embeddings。

这消除了 Conv2d batch-size-dependent 的 ~1e-7 数值差异（经过 28 层 transformer 后会放大到 0.11）。

#### 修改 3：合并 new audio + post-audio 为单次 forward（消除 post-audio K 差异）

将 `streaming_incremental_prefill` 中的 Step 2（new audio prefill）和 Step 3（post-audio prefill）合并为一次 `text_decoder.forward` 调用。

分两次调用会导致 post-audio 位置的 K cache 与 fresh prefill 有 2.892 的差异（原因可能是 MLX SDPA 在不同调用方式下的数值行为不同）。合并后 diff=0。

#### 验证结果

三个测试音频全部通过（offline == incremental）：
- sample1.wav (8s, English): ✅
- sample2.wav (4.2s, English): ✅
- sample3.wav (5.6s, Chinese): ✅

1.0s chunk（8 步增量）也全部通过。

#### 性能

当前实现了两个加速优化：

1. **encoder 增量编码**：只编码新增 mel frames（需 `ASR_FORCE_CHUNK_LOCAL=1`）
2. **decoder prefix rollback**：通过 `rollback_tokens` 参数控制重新 decode 的 token 数

`init_streaming(language, rollback_tokens)` 的 `rollback_tokens` 参数：
- `0`：每次重新 decode 全部文本（精确匹配，最慢）
- `N`：保留前 `len-N` 个 token 作为 prefix（重新 prefill），只 decode 最后 N 个 token

**基准测试结果（sample1.wav, 8s, M4 Mac Mini）：**

| 配置 | offline | re-transcribe | incremental | speedup |
|------|---------|---------------|-------------|---------|
| chunk=2s, rollback=0 | 2.8s | 6.7s | 6.6s | 1.0x |
| chunk=2s, rollback=5 | 2.6s | 6.7s | 4.0s | **1.7x** |
| chunk=2s, rollback=10 | 2.6s | 6.7s | 5.1s | 1.3x |
| chunk=1s, rollback=3 | 2.5s | 12.7s | 5.0s | **2.5x** |

- `rollback=5` 是最佳平衡：1.7x 加速，结果与离线完全一致
- `rollback=10` 反而更慢：prefix 太长，prefill 开销增大
- 所有测试案例的结果与离线完全一致（✅ PASS）

**使用方式：**
```bash
# 精确匹配（rollback=0）
ASR_FORCE_CHUNK_LOCAL=1 cargo run --release --no-default-features --features mlx --bin test_streaming -- <model> <audio> 2.0 0

# 加速模式（rollback=5）
ASR_FORCE_CHUNK_LOCAL=1 cargo run --release --no-default-features --features mlx --bin test_streaming -- <model> <audio> 2.0 5
```

## 诊断代码

以下诊断环境变量可控制（在 `inference.rs` 中）：
- `ASR_VERIFY_INCREMENTAL=1`：对比 incremental vs fresh full prefill 的 logits 和 K cache
- `ASR_VERIFY_TRUNCATE=1`：对比 truncate 后的 K cache 与 fresh prefill
- `ASR_VERIFY_POST_DECODE=1`：对比 decode 后的 K cache 与 fresh prefill
- `ASR_VERIFY_ENCODER=1`：对比编码器对短/长音频的前 N token 输出

运行：
```bash
ASR_VERIFY_ENCODER=1 RUST_LOG=warn cargo run --release --no-default-features --features mlx --bin test_streaming -- <model_dir> <audio_file> 2.0
```
