# Skill: 言落设置（yanluo-settings）

用 `{kit}/bin/yanluo-config` 读写白名单字段。kit = 本文件所在目录的上一级。

## 白名单（可 set）

| Key | 类型 | 说明 |
|-----|------|------|
| `asr_model_dir` | string | Qwen ASR 模型目录（绝对路径） |
| `asr_model_id` | string | 目录 catalog id，如 `Qwen3-ASR-0.6B` |
| `align_model_dir` | string | ForcedAligner 模型目录 |
| `align_enabled` | bool | 是否启用对齐 |
| `vad_backend` | string | `webrtc` / `energy` / `silero`（若构建支持） |
| `vad_aggression` | u8 | 0–3；口述偏 1，会议 2，采访可 3 |
| `chunk_size_sec` | f64 | 流式块长（秒），常见 1.0–2.0 |
| `language` | string | `auto` 或语言 id |
| `translate_target_language` | string | 翻译目标，如 `en-US` |
| `llm_enabled` | bool | 是否启用润色 LLM |
| `llm_provider` | string | 服务商 id |
| `llm_model` | string | 推荐本地 `qwen3:1.7b`；云端 `deepseek-chat` |
| `llm_api_base_url` | string | OpenAI 兼容 base URL |

## 禁止

- `elevenlabs_api_key`、`llm_api_key`、`llm_credentials`
- 热键绑定结构（易弄坏）
- 任意未知 key

## 示例

把识别模型指到已下载目录：

```bash
./bin/yanluo-config set asr_model_dir "$HOME/Library/Application Support/Yanluo/models/Qwen3-ASR-0.6B"
./bin/yanluo-config set asr_model_id "Qwen3-ASR-0.6B"
```

口述少切段：

```bash
./bin/yanluo-config set vad_aggression 1
```
