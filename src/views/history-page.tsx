import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, TextField, toast } from "@heroui/react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { TranscriptViewer } from "@/components/ui/transcript-viewer";
import {
  hasRefineDiff,
  RefineDiff,
  SemanticPair,
} from "@/components/ui/refine-diff";
import { isVideoMediaKind } from "@/lib/alignment";
import { cn } from "@/lib/cn";
import { translateTargetLabel } from "@/lib/constants";
import { exportHistoryEntry, historyEntryTitle } from "@/lib/export-transcript";
import { springUI, useCollapse } from "@/lib/motion";
import { writePendingDispatchPrompt } from "@/lib/ui-session";
import { useI18n, useT } from "@/lib/i18n";
import type { HistoryEntry } from "@/types";
import { useApp } from "@/app-context";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

function historySourceLabel(entry: HistoryEntry, t: TFunc): string {
  const src = entry.source ?? "fn";
  if (src === "translate") return t("history.source.translate");
  if (src === "transcribe") return t("history.source.transcribe");
  return "Fn";
}

/** Local calendar day key — groups list rows regardless of timezone drift. */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Mono day header label — 今天/昨天, else `7月21日 · 周二` (+ year if not current). */
function dayHeaderLabel(iso: string, t: TFunc, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return t("history.today");
  if (diffDays === 1) return t("history.yesterday");
  const md = t("history.monthDay", { m: d.getMonth() + 1, d: d.getDate() });
  const weekday = d.toLocaleDateString(
    locale === "zh" ? "zh-CN" : "en-US",
    { weekday: "short" },
  );
  return d.getFullYear() === now.getFullYear()
    ? `${md} · ${weekday}`
    : t("history.monthDayYear", { y: d.getFullYear(), md });
}

