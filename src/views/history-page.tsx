import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, Input, Modal, Separator, TextField } from "@heroui/react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Copy,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Save,
  Search,
  SearchX,
  Send,
  Trash2,
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  InfoTip,
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { TranscriptViewer } from "@/components/ui/transcript-viewer";
import { TranscriptExportMenu } from "@/components/ui/transcript-export-menu";
import {
  hasRefineDiff,
  RefineDiff,
  SemanticPair,
} from "@/components/ui/refine-diff";
import { isVideoMediaKind } from "@/lib/alignment";
import { cn } from "@/lib/cn";
import { translateTargetLabel } from "@/lib/constants";
import { exportHistoryEntry, historyEntryTitle } from "@/lib/export-transcript";
import { easeOut, springUI, useCollapse } from "@/lib/motion";
import { writePendingDispatchPrompt } from "@/lib/ui-session";
import { useI18n, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
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
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
    if (cleaning) return;
    setCleaning(true);
    try {
      await action();
      setExpandedId(null);
      toast.success(label);
    } finally {
      setCleaning(false);
    }
  };

  const removeEntry = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await deleteHistory(id);
      setExpandedId((cur) => (cur === id ? null : cur));
      toast.success(t("history.deleted"));
    } catch (error) {
      toast.danger(t("history.deleteFailed", { error: String(error) }));
    } finally {
      setDeletingId(null);
    }
  };

  const onCleanupAction = (key: string | number) => {
    switch (key) {
      case "keep-100":
        void runCleanup(t("history.keptRecent", { n: 100 }), () =>
          pruneHistory(100),
        );
        break;
      case "keep-500":
        void runCleanup(t("history.keptRecent", { n: 500 }), () =>
          pruneHistory(500),
        );
        break;
      case "older-30":
        void runCleanup(t("history.deletedOlderThan", { n: 30 }), () =>
          pruneHistoryOlderThan(30),
        );
        break;
      case "older-90":
        void runCleanup(t("history.deletedOlderThan", { n: 90 }), () =>
          pruneHistoryOlderThan(90),
        );
        break;
      case "clear-all":
        setClearModalOpen(true);
        break;
    }
  };

  const headerStatus = history.length
    ? t("history.count", { n: history.length })
    : undefined;
  const headerAction =
    history.length > 0 ? (
      <Dropdown>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={cleaning}
          isPending={cleaning}
          className="text-xs btn-press"
        >
          <Trash2 size={12} />
          {t("history.cleanup")}
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t("history.cleanup")}
            onAction={onCleanupAction}
          >
            <Dropdown.Item
              id="keep-100"
              isDisabled={cleaning}
              textValue={t("history.keepRecent", { n: 100 })}
            >
              {t("history.keepRecent", { n: 100 })}
            </Dropdown.Item>
            <Dropdown.Item
              id="keep-500"
              isDisabled={cleaning}
              textValue={t("history.keepRecent", { n: 500 })}
            >
              {t("history.keepRecent", { n: 500 })}
            </Dropdown.Item>
            <Dropdown.Item
              id="older-30"
              isDisabled={cleaning}
              textValue={t("history.deleteOlderThan", { n: 30 })}
            >
              {t("history.deleteOlderThan", { n: 30 })}
            </Dropdown.Item>
            <Dropdown.Item
              id="older-90"
              isDisabled={cleaning}
              textValue={t("history.deleteOlderThan", { n: 90 })}
            >
              {t("history.deleteOlderThan", { n: 90 })}
            </Dropdown.Item>
            <Separator />
            <Dropdown.Item
              id="clear-all"
              variant="danger"
              isDisabled={cleaning}
              textValue={t("history.clearAll")}
            >
              {t("history.clearAll")}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    ) : null;

  const content = (
    <>
      {embedded && active && actionSlot
        ? createPortal(
            <>
              {headerStatus ? (
                <motion.span
                  key={headerStatus}
                  className="dmast-meta"
                  initial={reducedMotion ? false : { opacity: 0.92, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "tween", duration: 0.16, ease: easeOut }}
                >
                  {headerStatus}
                </motion.span>
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
        <Reveal>
          <div className="dropzone" style={{ minHeight: 200 }}>
            <span className="dropzone-ic">
              <History size={22} aria-hidden />
            </span>
            <span className="dropzone-t inline-flex items-center gap-1.5">
              {t("history.emptyTitle")}
              <InfoTip content={t("history.emptyHint")} />
            </span>
          </div>
        </Reveal>
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
            <Reveal>
              <div className="dropzone" style={{ minHeight: 160 }}>
                <span className="dropzone-ic">
                  <SearchX size={22} aria-hidden />
                </span>
                <span className="dropzone-t">{t("history.noMatch")}</span>
              </div>
            </Reveal>
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
                      className={cn(
                        "rec is-clickable",
                        open && "exp",
                        deletingId === entry.id && "pointer-events-none opacity-50",
                      )}
                      data-history-id={entry.id}
                    >
                      <HistoryRow
                        entry={entry}
                        open={open}
                        deleting={deletingId === entry.id}
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

/** P0-3: Product-internal modal to confirm clearing all history. */
function ClearAllModal({
  open,
  count,
  onConfirm,
  onClose,
}: {
  open: boolean;
  count: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog aria-label={t("history.confirmClearAria")}>
          <Modal.Header>
            <Modal.Heading>
              {t("history.clearAllTitle", { n: count })}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <p className="text-[13px] text-muted">{t("history.clearAllBody")}</p>
          </Modal.Body>
          <Modal.Footer>
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
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function HistoryRow({
  entry,
  open,
  deleting,
  onToggle,
  onDelete,
  onDispatch,
}: {
  entry: HistoryEntry;
  open: boolean;
  deleting?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onDispatch: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);
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
    if (deleting) return;
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
        className="min-w-0 flex-1 cursor-pointer text-left"
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
          "mt-0.5 shrink-0 text-muted btn-press transition-opacity data-[hovered=true]:opacity-100",
          copied ? "opacity-100 text-success" : "opacity-70 sm:opacity-0 sm:group-hover:opacity-100",
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
      <Dropdown>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("history.moreActionsAria")}
          className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 data-[hovered=true]:opacity-100 aria-expanded:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t("history.moreActionsAria")}
            onAction={(key) => {
              switch (key) {
                case "dispatch":
                  onDispatch();
                  break;
                case "export-md":
                  exportHistoryEntry(entry, "md");
                  break;
                case "export-txt":
                  exportHistoryEntry(entry, "txt");
                  break;
                case "export-srt":
                  exportHistoryEntry(entry, "srt");
                  break;
                case "export-raw":
                  exportHistoryEntry(entry, "raw");
                  break;
                case "open-work":
                  if (entry.work_id) {
                    void invoke("works_open_in_finder", {
                      id: entry.work_id,
                    }).catch(() => {});
                  }
                  break;
                case "delete":
                  pressDelete();
                  break;
              }
            }}
          >
            <Dropdown.Item id="dispatch" textValue={t("history.dispatchThis")}>
              {t("history.dispatchThis")}
            </Dropdown.Item>
            <Dropdown.Item id="export-md" textValue={t("history.exportMd")}>
              {t("history.exportMd")}
            </Dropdown.Item>
            <Dropdown.Item id="export-txt" textValue={t("history.exportTxt")}>
              {t("history.exportTxt")}
            </Dropdown.Item>
            <Dropdown.Item id="export-srt" textValue={t("history.exportSrt")}>
              {t("history.exportSrt")}
            </Dropdown.Item>
            <Dropdown.Item id="export-raw" textValue={t("history.exportRaw")}>
              {t("history.exportRaw")}
            </Dropdown.Item>
            {entry.work_id ? (
              <Dropdown.Item id="open-work" textValue={t("history.openWork")}>
                {t("history.openWork")}
              </Dropdown.Item>
            ) : null}
            <Separator />
            <Dropdown.Item
              id="delete"
              variant="danger"
              isDisabled={deleting}
              textValue={
                confirmingDelete
                  ? t("history.confirmDelete")
                  : t("history.delete")
              }
            >
              {confirmingDelete
                ? t("history.confirmDelete")
                : t("history.delete")}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
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
        <Reveal className="mb-4">
          <SemanticPair before={view.raw_text} after={view.text} />
        </Reveal>
      ) : showDiff ? (
        <Reveal className="mb-4">
          <RefineDiff before={view.raw_text} after={view.text} />
        </Reveal>
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
          <TranscriptExportMenu entry={view} variant="copy-export" />
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
            <InfoTip content={t("history.saveLearnHint")} />
          </div>
        </div>
      </SoftCollapse>
    </div>
  );
}
