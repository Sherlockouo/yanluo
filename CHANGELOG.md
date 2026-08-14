# Changelog

All notable changes to Yanluo（言落）are documented in this file.

## Unreleased

### Changed（吐字响应性）
- **说话中**：稳态吐字节奏 chunk 默认 1.0s → **0.6s**（段首 0.5s ramp 不变），文字跟读更「直播」
- **说完定稿更快**：静音判定 900+500ms → **650+250ms（~0.9s 定稿）**；「迅速」预设升级为 450/150ms（~0.6s）
- **短句修复**：`vad_min_segment_ms` 只计语音样本，旧默认 2.5s 导致不足 2s 的短句**永不自动定稿**——降为 1.2s（下限 800ms）
- 设置 → 识别新增「**响应速度**」开关（均衡 / 迅速）；分片秒数输入下限与后端钳制统一为 0.5s（旧 UI 允许 0.2 但被后端静默吞掉）
- 前后端默认值全面对齐（`defaultConfig` 此前停留在 1.5s 旧值）

## [0.11.1] — 2026-08-14

### Fixed（CI 打包）
- **Windows qwen-local 打包**：esaxx-rs 0.1.10 硬编码 `static_crt`（MSVC /MT）
  与 libtorch 的 /MD 冲突（LNK2038）——vendored patch（`src-tauri/vendor/esaxx-rs`）
  去掉 static_crt，动态 CRT 统一（Apache-2.0 许可保留）
- **Linux AppImage 打包**：linuxdeploy 递归解析依赖需要 libtorch（及 CUDA 版的
  cuDNN/cuSparseLt 等全套 NVIDIA 库）在 `LD_LIBRARY_PATH` 上——已补齐；runner
  装 squashfs-tools/file 并预释放磁盘
- **Linux 发行包改用 CPU libtorch**（与 Windows 策略对齐）：CUDA 版 AppImage 需捆绑
  整个 NVIDIA 栈，超出 GitHub Release 单资产 2GB 上限；NVIDIA 用户本地
  `node scripts/fetch-libtorch.mjs --cuda` 自建即可
- 0.11.0 起 Windows / Linux 资产随 v0.11.1 补齐（macOS 不受影响）

## [0.11.0] — 2026-08-13

### Performance（macOS 交互延迟优化批次）
- **Fn → HUD 原生直通**：热键不再绕行隐藏主窗口 webview + 2 次 IPC，原生
  决策 start/stop（`handle_fn_toggle`）；松开→HUD 可见从 ~100–300ms 降至 ≈1 帧
- **按下即开麦**（`speculative_mic`，默认开）：Fn 按下即预热采集，松开转正；
  按下→松开之间的语音不再丢失；取消/异常路径立即丢弃，10s 收割兜底
- **GPU 预热**：LoadModel 后跑静音前向，首次录音不再付 ~2s Metal JIT 冷启动
- **吐字节奏 ramp**：段内前 3 个 partial 以 0.5s 步进（首字后快速跟进），
  之后回 chunk 节奏；VAD commit / rollback 质量地板不变
- `chunk_size_sec` 默认 1.5s → 1.0s（与前端对齐）
- Apple 路径：设备支持时强制 on-device 识别（省网络往返）
- HUD 弹出零磁盘 IO（hud-position.json 进程内缓存）；`start_recording`
  异步化不再阻塞 AppKit 主线程；sfx AudioContext 启动即预建
- `elog!` 全量毫秒时间戳 + 关键链路埋点，量化见 `doc/PERFORMANCE.md`

### Changed
- 性能差异报告：新增 `doc/PERFORMANCE.md`（链路前后对比 / 估算依据 / 实测协议）

## [0.10.8] — 2026-08-04（随 v0.11.0 一并发布）

### Changed
- 品牌 EN / 安装包 / macOS TCC 显示名恢复为 **Yanluo**（QuietType 退役）；UI 中文仍为「言落」
- 权限说明：提示系统设置里找 **Yanluo**，勿搜「言落」
- HUD 默认位：靠下约 78% 屏高，距底 ≥160px
- HUD 实时文字：水流式左推（transform 粘性跟追），不再变灰

### Fixed
- HUD：去掉粘贴后「撤销」态
- HUD 编辑态：加宽加高、可选字（关 MovableByWindowBackground）、去掉 Fn badge
- HUD 编辑态向上扩展（底边锚定）
- HUD 位置记忆：外接屏错误 scale 导致左上角；拒绝/清理 `(0,~30)` 垃圾偏移
- HUD：hide→show 才放置；FE 不再 `recenter` 抢位

## [0.10.7] — 2026-07-30

### Fixed
- `pnpm build` / CI：`asr-hud` 未使用的 `autoSubmitHint`（TS6133）——接上 90s 提示 UI
- 发版流程：必须本地 `pnpm build` + `cargo check` 过后再推 tag（见 `doc/RELEASE.md`）

## [0.10.6] — 2026-07-29

### Added
- 首次启动品牌 intro + 轻量交互音效（可关）
- 启动壳：内联主题底色，主窗首帧后再显示，减轻白屏

### Fixed
- 模型下载改为后台线程 + 进度节流，不再冻住前端
- HUD：仅 hide→show 时放置；去掉副屏 `.max(8)` 拽回主屏
- HUD：全屏 Space 用 `CanJoinAllSpaces | FullScreenAuxiliary`（去掉 Transient）
- （CI 因上述 TS6133 未出包；功能随 0.10.7 发布）

## [0.10.5] — 2026-07-23

