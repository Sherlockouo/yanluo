# Release checklist (QuietType / 言落)

## Hard rule — local green before push

**Never push a release tag (or release commit) until the same commands CI runs have passed locally.** Tagging first and “letting CI find it” burns Actions minutes and ships broken releases (v0.10.5 / v0.10.6).

Minimum gate **on the machine that cuts the release** (today: macOS arm64):

```bash
# 1) Frontend — same as tauri beforeBuildCommand (tsc catches unused vars)
pnpm build

# 2) Rust lib with release features
cd src-tauri && cargo check --features qwen-local && cd ..

# 3) Prefer a real package once (slow but catches metallib / bundle hooks)
#    pnpm tauri build --features qwen-local --bundles app
```

Only after those pass: bump version → `pnpm version:sync` → CHANGELOG → commit → **then** tag + push.

If `pnpm build` / `tsc` fails, do **not** tag. Fix, re-run, then release.

Linux/Windows release jobs still run in CI (libtorch); macOS local `pnpm build` + package is the bar for FE / Tauri wiring mistakes.

## Version source of truth

```
package.json version
        │
        ├─ pnpm version:sync  →  Cargo.toml + tauri.conf.json
        │
        ├─ git tag vX.Y.Z     →  must equal package.json
        │
        └─ CI build embeds CARGO_PKG_VERSION
                 │
                 ├─ GitHub Release assets (dmg / msi / AppImage…)
                 └─ In-app「设置 → 更新」shows this version + checks newer tags
```

**Bundle name:** `tauri.conf.json` `productName` must stay ASCII **`QuietType`** (WiX / installer filenames). Window title + `CFBundleDisplayName` / menu are **QuietType**（中文名「言落」走 zh locale 文案）. Do not put CJK in `productName` — CI WiX `light.exe` and asset names break.

1. Bump `package.json` version.
2. Run `pnpm version:sync` (keeps Cargo / tauri.conf in lockstep).
3. Update `CHANGELOG.md` with `## [x.y.z] — YYYY-MM-DD`.
4. **Run the local gate above** (`pnpm build` + `cargo check --features qwen-local`).
5. Commit, then tag **exactly** that version:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin HEAD
git push origin "v$VERSION"
```

CI **fails** if `v*` tag ≠ `package.json`. The built app’s displayed version is the same string (from `CARGO_PKG_VERSION`).

## Platforms
| Platform | Runner | Features | Backend | Artifacts |
|----------|--------|----------|---------|-----------|
| macOS ARM64 | `macos-14` | `qwen-local` | MLX (Metal) | `.app` / `.dmg` |
| Linux x86_64 | `ubuntu-22.04` | `qwen-local` | libtorch **CUDA 12.6** (CPU fallback if no GPU) | `.deb` / `.AppImage` |
| Windows x86_64 | `windows-latest` | `qwen-local` | libtorch **CPU** (CUDA: local `--cuda` build) | `.msi` / NSIS |

Apple Speech is **macOS-only**. Local Qwen uses MLX on Apple Silicon; Linux/Windows use [qwen3_asr_rs](https://github.com/XBCoder128/qwen3_asr_rs) `tch-backend` + bundled libtorch (see `scripts/fetch-libtorch.mjs`).

**NVIDIA users (Linux/Windows):** Release builds link CUDA libtorch. Need a working NVIDIA driver (CUDA 12.x runtime). No discrete GPU → load falls back to CPU (slower). Missing driver libs may prevent CUDA path from loading — CPU fallback in worker.

## One-time setup
1. Enable GitHub Actions with `contents: write`.
2. Optional Apple signing secrets for notarized macOS builds (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`). Without these, macOS builds are **adhoc** — Gatekeeper may say「已损坏」; users need `xattr -cr` or right-click → Open. `hardenedRuntime` stays off until secrets are wired (`tauri.macos.conf.json`).
3. Keep the repo **Public** so in-app update checks can read Releases without auth.
   Private repos return **404** to unauthenticated API (browser login can still see them — that is why the Updates page can look “wrong”).
   Dev-only: set `GITHUB_TOKEN` / `GH_TOKEN` before launching the app.

## macOS MLX metallib

`qwen-local` builds must ship `Contents/MacOS/mlx.metallib` (staged by `scripts/stage-mlx-metallib.mjs` via `beforeBundleCommand`). Missing file → runtime falls back to CI absolute `METAL_PATH` and fails on user machines. See `doc/BUILD.md`.

## Linux / Windows libtorch

Release jobs run `node scripts/fetch-libtorch.mjs --cuda` then set `LIBTORCH` / `LIBTORCH_BYPASS_VERSION_CHECK`. Bundle hooks (`tauri.linux.conf.json` / `tauri.windows.conf.json`) stage libs via `scripts/stage-libtorch.mjs`. Runtime prepends bundled `libtorch/lib` to `LD_LIBRARY_PATH` / `PATH`.

## macOS Gatekeeper helper

After the DMG is built, `scripts/embed-gatekeeper-fix.mjs` puts `若打不开-点我.command` on the DMG volume (and beside `.app` when present). CI re-uploads the patched DMG. Users who see「已损坏」drag the app to Applications, then double-click that script.

## Cut a release
1. Follow **Hard rule — local green before push**, then **Version source of truth**.
2. **Release** workflow builds all platforms and uploads to the GitHub Release for that tag.
3. In-app **设置 → 更新** compares local `CARGO_PKG_VERSION` to the latest GitHub Release tag and can download the matching installer.

## Local package
```bash
# current OS, default features
make install

# macOS + Qwen MLX
make install-local
```

## In-app updates
- **检查更新** calls the GitHub Releases API off the UI thread (async + short timeout).
- **下载并安装** saves under `~/Downloads/QuietType Updates/` and opens the installer.
- macOS: open the `.dmg`, drag into Applications, relaunch.
- Menu: **Check for Updates…** → **设置 → 更新**.

## macOS permission debugging
Privacy lists only show apps that **requested** the permission.

1. Open **设置 → 权限**
2. Click **去授权** (one click — do not also spam「系统设置」)
3. Mic / Speech show an Allow dialog; Accessibility / Input Monitoring / Screen use the system prompt or Settings pane themselves
4. During `tauri dev`, look for binary `yanluo` (path shown on the page), not the product display name alone
5. After packaging a `.app`, the product name appears
6. Signed releases keep Mic / Speech / Screen across reinstalls; Accessibility / Input Monitoring often need a re-toggle after path change (macOS TCC)