/** Full history mode panel. Used standalone or embedded in 出稿. */
export function HistoryPage({
  embedded = false,
  active = true,
  actionSlot,
}: {
  embedded?: boolean;
  active?: boolean;
  actionSlot?: HTMLElement | null;
} = {}) {
  const { t, locale } = useI18n();
  const {
    history,
    clearHistory,
    deleteHistory,
    pruneHistory,
    pruneHistoryOlderThan,
  } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const collapse = useCollapse();
  const reducedMotion = useReducedMotion();

  // Deep-link from home word cloud: /draft?mode=history&hid=<id>
  useEffect(() => {
    const hid = searchParams.get("hid");
    if (!hid) return;
    setExpandedId(hid);
  }, [searchParams]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return history;
    return history.filter((entry) => {
      const title = historyEntryTitle(entry).toLowerCase();
      const text = (entry.text ?? "").toLowerCase();
      const raw = (entry.raw_text ?? "").toLowerCase();
      return title.includes(q) || text.includes(q) || raw.includes(q);
    });
  }, [history, query]);

  // First paint: few rows (each row can run a refine diff). Ramp after idle,
  // then render the rest when the user scrolls near the bottom — mirrors
  // TranscribePage's listReady/visibleCount deferral.
  const [visibleCount, setVisibleCount] = useState(8);
  useEffect(() => {
    const raise = () => setVisibleCount(30);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(raise, { timeout: 400 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(raise, 300);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (visibleCount >= filtered.length) return;
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 600;
      if (nearBottom) setVisibleCount(filtered.length);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [filtered.length, visibleCount]);

  // Ensure deep-linked row is in the rendered slice, then scroll into view.
  useEffect(() => {
    if (!expandedId) return;
    const idx = filtered.findIndex((e) => e.id === expandedId);
    if (idx < 0) return;
    setVisibleCount((c) => Math.max(c, idx + 1));
    const t = window.setTimeout(() => {
      document
        .querySelector(`[data-history-id="${CSS.escape(expandedId)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [expandedId, filtered]);

  const dispatchText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.danger(t("history.nothingToDispatch"));
      return;
    }
    writePendingDispatchPrompt(trimmed);
    navigate("/dispatch");
  };

  const runCleanup = async (label: string, action: () => Promise<void>) => {
    await action();
    setExpandedId(null);
    setCleanupOpen(false);
    toast.success(label);
  };

  const removeEntry = async (id: string) => {
    try {
      await deleteHistory(id);
      setExpandedId((cur) => (cur === id ? null : cur));
      toast.success(t("history.deleted"));
    } catch (error) {
      toast.danger(t("history.deleteFailed", { error: String(error) }));
    }
  };

  const headerStatus = history.length
    ? t("history.count", { n: history.length })
    : undefined;
  const headerAction =
    history.length > 0 ? (
      <div className="relative">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={cleanupOpen}
          aria-haspopup="menu"
          onPress={() => setCleanupOpen((v) => !v)}
          className="text-xs"
        >
          <Trash2 size={12} />
          {t("history.cleanup")}
        </Button>
        <AnimatePresence>
          {cleanupOpen ? (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setCleanupOpen(false)}
            />
            <motion.div
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
              transition={springUI}
              style={{ transformOrigin: "top right" }}
              className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg"
            >
              <CleanupItem
                label={t("history.keepRecent", { n: 100 })}
                onPress={() =>
                  void runCleanup(t("history.keptRecent", { n: 100 }), () =>
                    pruneHistory(100),
                  )
                }
              />
              <CleanupItem
                label={t("history.keepRecent", { n: 500 })}
                onPress={() =>
                  void runCleanup(t("history.keptRecent", { n: 500 }), () =>
                    pruneHistory(500),
                  )
                }
              />
              <CleanupItem
                label={t("history.deleteOlderThan", { n: 30 })}
                onPress={() =>
                  void runCleanup(t("history.deletedOlderThan", { n: 30 }), () =>
                    pruneHistoryOlderThan(30),
                  )
                }
              />
              <CleanupItem
                label={t("history.deleteOlderThan", { n: 90 })}
                onPress={() =>
                  void runCleanup(t("history.deletedOlderThan", { n: 90 }), () =>
                    pruneHistoryOlderThan(90),
                  )
                }
              />
              <div className="my-1 border-t border-border" />
              <CleanupItem
                label={t("history.clearAll")}
                danger
                onPress={() => {
                  setCleanupOpen(false);
                  setClearModalOpen(true);
                }}
              />
            </motion.div>
          </>
        ) : null}
        </AnimatePresence>
      </div>
    ) : null;

  const content = (
    <>
      {embedded && active && actionSlot
        ? createPortal(
            <>
              {headerStatus ? (
                <span className="dmast-meta">{headerStatus}</span>
              ) : null}
              {headerAction}
            </>,
            actionSlot,
          )
        : null}
      {embedded ? null : (
        <PageHeader title={t("history.title")} status={headerStatus} action={headerAction} />
      )}

      {history.length === 0 ? (
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-t">{t("history.emptyTitle")}</span>
          <span className="dropzone-fmt">{t("history.emptyHint")}</span>
        </div>
      ) : (
        <>
          <div className="history-search">
            <Search size={13} className="history-search-icon" aria-hidden />
            <TextField
              fullWidth
              aria-label={t("history.searchAria")}
              value={query}
              onChange={setQuery}
              variant="secondary"
            >
              <Input
                placeholder={t("history.searchPlaceholder")}
                className="history-search-input"
              />
            </TextField>
          </div>

          {filtered.length === 0 ? (
            <div className="dropzone" style={{ minHeight: 160 }}>
              <span className="dropzone-t">{t("history.noMatch")}</span>
            </div>
          ) : (
            <div className="recs">
              <AnimatePresence initial={false}>
              {(() => {
                let lastDayKey: string | null = null;
                return filtered.slice(0, visibleCount).map((entry, i) => {
                  const open = expandedId === entry.id;
                  const dayKey = dayKeyOf(entry.created_at);
                  const showDayHeader = dayKey !== "" && dayKey !== lastDayKey;
                  lastDayKey = dayKey || lastDayKey;
                  const row = (
                    <div
                      className={cn("rec is-clickable", open && "exp")}
                      data-history-id={entry.id}
                    >
                      <HistoryRow
                        entry={entry}
                        open={open}
                        onToggle={() =>
                          setExpandedId((id) =>
                            id === entry.id ? null : entry.id,
                          )
                        }
                        onDelete={() => void removeEntry(entry.id)}
                        onDispatch={() => dispatchText(entry.text)}
                      />
                      {open ? (
                        <motion.div
                          key="expanded"
                          initial={collapse.initial}
                          animate={collapse.animate}
                          transition={collapse.transition}
                          style={{ willChange: "opacity, transform" }}
                        >
                          <ExpandedViewer entry={entry} onDispatch={dispatchText} />
                        </motion.div>
                      ) : null}
                    </div>
                  );
                  // Reveal (framer, willChange) only for the first screenful —
                  // beyond that a plain div keeps long lists cheap.
                  return (
                    <motion.div
                      key={entry.id}
                      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -12 }}
                      transition={springUI}
                      style={{ willChange: "opacity, transform" }}
                    >
                      {showDayHeader ? (
                        <div className="rec-day">{dayHeaderLabel(entry.created_at, t, locale)}</div>
                      ) : null}
                      {i < 8 ? <Reveal index={i}>{row}</Reveal> : row}
                    </motion.div>
                  );
                });
              })()}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </>
  );

  const clearAllModal = (
    <ClearAllModal
      open={clearModalOpen}
      count={history.length}
      reducedMotion={reducedMotion}
      onConfirm={() => {
        setClearModalOpen(false);
        void runCleanup(t("history.clearedAll"), () => clearHistory());
      }}
      onClose={() => setClearModalOpen(false)}
    />
  );

  if (embedded) return <>{content}{clearAllModal}</>;
  return <PageShell>{content}{clearAllModal}</PageShell>;
}

function CleanupItem({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "h-auto min-h-0 w-full justify-start rounded-none px-3.5 py-2 text-left text-[13px] font-normal shadow-none",
        danger ? "text-danger" : "text-foreground",
      )}
      onPress={onPress}
    >
      {label}
    </Button>
  );
}

/** P0-3: Product-internal modal to confirm clearing all history. */
function ClearAllModal({
  open,
  count,
  reducedMotion,
  onConfirm,
  onClose,
}: {
  open: boolean;
  count: number;
  reducedMotion: boolean | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="clear-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            key="clear-panel"
            role="alertdialog"
            aria-modal="true"
            aria-label={t("history.confirmClearAria")}
            className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-2xl"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 24 }}
            transition={{ type: "spring", bounce: 0.2, duration: 0.3 }}
          >
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("history.clearAllTitle", { n: count })}
            </h2>
            <p className="mt-2 text-[13px] text-muted">
              {t("history.clearAllBody")}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button size="sm" variant="secondary" onPress={onClose}>
                {t("history.cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="bg-danger text-white hover:bg-danger/90"
                onPress={onConfirm}
              >
                {t("history.clearAll")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function HistoryRow({
  entry,
  open,
  onToggle,
  onDelete,
  onDispatch,
}: {
  entry: HistoryEntry;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onDispatch: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const isTranslate = (entry.source ?? "fn") === "translate";
  const showDiff = !isTranslate && hasRefineDiff(entry.raw_text, entry.text);
  const showTranslatePair =
    isTranslate && Boolean(entry.raw_text?.trim() && entry.text?.trim());
  const lang =
    isTranslate
      ? translateTargetLabel(entry.translate_target_language) ||
        t("history.translateTag")
      : entry.language || "auto";

  useEffect(
    () => () => {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
      }
    },
    [],
  );

  const pressDelete = () => {
    if (confirmingDelete) {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
      setConfirmingDelete(false);
      onDelete();
      return;
    }
    setConfirmingDelete(true);
    confirmTimer.current = window.setTimeout(() => {
      setConfirmingDelete(false);
      confirmTimer.current = null;
    }, 3000);
  };

  return (
    <div className="group flex w-full items-start gap-2">
      <button
        type="button"
        onClick={onToggle}
        className="min-w-0 flex-1 text-left"
      >
        <div className="rec-l">
          <span>{new Date(entry.created_at).toLocaleString()}</span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
          <span className="tag">{historySourceLabel(entry, t)}</span>
          <span>{lang}</span>
        </div>
        {showTranslatePair ? (
          <div className="rec-pair line-clamp-4">
            <SemanticPair before={entry.raw_text} after={entry.text} compact />
          </div>
        ) : showDiff ? (
          <div className="rec-c line-clamp-3">
            <RefineDiff before={entry.raw_text} after={entry.text} compact />
          </div>
        ) : (
          <p className="rec-c line-clamp-2">{entry.text || t("history.empty")}</p>
        )}
      </button>
      <ChevronDown
        size={16}
        className={cn(
          "mt-1 shrink-0 text-muted transition-transform duration-150",
          open && "rotate-180",
        )}
      />
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t("history.copyAllAria")}
        className={cn(
          "mt-0.5 shrink-0 text-muted transition-opacity group-hover:opacity-100 data-[hovered=true]:opacity-100",
          copied ? "opacity-100 text-success" : "opacity-0",
        )}
        onPress={() => {
          void navigator.clipboard.writeText(entry.text || "").then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </Button>
      <div className="relative mt-0.5 shrink-0">
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("history.moreActionsAria")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={cn(
            "text-muted transition-opacity group-hover:opacity-100 data-[hovered=true]:opacity-100",
            menuOpen ? "opacity-100" : "opacity-0",
          )}
          onPress={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal size={14} aria-hidden />
        </Button>
        <AnimatePresence>
        {menuOpen ? (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <motion.div
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
              transition={springUI}
              style={{ transformOrigin: "top right" }}
              className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg"
            >
              <CleanupItem
                label={t("history.dispatchThis")}
                onPress={() => {
                  setMenuOpen(false);
                  onDispatch();
                }}
              />
              <CleanupItem
                label={t("history.exportMd")}
                onPress={() => {
                  setMenuOpen(false);
                  exportHistoryEntry(entry, "md");
                }}
              />
              <CleanupItem
                label={t("history.exportTxt")}
                onPress={() => {
                  setMenuOpen(false);
                  exportHistoryEntry(entry, "txt");
                }}
              />
              <div className="my-1 border-t border-border" />
              <CleanupItem
                label={confirmingDelete ? t("history.confirmDelete") : t("history.delete")}
                danger
                onPress={() => {
                  pressDelete();
                  if (confirmingDelete) setMenuOpen(false);
                }}
              />
            </motion.div>
          </>
        ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ExpandedViewer({
  entry,
  onDispatch,
}: {
  entry: HistoryEntry;
  onDispatch: (text: string) => void;
}) {
  const t = useT();
  const { setHistoryUserText } = useApp();
  const [full, setFull] = useState<HistoryEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  useEffect(() => {
    let cancelled = false;
    void invoke<HistoryEntry | null>("get_history_entry", { id: entry.id })
      .then((next) => {
        if (!cancelled) setFull(next);
      })
      .catch(() => {
        if (!cancelled) setFull(entry);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch by id only
  }, [entry.id]);

  const view = full ?? entry;
  const mediaSrc = view.audio_path ? convertFileSrc(view.audio_path) : null;
  const mediaKind = isVideoMediaKind(view.media_kind, view.audio_path)
    ? "video"
    : "audio";
  const showDiff = hasRefineDiff(view.raw_text, view.text);
  const isTranslate = (view.source ?? "fn") === "translate";
  const isFn = (view.source ?? "fn") === "fn";
  // Revert available when refine changed the text (fn, not translate).
  const canRevert = isFn && showDiff && Boolean(view.raw_text?.trim());

  const revertToRaw = async () => {
    const raw = view.raw_text?.trim();
    if (!raw) return;
    try {
      await setHistoryUserText(view.id, raw);
      setFull((prev) => (prev ? { ...prev, text: raw, user_text: raw } : prev));
      toast.success(t("history.revertedToRaw"));
    } catch (error) {
      toast.danger(t("history.revertFailed", { error: String(error) }));
    }
  };

  const saveEdit = async () => {
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === view.text) {
      setEditing(false);
      return;
    }
    try {
      await invoke("learn_from_edit", { entryId: view.id, before: view.text, after: trimmed });
      await setHistoryUserText(view.id, trimmed);
      setFull((prev) => prev ? { ...prev, text: trimmed, user_text: trimmed } : prev);
      toast.success(t("history.correctionSaved"));
      setEditing(false);
    } catch (e) {
      toast.danger(t("history.saveFailed", { error: String(e) }));
    }
  };

  return (
    <div className="expbody">
      {isTranslate && showDiff ? (
        <div className="mb-4">
          <SemanticPair before={view.raw_text} after={view.text} />
        </div>
      ) : showDiff ? (
        <div className="mb-4">
          <RefineDiff before={view.raw_text} after={view.text} />
        </div>
      ) : null}

      {mediaSrc ? (
        <TranscriptViewer
          text={view.text}
          mediaSrc={mediaSrc}
          mediaKind={mediaKind}
          durationSeconds={view.duration_seconds}
          segments={view.segments}
          alignment={view.alignment}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.75] text-foreground">
          {view.text || t("history.empty")}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {isFn ? (
          <Link
            to="/settings?tab=refine"
            className="text-[12px] text-muted hover:text-accent-soft-foreground hover:underline"
          >
            {t("history.learnLink")}
          </Link>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {canRevert ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => void revertToRaw()}
            >
              <RotateCcw size={14} />
              {t("history.useRaw")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => { setEditing(v => !v); if (!editing) setEditDraft(view.text || ""); }}
          >
            <Pencil size={14} />
            {editing ? t("history.cancel") : t("history.editCorrection")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => onDispatch(view.text)}
          >
            <Send size={14} />
            {t("history.dispatchThis")}
          </Button>
          <ExportMenu entry={view} />
          <Button
            size="sm"
            variant="secondary"
            onPress={() => {
              void navigator.clipboard.writeText(view.text);
              toast.success(t("history.copied"));
            }}
          >
            <Clipboard size={14} />
            {t("history.copy")}
          </Button>
        </div>
      </div>

      <SoftCollapse open={editing}>
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className="w-full resize-none rounded-lg border border-border bg-surface-secondary/40 px-3 py-2 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:border-accent-soft-foreground/40 transition-colors"
            rows={3}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" className="btn-press" onPress={() => void saveEdit()}>
              <Save size={12} />
              {t("history.saveCorrection")}
            </Button>
            <span className="type-meta text-muted">{t("history.saveLearnHint")}</span>
          </div>
        </div>
      </SoftCollapse>
    </div>
  );
}

function ExportMenu({ entry }: { entry: HistoryEntry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onPress={() => setOpen((v) => !v)}
      >
        <Download size={14} />
        {t("history.export")}
      </Button>
      {open ? (
        <>
          <div
            role="presentation"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-2 w-40 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg">
            <CleanupItem
              label={t("history.exportMd")}
              onPress={() => {
                setOpen(false);
                exportHistoryEntry(entry, "md", entry.text);
              }}
            />
            <CleanupItem
              label={t("history.exportTxt")}
              onPress={() => {
                setOpen(false);
                exportHistoryEntry(entry, "txt", entry.text);
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
