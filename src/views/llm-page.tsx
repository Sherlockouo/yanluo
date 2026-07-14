import { useMemo, useState } from "react";
import {
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { Link } from "react-router-dom";
import { BookPlus, RotateCcw, Save, Sparkles } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import {
  QualityRateBar,
  type QualityRating,
} from "@/components/ui/quality-rate-bar";
import { useApp } from "@/app-context";
import {
  DEFAULT_LLM_REFINE_PROMPT,
  LLM_PROVIDER_PRESETS,
} from "@/lib/constants";
import type { HistoryEntry } from "@/types";
import { acceptVocabLine } from "@/lib/learn-from-refine";
import {
  collectLearnTriples,
  harvestFromTriples,
  learnGold,
  mergeFewShotIntoPrompt,
  toLearnTriple,
} from "@/lib/learn-cases";

function ratingOf(entry: Pick<HistoryEntry, "quality_rating">): QualityRating | null {
  const r = entry.quality_rating;
  if (r === "bad" || r === "ok" || r === "good") return r;
  return null;
}

function learnOpen(entry: HistoryEntry): boolean {
  const s = entry.learn_status;
  return s !== "applied" && s !== "skipped";
}

function showLearnEntry(e: HistoryEntry): boolean {
  if ((e.source ?? "fn") === "translate") return false;
  if (e.user_text?.trim()) return true;
  return (
    Boolean(e.refined) &&
    hasRefineDiff(e.raw_text, learnGold(e))
  );
}

export function LlmPage() {
  const {
    config,
    updateConfig,
    saveConfig,
    testLlm,
    history,
    rateHistory,
    setHistoryUserText,
    distillLearnFromRatings,
    applyLearnedTerms,
    pendingLearn,
    offerLearnFromEntries,
    abortPendingLearn,
    removePendingLearnTerm,
  } = useApp();
  const [customModel, setCustomModel] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  const llmReady = Boolean(
    config.llm_api_base_url?.trim() && config.llm_model?.trim(),
  );
  const [configOpen, setConfigOpen] = useState(!llmReady);

  const preset = useMemo(
    () =>
      LLM_PROVIDER_PRESETS.find((p) => p.id === config.llm_provider) ??
      LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1],
    [config.llm_provider],
  );

  const modelInList = preset.models.includes(config.llm_model);
  const showCustomField = customModel || !modelInList || preset.models.length === 0;

  const learnEntries = useMemo(
    () => history.filter(showLearnEntry).slice(0, 40),
    [history],
  );

  const triples = useMemo(() => collectLearnTriples(history), [history]);
  const userTripleCount = useMemo(
    () => triples.filter((t) => t.hasUser).length,
    [triples],
  );

  const ratingStats = useMemo(() => {
    let bad = 0;
    let applied = 0;
    let unlabeled = 0;
    for (const e of learnEntries) {
      const r = ratingOf(e);
      if (r == null) unlabeled += 1;
      if (r === "bad") bad += 1;
      if (e.learn_status === "applied") applied += 1;
    }
    return { bad, applied, unlabeled };
  }, [learnEntries]);

  const badOpenEntries = useMemo(
    () =>
      learnEntries.filter(
        (e) =>
          learnOpen(e) &&
          (ratingOf(e) === "bad" || Boolean(e.user_text?.trim())),
      ),
    [learnEntries],
  );

  const harvestedFromBad = useMemo(
    () => harvestFromTriples(badOpenEntries, config.vocabulary),
    [badOpenEntries, config.vocabulary],
  );

  const refineValue = config.llm_refine_prompt || DEFAULT_LLM_REFINE_PROMPT;

  const vocabSet = useMemo(
    () =>
      new Set(config.vocabulary.map((t) => t.trim().toLocaleLowerCase())),
    [config.vocabulary],
  );

  const confirmPending = async () => {
    if (!pendingLearn?.terms.length) return;
    const terms = pendingLearn.terms
      .map((c) => c.term.trim())
      .filter((t) => t && !vocabSet.has(t.toLocaleLowerCase()));
    if (!terms.length) {
      toast("没有新词条可加");
      await abortPendingLearn();
      return;
    }
    try {
      await applyLearnedTerms(pendingLearn.sourceIds, terms);
      toast.success(`已加入词库 ${terms.length} 条，下次 ASR/纠错生效`);
    } catch (e) {
      toast.danger(String(e));
    }
  };

  const runLocalHarvest = async () => {
    if (!badOpenEntries.length) {
      toast("先标差或填写用户修正");
      return;
    }
    if (!harvestedFromBad.length) {
      toast("暂无可提炼词条（或已在词库）");
      return;
    }
    const n = await offerLearnFromEntries(badOpenEntries, harvestedFromBad);
    toast.success(`从 case 提炼 ${n} 条，确认后写入词库`);
  };

  const runAiDistill = async () => {
    if (!badOpenEntries.length) {
      toast("先标差或填写用户修正");
      return;
    }
    setDistilling(true);
    try {
      const result = await distillLearnFromRatings();
      const cands = result.terms
        .map(acceptVocabLine)
        .filter((c): c is NonNullable<typeof c> => !!c)
        .filter((c) => !vocabSet.has(c.term.toLocaleLowerCase()));
      if (!cands.length) {
        toast("AI 未提炼出可用词条");
        return;
      }
      const sourceIds = result.source_ids.length
        ? result.source_ids
        : badOpenEntries.map((e) => e.id);
      const entries = sourceIds
        .map((id) => history.find((e) => e.id === id) ?? badOpenEntries.find((e) => e.id === id))
        .filter((e): e is HistoryEntry => !!e);
      await offerLearnFromEntries(
        entries.length ? entries : badOpenEntries,
        cands,
      );
      toast.success(`AI 提炼 ${cands.length} 条，确认后写入词库`);
    } catch (e) {
      toast.danger(String(e));
    } finally {
      setDistilling(false);
    }
  };

  const writeFewShot = async () => {
    const forShot = collectLearnTriples(history, { requireUser: false, max: 12 });
    const preferred = [
      ...forShot.filter((t) => t.hasUser),
      ...forShot.filter((t) => !t.hasUser),
    ];
    if (!preferred.length) {
      toast("没有可用 case：请在记录里写「用户修正」或标差");
      return;
    }
    const next = mergeFewShotIntoPrompt(
      config.llm_refine_prompt.trim()
        ? config.llm_refine_prompt
        : DEFAULT_LLM_REFINE_PROMPT,
      preferred,
    );
    updateConfig("llm_refine_prompt", next);
    await saveConfig({ ...config, llm_refine_prompt: next });
    toast.success(`已写入 ${Math.min(preferred.length, 8)} 条 few-shot 到 Prompt`);
  };

  const setRating = async (id: string, rating: QualityRating | "") => {
    try {
      await rateHistory(id, rating);
      if (rating === "bad") {
        const entry = learnEntries.find((e) => e.id === id);
        if (!entry) return;
        const n = await offerLearnFromEntries([entry]);
        if (n > 0) {
          toast.success("差评已记，确认词条");
        }
      }
    } catch (e) {
      toast.danger(String(e));
    }
  };

  const saveUserAdjust = async (entry: HistoryEntry) => {
    const draft =
      editDrafts[entry.id] ?? entry.user_text ?? entry.text ?? "";
    const trimmed = draft.trim();
    if (!trimmed) {
      toast("用户修正不能为空");
      return;
    }
    try {
      await setHistoryUserText(entry.id, trimmed);
      const updated = { ...entry, user_text: trimmed, text: trimmed };
      const n = await offerLearnFromEntries([updated]);
      toast.success(
        n > 0 ? `已保存用户修正，提炼 ${n} 条` : "已保存用户修正",
      );
    } catch (e) {
      toast.danger(String(e));
    }
  };

  return (
    <PageShell className="max-w-2xl">
      <PageHeader
        title="LLM"
        status={
          <>
            {config.llm_enabled ? "纠错开" : "纠错关"}
            {" · "}
            {config.llm_model || "未设模型"}
            {" · "}
            <Link to="/settings?tab=llm" className="text-accent hover:underline">
              设置
            </Link>
          </>
        }
        action={
          <Button
            size="sm"
            variant={configOpen ? "primary" : "secondary"}
            onPress={() => setConfigOpen((v) => !v)}
          >
            配置
          </Button>
        }
      />

      <SoftCollapse open={configOpen}>
        <div className="mb-1 flex flex-col gap-5 rounded-2xl border border-border bg-surface p-4">
          <div className="rounded-2xl border border-border bg-surface-secondary/50 px-3 py-2">
            <Switch
              isSelected={config.llm_enabled}
              onChange={(value) => updateConfig("llm_enabled", value)}
            >
              <Switch.Content className="w-full justify-between gap-2 p-2">
                <div className="min-w-0 pr-2">
                  <div className="type-ui">启用纠错</div>
                </div>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          {preset.models.length > 0 ? (
            <Select
              className="w-full flex"
              selectedKey={
                showCustomField && !modelInList ? "__custom__" : config.llm_model
              }
              onSelectionChange={(key) => {
                if (key == null) return;
                const id = String(key);
                if (id === "__custom__") {
                  setCustomModel(true);
                  return;
                }
                setCustomModel(false);
                updateConfig("llm_model", id);
              }}
            >
              <Label>Model（{preset.label}）</Label>
              <Select.Trigger className="flex items-center justify-between p-4">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="gap-2 p-2">
                  {preset.models.map((m) => (
                    <ListBox.Item key={m} id={m} textValue={m}>
                      {m}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                  <ListBox.Item id="__custom__" textValue="自定义">
                    自定义…
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          ) : null}

          {showCustomField ? (
            <TextField
              fullWidth
              variant="secondary"
              value={config.llm_model}
              onChange={(value) => updateConfig("llm_model", value)}
            >
              <Label>自定义 Model</Label>
              <Input placeholder="qwen3:1.7b" />
            </TextField>
          ) : null}

          <TextField
            fullWidth
            variant="secondary"
            value={refineValue}
            onChange={(value) => updateConfig("llm_refine_prompt", value)}
          >
            <Label>纠错 Prompt</Label>
            <TextArea
              rows={10}
              className="min-h-[12rem] font-mono type-meta !text-[12px]"
            />
          </TextField>

          <div className="form-actions">
            <div className="form-actions-secondary">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => updateConfig("llm_refine_prompt", "")}
              >
                <RotateCcw size={14} />
                恢复默认
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!triples.length}
                onPress={() => void writeFewShot()}
              >
                <BookPlus size={14} />
                few-shot
                {userTripleCount > 0
                  ? `（${userTripleCount}）`
                  : triples.length
                    ? `（${triples.length}）`
                    : ""}
              </Button>
              <Button size="sm" variant="secondary" onPress={() => void testLlm()}>
                <Sparkles size={14} aria-hidden />
                测试
              </Button>
            </div>
            <Button
              className="form-actions-primary btn-press"
              fullWidth
              variant="primary"
              onPress={() => void saveConfig()}
            >
              <Save size={16} aria-hidden />
              保存
            </Button>
          </div>
        </div>
      </SoftCollapse>

      {pendingLearn && pendingLearn.terms.length > 0 ? (
        <Reveal>
          <div className="rounded-2xl border border-accent/25 bg-accent/[0.06] px-3.5 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="type-ui">
                待确认（{pendingLearn.terms.length}）
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => void abortPendingLearn()}
                >
                  清空
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  className="btn-press"
                  onPress={() => void confirmPending()}
                >
                  确认加入
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pendingLearn.terms.map((c) => (
                <button
                  key={c.term}
                  type="button"
                  title="点击移除"
                  onClick={() => void removePendingLearnTerm(c.term)}
                >
                  <Chip size="sm" variant="soft" color="accent">
                    <Chip.Label className="font-mono type-micro !normal-case !tracking-normal">
                      {c.kind === "pair" ? `${c.from} → ${c.to}` : c.term}
                    </Chip.Label>
                  </Chip>
                </button>
              ))}
            </div>
          </div>
        </Reveal>
      ) : null}

      {learnEntries.length === 0 ? (
        <EmptyState title="还没有学习 case" icon={<Sparkles size={18} />} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="type-meta">
              未标 {ratingStats.unlabeled} · 差 {ratingStats.bad} · 修正{" "}
              {userTripleCount} · 词库 {ratingStats.applied}
              {" · "}
              <Link to="/vocabulary" className="text-accent hover:underline">
                词库
              </Link>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!badOpenEntries.length || distilling}
                isPending={distilling}
                onPress={() => void runAiDistill()}
              >
                <Sparkles size={14} />
                AI 提炼
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!badOpenEntries.length}
                onPress={() => void runLocalHarvest()}
              >
                <BookPlus size={14} />
                本地
                {harvestedFromBad.length > 0
                  ? `（${harvestedFromBad.length}）`
                  : ""}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {learnEntries.map((entry, i) => {
              const rated = ratingOf(entry);
              const status = entry.learn_status;
              const triple = toLearnTriple(entry);
              const draft =
                editDrafts[entry.id] ??
                entry.user_text ??
                entry.text ??
                "";
              const editing = editingId === entry.id;
              return (
                <Reveal key={entry.id} index={i}>
                  <article className="rounded-2xl border border-border bg-surface px-4 py-3.5">
                    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 type-meta">
                      <span>
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                      <span>{entry.duration_seconds.toFixed(1)}s</span>
                      {triple?.hasUser ? <span>有修正</span> : null}
                      {status === "applied" ? (
                        <span>已入词库</span>
                      ) : status === "suggested" ? (
                        <span>待确认</span>
                      ) : null}
                    </div>

                    {entry.raw_text && learnGold(entry) !== entry.raw_text ? (
                      <div className="mb-2">
                        <RefineDiff
                          before={entry.raw_text}
                          after={learnGold(entry)}
                          compact
                        />
                      </div>
                    ) : (
                      <p className="mb-2 type-body !text-[13px]">
                        {entry.raw_text}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <QualityRateBar
                        rating={rated}
                        onRate={(next) => void setRating(entry.id, next)}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          setEditingId((id) =>
                            id === entry.id ? null : entry.id,
                          )
                        }
                      >
                        {editing ? "收起" : "修正"}
                      </Button>
                    </div>

                    <SoftCollapse open={editing}>
                      <div className="mt-3 flex flex-col gap-2">
                        <TextField
                          fullWidth
                          variant="secondary"
                          value={draft}
                          onChange={(value) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [entry.id]: value,
                            }))
                          }
                        >
                          <Label>用户修正</Label>
                          <TextArea
                            rows={2}
                            className="font-mono text-[12px]"
                          />
                        </TextField>
                        <Button
                          size="sm"
                          variant="primary"
                          className="btn-press self-start"
                          onPress={() => void saveUserAdjust(entry)}
                        >
                          <Save size={12} />
                          保存修正
                        </Button>
                      </div>
                    </SoftCollapse>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </>
      )}
    </PageShell>
  );
}
