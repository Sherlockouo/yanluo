import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, toast } from "@heroui/react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronDown, Clipboard, RotateCcw, Trash2 } from "lucide-react";
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
import { useCollapse } from "@/lib/motion";
import type { HistoryEntry } from "@/types";
import { useApp } from "@/app-context";

function historySourceLabel(entry: HistoryEntry): string {
  const src = entry.source ?? "fn";
  if (src === "translate") return "翻译";
  if (src === "transcribe") return "转写";
  return "Fn";
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const collapse = useCollapse();

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
    if (visibleCount >= history.length) return;
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 600;
      if (nearBottom) setVisibleCount(history.length);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [history.length, visibleCount]);

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
          <span className="dropzone-t">还没有记录</span>
        </div>
      ) : (
        <div className="recs">
          {history.slice(0, visibleCount).map((entry, i) => {
            const open = expandedId === entry.id;
            const row = (
              <div className={cn("rec is-clickable", open && "exp")}>
                <HistoryRow
                  entry={entry}
                  open={open}
                  onToggle={() =>
                    setExpandedId((id) =>
                      id === entry.id ? null : entry.id,
                    )
                  }
                  onDelete={() => void removeEntry(entry.id)}
                />
                {open ? (
                  <motion.div
                    key="expanded"
                    initial={collapse.initial}
                    animate={collapse.animate}
                    transition={collapse.transition}
                    style={{ willChange: "opacity, transform" }}
                  >
                    <ExpandedViewer entry={entry} />
                  </motion.div>
                ) : null}
              </div>
            );
            // Reveal (framer, willChange) only for the first screenful —
            // beyond that a plain div keeps long lists cheap.
            return i < 8 ? (
              <Reveal key={entry.id} index={i}>
                {row}
              </Reveal>
            ) : (
              <div key={entry.id}>{row}</div>
            );
          })}
        </div>
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
}: {
  entry: HistoryEntry;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
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
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-danger/10 hover:text-danger data-[hovered=true]:bg-danger/10 data-[hovered=true]:text-danger"
        aria-label="删除"
        onPress={onDelete}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </div>
  );
}

function ExpandedViewer({ entry }: { entry: HistoryEntry }) {
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
