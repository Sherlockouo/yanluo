import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, TextField, toast } from "@heroui/react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ChevronDown,
  Clipboard,
  Download,
  MoreHorizontal,
  RotateCcw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  PageHeader,
  PageShell,
  Reveal,
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
import { useCollapse } from "@/lib/motion";
import { writePendingDispatchPrompt } from "@/lib/ui-session";
import type { HistoryEntry } from "@/types";
import { useApp } from "@/app-context";

function historySourceLabel(entry: HistoryEntry): string {
  const src = entry.source ?? "fn";
  if (src === "translate") return "翻译";
  if (src === "transcribe") return "转写";
  return "Fn";
}

/** Local calendar day key — groups list rows regardless of timezone drift. */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Mono day header label — 今天/昨天, else `7月21日 · 周二` (+ year if not current). */
function dayHeaderLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const weekday = d.toLocaleDateString("zh-CN", { weekday: "short" });
  return d.getFullYear() === now.getFullYear()
    ? `${md} · ${weekday}`
    : `${d.getFullYear()}年${md}`;
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
  const [query, setQuery] = useState("");
  const collapse = useCollapse();

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
      toast.danger("没有可派的内容");
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
    if (!window.confirm("确定删除这条记录？")) return;
    try {
      await deleteHistory(id);
      setExpandedId((cur) => (cur === id ? null : cur));
      toast.success("已删除");
    } catch (error) {
      toast.danger(`删除失败: ${error}`);
    }
  };

  const headerStatus = history.length ? `${history.length} 条` : undefined;
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
          清理
        </Button>
        {cleanupOpen ? (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setCleanupOpen(false)}
            />
            <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg">
              <CleanupItem
                label="保留最近 100 条"
                onPress={() =>
                  void runCleanup("已保留最近 100 条", () =>
                    pruneHistory(100),
                  )
                }
              />
              <CleanupItem
                label="保留最近 500 条"
                onPress={() =>
                  void runCleanup("已保留最近 500 条", () =>
                    pruneHistory(500),
                  )
                }
              />
              <CleanupItem
                label="删除 30 天前"
                onPress={() =>
                  void runCleanup("已删除 30 天前记录", () =>
                    pruneHistoryOlderThan(30),
                  )
                }
              />
              <CleanupItem
                label="删除 90 天前"
                onPress={() =>
                  void runCleanup("已删除 90 天前记录", () =>
                    pruneHistoryOlderThan(90),
                  )
                }
              />
              <div className="my-1 border-t border-border" />
              <CleanupItem
                label="清空全部"
                danger
                onPress={() => {
                  if (
                    !window.confirm(
                      `确定清空全部 ${history.length} 条记录？`,
                    )
                  ) {
                    return;
                  }
                  void runCleanup("已清空历史", () => clearHistory());
                }}
              />
            </div>
          </>
        ) : null}
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
        <PageHeader title="历史" status={headerStatus} action={headerAction} />
      )}

      {history.length === 0 ? (
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-t">还没有稿</span>
          <span className="dropzone-fmt">出稿和翻译会在这里</span>
        </div>
      ) : (
        <>
          <div className="history-search">
            <Search size={13} className="history-search-icon" aria-hidden />
            <TextField
              fullWidth
              aria-label="搜索历史"
              value={query}
              onChange={setQuery}
              variant="secondary"
            >
              <Input
                placeholder="搜索标题或内容…"
                className="history-search-input"
              />
            </TextField>
          </div>

          {filtered.length === 0 ? (
            <div className="dropzone" style={{ minHeight: 160 }}>
              <span className="dropzone-t">没有匹配的稿</span>
            </div>
          ) : (
            <div className="recs">
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
                    <Fragment key={entry.id}>
                      {showDayHeader ? (
                        <div className="rec-day">{dayHeaderLabel(entry.created_at)}</div>
                      ) : null}
                      {i < 8 ? <Reveal index={i}>{row}</Reveal> : row}
                    </Fragment>
                  );
                });
              })()}
            </div>
          )}
        </>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell>{content}</PageShell>;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const isTranslate = (entry.source ?? "fn") === "translate";
  const showDiff = !isTranslate && hasRefineDiff(entry.raw_text, entry.text);
  const showTranslatePair =
    isTranslate && Boolean(entry.raw_text?.trim() && entry.text?.trim());
  const lang =
    isTranslate
      ? translateTargetLabel(entry.translate_target_language) || "译"
      : entry.language || "auto";

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
          <span className="tag">{historySourceLabel(entry)}</span>
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
          <p className="rec-c line-clamp-2">{entry.text || "（空）"}</p>
        )}
      </button>
      <ChevronDown
        size={16}
        className={cn(
          "mt-1 shrink-0 text-muted transition-transform duration-150",
          open && "rotate-180",
        )}
      />
      <div className="relative mt-0.5 shrink-0">
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="更多操作"
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
        {menuOpen ? (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg">
              <CleanupItem
                label="派这段"
                onPress={() => {
                  setMenuOpen(false);
                  onDispatch();
                }}
              />
              <CleanupItem
                label="导出为 Markdown"
                onPress={() => {
                  setMenuOpen(false);
                  exportHistoryEntry(entry, "md");
                }}
              />
              <CleanupItem
                label="导出为 TXT"
                onPress={() => {
                  setMenuOpen(false);
                  exportHistoryEntry(entry, "txt");
                }}
              />
              <div className="my-1 border-t border-border" />
              <CleanupItem
                label="删除"
                danger
                onPress={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              />
            </div>
          </>
        ) : null}
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
  const { setHistoryUserText } = useApp();
  const [full, setFull] = useState<HistoryEntry | null>(null);
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
      toast.success("已改回原文");
    } catch (error) {
      toast.danger(`回退失败: ${error}`);
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
          {view.text || "（空）"}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {isFn ? (
          <Link
            to="/settings?tab=refine"
            className="text-[12px] text-muted hover:text-accent-soft-foreground hover:underline"
          >
            在纠错学习页学习
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
              用原文
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => onDispatch(view.text)}
          >
            <Send size={14} />
            派这段
          </Button>
          <ExportMenu entry={view} />
          <Button
            size="sm"
            variant="secondary"
            onPress={() => {
              void navigator.clipboard.writeText(view.text);
              toast.success("已复制");
            }}
          >
            <Clipboard size={14} />
            复制
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExportMenu({ entry }: { entry: HistoryEntry }) {
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
        导出
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
              label="导出为 Markdown"
              onPress={() => {
                setOpen(false);
                exportHistoryEntry(entry, "md", entry.text);
              }}
            />
            <CleanupItem
              label="导出为 TXT"
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
