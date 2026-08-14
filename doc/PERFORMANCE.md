# 性能报告 — Fn→HUD 弹出 & 说话→ASR 吐字（v0.11.0 优化批次）

> 2026-08-13。本批次针对 macOS 平台两条交互关键链路做了架构级优化。
> 表格中「估算」值为基于链路结构的专业估计（附依据），非实测；
> 实测协议见文末「埋点与测量」，发布后请用 stderr 时间戳日志回填实测列。

## TL;DR

| 环节 | 优化前（估算） | 优化后（预期） | 主要手段 |
|---|---|---|---|
| Fn 松开 → HUD 窗口原生可见 | ~100–300ms | **≈1 帧（<16ms）** | 原生直通，砍掉隐藏 webview 绕圈 + 2 次 IPC |
| Fn 松开 → 麦克风出数据 | +30–80ms（cpal 冷启动） | **≈0**（按下已预热） | Fn keydown 推测性开麦，松开转正 |
| 按下→松开之间的语音 | 丢失 | **保留**（进正式转写） | 预热缓冲无缝转正 |
| 首次录音首字延迟（Qwen） | 0.5s + **~2s Metal JIT** + 推理 | 0.5s + 推理 | LoadModel 后 GPU 预热 |
| 说话 onset → 首字上屏（Qwen） | ~0.7–1.2s（0.5s bootstrap + 空假设再等一拍 + warm 压制） | **~0.45–0.6s** | bootstrap 0.3s + push-then-refine + 空假设 0.15s 重试 |
| 吐字更新粒度（段内前 3 个 partial） | 1.0–1.5s | **0.5s** | 早期节奏 ramp（质量地板不动） |
| 吐字更新粒度（稳态） | 1.5s（默认） | **0.6s** | 默认 chunk 与前端对齐 |
| 说完停顿 → 文字定稿（commit） | ~1.4s（且短句永不自动定稿） | **~0.9s**（迅速档 ~0.6s） | 静音/hold/min_segment 参数重调 |
| 文字上屏观感 | partial 整串直出（0.5–1s 一跳，3–5 字/跳） | **逐字渐显**（自适应滴入，~0.3s 流完小批次） | FE `useStreamingReveal` |
| Apple 路径首字 | 可能含网络往返 | on-device（设备支持时） | requiresOnDeviceRecognition |

---

## 链路 A：Fn → HUD 弹出

### 优化前（v0.10.8 及之前）

```
Fn 按下（CGEventTap 仅 arm，无动作）
  → Fn 松开 → emit "fn-key-down"
  → 隐藏主窗口 WKWebView 的 JS（⚠ 系统可将其挂起/节流，唤醒代价不定）
  → await invoke("is_recording")        ← IPC 往返 ①（纯状态确认）
  → await invoke("start_recording")     ← IPC 往返 ②
  → [AppKit 主线程] 配置/权限检查
      同步读 hud-position.json + CGDisplay 枚举（每次弹出都读盘）
  → orderFrontRegardless（HUD 原生可见）
  → AudioRecorder::start（cpal 设备枚举 + AudioUnit 冷构建，阻塞主线程）
  → 麦克风开始出数据
```

延迟构成（估算）：

| 阶段 | 估算 | 依据 |
|---|---|---|
| 隐藏 WKWebView 唤醒 + JS 事件分发 | 30–200ms，波动 | macOS 对不可见 webview 的调度节流；冷启动时更高 |
| 2 次串行 IPC 往返 | 5–20ms | Tauri invoke 单次 RTT 数 ms 级，串行 ×2 |
| 主线程串行检查 + 读盘 | 2–10ms | hud-position.json 同步读 + 锁 + 状态查询 |
| cpal 冷启动（枚举+建流+play） | 30–80ms | CoreAudio 设备枚举与 AudioUnit 初始化典型值 |
| **合计（松开→麦克风出数据）** | **~70–300ms** | |

### 优化后（v0.11.0）

```
Fn 按下（CGEventTap arm）
  → 立即后台线程预热麦克风（丢弃式缓冲，~50µs 返回不阻塞 tap）
  → Fn 松开 → emit "fn-toggle-native"（纯原生事件）
  → lib.rs 原生监听（tap 线程内联）→ 独立线程 handle_fn_toggle
      读 Rust 真相（recording atomic + floating_status_slot）决策 start/stop
  → start_recording_impl：
      HUD show（run_on_main_thread 异步派发，零读盘——位置内存缓存）
  → AudioRecorder::start：直接转正预热流（缓冲已在流动）
  → worker StartStreaming
```

