# Changelog

All notable changes to 言落 (Yanluo) are documented in this file.

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
