# Release checklist (ASR Workshop)

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

1. Bump `package.json` version.
2. Run `pnpm version:sync` (keeps Cargo / tauri.conf in lockstep).
3. Update `CHANGELOG.md` with `## [x.y.z] — YYYY-MM-DD`.
4. Commit, then tag **exactly** that version:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

CI **fails** if `v*` tag ≠ `package.json`. The built app’s displayed version is the same string (from `CARGO_PKG_VERSION`).

## Platforms
| Platform | Runner | Features | Artifacts |
|----------|--------|----------|-----------|
| macOS ARM64 | `macos-14` | `qwen-local` (MLX) | `.app` / `.dmg` |
| Linux x86_64 | `ubuntu-22.04` | default | `.deb` / `.AppImage` |
| Windows x86_64 | `windows-latest` | default | `.msi` / NSIS |

Apple Speech is **macOS-only**. Linux/Windows default to ElevenLabs (Qwen local needs MLX / separate backend).

## One-time setup
1. Enable GitHub Actions with `contents: write`.
2. Optional Apple signing secrets for notarized macOS builds.
3. Keep the repo **Public** so in-app update checks can read Releases without auth.
   Private repos return **404** to unauthenticated API (browser login can still see them — that is why the Updates page can look “wrong”).
   Dev-only: set `GITHUB_TOKEN` / `GH_TOKEN` before launching the app.

## Cut a release
1. Follow **Version source of truth** above.
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
- **下载并安装** saves under `~/Downloads/ASR Workshop Updates/` and opens the installer.
- macOS: open the `.dmg`, drag into Applications, relaunch.
- Menu: **Check for Updates…** → **设置 → 更新**.

## macOS permission debugging
Privacy lists only show apps that **requested** the permission.

1. Open **设置 → 权限**
2. Click **去授权** (one click — do not also spam「系统设置」)
3. Mic / Speech show an Allow dialog; Accessibility / Input Monitoring / Screen use the system prompt or Settings pane themselves
4. During `tauri dev`, look for binary `asr-workshop` (path shown on the page), not “ASR Workshop”
5. After packaging a `.app`, the product name appears
6. Signed releases keep Mic / Speech / Screen across reinstalls; Accessibility / Input Monitoring often need a re-toggle after path change (macOS TCC)
