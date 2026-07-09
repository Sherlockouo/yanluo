import { useMemo, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Chip } from "@heroui/react";
import {
  CheckCircle2,
  Clipboard,
  FileAudio,
  Sparkles,
  Upload,
} from "lucide-react";
import type { HistoryEntry } from "@/types";
import { providerLabel } from "@/lib/constants";
import {
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";
import { toast } from "@heroui/react";

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
  const [lastText, setLastText] = useState("");

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

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      title: "选择音频文件",
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "m4a", "caf", "aac", "flac", "aiff", "aif"],
        },
      ],
    });
    if (typeof selected !== "string") return;
    setSelectedPath(selected);
    setLastText("");
  };

  const runTranscribe = async () => {
    if (!selectedPath || !canUpload) return;
    setBusy(true);
    markSession("transcribe");
    try {
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", { path: selectedPath });
      // Result arrives via transcription-result event in AppProvider.
      // Refresh after a short delay as a fallback.
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      toast.danger(`转写失败: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  // Keep last successful text from newest transcribe entry.
  const newest = sessionEntries[0];
  const displayText = lastText || newest?.text || "";

  return (
    <PageShell>
      <PageHeader
        title="转写"
        subtitle="上传本地音频文件进行转写。结果与音频会保存到记录中，不会自动粘贴。"
      />

      <SectionCard className="max-w-3xl flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {processing ? "转写中…" : "选择音频"}
            </div>
            <div className="text-xs text-muted">
              {providerLabel(config.asr_provider)} · {config.language}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              isDisabled={processing}
              onPress={() => void pickFile()}
            >
              <Upload size={15} aria-hidden />
              选择文件
            </Button>
            <Button
              variant="primary"
              isDisabled={!selectedPath || !canUpload}
              isPending={processing}
              onPress={() => void runTranscribe()}
            >
              <FileAudio size={15} aria-hidden />
              开始转写
            </Button>
          </div>
        </div>

        {config.asr_provider === "qwen" && !modelLoaded ? (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            Qwen 模型尚未加载，请先到 ASR 页加载模型，或切换到 Apple / ElevenLabs。
          </div>
        ) : null}

        <div className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface-secondary/40 px-4 py-8 text-center">
          {selectedPath ? (
            <>
              <FileAudio className="block text-foreground" size={28} aria-hidden />
              <div className="max-w-full truncate text-sm font-medium text-foreground">
                {selectedPath.split("/").pop()}
              </div>
              <div className="max-w-full truncate text-xs text-muted">
                {selectedPath}
              </div>
            </>
          ) : (
            <>
              <Upload className="block opacity-60 text-muted" size={28} aria-hidden />
              <p className="text-sm text-muted">
                支持 WAV / MP3 / M4A / CAF / FLAC 等常见格式
              </p>
            </>
          )}
        </div>

        <div className="min-h-[120px] rounded-2xl border border-border bg-surface-secondary/40 p-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            转写结果
          </div>
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
            {displayText ||
              (processing
                ? "正在识别…"
                : "选择音频并点击「开始转写」。")}
          </p>
          {displayText ? (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  setLastText(displayText);
                  void navigator.clipboard.writeText(displayText);
                  toast.success("已复制");
                }}
              >
                <Clipboard size={13} aria-hidden />
                复制结果
              </Button>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        className="max-w-3xl"
        title="转写记录"
        description="仅显示上传转写产生的记录（含音频）。Fn 快捷键记录在「历史」页。"
      >
        <div className="grid gap-3">
          {sessionEntries.length === 0 ? (
            <div className="grid min-h-[120px] place-items-center text-sm text-[color:var(--muted)]">
              还没有转写记录
            </div>
          ) : (
            sessionEntries.map((entry) => (
              <TranscribeEntryCard key={entry.id} entry={entry} />
            ))
          )}
        </div>
      </SectionCard>
    </PageShell>
  );
}

function TranscribeEntryCard({ entry }: { entry: HistoryEntry }) {
  const audioSrc = entry.audio_path
    ? convertFileSrc(entry.audio_path)
    : null;

  return (
    <div className="rounded-2xl border border-border bg-surface-secondary/30 p-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            <span>{entry.duration_seconds.toFixed(1)}s</span>
            {entry.audio_path ? <span>已保存音频</span> : null}
          </div>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
            {entry.text || "（空）"}
          </p>
          <Chip
            size="sm"
            variant="soft"
            color={entry.refined ? "accent" : "default"}
          >
            <Chip.Label className="inline-flex items-center gap-1.5">
              {entry.refined ? (
                <Sparkles size={12} aria-hidden />
              ) : (
                <CheckCircle2 size={12} aria-hidden />
              )}
              {entry.language || "zh-CN"}
              {entry.refined ? " · refined" : ""}
            </Chip.Label>
          </Chip>
          {audioSrc ? (
            <audio className="mt-2 w-full" controls preload="none" src={audioSrc} />
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onPress={() => void navigator.clipboard.writeText(entry.text)}
        >
          <Clipboard size={13} aria-hidden />
          复制
        </Button>
      </div>
    </div>
  );
}
