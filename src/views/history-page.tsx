import { useState } from "react";
import { Button, Chip, toast } from "@heroui/react";
import {
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Languages,
  Sparkles,
  Trash2,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  EmptyState,
  PageHeader,
  PageShell,
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
import type { HistoryEntry } from "@/types";
import { useApp } from "@/app-context";

function historyLanguageChip(entry: HistoryEntry): string {
  const isTranslate = (entry.source ?? "fn") === "translate";
  if (isTranslate) {
    return translateTargetLabel(entry.translate_target_language) || "译";
  }
  return entry.language || "auto";
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
        subtitle={history.length ? `${history.length} 条` : undefined}
        action={
          history.length > 0 ? (
            <div className="relative">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setCleanupOpen((v) => !v)}
              >
                <Trash2 size={14} />
                清理
              </Button>
              {cleanupOpen ? (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-40 cursor-default"
                    aria-label="关闭"
                    onClick={() => setCleanupOpen(false)}
                  />
                  <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-xl">
                    <CleanupItem
                      label="保留最近 100 条"
                      onClick={() =>
                        void runCleanup("已保留最近 100 条", () =>
                          pruneHistory(100),
                        )
                      }
                    />
                    <CleanupItem
                      label="保留最近 500 条"
                      onClick={() =>
                        void runCleanup("已保留最近 500 条", () =>
                          pruneHistory(500),
                        )
                      }
                    />
                    <CleanupItem
                      label="删除 30 天前"
                      onClick={() =>
                        void runCleanup("已删除 30 天前记录", () =>
                          pruneHistoryOlderThan(30),
                        )
                      }
                    />
                    <CleanupItem
                      label="删除 90 天前"
                      onClick={() =>
                        void runCleanup("已删除 90 天前记录", () =>
                          pruneHistoryOlderThan(90),
                        )
                      }
                    />
                    <div className="my-1 border-t border-border" />
                    <CleanupItem
                      label="清空全部"
                      danger
                      onClick={() => {
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
          {history.map((entry) => {
            const open = expandedId === entry.id;
            return (
              <div key={entry.id} className="flex flex-col gap-2">
                <HistoryRow
                  entry={entry}
                  open={open}
                  onToggle={() =>
                    setExpandedId((id) => (id === entry.id ? null : entry.id))
                  }
                  onDelete={() => void removeEntry(entry.id)}
                />
                {open ? (
                  <ExpandedViewer
                    entry={entry}
                    onClose={() => setExpandedId(null)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function CleanupItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full px-3.5 py-2 text-left text-[13px] transition hover:bg-default",
        danger ? "text-danger" : "text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
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
  const isVideo = isVideoMediaKind(entry.media_kind, entry.audio_path);
  const isTranslate = (entry.source ?? "fn") === "translate";
  const showDiff = !isTranslate && hasRefineDiff(entry.raw_text, entry.text);
  const showTranslatePair =
    isTranslate && Boolean(entry.raw_text?.trim() && entry.text?.trim());
  return (
    <div
      className={cn(
        "flex w-full items-start gap-2 rounded-2xl border px-4 py-3.5 transition",
        open
          ? "border-accent/35 bg-accent/[0.07]"
          : "border-border bg-surface hover:bg-surface-secondary/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            <span>{entry.duration_seconds.toFixed(1)}s</span>
            <span>
              {isTranslate
                ? "翻译"
                : (entry.source ?? "fn") === "transcribe"
                  ? "转写"
                  : "Fn"}
            </span>
            {isVideo ? <span>视频</span> : null}
            <Chip
              size="sm"
              variant="soft"
              color={entry.refined || isTranslate ? "accent" : "default"}
            >
              <Chip.Label className="inline-flex items-center gap-1">
                {isTranslate ? (
                  <Languages size={10} />
                ) : entry.refined || showDiff ? (
                  <Sparkles size={10} />
                ) : (
                  <CheckCircle2 size={10} />
                )}
                {historyLanguageChip(entry)}
              </Chip.Label>
            </Chip>
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
            <p className="mt-1.5 line-clamp-2 text-[14px] leading-snug text-foreground">
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
      </button>
      <button
        type="button"
        className="mt-0.5 shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-danger/10 hover:text-danger"
        title="删除"
        aria-label="删除"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  );
}

function ExpandedViewer({
  entry,
  onClose: _onClose,
}: {
  entry: HistoryEntry;
  onClose: () => void;
}) {
  const mediaSrc = entry.audio_path ? convertFileSrc(entry.audio_path) : null;
  const mediaKind = isVideoMediaKind(entry.media_kind, entry.audio_path)
    ? "video"
    : "audio";
  const showDiff = hasRefineDiff(entry.raw_text, entry.text);
  const isTranslate = (entry.source ?? "fn") === "translate";

  return (
    <SectionCard className="!p-4">
      
      {isTranslate && showDiff ? (
        <div className="mb-4 rounded-2xl border border-border bg-surface-secondary/40 px-3.5 py-3">
          <SemanticPair before={entry.raw_text} after={entry.text} />
        </div>
      ) : showDiff ? (
        <div className="mb-4 rounded-2xl border border-border bg-surface-secondary/40 px-3.5 py-3">
          <RefineDiff before={entry.raw_text} after={entry.text} />
        </div>
      ) : null}
      {mediaSrc ? (
        <TranscriptViewer
          text={entry.text}
          mediaSrc={mediaSrc}
          mediaKind={mediaKind}
          durationSeconds={entry.duration_seconds}
          segments={entry.segments}
          alignment={entry.alignment}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.75] text-foreground">
          {entry.text || "（空）"}
        </p>
      )}
      <div className="mb-3 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          onPress={() => {
            void navigator.clipboard.writeText(entry.text);
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