### Added
- DMG / bundle 附带 `若打不开-点我.command`（双击清 quarantine + 本机重签）
- Linux / Windows 本地 Qwen：libtorch（`scripts/fetch-libtorch.mjs`）；Release 已带 `qwen-local`（Linux CUDA / Windows CPU）
- HUD / Apple Speech / 设置与转写打磨

### Fixed
- macOS Gatekeeper 辅助脚本打进 DMG；CI 打包后 `--clobber` 回传

## [0.10.4] — 2026-07-23

### Fixed
- `beforeBundleCommand` 脚本路径：工作目录是仓库根，应为 `scripts/…`（原 `../scripts` 导致本地/CI 打包失败）

## [0.10.3] — 2026-07-23

### Fixed
- 打包缺 `mlx.metallib` → 回退 CI 绝对路径导致 MLX 加载失败；macOS bundle 自动塞入 `Contents/MacOS/`
- 无证书时关闭 `hardenedRuntime`，减轻 Gatekeeper「无法验证 / 已损坏」

## [0.10.2] — 2026-07-22

### Added
- 首次引导：选系统识别或一键下载本机 Qwen（权重 + tokenizer，下完自动加载）
- README：CI / Release badge

### Fixed
- 模型下载后 `loadModel` 用空 path 盖掉刚写入目录的竞态

## [0.10.1] — 2026-07-22

### Added
- 派活：消息内本地路径 / URL 识别；可预览文件弹窗（图/音视频/PDF/HTML/文本）
- Markdown 裸 URL 自动可点，系统浏览器打开

### Changed
- 派活消息脚注：复制 + 时间挪到底栏
- 首页词云：仅指针进入且悬停词才磁吸；静止无漂浮

### Fixed
- 路径提取过滤假阳（`f:\n`、泛目录、书名号碎片等）

## [0.10.0] — 2026-07-21

### Added
- Agent mid-flight steer：运行中发消息先中断再续聊；空发送 = 暂停
- Close main window → hide to tray；Dock reopen；自定义退出菜单
- 设置 → 纠错学习：few-shot 示例管理面板（`list_fewshot_cases`）

### Fixed
- HUD mid-pipeline Fn accept：保留 live 文本，FE 可覆盖 slot（避免空粘贴）
- Agent 续聊不再因「仍在运行」被拒；旧 turn 不再覆盖新 turn 状态

### Changed
- 派活 / 出稿 / HUD 样式与交互打磨

## [0.9.1] — 2026-07-19

### Fixed
- Bundle `productName` ASCII **Yanluo** (CJK broke WiX `light.exe` + stripped asset filenames to `_0.9.0_*.dmg`)
- Release CI passes per-platform `--bundles` (macOS app/dmg, Linux deb/appimage, Windows msi/nsis)
- macOS `CFBundleDisplayName` / menu About stay **言落**; window title `言落 · Yanluo`

## [0.9.0] — 2026-07-19

### Added
- 出稿 / 设置 tab 记忆：记住上次打开的 mode/tab/sub，以及各自 `.app-content` 滚动位置（裸侧栏链接从 session 还原；URL 深链优先）
- Refine 护栏：长度/句子数/删句拦截，跑偏回退原文
- Refine few-shot：历史已确认修正注入纠错 prompt
- Distill 频次门槛 + 常用词 hotword 提炼；词库单 CJK 字 pair 防误伤

### Changed
- 言落出稿 / 派活 / 设置与 HUD 体验打磨（v0.8.0 以来）
- Refine 默认 prompt 前后端单一真源；长文分段纠错 + 瞬态失败重试

## [0.8.0] — 2026-07-16

### Added
- 言落 branding + design system (出稿 / 派活 / 设置)
- Agent job flow and local-first jobs UI
- Streaming ASR + VAD path (segment KV, RoPE grow, Silero)

### Changed
- Results-first / jobs hierarchy across ASR, translate, glossary, history

## [0.5.2] — 2026-07-11

### Fixed
- Linux CI: install `libasound2-dev` for cpal/alsa
- Windows build: import `std::process::Command` for clipboard helper

## [0.5.1] — 2026-07-10

### Fixed
- Linux CI: drop conflicting `libappindicator3-dev` (keep Ayatana)
- Windows CI: UTF-8 when generating release notes from CHANGELOG

## [0.5.0] — 2026-07-10

### Added
- Translate mode (Shift+Fn): stable-prefix streaming translation, HUD shows translation only
- Separate HUD language chip with native system menu for live target switching
- Standard macOS app menu (About / Settings / Edit / Window) and tray icon
- History stores translate target language (`译为 English` etc.)

### Fixed
- Fn-then-Shift chord starts translate (commit on Fn release with peak modifiers)
- Translate finalize re-translates full transcript for quality (stream is HUD preview)
- App icon bundling (`No matching IconType`) — regenerate icns/ico/png set
- Release CI: pnpm workspace `packages` field so Node cache / install works

### Changed
- Language / LLM removed from custom menu bar; configure in Settings / Translate pages

## [0.1.1] — 2026-07-10

### Fixed
- Apple Speech / Microphone permission request no longer crashes (main-queue, non-blocking)
- HUD meter: real log-spaced speech bands (Goertzel) instead of stiff RMS bars

### Changed
- Thinner Apple Music–style spectrum bars with per-band attack/release
- ElevenLabs credentials moved into ASR provider settings
- Multi-platform CI/release (macOS / Linux / Windows)

## [0.1.0] — 2026-07-10

### Added
- Tauri desktop shell with floating always-on-top HUD capsule
- Apple Speech (macOS only), ElevenLabs Scribe, and optional Qwen local ASR
- ForcedAligner character alignment for transcript highlighting
- Settings: General, Permissions (request + debug path), Updates (release log)
- GitHub Actions CI + multi-platform release (macOS / Linux / Windows)
