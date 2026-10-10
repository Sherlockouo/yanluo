import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { MarkdownBody } from "@/components/shared/markdown-body";
import { linkifyTimestamps } from "@/lib/timestamps";
import { useTranscriptSeek } from "@/components/ui/transcript-viewer";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { WorkResearchEntry } from "@/types";

/**
 * Work research pane: ask a question, the configured agent answers from the
 * transcript + notes and saves the report under the work's research/ folder.
 */
export function WorkResearchPanel({ workId }: { workId: string }) {
  const t = useT();
  const { works, loadWorks } = useApp();
  const work = works.find((w) => w.id === workId);
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const entries = work?.research ?? [];

  const start = () => {
    const q = question.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    invoke("works_start_research", { workId, question: q })
      .then(() => {
        setQuestion("");
        void loadWorks();
      })
      .catch((error) => toast.danger(String(error)))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/60 px-4 py-3">
        <textarea
          value={question}
          rows={2}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
          }}
          placeholder={t("works.research.placeholder")}
          aria-label={t("works.research.placeholder")}
          className="w-full resize-none rounded-lg border border-border bg-surface-secondary/40 p-2.5 text-[13px] leading-relaxed outline-none focus:border-accent"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">{t("works.research.hint")}</p>
          <Button
            size="sm"
            variant="primary"
            isDisabled={!question.trim() || submitting}
            onPress={start}
          >
            {t("works.research.start")}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {entries.length === 0 ? (
          <p className="pt-4 text-center text-[12px] text-muted">
            {t("works.research.empty")}
          </p>
        ) : (
          entries.map((entry) => (
            <ResearchItem key={entry.id} workId={workId} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

function ResearchItem({
  workId,
  entry,
}: {
  workId: string;
  entry: WorkResearchEntry;
}) {
  const t = useT();
  const seek = useTranscriptSeek();
  const [open, setOpen] = useState(true);
  const [content, setContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const done = entry.status === "done";

  useEffect(() => {
    setContent(null);
    if (!done) return;
    let cancelled = false;
    void invoke<string>("works_read_artifact", { id: workId, path: entry.path })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((error) => {
        if (!cancelled) toast.danger(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [workId, entry.path, done]);

  const copy = () => {
    void navigator.clipboard.writeText(content ?? "").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="rounded-xl border border-border/70 bg-surface">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 shrink-0 text-muted"
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug">{entry.question}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted">
            {new Date(entry.created_at).toLocaleString()}
          </p>
        </div>
        <StatusBadge status={entry.status} />
        {done && content ? (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t("works.copy")}
            className={cn("btn-press shrink-0", copied && "text-success")}
            onPress={copy}
          >
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-border/60 px-4 pb-3 pt-2">
          {entry.status === "running" ? (
            <p className="flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              {t("works.research.running")}
            </p>
          ) : entry.status === "failed" ? (
            <p className="text-[12px] text-danger">{entry.error || t("works.research.failed")}</p>
          ) : entry.status === "cancelled" ? (
            <p className="text-[12px] text-muted">{t("works.research.cancelled")}</p>
          ) : content == null ? (
            <p className="text-[12px] text-muted">{t("works.research.noReport")}</p>
          ) : (
            <MarkdownBody text={linkifyTimestamps(content)} onSeek={seek} />
          )}
        </div>
      ) : null}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const label =
    status === "running"
      ? t("works.research.running")
      : status === "failed"
        ? t("works.research.failed")
        : status === "cancelled"
          ? t("works.research.cancelled")
          : null;
  if (!label) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
        status === "failed" ? "bg-danger/10 text-danger" : "bg-surface-secondary text-muted",
      )}
    >
      {label}
    </span>
  );
}
