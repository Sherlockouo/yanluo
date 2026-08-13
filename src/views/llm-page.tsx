import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Chip,
  Input,
  Label,
  Switch,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  MoreHorizontal,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import { LlmProviderSelect } from "@/components/ui/llm-provider-select";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { DEFAULT_LLM_REFINE_PROMPT } from "@/lib/constants";
import { springUI } from "@/lib/motion";
import type { HistoryEntry } from "@/types";
import { learnGold } from "@/lib/learn-cases";

// ─── Types ──────────────────────────────────────────────────────────────────

type LearnPair = {
  id: string;
  wrong: string;
  right: string;
  source: string;
  confidence: number;
  occurrence_count: number;
  hit_count: number;
  enabled: boolean;
  created_at: string;
  last_seen_at: string;
};

type LearnStats = {
  total_pairs: number;
  week_hits: number;
  top_pairs: Array<{ wrong: string; right: string; hit_count: number }>;
};

type LearnKnowledge = {
  pairs: LearnPair[];
  version: number;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function sourceBadge(
  source: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (source) {
    case "auto":
      return t("learn.sourceAuto");
    case "manual":
      return t("learn.sourceManual");
    case "ai":
      return "AI";
    default:
      return source;
  }
}

function showLearnEntry(e: HistoryEntry): boolean {
  if ((e.source ?? "fn") === "translate") return false;
  if (e.user_text?.trim()) return true;
  return Boolean(e.refined) && hasRefineDiff(e.raw_text, learnGold(e));
}

// ─── Main export ────────────────────────────────────────────────────────────

/** Automatic learning dashboard. Used standalone or embedded in 设置 → 纠错学习. */
export function LlmPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const {
    config,
    updateConfig,
    saveConfig,
    testLlm,
    history,
    distillLearnFromRatings,
  } = useApp();

  const reducedMotion = useReducedMotion();

  // ─── LLM config state
  const llmReady = Boolean(
    config.llm_api_base_url?.trim() && config.llm_model?.trim(),
  );
  const [configOpen, setConfigOpen] = useState(!llmReady);

  // ─── Knowledge base state
  const [knowledge, setKnowledge] = useState<LearnKnowledge | null>(null);
  const [stats, setStats] = useState<LearnStats | null>(null);
  const [query, setQuery] = useState("");
  const [distilling, setDistilling] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);

  // ─── Delete confirm state (two-step inline)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  // ─── Fetch knowledge + stats
  const fetchKnowledge = useCallback(async () => {
    try {
      const data = await invoke<LearnKnowledge>("get_learn_knowledge");
      setKnowledge(data);
    } catch {
      // backend not yet available — leave null
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const data = await invoke<LearnStats>("get_learn_stats");
      setStats(data);
    } catch {
      // backend not yet available
    }
  }, []);

  useEffect(() => {
    void fetchKnowledge();
    void fetchStats();
  }, [fetchKnowledge, fetchStats]);

  // ─── Filtered pairs
  const filteredPairs = useMemo(() => {
    if (!knowledge) return [];
    const q = query.trim().toLowerCase();
    if (!q) return knowledge.pairs;
    return knowledge.pairs.filter(
      (p) =>
        p.wrong.toLowerCase().includes(q) ||
        p.right.toLowerCase().includes(q),
    );
  }, [knowledge, query]);

  // ─── Learning activity entries (from history)
  const learnEntries = useMemo(
    () => history.filter(showLearnEntry).slice(0, 30),
    [history],
  );

  // ─── Actions
  const togglePair = async (id: string, enabled: boolean) => {
    try {
      await invoke("set_learn_pair_enabled", { id, enabled });
      setKnowledge((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pairs: prev.pairs.map((p) =>
            p.id === id ? { ...p, enabled } : p,
          ),
        };
      });
    } catch (e) {
      toast.danger(String(e));
    }
  };

  const deletePair = async (id: string) => {
    // Two-step confirm
    if (confirmingDelete !== id) {
      // First press — enter confirm state
      setConfirmingDelete(id);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => {
        setConfirmingDelete(null);
      }, 3000);
      return;
    }
    // Second press — do delete
    if (confirmTimer.current) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirmingDelete(null);
    try {
      await invoke("delete_learn_pair", { id });
      setKnowledge((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pairs: prev.pairs.filter((p) => p.id !== id),
        };
      });
      void fetchStats();
      toast.success(t("learn.deleted"));
    } catch (e) {
      toast.danger(String(e));
    }
  };

  const runAiDistill = async () => {
    if (!history.length) {
      toast(t("learn.nothingToDistill"));
      return;
    }
    setDistilling(true);
    try {
      await distillLearnFromRatings();
      toast.success(t("learn.distillDone"));
      void fetchKnowledge();
      void fetchStats();
    } catch (e) {
      toast.danger(String(e));
    } finally {
      setDistilling(false);
    }
  };

  const refineValue = config.llm_refine_prompt || DEFAULT_LLM_REFINE_PROMPT;

  // ─── Stats bar
  const topPair = stats?.top_pairs?.[0];

  // ─── Render
  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span>{config.llm_enabled ? t("learn.correctionsOn") : t("learn.correctionsOff")}</span>
      <span className="text-muted/40">·</span>
      <LlmProviderSelect />
    </div>
  );

  const headerAction = (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("learn.moreActionsAria")}
          onPress={() => setMoreMenuOpen((v) => !v)}
        >
          <MoreHorizontal size={16} />
        </Button>
        {moreMenuOpen && (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40"
              onClick={() => setMoreMenuOpen(false)}
            />
            <motion.div
              className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] rounded-xl border border-border bg-surface p-1 shadow-lg"
              initial={reducedMotion ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springUI}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-default/60"
                onClick={() => {
                  setMoreMenuOpen(false);
                  void runAiDistill();
                }}
              >
                <Sparkles size={14} />
                {t("learn.distillFromHistory")}
              </button>
            </motion.div>
          </>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        onPress={() => setConfigOpen((v) => !v)}
      >
        {t("learn.configure")}
      </Button>
    </div>
  );

  const content = (
    <>
      {embedded ? (
        <div className="set-row-line">
          <div className="set-row-line-lab">
            {t("learn.correctionsTitle")}
            <small>{t("learn.embeddedDesc")}</small>
          </div>
          <div className="set-row-line-ctl">
            <Switch
              aria-label={t("learn.correctionsSwitchAria")}
              isSelected={config.llm_enabled}
              onChange={(value) => updateConfig("llm_enabled", value)}
            >
              <Switch.Content className="gap-2">
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <LlmProviderSelect triggerCls="qsel-quiet" />
            <button
              type="button"
              className="dlink muted shrink-0"
              onClick={() => setConfigOpen((v) => !v)}
            >
              {t("learn.configure")}{configOpen ? " ▴" : " ▾"}
            </button>
          </div>
        </div>
      ) : (
        <PageHeader title={t("learn.title")} status={header} action={headerAction} />
      )}

      {/* ─── Stats bar ─── */}
      {stats && (
        <Reveal>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono type-meta">
            <span>
              {t("learn.statLearnedPrefix")}{" "}
              <span className="text-foreground">{stats.total_pairs}</span>{" "}
              {t("learn.statLearnedSuffix")}
            </span>
            <span className="text-muted/40">·</span>
            <span>
              {t("learn.statWeekPrefix")}{" "}
              <span className="text-foreground">{stats.week_hits}</span>{" "}
              {t("learn.statWeekSuffix")}
            </span>
            {topPair && (
              <>
                <span className="text-muted/40">·</span>
                <span>
                  {t("learn.statTopPrefix")}{" "}
                  <span className="text-foreground">
                    {topPair.wrong} → {topPair.right}
                  </span>
                  {" "}
                  ({topPair.hit_count})
                </span>
              </>
            )}
          </div>
        </Reveal>
      )}

      {/* ─── Config fold ─── */}
      <SoftCollapse open={configOpen}>
        <div className="surface-card mb-1 flex flex-col gap-5 p-4">
          <div className="settings-switchrow px-3 py-2">
            <Switch
              isSelected={config.llm_enabled}
              onChange={(value) => updateConfig("llm_enabled", value)}
            >
              <Switch.Content className="w-full justify-between gap-2 p-2">
                <div className="min-w-0 pr-2">
                  <div className="type-ui">{t("learn.enableCorrections")}</div>
                </div>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          <p className="type-meta">
            {t("learn.configHintPrefix")}{" "}
            <Link
              to="/settings?tab=llm"
              className="text-accent-soft-foreground hover:underline"
            >
              {t("learn.configHintSettings")}
            </Link>
            {t("learn.configHintSuffix")}
          </p>

          <TextField
            fullWidth
            variant="secondary"
            value={refineValue}
            onChange={(value) => updateConfig("llm_refine_prompt", value)}
          >
            <Label>{t("learn.promptLabel")}</Label>
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
                {t("learn.restoreDefault")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="btn-press"
                isPending={testingLlm}
                isDisabled={testingLlm}
                onPress={() => {
                  setTestingLlm(true);
                  void testLlm().finally(() => setTestingLlm(false));
                }}
              >
                <Sparkles size={14} aria-hidden />
                {t("learn.test")}
              </Button>
            </div>
            <Button
              className="form-actions-primary btn-press"
              fullWidth
              variant="secondary"
              onPress={() => void saveConfig()}
            >
              <Save size={16} aria-hidden />
              {t("learn.save")}
            </Button>
          </div>
        </div>
      </SoftCollapse>

      {/* ─── Knowledge base ─── */}
      {knowledge && knowledge.pairs.length === 0 && !query ? (
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-ic">
            <BookOpen size={22} aria-hidden />
          </span>
          <span className="dropzone-t">
            {t("learn.emptyTitle")}
          </span>
          <span className="dropzone-fmt">
            {t("learn.emptyHint")}
          </span>
        </div>
      ) : (
        <>
          {/* Search */}
          <div className="flex items-center gap-2">
            <TextField
              fullWidth
              variant="secondary"
              value={query}
              onChange={setQuery}
            >
              <Input
                placeholder={t("learn.searchPlaceholder")}
                className="font-mono text-sm"
              />
            </TextField>
            {embedded && (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={!history.length || distilling}
                isPending={distilling}
                onPress={() => void runAiDistill()}
              >
                <Sparkles size={14} />
                {t("learn.distillFromHistory")}
              </Button>
            )}
          </div>

          {/* Pair list */}
          <div className="recs">
            {filteredPairs.map((pair, i) => (
              <Reveal key={pair.id} index={i}>
                <article className="rec">
                  <div className="rec-l">
                    <span className="font-mono">
                      <span className="text-red-400/80 line-through">
                        {pair.wrong}
                      </span>
                      {" → "}
                      <span className="text-green-500/90">{pair.right}</span>
                    </span>
                    <Chip size="sm" variant="soft" color="default">
                      <Chip.Label className="type-micro">
                        {sourceBadge(pair.source, t)}
                      </Chip.Label>
                    </Chip>
                    {pair.hit_count > 0 && (
                      <span className="type-meta text-muted">
                        {t("learn.hitCount", { n: pair.hit_count })}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <Switch
                      aria-label={t(
                        pair.enabled ? "learn.disablePair" : "learn.enablePair",
                        { wrong: pair.wrong, right: pair.right },
                      )}
                      isSelected={pair.enabled}
                      onChange={(value) => void togglePair(pair.id, value)}
                    >
                      <Switch.Content className="gap-2">
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn(
                        "h-auto min-h-0 px-1.5 py-0.5 type-meta shadow-none transition-colors",
                        confirmingDelete === pair.id
                          ? "text-red-500"
                          : "text-muted hover:text-foreground",
                      )}
                      onPress={() => void deletePair(pair.id)}
                    >
                      <Trash2 size={12} />
                      {confirmingDelete === pair.id
                        ? t("learn.confirmDelete")
                        : t("learn.delete")}
                    </Button>
                  </div>
                </article>
              </Reveal>
            ))}
            {filteredPairs.length === 0 && query && (
              <p className="type-meta text-muted py-6 text-center">
                {t("learn.noMatch")}
              </p>
            )}
          </div>
        </>
      )}

      {/* ─── Learning activity (collapsed) ─── */}
      {learnEntries.length > 0 && (
        <div>
          <button
            type="button"
            className="flex w-full items-center gap-2 py-2 text-left type-meta text-muted hover:text-foreground transition-colors"
            onClick={() => setActivityOpen((v) => !v)}
          >
            <span className="type-ui text-sm">{t("learn.activityTitle")}</span>
            <span className="text-muted/60 type-micro">
              ({learnEntries.length})
            </span>
            <span className="ml-auto text-xs">
              {activityOpen ? "▴" : "▾"}
            </span>
          </button>
          <SoftCollapse open={activityOpen}>
            <div className="recs">
              {learnEntries.slice(0, 20).map((entry, i) => (
                <Reveal key={entry.id} index={i}>
                  <article className="rec">
                    <div className="rec-l">
                      <span className="type-meta">
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                      <span className="type-meta">
                        {entry.duration_seconds.toFixed(1)}s
                      </span>
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
                      <p className="rec-c type-meta">{entry.raw_text}</p>
                    )}
                  </article>
                </Reveal>
              ))}
            </div>
          </SoftCollapse>
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
