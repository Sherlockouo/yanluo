import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import { ArrowLeft, FileAudio, FolderOpen } from "lucide-react";
import { useApp } from "@/app-context";
import {
  TranscriptViewer,
  type TranscriptSelection,
} from "@/components/ui/transcript-viewer";
import { AnnotationToolbar } from "@/components/ui/annotation-toolbar";
import { WorkArtifactsPanel } from "@/components/ui/work-artifacts";
import { WorkMemPanel } from "@/components/ui/work-mem";
import { WorkResearchPanel } from "@/components/ui/work-research";
import { isVideoMediaKind } from "@/lib/alignment";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type {
  WorkAnnotation,
  WorkAnnotationDraft,
  WorkDetail,
} from "@/types";

type WorkPane = "transcript" | "artifacts" | "research";

const WORK_PANES: { id: WorkPane; labelKey: string }[] = [
  { id: "transcript", labelKey: "works.tabTranscript" },
  { id: "artifacts", labelKey: "works.tabArtifacts" },
  { id: "research", labelKey: "works.tabResearch" },
];

/**
 * Full-page work reader (replaces the old modal): media on the left, the
 * transcript or AI panes in the middle, and the 原文批注 `mem.md` view on the
 * right. Selecting words opens a toolbar to highlight or comment.
 */
