import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { Check, Copy, Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { MarkdownBody } from "@/components/shared/markdown-body";
import { linkifyTimestamps } from "@/lib/timestamps";
import { useTranscriptSeek } from "@/components/ui/transcript-viewer";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";
import {
  WORK_ARTIFACT_KINDS,
  type WorkArtifactKind,
} from "@/lib/constants";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { ArtifactState } from "@/types";

/**
 * Works pipeline (作品 AI 产物) panel: one tab per artifact kind.
 * State comes from work.json via app context (works-updated /
 * work-artifact-progress both trigger a reload there).
 */
export function WorkArtifactsPanel({ workId }: { workId: string }) {
  const t = useT();
  const { works } = useApp();
  const work = works.find((w) => w.id === workId);
  const [kind, setKind] = useState<WorkArtifactKind>("summary");

  if (!work) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-[12px] text-muted">
        {t("works.loading")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-4 py-2"
        role="tablist"
        aria-label={t("works.tabsAria")}
      >
        {WORK_ARTIFACT_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            onClick={() => setKind(k.id)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] transition-colors",
              kind === k.id
                ? "bg-accent-soft font-medium text-accent-soft-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            {t(k.labelKey)}
          </button>
        ))}
      </div>
      <ArtifactBody
        key={`${work.id}:${kind}`}
        workId={work.id}
        kind={kind}
        artifact={work.artifacts?.[kind]}
      />
    </div>
  );
}

function ArtifactBody({
  workId,
  kind,
  artifact,
}: {
  workId: string;
  kind: WorkArtifactKind;
  artifact: ArtifactState | undefined;
}) {
  const t = useT();
  const { loadWorks } = useApp();
  const seek = useTranscriptSeek();
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const status = artifact?.status ?? "pending";
  const path = artifact?.path || `notes/${kind}.md`;

  useEffect(() => {
    setContent(null);
    if (status !== "done") return;
    let cancelled = false;
    void invoke<string>("works_read_artifact", { id: workId, path })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((error) => {
        if (!cancelled) toast.danger(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [workId, path, status]);

  const generate = useCallback(() => {
    void invoke("works_generate_artifact", { workId, kind }).catch((error) => {
      toast.danger(String(error));
    });
  }, [workId, kind]);

  const cancel = useCallback(() => {
    void invoke("works_cancel_artifact", { workId, kind }).catch(() => {});
  }, [workId, kind]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(content ?? "").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const save = useCallback(() => {
    void invoke("works_write_artifact", { id: workId, path, content: draft })
      .then(() => {
        setContent(draft);
        setEditing(false);
        void loadWorks();
        toast.success(t("works.saved"));
      })
      .catch((error) => toast.danger(String(error)));
  }, [workId, path, draft, loadWorks, t]);

  if (status === "running") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <Loader2 size={20} className="animate-spin text-muted" aria-hidden />
        <p className="text-[12px] text-muted">{t("works.generating")}</p>
        <Button size="sm" variant="secondary" onPress={cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p className="text-[13px] font-medium text-danger">{t("works.failed")}</p>
        {artifact?.error ? (
          <p className="max-w-md text-center text-[12px] text-muted">
            {artifact.error}
          </p>
        ) : null}
        <Button size="sm" variant="primary" onPress={generate}>
          <RefreshCw size={14} aria-hidden />
          {t("works.retry")}
        </Button>
      </div>
    );
  }

  if (status !== "done") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p className="max-w-sm text-center text-[12px] text-muted">
          {t("works.empty", { kind: t(`works.kind.${camel(kind)}`) })}
        </p>
        <Button size="sm" variant="primary" onPress={generate}>
          {t("works.generate")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1.5 px-4 py-2">
        <Button
          isIconOnly={!copied}
          size="sm"
          variant="ghost"
          aria-label={t("works.copy")}
          className={cn("btn-press", copied && "text-success")}
          onPress={copy}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={editing ? t("common.cancel") : t("works.edit")}
          className="btn-press"
          onPress={() => {
            if (editing) {
              setEditing(false);
            } else {
              setDraft(content ?? "");
              setEditing(true);
            }
          }}
        >
          {editing ? <X size={14} aria-hidden /> : <Pencil size={14} aria-hidden />}
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("works.regenerate")}
          className="btn-press"
          onPress={generate}
        >
          <RefreshCw size={14} aria-hidden />
        </Button>
      </div>
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t("works.editAria")}
            className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-surface-secondary/40 p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onPress={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" variant="primary" onPress={save}>
              {t("works.save")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {content == null ? (
            <p className="pt-4 text-center text-[12px] text-muted">
              {t("works.loading")}
            </p>
          ) : (
            <MarkdownBody text={linkifyTimestamps(content)} onSeek={seek} />
          )}
        </div>
      )}
    </div>
  );
}

/** snake_case kind → the camelCase i18n key suffix. */
function camel(kind: string): string {
  return kind.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
