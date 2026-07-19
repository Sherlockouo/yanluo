# Refine 纠错 + 主动提炼优化方案

> 目标：把「LLM 纠错（refine）」和「主动提炼词库（distill / learn）」从现在「勉强能用」提升到「可信、稳、贴用户」。
> 权威文档：[`../design-hud-confirm-learn.md`](../design-hud-confirm-learn.md)（确认再贴+改字即学）、[`../Sell-it.md`](../Sell-it.md)（少乱改、术语别丢）、根 `DESIGN.md`（本地优先、结果优先）。
>
> 相关代码：
> - `src-tauri/src/transcription/mod.rs`：`refine_transcript` / `distill_learn_from_cases` / `apply_vocabulary` / `strip_refine_artifacts` / `accept_distill_term` / `finalize_successful_result`
> - `src-tauri/src/commands/mod.rs`：`eligible_for_distill` / `distill_learn_from_ratings` / `test_llm_refinement`
> - `src/lib/constants.ts`：`DEFAULT_LLM_REFINE_PROMPT`
> - `src/lib/learn-from-refine.ts`：`extractLearnCandidates` / `scoreCandidate` / `isTermSized`
> - `src/lib/learn-cases.ts`：`collectLearnTriples` / few-shot 注入
> - `src/components/ui/refine-diff.tsx`：diff 渲染

---

## 现状诊断（为什么现在差）

### Refine（纠错）

1. **两处 prompt 各写一份，且会漂移。** `constants.ts` 里 `DEFAULT_LLM_REFINE_PROMPT` 和 `transcription/mod.rs` 里的 `const DEFAULT_REFINE` 是两份手抄的常量，内容已经不完全一致（换行/示例）。真正生效的是 Rust 那份，前端那份只在 UI 占位显示 → 用户在设置里看到的默认 prompt 跟实际跑的不是同一个。
2. **没利用已学到的 few-shot。** `learn-cases.ts` 有 `mergeFewShotIntoPrompt` / `formatFewShotBlock`，但 Rust 的 `refine_transcript` 只拼了 `vocabulary` 词库，**从没把历史里的 ASR→gold 三元组作为 few-shot 喂给纠错模型**。学习闭环断了一半：词库进了，示例没进。
3. **词库只做全局字符串 replace，会误伤。** `apply_vocabulary` 用 `String::replace`（子串替换），对 CJK 没有词边界。例如词条 `华=划` 会把「中华」改成「中划」。Latin 有词边界判断，CJK 完全没有。
4. **纠错「不该改却改了」缺乏刹车。** refine 只有 prompt 里写「看不出错误→原样输出」，没有任何后处理护栏：模型如果擅自扩写/删句/改语气，代码不校验就整段替换。长度暴涨/暴缩、句子数骤变都不拦。
5. **整段送、无分段、无长度上限。** 长会议一整段丢给小模型，容易「后半段漏译/截断」（跟 translate 里已经吃过的亏一样，但 refine 没做分段）。90s 超时后整段失败，用户白等。
6. **Qwen3 `/no_think` 是唯一的思维链处理，其它模型无。** `strip_refine_artifacts` 兜底能力弱：只剥一层 `<think>`、一次 `输出：` 前缀、一层引号。多段 think、markdown 代码块、解释性开场白（「好的，纠错后：」）不处理。
7. **temperature 0.0 但无 seed/无重试。** 网络抖动/模型冷启动直接失败，没有「失败就退回原文并提示」以外的降级。

### Distill（主动提炼词库）

8. **eligible 条件太苛刻，学不到东西。** `eligible_for_distill` 要求：非 translate + 有 raw + gold≠asr +（用户改过 或 (refined 且被打 bad 评分)）。也就是说**用户不主动改字、也不主动打差评，就永远不提炼**。Sell-it 想要的是「越用越懂你」，但现在几乎不触发。
9. **提炼只在「纠错学习页手动点」触发。** `distill_learn_from_ratings` 是命令式，要用户进设置页手动点「AI 提炼」。没有任何被动/批量/定时的主动提炼。
10. **前端 heuristic 抽词（`extractLearnCandidates`）和后端 LLM distill 两套逻辑并存，标准不统一。** 前端 `isTermSized`（≤24、latin≤4词、cjk≤8）和后端 `accept_distill_term`（≤24、terminators<2）阈值不同，产出会互相打架。
11. **谐音 pair 的方向/泛化没保证。** 抽出来的是「这一次这句里的 wrong=right」，没有验证这个 pair 泛化到别的句子安不安全（见问题 3 的误伤）。也没有出现频次统计——偶发一次的错也可能进词库。
12. **没有置信度/来源展示给用户确认。** 提炼出的词条直接进 `pendingLearn`，用户在词库页只能看到 term，不知道它是从哪句、改了几次、AI 还是本地抽的。信任建立不起来。

