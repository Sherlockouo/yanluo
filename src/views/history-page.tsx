import { useEffect, useState } from "react";
import { Button, toast } from "@heroui/react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ChevronDown, Clipboard, Trash2 } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Reveal,
  SectionCard,
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

export function HistoryPage() {
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

  return (
    <PageShell>
      <PageHeader
        title="历史"
        status={history.length ? `${history.length} 条` : undefined}
        action={
          history.length > 0 ? (
            <div className="relative">
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={cleanupOpen}
                aria-haspopup="menu"
                onPress={() => setCleanupOpen((v) => !v)}
              >
                <Trash2 size={14} />
                清理
              </Button>
              {cleanupOpen ? (
                <>
                  <div
                    role="presentation"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setCleanupOpen(false)}
                  />
                  <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-xl">
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
          ) : null
        }
      />

      {history.length === 0 ? (
        <SectionCard>
          <EmptyState title="还没有记录" />
        </SectionCard>
      ) : (
        <div className="flex flex-col gap-2">
          {history.map((entry, i) => {
            const open = expandedId === entry.id;
            return (
              <Reveal key={entry.id} index={i}>
                <div className="flex flex-col gap-2">
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
              </Reveal>
            );
          })}
        </div>
      )}
    </PageShell>
  );
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
        "h-auto min-h-0 w-full justify-start rounded-none px-3.5 py-2 text-left text-[13px] font-normal shadow-none data-[pressed=true]:scale-100",
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
    <div
      className={cn(
        "flex w-full items-start gap-2 rounded-2xl border px-4 py-3.5 transition",
        open
          ? "border-accent/35 bg-accent/[0.07]"
          : "border-border bg-surface hover:bg-surface-secondary/40",
      )}
    >
      <Button
        variant="ghost"
        onPress={onToggle}
        className="h-auto min-h-0 min-w-0 flex-1 items-start justify-start gap-3 rounded-none bg-transparent px-0 py-0 text-left font-normal shadow-none hover:bg-transparent data-[hovered=true]:bg-transparent data-[pressed=true]:scale-100 data-[pressed=true]:bg-transparent"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 type-meta">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            <span>{entry.duration_seconds.toFixed(1)}s</span>
            <span>{historySourceLabel(entry)}</span>
            <span>{lang}</span>
          </div>
          {showTranslatePair ? (
            <div className="mt-1.5 line-clamp-4">
              <SemanticPair
                before={entry.raw_text}
                after={entry.text}
                compact
              />
            </div>
          ) : showDiff ? (
            <div className="mt-1.5 line-clamp-3">
              <RefineDiff before={entry.raw_text} after={entry.text} compact />
            </div>
          ) : (
            <p className="mt-1.5 line-clamp-2 type-body leading-snug">
              {entry.text || "（空）"}
            </p>
          )}
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "mt-1 shrink-0 text-muted transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </Button>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        className="mt-0.5 shrink-0 text-muted hover:bg-danger/10 hover:text-danger data-[hovered=true]:bg-danger/10 data-[hovered=true]:text-danger"
        aria-label="删除"
        onPress={onDelete}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </div>
  );
}

function ExpandedViewer({ entry }: { entry: HistoryEntry }) {
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

  return (
    <SectionCard className="!p-4">
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
            to="/llm"
            className="text-[12px] text-muted hover:text-accent hover:underline"
          >
            在 LLM 页学习
          </Link>
        ) : (
          <span />
        )}
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
    </SectionCard>
  );
}
