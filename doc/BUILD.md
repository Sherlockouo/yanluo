# Build troubleshooting（言落）

本地 Qwen / MLX 编译与运行时踩过的坑。日常开发见根目录 [`README.md`](../README.md)。

## 打包后 `Failed to load the default metallib`

**症状**：`.app` 能开，加载 Qwen 时报：

```
MLX error: Failed to load the default metallib. library not found
… at /Users/runner/.cargo/git/checkouts/qwen3_asr_rs-…/mlx-c/mlx/c/stream.cpp:31
```

**根因**：MLX 先在可执行文件同目录找 `mlx.metallib`，找不到再回退到**编译机绝对路径**（CI = `/Users/runner/...`）。路径里的 `.cpp` 是报错位置，不是 metallib 路径。

**解决**（已接入打包）：

- **权威步骤**：`beforeBundleCommand` → `scripts/stage-mlx-metallib.mjs --bundle`，cargo **整编完成后**把 metallib 塞进 `Yanluo.app/Contents/MacOS/`
- `build.rs` 只做 best-effort（给 `tauri:dev:local`）；CI 里若出现 `mlx.metallib not staged yet` **可忽略**，bundle hook 会再拷
- 已装坏的包可手动修：

```bash
node scripts/stage-mlx-metallib.mjs --app /Applications/Yanluo.app
codesign --force --deep --sign - /Applications/Yanluo.app
xattr -cr /Applications/Yanluo.app
```
## Gatekeeper「已损坏 / 无法验证」

**症状**：从 Release 拖到「应用程序」后打不开；`spctl` 报 signature / resources。

**根因**（常见叠两层）：

1. 未配置 Apple Developer ID / 公证 → 包是 **adhoc** 签名  
2. 旧包缺 `mlx.metallib` 或签名未密封 Resources

**当前策略**：`tauri.macos.conf.json` 里 `hardenedRuntime: false`（无证书时避免 hardened+adhoc 互撕）。有证书后应在 CI 配 `APPLE_CERTIFICATE*` 并重新打开 hardened + notarize（见 `RELEASE.md`）。

临时绕过（本机自建 / 可信来源）：

```bash
xattr -cr /Applications/Yanluo.app
codesign --force --deep --sign - /Applications/Yanluo.app
```

## Metal Toolchain 缺失 → `bfloat16_t` 未识别

**症状**：编译 mlx-c 时 Metal shader 失败：

```
mlx/backend/metal/kernels/utils.h:64:25: error: unknown type name 'bfloat16_t'
```

**解决**：

```bash
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadComponent MetalToolchain
```

若 `xcodebuild` 报 `IDESimulatorFoundation` 插件加载失败，先跑 `runFirstLaunch`，再下 Metal Toolchain。

## mlx-c 过旧 → kernel 与新 Toolchain 不兼容

**症状**：`mlx` feature 能编过，运行段错误，或 shader 报 `complex64_t` / `vec` 未识别。

**根因**：旧 mlx-c（如 v0.5.0 / MLX 0.30.x）与新 Metal Toolchain 不匹配。

**解决**：用已升到 mlx-c ≥ 0.6 / MLX 0.31 的 fork 分支（见 `src-tauri/Cargo.toml` 里 `qwen3-asr-rs` 的 git 依赖）。

## `mlx_fft_rfft` 段错误（STFT）

**症状**：推理崩溃在 `mlx_fft_rfft`，栈经过 `stft_magnitude` → mel feature extract。

**根因**：mlx-c 0.31+ FFT 多了 `mlx_fft_norm` 参数；旧 FFI 少参 → 把 stream 当 norm。

**解决**：fork 里 FFI / ops 对齐 `norm`（`BACKWARD=0`，对齐 `torch.stft` 默认）。

## 缺 cmake

```
is cmake not installed?
```

```bash
brew install cmake
```

## pip / transformers SSL

`CERTIFICATE_VERIFY_FAILED` 多为 conda Python 证书或网络：重试或换网络；确认能访问 `https://pypi.org` 再装。
