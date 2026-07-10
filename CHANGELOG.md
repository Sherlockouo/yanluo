# Changelog

All notable changes to ASR Workshop are documented in this file.

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
