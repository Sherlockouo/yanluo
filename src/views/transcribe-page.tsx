import { useMemo, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Chip, toast } from "@heroui/react";
import {
  CheckCircle2,
  Clipboard,
  FileAudio,
  FileVideo,
  Sparkles,
  Upload,
} from "lucide-react";
import type { HistoryEntry } from "@/types";
import {
  providerLabel,
  TRANSCRIBE_FILE_FILTERS,
  TRANSCRIBE_FORMAT_HINT,
} from "@/lib/constants";
import { isVideoMediaKind } from "@/lib/alignment";
import {
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { TranscriptViewer } from "@/components/ui/transcript-viewer";
import { useApp } from "@/app-context";

export function TranscribePage() {
  const {
    config,
    history,
    modelLoaded,
    state,
    markSession,
    loadHistory,
  } = useApp();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sessionEntries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "fn") === "transcribe")
        .slice(0, 30),
    [history],
  );

  const processing = state === "processing" || state === "refining" || busy;
  const canUpload =
    !processing &&
    !(config.asr_provider === "qwen" && !modelLoaded);

  const activeEntry = useMemo(() => {
    if (activeId) {
      return sessionEntries.find((e) => e.id === activeId) ?? sessionEntries[0];
    }
    return sessionEntries[0] ?? null;
  }, [activeId, sessionEntries]);

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      title: "选择音频或视频文件",
      filters: TRANSCRIBE_FILE_FILTERS.map((f) => ({
        name: f.name,
        extensions: [...f.extensions],
      })),
    });
    if (typeof selected !== "string") return;
    setSelectedPath(selected);
    setActiveId(null);
  };

  const selectedIsVideo = useMemo(() => {
    if (!selectedPath) return false;
    const ext = selectedPath.split(".").pop()?.toLowerCase() ?? "";
    return ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "3gp", "3g2"].includes(
      ext,
    );
  }, [selectedPath]);

  const runTranscribe = async () => {
    if (!selectedPath || !canUpload) return;
    setBusy(true);
    markSession("transcribe");
    try {
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", { path: selectedPath });
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      toast.danger(`转写失败: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const languageLabel =
    config.language === "auto" ? "自动检测" : config.language;

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        title="转写"
        subtitle="上传音频或视频，识别后跟随回放。"
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
        <div className="flex flex-col gap-5">
          <SectionCard className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  {processing ? "转写中…" : "选择媒体"}
                </div>
                <div className="text-xs text-muted">
                  {providerLabel(config.asr_provider)} · {languageLabel}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  isDisabled={processing}
                  onPress={() => void pickFile()}
                >
                  <Upload size={16} aria-hidden />
                  选择文件
                </Button>
                <Button
                  variant="primary"
                  isDisabled={!selectedPath || !canUpload}
                  isPending={processing}
                  onPress={() => void runTranscribe()}
                >
                  {selectedIsVideo ? (
                    <FileVideo size={16} aria-hidden />
                  ) : (
                    <FileAudio size={16} aria-hidden />
                  )}
                  开始转写
                </Button>
              </div>
            </div>

            {config.asr_provider === "qwen" && !modelLoaded ? (
              <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                Qwen 模型加载中或未加载。若已配置模型目录，启动时会自动加载。
              </div>
            ) : null}

            <div className="flex min-h-[88px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-surface-secondary/40 px-4 py-5 text-center">
              {selectedPath ? (
                <>
                  {selectedIsVideo ? (
                    <FileVideo className="block text-foreground" size={22} aria-hidden />
                  ) : (
                    <FileAudio className="block text-foreground" size={22} aria-hidden />
                  )}
                  <div className="max-w-full truncate text-sm font-medium text-foreground">
                    {selectedPath.split("/").pop()}
                  </div>
                  {selectedIsVideo ? (
                    <p className="text-[11px] text-muted">将提取音轨进行转写</p>
                  ) : null}
                </>
              ) : (
                <>
                  <Upload className="block text-muted opacity-60" size={22} aria-hidden />
                  <p className="text-xs text-muted">{TRANSCRIBE_FORMAT_HINT}</p>
                </>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="转写结果"
            description="播放时跟随当前一句；长文可切换专注 / 全文。"
          >
            {processing && !activeEntry ? (
              <div className="grid min-h-[160px] place-items-center text-sm text-muted">
                正在识别…
              </div>
            ) : activeEntry ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>{new Date(activeEntry.created_at).toLocaleString()}</span>
                    <span>{activeEntry.duration_seconds.toFixed(1)}s</span>
                    <Chip
                      size="sm"
                      variant="soft"
                      color={activeEntry.refined ? "accent" : "default"}
                    >
                      <Chip.Label className="inline-flex items-center gap-1">
                        {activeEntry.refined ? (
                          <Sparkles size={11} />
                        ) : (
                          <CheckCircle2 size={11} />
                        )}
                        {activeEntry.language || languageLabel}
                        {activeEntry.refined ? " · refined" : ""}
                      </Chip.Label>
                    </Chip>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      void navigator.clipboard.writeText(activeEntry.text);
                      toast.success("已复制");
                    }}
                  >
                    <Clipboard size={14} aria-hidden />
                    复制
                  </Button>
                </div>
                <TranscriptViewer
                  text={activeEntry.text}
                  mediaSrc={
                    activeEntry.audio_path
                      ? convertFileSrc(activeEntry.audio_path)
                      : null
                  }
                  mediaKind={
                    isVideoMediaKind(
                      activeEntry.media_kind,
                      activeEntry.audio_path,
                    )
                      ? "video"
                      : "audio"
                  }
                  durationSeconds={activeEntry.duration_seconds}
                  segments={activeEntry.segments}
                  alignment={activeEntry.alignment}
                  emptyLabel="（空结果）"
                />
                {activeEntry.raw_text &&
                activeEntry.raw_text !== activeEntry.text ? (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer select-none">
                      查看原始识别（纠错前）
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed">
                      {activeEntry.raw_text}
                    </p>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="grid min-h-[160px] place-items-center text-sm text-muted">
                选择音频或视频并开始转写后，结果会显示在这里。
              </div>
            )}
          </SectionCard>
        </div>

        <SectionCard
          title="转写记录"
          description="点击条目可回放并高亮。"
          className="h-fit max-h-[calc(100vh-10rem)] overflow-y-auto"
        >
          <div className="flex flex-col gap-2">
            {sessionEntries.length === 0 ? (
              <div className="grid min-h-[100px] place-items-center text-sm text-muted">
                还没有转写记录
              </div>
            ) : (
              sessionEntries.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  active={activeEntry?.id === entry.id}
                  onSelect={() => setActiveId(entry.id)}
                />
              ))
            )}
          </div>
        </SectionCard>
      </div>
    </PageShell>
  );
}

function HistoryRow({
  entry,
  active,
  onSelect,
}: {
  entry: HistoryEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-border bg-surface-secondary/30 hover:bg-surface-secondary/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{new Date(entry.created_at).toLocaleString()}</span>
        <span>{entry.duration_seconds.toFixed(1)}s</span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground">
        {entry.text || "（空）"}
      </p>
    </button>
  );
}
