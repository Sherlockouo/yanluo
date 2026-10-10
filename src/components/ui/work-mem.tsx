import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { Check, Copy, Trash2 } from "lucide-react";
import { useTranscriptSeek } from "@/components/ui/transcript-viewer";
import { formatClock } from "@/lib/alignment";
import { HIGHLIGHT_SWATCH, highlightBackground, type HighlightColor } from "@/lib/annotations";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { WorkAnnotation } from "@/types";

type MemTab = "comments" | "highlights";

/**
 * 原文批注 panel — the live view of `mem.md`: 原文 + 评论 and 原文 + 高亮,
 * ordered by playback time. Time chips seek the media on the left.
 */
export function WorkMemPanel({
  workId,
  annotations,
  onEditComment,
  onDelete,
}: {
  workId: string;
  annotations: WorkAnnotation[];
  onEditComment: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<MemTab>("comments");
  const [copied, setCopied] = useState(false);

  const comments = useMemo(
    () => annotations.filter((a) => a.kind === "comment").sort(byTime),
    [annotations],
  );
  const highlights = useMemo(
    () => annotations.filter((a) => a.kind === "highlight").sort(byTime),
    [annotations],
  );
  const list = tab === "comments" ? comments : highlights;

  const copyMd = () => {
    invoke<string>("works_read_artifact", { id: workId, path: "mem.md" })
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((error) => toast.danger(String(error)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{t("mem.title")}</p>
          <p className="font-mono text-[11px] text-muted">mem.md</p>
        </div>
        <Button size="sm" variant="ghost" className="btn-press" onPress={copyMd}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? t("mem.copied") : t("mem.copy")}
        </Button>
      </div>
      <div className="flex shrink-0 gap-1 px-3 pt-3" role="tablist" aria-label={t("mem.title")}>
        {(
          [
            ["comments", t("mem.tabComments"), comments.length],
            ["highlights", t("mem.tabHighlights"), highlights.length],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] transition-colors",
              tab === id
                ? "bg-accent-soft font-medium text-accent-soft-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            {label} · {count}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {list.length === 0 ? (
          <p className="pt-6 text-center text-[12px] leading-relaxed text-muted">
            {tab === "comments" ? t("mem.emptyComments") : t("mem.emptyHighlights")}
          </p>
        ) : (
          list.map((a) => (
            <MemItem
              key={a.id}
              annotation={a}
              onEditComment={onEditComment}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function byTime(a: WorkAnnotation, b: WorkAnnotation) {
  return a.start_time - b.start_time || a.word_start - b.word_start;
}

function MemItem({
  annotation,
  onEditComment,
  onDelete,
}: {
  annotation: WorkAnnotation;
  onEditComment: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  const seek = useTranscriptSeek();
  const isComment = annotation.kind === "comment";
  const swatch = HIGHLIGHT_SWATCH[annotation.color as HighlightColor];
  const [draft, setDraft] = useState(annotation.text);

  return (
    <article className="group">
      <div className="mb-1.5 flex items-center gap-2">
        <button
          type="button"
          disabled={!seek}
          onClick={() => seek?.(annotation.start_time)}
          aria-label={t("common.transcript.jumpToAria", {
            time: formatClock(annotation.start_time),
          })}
          className="font-mono text-[11px] tabular-nums text-muted hover:text-accent-soft-foreground disabled:cursor-default"
        >
          {formatClock(annotation.start_time)}
        </button>
        {!isComment && swatch ? (
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
        ) : null}
        <span className="flex-1" />
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("mem.delete")}
          className="btn-press text-muted opacity-60 hover:text-danger group-hover:opacity-100"
          onPress={() => onDelete(annotation.id)}
        >
          <Trash2 size={13} aria-hidden />
        </Button>
      </div>
      <blockquote
        className="mem-quote rounded-r-md"
        style={
          !isComment
            ? { backgroundColor: highlightBackground(annotation.color), borderLeftColor: swatch }
            : undefined
        }
      >
        {annotation.quote}
      </blockquote>
      {isComment ? (
        <textarea
          value={draft}
          rows={2}
          aria-label={t("mem.commentAria")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const next = draft.trim();
            if (!next) {
              setDraft(annotation.text);
              return;
            }
            if (next !== annotation.text) onEditComment(annotation.id, next);
          }}
          className="mt-2 w-full resize-none rounded-lg border border-transparent bg-surface-secondary/40 p-2 text-[13px] leading-relaxed outline-none focus:border-accent"
        />
      ) : null}
    </article>
  );
}
