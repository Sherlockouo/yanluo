# Release checklist (ASR Workshop)

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
3. Keep versions in sync: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`.

## Cut a release
1. Update `CHANGELOG.md` with `## [x.y.z] — YYYY-MM-DD`.
2. Commit and push to `main`.
3. Tag and push:

```bash
git tag v0.1.1
git push origin v0.1.1
```

4. **Release** workflow builds all three platforms and uploads to the GitHub Release.
5. In-app: **设置 → 更新** shows the Release Log.

## Local package
```bash
# current OS, default features
make install

# macOS + Qwen MLX
make install-local
```

## macOS permission debugging
Privacy lists only show apps that **requested** the permission.

1. Open **设置 → 权限**
2. Click **去授权** (one click — do not also spam「系统设置」)
3. Mic / Speech show an Allow dialog; Accessibility / Input Monitoring / Screen use the system prompt or Settings pane themselves
4. During `tauri dev`, look for binary `asr-workshop` (path shown on the page), not “ASR Workshop”
5. After packaging a `.app`, the product name appears
6. Signed releases keep Mic / Speech / Screen across reinstalls; Accessibility / Input Monitoring often need a re-toggle after path change (macOS TCC)
