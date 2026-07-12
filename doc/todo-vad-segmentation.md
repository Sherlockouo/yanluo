# TODO: VAD 分段与内存优化

> **已收敛**：阶段表 [`ROADMAP-streaming-asr-vad.md`](./ROADMAP-streaming-asr-vad.md)；架构 [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md)。  
> **实现进度**：S0+S1 已交付；S1.1 调切段质量（过早 VAD 会伤准确度）。

## 问题

当前流式 ASR 始终处理完整音频（从头累积），随着录音时间增长：

- **KV cache 线性增长**：每个 audio token 在 28 层 decoder 中都有 K/V 缓存。120s 音频 ≈ 1560 audio tokens × 28 层 × 2(K,V) × 8 KV heads × 128 dim × 4 bytes ≈ ~360MB
- **prefix 文本增长**：rollback 模式下 prefix 越来越长，每步 prefill 的 token 数增加
- **decode 耗时增长**：虽然测试显示 50s 内增长不明显，但更长的音频（5min+）会看到 decode 变慢（attention 扫描更长 KV cache）
- **cos/sin 位置上限**：当前 4096，约支持 3 分钟。更长音频需要进一步增大或改用动态计算

## 方案：VAD 分段

在流式过程中引入语音活动检测（VAD），将连续语音分割为独立段落：

### 工作流程

```
音频流 → VAD 检测 → [段落1] [段落2] [段落3] ...
                      ↓           ↓           ↓
                   流式识别    流式识别    流式识别
                   (独立KV)   (独立KV)   (独立KV)
```

1. VAD 检测静音段（如 >500ms 的静音）
2. 在静音处"提交"当前段落的识别结果
3. 重置 KV cache 和 StreamingState
4. 下一段从空白状态开始识别

### 优势

- **内存恒定**：每段独立处理，KV cache 不会无限增长
- **性能稳定**：每段的 prefill/decode 耗时不会随总录音时间增长
- **结果更准确**：分段处理避免了超长上下文导致的注意力分散

### 实现要点

1. **VAD 算法选择**：
   - 简单方案：能量阈值（RMS < threshold 持续 N ms → 静音）
   - 中级方案：WebRTC VAD（已有 Rust binding `webrtc-vad`）
   - 高级方案：Silero VAD（神经网络，精度高但需额外模型）

2. **段落提交策略**：
   - 检测到静音 → 等待 300ms 确认（避免短暂停顿误判）
   - 确认静音 → 提交当前文本到最终结果 → 重置 state
   - 前端显示：已提交段落 + 当前进行中的段落

3. **State 重置**：
   - 重新调用 `init_streaming()` 创建新的 `StreamingState`
   - 旧的 KV cache 被 drop，内存释放
   - `cached_audio_embeds`、`cached_mel_frames` 等全部清零

4. **前端交互**：
   - 实时显示：已完成段落（灰色）+ 当前段落（高亮）
   - 最终结果：所有段落拼接

### 优先级

中优先级。当前方案在 3 分钟内可用（cos/sin 4096 位置），但：
- 5 分钟以上的会议/讲座场景需要此优化
- 内存占用在长录音时会达到 GB 级
- VAD 还能提升识别质量（避免跨段落上下文干扰）

### 依赖

- VAD 库：`webrtc-vad`（纯 Rust，轻量）或能量阈值（无依赖）
- 前端改动：段落显示 UI
- 后端改动：worker 循环中集成 VAD + state 重置
