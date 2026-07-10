import { useState } from "react";
import { Button, Chip, toast } from "@heroui/react";
import {
  CheckCircle2,
  ChevronDown,
  Clipboard,
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
import { isVideoMediaKind } from "@/lib/alignment";
import { cn } from "@/lib/cn";
import type { HistoryEntry } from "@/types";
import { useApp } from "@/app-context";

export function HistoryPage() {
  const { history, clearHistory, pruneHistory, pruneHistoryOlderThan } =
    useApp();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const runCleanup = async (label: string, action: () => Promise<void>) => {
    await action();
    setExpandedId(null);
    setCleanupOpen(false);
    toast.success(label);
  };

  return (
    <PageShell>
      <PageHeader
        title="历史"
        subtitle={
          history.length
            ? `${history.length} 条本地记录`
            : "本地保存，随时清理"
        }
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
          <EmptyState
            title="还没有记录"
            description="Fn 录音或转写页上传后，会出现在这里。"
          />
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
}: {
  entry: HistoryEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const isVideo = isVideoMediaKind(entry.media_kind, entry.audio_path);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition",
        open
          ? "border-accent/35 bg-accent/[0.07]"
          : "border-border bg-surface hover:bg-surface-secondary/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
          <span>{new Date(entry.created_at).toLocaleString()}</span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
          <span>
            {(entry.source ?? "fn") === "transcribe" ? "转写" : "Fn"}
          </span>
          {isVideo ? <span>视频</span> : null}
          <Chip
            size="sm"
            variant="soft"
            color={entry.refined ? "accent" : "default"}
          >
            <Chip.Label className="inline-flex items-center gap-1">
              {entry.refined ? (
                <Sparkles size={10} />
              ) : (
                <CheckCircle2 size={10} />
              )}
              {entry.language || "auto"}
            </Chip.Label>
          </Chip>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[14px] leading-snug text-foreground">
          {entry.text || "（空）"}
        </p>
      </div>
      <ChevronDown
        size={16}
        className={cn(
          "mt-1 shrink-0 text-muted transition-transform duration-200",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

function ExpandedViewer({
  entry,
  onClose,
}: {
  entry: HistoryEntry;
  onClose: () => void;
}) {
  const mediaSrc = entry.audio_path ? convertFileSrc(entry.audio_path) : null;
  const mediaKind = isVideoMediaKind(entry.media_kind, entry.audio_path)
    ? "video"
    : "audio";

  return (
    <SectionCard className="!p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[12px] text-muted">详情</p>
        <div className="flex gap-2">
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
          <Button size="sm" variant="secondary" onPress={onClose}>
            收起
          </Button>
        </div>
      </div>
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
    </SectionCard>
  );
}
