import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@heroui/react";
import { FileAudio, FileVideo, FolderOpen } from "lucide-react";
import { useApp } from "@/app-context";
import { PageHeader, PageShell } from "@/components/shared/page-shell";
import { useT } from "@/lib/i18n";
import { isVideoMediaKind } from "@/lib/alignment";
import type { Work } from "@/types";

/** 作品库 — every saved transcription folder, newest first. */
export function WorksPage() {
  const t = useT();
  const navigate = useNavigate();
  const { works, openWorkInFinder } = useApp();

  const sorted = useMemo(
    () => [...works].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [works],
  );

  return (
    <PageShell className="max-w-5xl">
      <PageHeader title={t("works.list.title")} />
      {sorted.length === 0 ? (
        <div className="dropzone dropzone-empty">
          <span className="dropzone-t">{t("works.list.empty")}</span>
          <Button variant="primary" onPress={() => navigate("/draft?mode=file")}>
            {t("works.list.goTranscribe")}
          </Button>
        </div>
      ) : (
        <div className="rlist">
          {sorted.map((work, i) => (
            <WorkRow
              key={work.id}
              work={work}
              index={sorted.length - i}
              onOpen={() => navigate(`/works/${work.id}`)}
              onReveal={() => void openWorkInFinder(work.id).catch(() => {})}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function WorkRow({
  work,
  index,
  onOpen,
  onReveal,
}: {
  work: Work;
  index: number;
  onOpen: () => void;
  onReveal: () => void;
}) {
  const t = useT();
  const isVideo = isVideoMediaKind(work.media_kind, work.audio_file ?? null);
  const artifactsDone = Object.values(work.artifacts ?? {}).filter(
    (a) => a.status === "done",
  ).length;
  const researchCount = work.research?.length ?? 0;

  return (
    <div className="ritem group">
      <span className="ritem-n">{String(index).padStart(2, "0")}</span>
      <button type="button" onClick={onOpen} className="ritem-body text-left">
        <div className="rmeta">
          <span>{new Date(work.created_at).toLocaleString()}</span>
          <span className="tag inline-flex items-center gap-1">
            {isVideo ? <FileVideo size={11} aria-hidden /> : <FileAudio size={11} aria-hidden />}
            {isVideo ? t("transcribe.video") : t("transcribe.audio")}
          </span>
          <span>{work.duration_seconds.toFixed(1)}s</span>
          <span>{work.language}</span>
        </div>
        <p className="rtext">{work.title}</p>
        <div className="mt-1 flex gap-3 font-mono text-[11px] text-muted">
          <span>
            {t("works.list.artifacts", { n: artifactsDone })}
          </span>
          <span>{t("works.list.research", { n: researchCount })}</span>
        </div>
      </button>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t("transcribe.work.openFolder")}
        className="mt-0.5 shrink-0 btn-press text-muted"
        onPress={onReveal}
      >
        <FolderOpen size={14} aria-hidden />
      </Button>
    </div>
  );
}
