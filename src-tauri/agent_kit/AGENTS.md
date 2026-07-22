# 言落 (Yanluo) — Agent kit

本目录是言落给本机 CLI agent（Claude / Codex / Pi）用的工具包。
改**本机设置**前先读这里，不要猜路径。

## 产品是什么

- Mac 本地语音工具：**开口出稿**、**开口派活**。声音留在本机。
- 不是短消息输入法；主业是长口述 / 会议稿 + 派活。

## 热键（用户可改）

- 出稿 / 粘贴：见设置 → 系统 → 快捷键
- 翻译：Shift 组合
- 派活：默认 Fn+Space

## 配置文件

- 路径：与本 kit 同级的 `../config.json`（Application Support / Yanluo）
- **用脚本改**，不要手写破坏 JSON：

```bash
./bin/yanluo-config path          # 打印 config.json 绝对路径
./bin/yanluo-config get           # 打印全部（脱敏）
./bin/yanluo-config get asr_model_dir
./bin/yanluo-config set asr_model_dir "/path/to/Qwen3-ASR-0.6B"
./bin/yanluo-config set vad_aggression 1
```

白名单与字段说明：`skills/yanluo-settings.md`。

## 重要

- 密钥（API key、credentials）**禁止**改。
- 改完后用户切回言落窗口会从磁盘重载；模型目录变更会尝试重新加载模型。
- 录音进行中改 VAD/chunk 只影响**下一段**会话。