---

## 目标与非目标

**目标**
- 纠错：少乱改（护栏）、稳（分段+重试+更强清洗）、越用越准（few-shot 闭环）、可信（diff + 一键回退）。
- 提炼：更容易触发但更保守入库（频次+置信度）、单一评判标准、来源可追溯、用户可确认。

**非目标**
- 不引入云依赖破坏本地卖点（refine/distill 仍走用户自配的 LLM，纯本地 Ollama 优先保证可用）。
- 不做全自动改词库（DESIGN：改字即学是「建议」，入库仍需确认）。
- 不动 translate 流式主链路（只复用其分段/清洗经验）。

---

## 改进方案

### A. 统一 prompt 单一真源（P0，低风险）

**问题 1。** 让前端 `DEFAULT_LLM_REFINE_PROMPT` 成为唯一真源，Rust 侧不再手抄常量。

- 方案：把默认 prompt 作为 config 的默认值下发——`config/mod.rs` 的 `default_llm_refine_prompt()` 返回与前端字面完全一致的字符串；Rust `refine_transcript` 删掉内联 `const DEFAULT_REFINE`，改为「空则用 config 默认」。
- 加一个测试：`assert_eq!` 前端常量（通过生成或 include_str! 共享）与 Rust 默认，防止再次漂移。最省事的做法是把默认 prompt 抽到一个 `.txt`，前后端都 include/import 同一个文件。
- 验收：设置页显示的默认 prompt == 实际请求 system 里的 base_prompt。

### B. Refine 护栏（P0，直接决定「少乱改」口碑）

**问题 4、6。** 在 `refine_transcript` 拿到 `out` 之后、替换 `result.text` 之前，加一层 `guard_refine(input, out)`：

