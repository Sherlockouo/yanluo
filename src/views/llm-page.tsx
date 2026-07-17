import { useMemo, useState } from "react";
import {
  Button,
  Chip,
  Label,
  Switch,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { Link } from "react-router-dom";
import { BookPlus, RotateCcw, Save, Sparkles } from "lucide-react";
import {
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import { LlmProviderSelect } from "@/components/ui/llm-provider-select";
import {
  QualityRateBar,
  type QualityRating,
} from "@/components/ui/quality-rate-bar";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";
import { DEFAULT_LLM_REFINE_PROMPT } from "@/lib/constants";
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

/** LLM refine-learning loop. Used standalone or embedded in 设置 → 纠错学习. */
export function LlmPage({ embedded = false }: { embedded?: boolean } = {}) {
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
  const [distilling, setDistilling] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  const llmReady = Boolean(
    config.llm_api_base_url?.trim() && config.llm_model?.trim(),
  );
  const [configOpen, setConfigOpen] = useState(!llmReady);

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
        toast.success("差评已记（词库请用本地 / AI 提炼）");
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
      toast.success("已保存修正稿（识别稿 ↔ 修正稿）");
    } catch (e) {
      toast.danger(String(e));
    }
  };

  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span>{config.llm_enabled ? "纠错开" : "纠错关"}</span>
      <span className="text-muted/40">·</span>
      <LlmProviderSelect />
    </div>
  );
  const headerAction = (
    <Button
      size="sm"
      variant={configOpen ? "primary" : "secondary"}
      onPress={() => setConfigOpen((v) => !v)}
    >
      配置
    </Button>
  );

  const content = (
    <>
      {embedded ? (
        <div className="-mb-1 flex items-center justify-between gap-3">
          <div className="min-w-0">{header}</div>
          <button
            type="button"
            className="dlink muted shrink-0"
            onClick={() => setConfigOpen((v) => !v)}
          >
            配置{configOpen ? " ▴" : " ▾"}
          </button>
        </div>
      ) : (
        <PageHeader title="LLM" status={header} action={headerAction} />
      )}

      <SoftCollapse open={configOpen}>
        <div className="surface-card mb-1 flex flex-col gap-5 p-4">
          <div className="rounded-xl bg-surface-secondary/70 px-3 py-2 ring-1 ring-border/60">
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

          <p className="type-meta">
            Provider 与模型在标题栏选择，凭证在{" "}
            <Link to="/settings?tab=llm" className="text-accent hover:underline">
              设置
            </Link>
            {" 配置。"}
          </p>

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
          <div className="surface-card border-border bg-surface-secondary/60 px-4 py-3.5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="type-ui">
                词库待确认（{pendingLearn.terms.length}）
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
                <Button
                  key={c.term}
                  variant="ghost"
                  className="h-auto min-h-0 p-0 shadow-none data-[pressed=true]:scale-100"
                  aria-label={`移除 ${c.kind === "pair" ? `${c.from} → ${c.to}` : c.term}`}
                  onPress={() => void removePendingLearnTerm(c.term)}
                >
                  <Chip size="sm" variant="soft" color="accent">
                    <Chip.Label className="font-mono type-micro !normal-case !tracking-normal">
                      {c.kind === "pair" ? `${c.from} → ${c.to}` : c.term}
                    </Chip.Label>
                  </Chip>
                </Button>
              ))}
            </div>
          </div>
        </Reveal>
      ) : null}

      {learnEntries.length === 0 ? (
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-ic">
            <Sparkles size={22} aria-hidden />
          </span>
          <span className="dropzone-t">还没有学习 case</span>
          <span className="dropzone-fmt">
            HUD 改字确认后 · 整段识别稿 ↔ 修正稿出现在这里
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="type-meta">
              未标 {ratingStats.unlabeled} · 差 {ratingStats.bad} · 修正{" "}
              {userTripleCount} · 词库 {ratingStats.applied}
              {" · "}
              <Link to="/settings?tab=vocabulary" className="text-accent hover:underline">
                词库
              </Link>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                className="btn-press"
                isDisabled={!badOpenEntries.length || distilling}
                isPending={distilling}
                onPress={() => void runAiDistill()}
              >
                <Sparkles size={14} />
                AI 提炼
              </Button>
              <Button
                size="sm"
                variant="ghost"
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

          <div className="recs">
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
                  <article className="rec">
                    <div className="rec-l">
                      <span>
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                      <span>{entry.duration_seconds.toFixed(1)}s</span>
                      {triple?.hasUser ? (
                        <span className="tag">有修正</span>
                      ) : null}
                      {status === "applied" ? (
                        <span>已入词库</span>
                      ) : status === "suggested" ? (
                        <span>待确认</span>
                      ) : null}
                    </div>

                    {entry.raw_text && learnGold(entry) !== entry.raw_text ? (
                      <div className="rec-c">
                        <RefineDiff
                          before={entry.raw_text}
                          after={learnGold(entry)}
                          compact
                        />
                      </div>
                    ) : (
                      <p className="rec-c">{entry.raw_text}</p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2.5">
                      <QualityRateBar
                        rating={rated}
                        compact
                        className="!border-0 !pt-0"
                        onRate={(next) => void setRating(entry.id, next)}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className={cn(
                          "h-auto min-h-0 px-1.5 py-0.5 type-meta shadow-none transition-colors hover:text-foreground data-[hovered=true]:bg-transparent",
                          editing ? "text-accent" : "text-muted",
                        )}
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
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
