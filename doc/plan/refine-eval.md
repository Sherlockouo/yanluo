# Refine few-shot 效果评测（备查）

记录「有修正操作 → few-shot → LLM 纠错」这条链路的**真效果 A/B 评测**方法与已跑结果。
用于回答「few-shot 到底让纠错变好还是变差、该用哪个模型」。

## 评测怎么跑

评测是 lib crate 内的 `#[ignore]` 集成测试：`src-tauri/src/transcription/mod.rs` → `mod refine_eval`。
默认不跑（需要一个活的 LLM）；显式带 `--ignored` 才跑，用真函数 `refine_transcript_with_cases`（和线上同一条路径）。

```bash
cd asr-cli/src-tauri
# 本地 Ollama（默认值）
REFINE_EVAL_MODEL=qwen3:1.7b \
REFINE_EVAL_URL=http://127.0.0.1:11434/v1 \
cargo test --lib refine_eval -- --ignored --nocapture

# 云端（如 DeepSeek）：额外给 key
REFINE_EVAL_MODEL=deepseek-chat \
REFINE_EVAL_URL=https://api.deepseek.com/v1 \
REFINE_EVAL_KEY=sk-xxxx \
cargo test --lib refine_eval -- --ignored --nocapture
```

环境变量（都有默认值，只有 key 默认空）：
- `REFINE_EVAL_MODEL` — 模型名，默认 `qwen3:1.7b`
- `REFINE_EVAL_URL` — OpenAI 兼容 base url，默认 `http://127.0.0.1:11434/v1`
- `REFINE_EVAL_KEY` — API key，默认空（Ollama 不需要）

用户已保存的云端凭据在 `~/Library/Application Support/Yanluo/config.json` 的 `llm_credentials.<provider>`：
```bash
python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/Yanluo/config.json'))['llm_credentials']['deepseek']['api_key'])"
```

## 评测在测什么

- 8 条固定 `(带谐音错误的 ASR, 正确 gold)` 样本，覆盖中英混说的技术词谐音（配森=Python、库伯内战斯=Kubernetes、道克尔=Docker、普尔请求=PR、未定义=undefined …），外加 2 条 **no-op**（gold==asr）用于测「过度改写」。
- 每条各跑两遍：**无 few-shot** vs **注入 4 条训练 case 的 few-shot**（模拟用户已改过这些词）。
- 指标：
  - **exact-match**：整句和 gold 完全一致的条数
  - **char-acc**：字符级 Levenshtein 准确率均值（`1 - dist/len(gold)`）
  - **over-edit**：no-op 样本被模型改动的次数（越低越好，测护栏）

> 局限：n=8 偏小，单条波动会放大到百分比。要更稳的结论需扩到 ~30 条（未做，见改进项 2）。

## 已跑结果（2026-07-19，本机 M 系 + Ollama / DeepSeek 云端）

| 模型 | 类型 | 大小 | exact none→+shot | char-acc none→+shot | few-shot 收益 | over-edit | 速度(16 call) |
|---|---|---|---|---|---|---|---|
| **deepseek-chat** | 云端 | — | 4/8 → **5/8** | 0.679 → **0.768** | ✅ **+8.9%（最大）** | 0 | ~12s |
| **qwen3:1.7b** | 本地 | 1.4G | 4/8 → 4/8 | 0.697 → **0.732** | ✅ +3.5% | 0 | ~42s |
| gemma4:12b | 本地 | 7.6G | 4/8 → 4/8 | 0.697 → 0.732 | ✅ +3.5% | 0 | ~228s |
| qwen2.5:1.5b | 本地 | 986M | 2/8 → 2/8 | 0.692 → **0.617** | ❌ **-7.5%** | 1 | 中 |
| qwen3.5:2b | 本地 | 2.7G | 排除 | — | — | — | **单次 ~25min，本机异常** |

## 结论

1. **few-shot 链路真实有效**，且价值随模型能力单调递增：deepseek(+8.9%) > qwen3:1.7b/gemma(+3.5%) > qwen2.5:1.5b(**-7.5%**)。
   - 最佳例证：第 5 条「普尔请求」。deepseek 无 few-shot 时自作主张改成「Pull请求」（错向），+few-shot 后精准改成用户要的「PR」。**few-shot 不止补漏，还能纠正模型的错误倾向。**
2. **模型太弱会被 few-shot 带偏**（qwen2.5:1.5b 反噬 -7.5% 且出现 1 次过度改写）→ 应「弱模型不注入 few-shot」。
3. **本地最佳性价比是 qwen3:1.7b**：和 12G 的 gemma4 一样准、快 5 倍，few-shot 正向。**不必推荐用户升级到更大本地模型。**
4. **护栏有效**：qwen3 / gemma / deepseek 全程 0 过度改写；只有最弱的 qwen2.5 突破 1 次。
5. **qwen3.5:2b 在本机不可用**（单次推理 ~25 分钟，疑似 GGUF/Metal 兼容问题），评测直接排除。

## 落地建议（尚未实现）

1. **按模型强弱开关 few-shot**：qwen3 系 / deepseek / gpt 等强模型注入；qwen2.5:1.5b 这类弱模型关掉。（TDD：加判断函数 + 测试）
2. **扩样本到 ~30 条**，降低单条波动，让百分比结论更可信。
3. 本地默认继续 `qwen3:1.7b`；给愿意用云端换质量的用户，把 `deepseek-chat` 作为推荐云端模型。

## 复现注意

- 跑云端/慢模型前，用 `curl .../api/generate -d '{"model":"...","prompt":"hi","keep_alive":"10m"}'` 预热，避免冷加载撞 90s 超时。
- 别一次起多个本地模型（显存/内存会打架，甚至卡死）。逐个跑。
- 跑完卸载：`curl .../api/generate -d '{"model":"...","keep_alive":0}'`，`curl .../api/ps` 确认已清空。