- **长度护栏**：`out` 字符数偏离 `input` 超过 ±35%（可配）→ 判定模型跑偏，丢弃 `out`，退回 `input`，日志记 `refine rejected: length drift`。
- **句子数护栏**：终止符（。！？.!?）数量骤减（丢句）或骤增（扩写）超过阈值 → 拒绝。
- **删句检测**：`input` 里出现但 `out` 里整段消失的长片段（>8 CJK 连续无对应）→ 拒绝（防「总结化」）。
- **解释性开场白剥离**：`strip_refine_artifacts` 增补——剥掉 `好的，`/`以下是`/`纠错后：`/markdown ``` 代码围栏/多段 `<think>`。
- **兜底**：任何护栏触发，都退回原文而不是塞脏输出，且在 HUD/历史标记「未纠错（模型跑偏已回退）」。

验收：构造「模型把长段总结成一句」的假响应，`guard_refine` 必须拒绝并保留原文。加单测 `guard_refine_rejects_summary` / `_rejects_length_blowup` / `_accepts_typo_fix`。

### C. Few-shot 学习闭环接回 refine（P1，「越用越准」）

**问题 2。** 让历史里的 ASR→gold 三元组真正影响下一次纠错。

- 新增命令 `refine_transcript` 前，从 history 取最近 N 条「已确认修正」case（`collectLearnTriples` 的 Rust 等价），格式化成 few-shot（复用 `learn-cases.ts` 的 `输入/输出` 格式），拼进 system prompt 的示例区。
- 数量与长度限制：≤8 条、每侧 ≤80 字（对齐 `MAX_FEW_SHOT` / `MAX_SIDE_CHARS`），避免撑爆小模型上下文。
- 优先级：用户改过的 > 差评纠错的；去重；跳过 translate。
- 与词库互补：词库做确定性 replace（护栏见 D），few-shot 教模型「这类谐音这样改」。
- 验收：加一条「杰森=JSON」的 gold case 后，同类新句 refine 命中率上升（人工/回归样例）。

### D. 词库替换加词边界与防误伤（P0，修正确性 bug）

**问题 3。** `apply_vocabulary` 的 CJK pair 用裸 `replace`，会误伤子串。

- pair 替换改为「带边界」逻辑：CJK 侧也检查前后不构成更长已知词（至少不替换掉「命中在更长 vocab term 内部」的情况）；对 Latin 保持现有词边界。
- pair 只在「wrong 作为独立可替换单元」时替换：短 CJK（1–2 字）单字谐音 pair 风险最高，建议要求这类 pair 携带最小上下文或标记为「弱替换」（仅在 refine few-shot 用、不做硬 replace）。
- 加单测：`华=划` 不得把「中华人民共和国」改成「中划…」；`杰森=JSON` 正常命中。

### E. Refine 分段 + 重试 + 降级（P1，稳）

**问题 5、7。**

- 长文本（> ~1200 字或多段落）按句/段切分并发或顺序 refine，各段独立护栏，最后拼接——避免整段丢给小模型导致后半段漏改/截断。复用 translate 已验证的分段思路。
- 失败重试：网络/HTTP 5xx 重试 1 次（指数退避），仍失败 → 退回原文 + 明确提示（区分「超时」「模型没拉」「跑偏回退」）。
- 冷启动：首次调用前可选 warmup ping（Ollama），把 90s 超时的体感转成「加载中」。

### F. Distill 触发更易、入库更保守（P1，「越用越懂你」）

**问题 8、9、11、12。**

- **放宽 eligible**：除「用户改字 / 差评」外，增加「LLM refine 改动了、且改动是 term 级谐音（不是整句重写）」也进候选池——但**只进候选、不直接入库**。
- **频次门槛**：同一个 `wrong=right` 或 hotword 在历史里出现 ≥2 次（跨不同录音）才升为「建议入库」。偶发一次只留观察。这解决问题 11 的泛化风险。
- **单一评判标准**：前端 `isTermSized` 与后端 `accept_distill_term` 合并为一套阈值（抽到共享定义或让后端调用与前端一致的规则），产出不再打架（问题 10）。
- **来源可追溯**：`LearnCandidate` 带上 `sourceIds`、`occurrences`、`origin: "local" | "ai"`；词库确认 UI 展示「来自 3 次录音 · AI 提炼 · 置信 0.7」，用户可点进看原句。信任建立（问题 12）。
- **可选被动提炼**：设置里开关「累计 N 条可学 case 时自动跑一次 AI 提炼并放入待确认」（默认关，尊重本地/不打扰）。仍需用户在词库页确认才入库（符合 DESIGN 非目标）。

### G. Diff / 确认体验（P2，可信可回退）

- HUD/历史的 refine 结果始终能看 `RefineDiff`（raw→refined），并提供**一键「用原文」**回退按钮（写回 `text=raw_text`，标记 `refined=false`，且该次不产生学习信号）。
- 护栏回退（B）时明确告诉用户「这次没纠错」，而不是静默塞原文让用户以为纠错没生效。

---

## 进度（TDD）——全部完成 ✅

`cd src-tauri && cargo test --lib` 全绿（**66 passed**，default + qwen-local 两 feature 均编译）；`pnpm exec tsc --noEmit` 无错。均 test-first 实现并接入真实流程。

P0:

- **A 统一 prompt**：内联 `const DEFAULT_REFINE` 删除，抽为 `transcription::DEFAULT_REFINE` 单一真源；`refine_prompt_sync_tests::matches_frontend_constant` 用 `include_str!` 解析 `src/lib/constants.ts` 的 `DEFAULT_LLM_REFINE_PROMPT`，断言与 Rust 常量逐字节一致，永久防漂移。
- **B refine 护栏**：新增纯函数 `guard_refine(input, refined)`（长度比 ±35%/短文本绝对松弛、句子终止符漂移、扩写/删句拦截），已接入 `refine_transcript`——护栏不过则退回原文。测试：`guard_refine_tests`（typo 通过、总结/扩写/标点爆炸拒绝、短英文纠错通过）。
- **D 词库防误伤**：`apply_vocabulary` 跳过「单 CJK 字」pair 的裸 replace（`华=划` 不再把「中华」改成「中划」），多字 CJK / Latin pair 照常。测试：`apply_vocabulary_tests`。

P1:

- **C few-shot 闭环**：`FewShotCase` + `build_refine_fewshot`（抽取 ASR→gold 示例、cap 8、去 no-op/超长）；`collect_fewshot_from_history` 从 history 取已确认修正（用户改优先、其次差评 refine）；`refine_transcript_with_cases` 把 few-shot 拼进 system prompt。finalize 的 fn-refine 已改调带 few-shot 版。测试：`fewshot_tests`。
- **E 分段+重试**：`split_for_refine`（>1200 字按句切、无终止符硬切、`concat()` 无损）；`refine_one_chunk` 逐段纠错、瞬态失败/5xx 重试 1 次（400ms 退避）、逐段过护栏。测试：`split_refine_tests`。
- **F distill 频次门槛+单一标准**：`candidate_for_distill`（放宽：任何 gold≠asr 的修正都进候选池）；`mine_homophone_pair`（前后缀裁剪抽 `wrong=right`，复用 `accept_distill_term` 单一标准，过长 core 拒）；`gate_terms_by_frequency`（跨录音≥ 2 次才升入库）。distill 命令已合并 LLM 项 + 频次门槛确定性项。测试：`distill_gate_tests` / `mine_pair_tests` / `distill_eligibility_tests`。

词库两半（对齐需求「提炼常用词 + 相似语音替换 + AI+规则」）：

- **相似语音替换（谐音纠错）**：`mine_homophone_pair`（规则）+ `distill_learn_from_cases`（AI）→ `wrong=right`，经 `gate_terms_by_frequency` 跨录音≥ 2 次才入库。
- **提炼用户常用词（主动）**：`mine_frequent_hotwords`（规则：Latin/技术 term token、3–24 字、停用词过滤、按大写/数字/连接符判专有名）+ 跨转写频次门槛≥ 2，把用户反复说的产品/术语提前入库，不等出错。已接入 `distill_learn_from_ratings`（当无纠错 case 时跳过 LLM、仅跑规则）；前端 AI 提炼按钮不再要求先标差（有 history 即可）。测试：`frequent_hotword_tests`。
- **AI + 规则合并**：命令层按 AI distill → 频次谐音 pair → 常用词 hotword 去重合并，统一进 `pendingLearn` 待确认。

P2:

- **G diff 回退**：出稿历史详情新增「用原文」按钮（fn + 有 refine diff 时），一键把 text 回写 raw_text（走 `set_history_user_text`）。B 的护栏回退在后端日志明确标记。

> 说明：单 CJK 字谐音改为「只进 LLM few-shot、不做确定性 replace」（C），是 D 的配套决定。
> 前端 `*.test.ts` 依赖 `@/` alias，裸 `node` 跑不了（既有限制，非本次引入）；后续可加 tsx/vitest + alias 。

## 分期与验收

| 阶段 | 内容 | 风险 | 验收 |
|------|------|------|------|
| P0 ✅ | A 统一 prompt · B refine 护栏 · D 词库防误伤 | 低 | 单测通过；乱改/误伤消失 |
| P1 ✅ | C few-shot 闭环 · E 分段重试 · F distill 触发+频次+单一标准 | 中 | 同类纠错命中↑；长文不截断；词条带频次 |
| P2 ✅ | G diff 回退 | 低 | 用户可一键回原文；护栏回退日志标记 |

每阶段守住：本地优先（Ollama 可跑）、少乱改、词条入库仍需确认、只 opacity/transform 的动效约束不受影响。

## 需要补的测试（现状几乎为零）

- Rust：`guard_refine_*`、`apply_vocabulary` 边界、`strip_refine_artifacts` 多形态、`eligible_for_distill` 频次、few-shot 拼装长度上限。
- 前端：`isTermSized` / `scoreCandidate` 与后端阈值一致性（同输入同判定）。

## 开放问题（先问用户再动）

1. 护栏阈值（长度 ±%、句子数）默认值定多少？是否暴露到设置页高级项？
2. 被动提炼默认开还是关？（倾向默认关，符合「不打扰/本地」）
3. few-shot 是否让用户在设置里能看到/编辑已注入的示例？
