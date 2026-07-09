# ASR Workshop

Desktop app for [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) (Automatic Speech Recognition), built on Tauri 2 + Solid.js + Tailwind CSS. Pure Rust inference via [qwen3_asr_rs](https://github.com/second-state/qwen3_asr_rs), with MLX/Metal acceleration on Apple Silicon.

## Features

- **实时流式识别** — 边录音边转写，实时输出增量文本
- **离线文件转写** — 拖拽上传音频文件，整段转写
- **历史记录** — 转写结果列表，复制/删除
- **多语言** — 自动检测或手动指定（中/英/粤/日/韩等 30 种语言）
- **纯 Rust 推理** — 无 Python 依赖，MLX Metal GPU 加速

## Quick Start

### 1. 系统依赖（macOS / Apple Silicon）

```bash
# Xcode 命令行工具
xcode-select --install

# CMake（编译 MLX C++ 库需要）
brew install cmake
```

### 2. 生成 tokenizer.json

Qwen3-ASR 模型仓库只提供 `vocab.json` + `merges.txt`，但 qwen3_asr_rs 的 `tokenizers` crate 需要 `tokenizer.json`。下载模型后用 transformers 生成一次即可：

```bash
# 下载模型（任选其一）
huggingface-cli download Qwen/Qwen3-ASR-0.6B --local-dir ./Qwen3-ASR-0.6B
# 或
modelscope download --model Qwen/Qwen3-ASR-0.6B --local_dir ./Qwen3-ASR-0.6B

# 生成 tokenizer.json（需要 transformers，一次性）
pip install transformers
python3 -c "
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('./Qwen3-ASR-0.6B', trust_remote_code=True)
tok.backend_tokenizer.save('./Qwen3-ASR-0.6B/tokenizer.json')
"
```

### 3. 安装与运行

```bash
pnpm install          # 前端依赖
pnpm tauri dev        # 启动桌面应用（不启用本地 Qwen/MLX 后端）
pnpm tauri:dev:local  # 启动桌面应用并启用本地 Qwen/MLX 后端
```
首次 `pnpm tauri:dev:local` 会编译 Rust 依赖（含 MLX C++ 库），预计 5-10 分钟。后续增量编译很快。

`pnpm tauri:build:local` 产出带本地 Qwen/MLX 后端的 `.app` / `.dmg`，位于 `src-tauri/target/release/bundle/`。

## Build Troubleshooting

下面是实际踩过的坑及解决方案，按遇到的可能性排序。

### Metal Toolchain 缺失 → MLX 编译报 `bfloat16_t` 未识别

**症状**：编译 mlx-c 时 Metal shader 编译失败：

```
mlx/backend/metal/kernels/utils.h:64:25: error: unknown type name 'bfloat16_t'; did you mean 'float16_t'?
```

**根因**：系统缺少 Metal Toolchain 组件。

**解决**：

```bash
# 先修 Xcode 首次启动（如果 IDESimulatorFoundation 插件报错）
sudo xcodebuild -runFirstLaunch

# 下载 Metal Toolchain
xcodebuild -downloadComponent MetalToolchain
```

如果 `xcodebuild` 本身报 `DVTPlugInLoading: Failed to load code for plug-in com.apple.dt.IDESimulatorFoundation`，说明 Xcode 安装不完整，先跑 `sudo xcodebuild -runFirstLaunch` 修复，再下载 Metal Toolchain。

### mlx-c 版本过旧 → Metal kernel 与新 Toolchain 不兼容

**症状**：即使用 `mlx` feature 编译通过，运行时立刻段错误，或 Metal shader 编译报 `complex64_t`、`vec` 等未识别。

**根因**：qwen3_asr_rs 默认锁定的 mlx-c v0.5.0（MLX 0.30.6）的 Metal kernel 和新版 Metal Toolchain 不兼容。

**解决**：升级 mlx-c 子模块到 v0.6.0+（MLX 0.31.2）。本项目已通过 fork 分支 `fix/mlx-0.31-fft-norm` 修复，`Cargo.toml` 里直接引用该分支：

```toml
qwen3-asr-rs = {
  git = "https://github.com/XBCoder128/qwen3_asr_rs.git",
  branch = "fix/mlx-0.31-fft-norm",
  default-features = false,
  features = ["mlx"],
}
```

### `mlx_fft_rfft` 段错误（STFT 阶段崩溃）

**症状**：编译成功，运行推理时段错误，lldb 显示崩溃在 `mlx_fft_rfft`，调用栈经过 `stft_magnitude` → `mel::WhisperFeatureExtractor::extract`。

**根因**：mlx-c 0.31.2 给所有 FFT 函数新增了 `mlx_fft_norm` 枚举参数（`BACKWARD=0, ORTHO=1, FORWARD=2`），但 qwen3_asr_rs 的 FFI 声明还是旧签名（少一个参数）。调用时 `default_stream()` 被当成 `norm`，栈上的垃圾值被当成 stream 指针 → 段错误。

**解决**：fork 里的 `src/backend/mlx/ffi.rs` 给 `mlx_fft_rfft` 加 `norm: c_int` 参数，`src/backend/mlx/ops.rs` 调用时传 `0`（`MLX_FFT_NORM_BACKWARD`，匹配 `torch.stft` 默认不归一化）。详见 fork 分支的 commit。

### 缺 cmake → build script 失败

**症状**：`cargo build` 报 `is cmake not installed?`

**解决**：`brew install cmake`

### pip 安装 transformers 失败（SSL 证书）

**症状**：`pip install transformers` 报 `SSLError(CERTIFICATE_VERIFY_FAILED)` 或 `No matching distribution found`。

**根因**：conda Python 的 SSL 证书配置问题，通常是临时网络故障。

**解决**：重试几次，或切换网络。确认 `python3 -c "import urllib.request; urllib.request.urlopen('https://pypi.org')"` 能通后再装。

## Project Structure

```
asr-cli/
├── src/                        # 前端 (SolidJS)
│   ├── App.tsx                 # 三栏 shell
│   ├── views/
│   │   ├── Sidebar.tsx         # 模式切换 + 设置 + 引擎状态
│   │   ├── StreamPanel.tsx     # 实时流式：录音 + 实时转写
│   │   ├── OfflinePanel.tsx    # 离线：文件上传 + 转写
│   │   └── HistoryPanel.tsx    # 转写历史
│   ├── store/index.ts          # 全局状态（信号）
│   ├── lib/cn.ts               # className 工具
│   └── styles/tailwind.css     # 设计 token + 组件类
├── src-tauri/                  # 后端 (Rust + Tauri 2)
│   ├── Cargo.toml              # 含 qwen3-asr-rs git 依赖
│   ├── src/lib.rs
│   └── src/main.rs
├── index.html
└── package.json
```

## Tech Stack

- **Frontend**: Solid.js + TypeScript + Vite + Tailwind CSS + Kobalte
- **Desktop**: Tauri 2.0
- **ASR Engine**: [qwen3_asr_rs](https://github.com/second-state/qwen3_asr_rs)（fork: `XBCoder128/qwen3_asr_rs`）
- **Inference Backend**: MLX (Apple Silicon / Metal) · libtorch (Linux/CUDA)

## License

Apache-2.0

Qwen3-ASR 模型权重的使用需遵循其独立的许可协议，商用前请确认。