export function WorkPage() {
  const t = useT();
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const { works, renameWork, openWorkInFinder } = useApp();
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pane, setPane] = useState<WorkPane>("transcript");
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    setSelection(null);
    setPane("transcript");
    invoke<WorkDetail>("works_detail", { id })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const title = works.find((w) => w.id === id)?.title ?? detail?.work.title ?? "";
  const [titleDraft, setTitleDraft] = useState(title);
  useEffect(() => setTitleDraft(title), [title]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!next || next === title) {
      setTitleDraft(title);
      return;
    }
    renameWork(id, next).catch((error) => {
      setTitleDraft(title);
      toast.danger(String(error));
    });
  };

  const dropSelection = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const addAnnotation = useCallback(
    (draft: WorkAnnotationDraft) => {
      invoke<WorkAnnotation>("works_add_annotation", { id, draft })
        .then((created) => {
          setDetail((d) =>
            d ? { ...d, annotations: [...d.annotations, created] } : d,
          );
          dropSelection();
        })
        .catch((error) => toast.danger(String(error)));
    },
    [id, dropSelection],
  );

  const editComment = useCallback(
    (annotationId: string, text: string) => {
      invoke("works_update_annotation", { id, annotationId, text })
        .then(() =>
          setDetail((d) =>
            d
              ? {
                  ...d,
                  annotations: d.annotations.map((a) =>
                    a.id === annotationId ? { ...a, text } : a,
                  ),
                }
              : d,
          ),
        )
        .catch((error) => toast.danger(String(error)));
    },
    [id],
  );

  const removeAnnotation = useCallback(
    (annotationId: string) => {
      invoke("works_delete_annotation", { id, annotationId })
        .then(() =>
          setDetail((d) =>
            d
              ? {
                  ...d,
                  annotations: d.annotations.filter((a) => a.id !== annotationId),
                }
              : d,
          ),
        )
        .catch((error) => toast.danger(String(error)));
    },
    [id],
  );

  const backButton = (
    <Button size="sm" variant="ghost" onPress={() => navigate("/works")}>
      <ArrowLeft size={14} aria-hidden />
      {t("works.back")}
    </Button>
  );

  if (loadError) {
    return (
      <div className="work-page grid place-items-center gap-3 text-center">
        <p className="text-[13px] text-danger">{loadError}</p>
        {backButton}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="work-page grid place-items-center text-[12px] text-muted">
        {t("works.loading")}
      </div>
    );
  }

  const { work, transcript, media_path: mediaPath, annotations } = detail;
  const mediaSrc = mediaPath ? convertFileSrc(mediaPath) : null;
  const isVideo = isVideoMediaKind(work.media_kind, work.audio_file ?? null);
  const hasTiming = transcript.segments.length > 0 || Boolean(transcript.alignment);

  return (
    <div className="work-page">
      <header className="flex shrink-0 items-center gap-3 pb-3">
        {backButton}
        <div className="min-w-0 flex-1">
          <input
            value={titleDraft}
            aria-label={t("transcribe.work.titleAria")}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setTitleDraft(title);
            }}
            className="w-full min-w-0 truncate rounded-sm border-b border-transparent bg-transparent text-[18px] font-medium outline-none transition-colors focus:border-accent"
          />
          <p className="font-mono text-[11px] text-muted">
            {new Date(work.created_at).toLocaleString()} · {work.duration_seconds.toFixed(1)}s ·{" "}
            {work.language} · {work.asr_provider}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => void openWorkInFinder(id).catch(() => {})}
        >
          <FolderOpen size={14} aria-hidden />
          {t("transcribe.work.openFolder")}
        </Button>
      </header>

      <TranscriptViewer.Root
        key={work.id}
        text={transcript.text}
        mediaSrc={mediaSrc}
        mediaKind={isVideo ? "video" : "audio"}
        durationSeconds={work.duration_seconds}
        segments={transcript.segments}
        alignment={transcript.alignment}
        emptyLabel={t("transcribe.emptyResult")}
        annotations={annotations}
        onSelection={setSelection}
      >
        <div className="work-page-body">
          <section className="work-page-col">
            {mediaSrc ? (
              <>
                {isVideo ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                    <TranscriptViewer.Media className="max-h-full" />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
                    <TranscriptViewer.Media />
                    <div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
                      <FileAudio size={26} aria-hidden />
                    </div>
                    <div className="w-full min-w-0 text-center">
                      <div className="truncate text-[13px] font-medium">{work.audio_file}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-muted">
                        {work.duration_seconds.toFixed(1)}s · {t("transcribe.audio")}
                      </div>
                    </div>
                  </div>
                )}
                <div className="shrink-0 border-t border-border/60 p-3">
                  <TranscriptViewer.Controls />
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-muted">
                <FileAudio size={26} aria-hidden />
                <p className="text-[12px]">{t("transcribe.noMedia")}</p>
              </div>
            )}
          </section>

          <section className="work-page-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
              <div className="flex items-center gap-1" role="tablist">
                {WORK_PANES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={pane === p.id}
                    onClick={() => setPane(p.id)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12px] transition-colors",
                      pane === p.id
                        ? "bg-accent-soft font-medium text-accent-soft-foreground"
                        : "text-muted hover:text-foreground",
                    )}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
              {pane === "transcript" && hasTiming ? (
                <p className="truncate text-[11px] text-muted">{t("works.reader.hint")}</p>
              ) : null}
            </div>
            {pane === "transcript" ? (
              <>
                {!hasTiming ? (
                  <p className="shrink-0 border-b border-border/60 px-4 py-2 text-[11px] text-muted">
                    {t("works.reader.noTiming")}
                  </p>
                ) : null}
                <TranscriptViewer.ModeToggle className="shrink-0 border-b border-border/60 px-5 py-2" />
                <TranscriptViewer.Content
                  fill
                  className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                />
              </>
            ) : pane === "artifacts" ? (
              <WorkArtifactsPanel workId={id} />
            ) : (
              <WorkResearchPanel workId={id} />
            )}
          </section>

          <aside className="work-page-col">
            <WorkMemPanel
              workId={id}
              annotations={annotations}
              onEditComment={editComment}
              onDelete={removeAnnotation}
            />
          </aside>
        </div>

        {selection && hasTiming ? (
          <AnnotationToolbar
            key={`${selection.wordStart}-${selection.wordEnd}`}
            selection={selection}
            onHighlight={(color) =>
              addAnnotation({
                kind: "highlight",
                color,
                quote: selection.quote,
                word_start: selection.wordStart,
                word_end: selection.wordEnd,
                start_time: selection.startTime,
                text: "",
              })
            }
            onComment={(text) =>
              addAnnotation({
                kind: "comment",
                color: "",
                quote: selection.quote,
                word_start: selection.wordStart,
                word_end: selection.wordEnd,
                start_time: selection.startTime,
                text,
              })
            }
            onClose={dropSelection}
          />
        ) : null}
      </TranscriptViewer.Root>
    </div>
  );
}