- editing / refining / processing 三态仍由 tap 内 `emit_hud_skip_or_confirm`
  原生拦截（与优化前一致），不进入本链路。
- 主窗口 webview 不再位于关键路径：状态经 `floating-status` 被动镜像，
  错误经 `fn-toggle-error` 到前端 toast（i18n 归前端）。
- HUD 入场动画（350ms spring）按 DESIGN.md 契约保留——原生窗口即时可见，
  动画是内容编排而非出现门槛。

### 关键改动

| 文件 | 改动 |
|---|---|
| `src-tauri/src/hotkey/mod.rs` | 4 个发射点 `fn-key-down` → `fn-toggle-native`；Fn keydown 触发 `maybe_begin_speculative_mic` |
| `src-tauri/src/lib.rs` | 原生监听 `fn-toggle-native` → 独立线程执行（避免阻塞 CGEventTap） |
| `src-tauri/src/commands/mod.rs` | 新增 `handle_fn_toggle` / `start_recording_impl` / `stop_recording_impl`；`start_recording` 异步化 |
| `src-tauri/src/hud/mod.rs` | hud-position.json 进程内缓存（load 走缓存 / save 双写） |
| `src/app-context.tsx` | `fn-key-down` 110 行决策逻辑删除，改 `fn-toggle-error` toast |

## 链路 B：开始说话 → ASR 吐字（Qwen 本地路径）

### 优化前

```
麦克风 48k 回调 → 降混 + 线性重采样 16k → 共享缓冲 + condvar
→ worker 循环（condvar 唤醒，50ms 兜底）
→ VAD 20ms 帧开段（webrtc, aggression 2）
→ 段内攒满 0.5s（BOOTSTRAP_SAMPLES=8000）→ 首个 partial
   ⚠ 首次推理付 Metal shader JIT ~2s（warmup 从未被调用）
→ emit partial-result → HUD 上屏
→ 之后每 chunk_sec（默认 1.5s）新音频才出下一个 partial
```

### 优化后

```
（同上采集链路）
→ VAD 开段
→ 段内 partial #1：0.3s 门槛（bootstrap 4.8k samples；encoder 尾块零填充 + valid-token 掩码，无最小长度断言）
   ⚠ warm 压制已移除 —— push-then-refine：HUD 文字全部视为临时假设，
     识别出非空文本立刻 emit；后续 partial / commit / LLM refine 直接覆盖
→ 空假设 → 仅 0.15s 后快速重试（不再等一整拍）
→ 段内 #2、#3：0.3s 节奏（ramp 联动 bootstrap）
→ #4 起：chunk_sec 节奏（默认 0.6s）
→ VAD commit / rollback / min_silence 等质量地板：完全未动
```

- **GPU 预热**：LoadModel 成功后在 worker 线程跑 1s 静音 offline 前向 +
  `mlx::stream::synchronize()`，把 mel / encoder / prefill / decode 共享
  kernel 的 JIT 编译移出首次会话。`model-loaded` 事件现在意味着「热备完毕」。
  - 限制：git 依赖（`fix/asr-keep-punctuation` 分支）未暴露 `warmup()`，
    chunk-local 流式形状无法经公开 API 安全预热（encoder 字段私有，强行
    预热会把 chunk-local 态泄漏进文件转写）。共享 kernel 占冷启动大头，
    残余首次 JIT 为小份额。**后续**：引擎仓库合入 `warmup()` 后切换完整版。
- **Apple 路径**：`supportsOnDeviceRecognition` 为真时经 KVC 设
  `requiresOnDeviceRecognition`（KVC 方式规避部分 SDK 头文件 iOS-only
  声明；不支持时回退现状）。

### 关键改动

| 文件 | 改动 |
|---|---|
| `src-tauri/src/transcription/mod.rs` | LoadModel 后 `warmup_asr_inference`；partial 门限早期 ramp（`seg_partial_count`）；段开/重开归零 |
| `src-tauri/src/config/mod.rs` | 吐字节奏与 VAD 响应默认值（见下表）；新增 `speculative_mic`（默认 true） |
| `src-tauri/src/audio/vad.rs` | 质量下限放宽；「迅速」预设 450/150ms |
| `src-tauri/src/macos_speech.m` | on-device 优先 |

### 吐字与定稿节奏参数（v0.11.x 响应性批次）

