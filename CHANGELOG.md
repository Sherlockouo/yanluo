# Changelog

All notable changes to Sayi are documented in this file.（曾用名：QuietType → Yanluo 言落 → ShuoChengao 说成稿）

## [0.12.0] — 2026-10-12

### Added（转写作品工作室：作品目录 + 云识别 + AI 内容管线 + 研究）
- **作品目录**：每次文件转写生成一个独立文件夹（`audio.*`、`transcript.json` / `transcript.md`、`notes/`、`research/`、`work.json` 索引），默认 `app_data/works`，可在设置中改到任意目录；历史记录双向关联作品
- **云识别**：`transcription/cloud.rs` 统一分发 ElevenLabs Scribe（说话人分离 + 词级时间戳）、OpenAI 兼容 `/audio/transcriptions`（Whisper / Groq）、阿里云百炼 Paraformer（异步任务轮询），全部归一化为 `TranscriptionResult`
- **AI 产物**：摘要、会议纪要、笔记、小红书、抖音口播、公众号长文；基于 refine 后的底稿生成，逐字稿保持不变；摘要 / 纪要 / 笔记引用 `[mm:ss]` 时间戳
- **时间戳联动**：产物中的 `[mm:ss]` 可点击，直接跳转左侧音视频；产物与研究面板保留左侧媒体栏，边听边看
- **研究模式**：对单个作品提问，agent 在作品目录内基于逐字稿与笔记写研究报告，结果保存到 `research/<job>.md`
- **全页阅读器**：作品在独立页面打开（不再是弹窗）：左侧媒体、中间逐字稿 / AI 产物 / 研究，右侧「原文批注」。选中词可高亮（4 色）或写评论，批注写入作品目录的 `annotations.json` 并同步生成 `mem.md`（原文 + 评论 / 原文 + 高亮）
- **作品库**：侧边栏新增「作品」（与「文稿」同级），列出全部作品（倒序），点击进入全页阅读器；返回按钮回到作品库
- **文件转录入口迁入作品库**：「文稿」移除「文件」模式（默认模式改为「实时」）；作品库右上角「新转写」进入上传 / 链接转录，完成后直接打开该作品
- **转录进度**：本机识别按分块对齐后的时间戳换算百分比（已识别到的音频时间 / 总时长），处理界面显示进度条与 `已识别 mm:ss / mm:ss`；云端识别为单次请求，暂无进度

### Fixed（点「文稿」整页冻结 ~0.5s — 实测定位）
- **根因**：`get_ytdlp_status` 是同步 Tauri command（Tauri 2 主线程执行），每次进入文稿页都会同步
  spawn 最多 7 个 `yt-dlp --version` Python 子进程（每个 ~0.3s），整个 app UI 冻结——探针实测
  route-dom 仅 0-24ms 但帧率跌至 14-19/700ms、单帧最坏 414-505ms。现改为 `command(async)`
  （移出主线程）+ 60s 会话缓存
- 转写列表两阶段渲染（空态→列表、400ms 时 8→30 扩张）在进场动画期间强制 WKWebView 整页重栅格：
  列表首帧直接渲染（数据本在内存），更多行改为滚动接近时渲染（IntersectionObserver 哨兵）
- 删除列表行常驻 `willChange`（8-30 个强制合成层）；隐藏面板预挂载改 requestIdleCallback
  （不再进页 350ms 定时引爆）
- 首页词云 tab：三个源单次遍历聚合 + useDeferredValue，切换不再阻塞点击帧
- `.app-content` 移除 `scroll-behavior: smooth`（与程序化滚动恢复冲突，每次进页强制滚动动画）
- 新增 `src/dev/`（tauri-mock / perf-probe）：浏览器内复现 + 掉帧探针，dev 默认开启

### Changed（品牌）
- 产品名统一为 **Sayi**：crate / 二进制（`sayi`）、npm 包名、agent kit（`sayi-config` / `sayi-settings.md`）、
  更新 UA / 下载目录、导出文件名兜底、打包脚本与 Release 标题
- 不变（升级兼容）：bundle id `com.sherlockouo.yanluo`、数据目录 `Application Support/Yanluo`、
  GitHub 仓库 `Sherlockouo/yanluo`、既有 localStorage 键

### Changed（push-then-refine：说话即出字）
- **HUD 展示与 commit 解耦**：字幕全部视为临时假设——识别出非空文本**立刻上屏**，
  后续 partial / 定稿 / LLM refine 直接覆盖（`streaming_hypothesis_warm` 压制移除）
- 首解码门槛 0.5s → **0.3s**（encoder 尾块零填充已验证无最小长度约束）：
  说话 onset 后 **~0.5s 内**首字上屏（此前 ~0.7–1.2s）
- 首解码为空（语音太短）→ **0.15s 后快速重试**，不再空等一整拍
- 段内前 3 拍 0.3s 密集节奏（ramp 联动），之后 0.6s 稳态；定稿/回滚质量地板不动

### Fixed（流式观感）
- HUD 吐字改为**平滑逐字渐显**：ASR 假设以 ~0.6s 批次到达，此前整串直出造成「一段一段」跳变；现按自适应速率滴入（小批次 ~0.3s 流完、大追赶加速），假设修正即时吸附不拖延错字
- 句子定稿（active → committed）文字**原地沉降变色**，不再整句重排跳动；agent 语音字幕同样接入
- 尊重 `prefers-reduced-motion`（直接显示全文）

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
