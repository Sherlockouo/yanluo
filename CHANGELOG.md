# Changelog

All notable changes to ASR Workshop are documented in this file.

## [0.5.0] — 2026-07-10

### Added
- Translate mode (⇧+Fn): stable-prefix streaming translation, HUD shows translation only
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