| 参数 | 旧默认 | 新默认 | 下限 | 说明 |
|---|---|---|---|---|
| `chunk_size_sec` | 1.5 → 1.0 | **0.6** | 0.5 | 稳态 partial 节奏；partial 为增量计算，0.6s 开销小且读感「直播」 |
| `vad_min_silence_ms` | 900 | **650** | 500 | 静音多久成为定稿候选 |
| `vad_commit_hold_ms` | 500 | **250** | 150 | 候选后再 hold 的时长 |
| `vad_min_segment_ms` | 2500 | **1200** | 800 | **只计语音样本**——旧值导致 <2s 的短句永不自动定稿 |
| 「迅速」预设 | 600/200 | **450/150** | — | 设置 → 识别 → 响应速度（新增 UI 开关） |

效果：说完一句话 → 停顿 ~0.9s 文字定稿（迅速档 ~0.6s）；说话中每 ~0.5–0.6s 刷新一次假设。
按 Fn 停止的路径不受这些参数影响（立即 commit + 定稿）。

## 推测性开麦（新机制）

Fn 按下即起丢弃式采集流，松开提交时转正——按下到松开之间的人声（往往
是句首）不再丢失。线程模型：cpal `Stream` 是 `!Send`，由专属「属主线程」
创建并销毁；全局槽与会话租约只持有 Send 句柄（缓冲 Arc + 命令 Sender）。

生命周期：

| 事件 | 动作 |
|---|---|
| Fn keydown（非捕获态、空闲、External 模式、绑定含 Fn） | 后台预热（`begin_speculative_mic`） |
| 松开 → 转写/翻译/agent 会话成立 | `AudioRecorder::start` 转正（External 限定；Both 需 mic/system 索引对齐故不转正） |
| 和弦取消 / HUD 拦截 / 预检失败 / stop / cancel | 立即丢弃（`discard_speculative_mic`） |
| 无释放（异常残留） | 10s 收割线程兜底（上限 ~640KB 缓冲） |
| 双击竞态（按下早于 recording 置位） | stop/cancel 路径二次兜底丢弃 |

**取舍**：按下 Fn 期间系统麦克风指示灯会亮，即使最终取消（音频全程不出本机）。
配置 `"speculative_mic": false` 可关闭回「松开后冷启动」行为。

## 埋点与测量

`elog!` 现统一输出毫秒级时间戳前缀。量化两条链路：

```bash
# 跑 dev 或打包版，观察 stderr（打包版: ~/Library/Logs 或启动终端）
pnpm tauri:dev:local 2>&1 | grep -E "^\[[0-9]+\] \[(fn|floating|audio|fn-toggle|asr-worker|mlx-worker)\]"
```

关键行与差值含义：

| 差值 | 含义 | 优化前如何得到 |
|---|---|---|
| `[fn] key-down` → `[floating] orderFront` | **按下→HUD 原生可见**（含手指按压时长） | 旧无埋点；可用 v0.10.8 加临时日志对照 |
| `[fn] key-down` → `[audio] promoted speculative mic (pre-buffered X.XXs)` | 按下→音频已在流（X 为保留的按下期语音秒数） | 旧：松开后才 `[audio] mic device:` |
| `[fn-toggle] native start (fn) done in Xms` | 原生 toggle 全链路耗时 | — |
| `[asr-worker] GPU warmup done in Xms` | 预热成本（一次性，移出首录） | 旧：计入首录首字 |
| `[mlx-worker] partial #1 seg#N: (…) window` 距 `[fn] key-down` | **按下→首字推理触发** | — |
| 相邻 `partial #N` 时间差 | 吐字节奏（前 3 个应 ≈0.5s，其后 ≈chunk_sec） | — |

建议回填：跑 10 次「按下→说话→松开」，取中位数填入 TL;DR 实测列。

## 回归清单

- [ ] Fn 弹出 → 说话 → 首字 → 再按 Fn 停止 → 编辑/粘贴
- [ ] ⇧Fn 翻译（需 LLM 已配置 + 未配置两种提示）
- [ ] Fn+Space agent HUD（语音派发不回归）
- [ ] 录音中按 Fn = 停止；editing 态按 Fn = 确认
- [ ] 和弦捕获模式（设置 → 快捷键录制）不受预热影响
- [ ] 出稿页按钮发起的录音（HUD 隐藏会话）起停正常
- [ ] 系统音频 / 双混音模式起停正常（预热按设计不转正）
- [ ] 快速双击 Fn 无麦克风指示灯残留

## 后续空间（未纳入本批次）

1. 引擎侧暴露 `warmup()`（本地 qwen3_asr_rs 已有实现）→ 消除残余首次流式 JIT；
2. chunk_sec 自适应：段首小步长 + 稳态大步长的动态策略；
3. HUD 常驻合成层（隐藏时保持 1px 透明）消除极少数首帧 webview 重绘；
4. Apple 路径 `SFSpeechRecognizer` 预热（现每会话新建 request）。
