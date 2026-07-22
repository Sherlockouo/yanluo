# Build troubleshooting（言落）

本地 Qwen / MLX 编译与运行时踩过的坑。日常开发见根目录 [`README.md`](../README.md)。

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
