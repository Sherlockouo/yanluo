# ASR Workshop — Tauri

Desktop app for Qwen3-ASR (Automatic Speech Recognition), built on Tauri 2 + Solid.js + Tailwind CSS.

## Launch

```bash
pnpm install          # one time
pnpm tauri dev        # opens native window
```

`pnpm tauri build` produces `.app`/`.dmg` in `src-tauri/target/release/bundle/`.

The first `pnpm tauri dev` will compile Rust dependencies — expect a few minutes. Subsequent builds are fast.

## Stack

- **Frontend**: Solid.js + TypeScript + Vite
- **Styling**: Tailwind CSS + Kobalte (headless components)
- **Desktop**: Tauri 2.0
- **Backend**: see `../qwen3_asr_rs` (Rust ASR engine + OpenAI-compatible API server)

## Status

Skeleton only — empty placeholder page. Business logic (transcription UI, history, etc.) to be added.

## Keyboard

TBD — shortcuts will be wired as views are added.
