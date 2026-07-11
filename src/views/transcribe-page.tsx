import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Chip, Modal, toast } from "@heroui/react";
import {
  Clipboard,
  FileAudio,
  FileVideo,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { HistoryEntry, TranscriptionResult } from "@/types";
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
import { cn } from "@/lib/cn";

const VIDEO_EXTS = new Set([
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "mpeg",
  "mpg",
  "3gp",
  "3g2",
]);

const MEDIA_EXTS = new Set([
  ...VIDEO_EXTS,
  "wav",
  "mp3",
  "m4a",
  "m4b",
  "m4r",
  "aac",
  "flac",
  "aiff",
  "aif",
  "aifc",
  "caf",
  "ogg",
  "oga",
  "opus",
  "wma",
  "amr",
  "ac3",
  "eac3",
  "au",
  "snd",
]);

const STORAGE_KEY = "asr-transcribe-view";

type View = "upload" | "result";

type StoredView = {
  view: View;
  activeId: string | null;
  /** Survives route remounts while a file job is in flight. */
  processingName: string | null;
};

function isMediaPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_EXTS.has(ext);
}

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

function isVideoPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.has(ext);
}

function readStored(): StoredView | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredView;
    if (parsed.view !== "upload" && parsed.view !== "result") return null;
    return {
      view: parsed.view,
      activeId: parsed.activeId ?? null,
      processingName: parsed.processingName ?? null,
    };
  } catch {
    return null;
  }
}

function writeStored(next: StoredView) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function TranscribePage() {
  const {
    config,
    history,
    modelLoaded,
    markSession,
    loadHistory,
    deleteHistory,
  } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const stored = useMemo(() => readStored(), []);

  const viewParam = searchParams.get("view");
  const idParam = searchParams.get("id");

  // URL is source of truth; sessionStorage seeds first paint / restores after nav.
  const view: View =
    viewParam === "result" || viewParam === "upload"
      ? viewParam
      : (stored?.view ?? "upload");
  const activeId = idParam ?? stored?.activeId ?? null;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [processingName, setProcessingName] = useState<string | null>(
    () => stored?.processingName ?? null,
  );
  const [dragOver, setDragOver] = useState(false);
  const historyLenRef = useRef(0);
  const bootedRef = useRef(false);

  const processing = processingName != null;
  const screen: "upload" | "processing" | "result" = processing
    ? "processing"
    : view;

  const sessionEntries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "fn") === "transcribe")
        .slice(0, 30),
    [history],
  );

  const modelBlocked = config.asr_provider === "qwen" && !modelLoaded;
  const canStart = Boolean(selectedPath) && !modelBlocked && !processing;

  const activeEntry = useMemo(() => {
    if (!sessionEntries.length) return null;
    if (activeId) {
      return sessionEntries.find((e) => e.id === activeId) ?? sessionEntries[0];
    }
    return sessionEntries[0];
  }, [activeId, sessionEntries]);

  const go = useCallback(
    (
      next: View,
      opts?: {
        id?: string | null;
        processingName?: string | null;
        clearSelection?: boolean;
      },
    ) => {
      const nextId =
        next === "result"
          ? (opts?.id !== undefined ? opts.id : activeId)
          : null;
      const nextProcessing =
        opts?.processingName !== undefined
          ? opts.processingName
          : processingName;

      writeStored({
        view: next,
        activeId: nextId,
        processingName: nextProcessing,
      });

      const params = new URLSearchParams();
      params.set("view", next);
      if (next === "result" && nextId) params.set("id", nextId);
      setSearchParams(params, { replace: true });

      if (opts?.processingName !== undefined) {
        setProcessingName(opts.processingName);
      }
      if (opts?.clearSelection) setSelectedPath(null);
    },
    [activeId, processingName, setSearchParams],
  );

  // Hydrate URL once from storage so leaving the page still remembers view.
  // Default is upload — never auto-open result just because history exists.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    historyLenRef.current = sessionEntries.length;

    if (viewParam === "upload" || viewParam === "result") {
      writeStored({
        view: viewParam,
        activeId: idParam,
        processingName: stored?.processingName ?? null,
      });
      if (stored?.processingName) {
        setProcessingName(stored.processingName);
      }
      return;
    }

    if (stored?.processingName) {
      go("upload", { processingName: stored.processingName });
      return;
    }
    if (stored) {
      go(stored.view, { id: stored.activeId });
      return;
    }
    go("upload");
    // intentionally once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Job finished → newest result page.
  useEffect(() => {
    const prev = historyLenRef.current;
    historyLenRef.current = sessionEntries.length;
    if (!processingName) return;
    if (sessionEntries.length <= prev) return;

    const newest = sessionEntries[0];
    go("result", {
      id: newest.id,
      processingName: null,
      clearSelection: true,
    });
  }, [go, processingName, sessionEntries]);

  // Backend error while processing.
  useEffect(() => {
    if (!processingName) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<TranscriptionResult>("transcription-result", (event) => {
      if (!event.payload.error) {
        void loadHistory();
        return;
      }
      go("upload", { processingName: null });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [go, loadHistory, processingName]);

  // Keep storage in sync when URL-driven id changes via history clicks.
  useEffect(() => {
    if (!bootedRef.current) return;
    writeStored({
      view,
      activeId: view === "result" ? (activeEntry?.id ?? activeId) : null,
      processingName,
    });
  }, [activeEntry?.id, activeId, processingName, view]);

  const enterUpload = () => {
    go("upload", { processingName: null, clearSelection: true });
  };

  const selectEntry = (id: string) => {
    go("result", { id, processingName: null });
  };

  const removeEntry = async (id: string) => {
    if (!window.confirm("确定删除这条转写记录？")) return;
    const remaining = sessionEntries.filter((e) => e.id !== id);
    const nextId =
      activeId === id || activeEntry?.id === id
        ? (remaining[0]?.id ?? null)
        : activeId;
    try {
      await deleteHistory(id);
      toast.success("已删除");
      if (remaining.length === 0) {
        go("upload", { processingName: null });
      } else if (nextId && nextId !== activeId) {
        go("result", { id: nextId, processingName: null });
      }
    } catch (error) {
      toast.danger(`删除失败: ${error}`);
    }
  };

  const acceptPath = (path: string) => {
    setSelectedPath(path);
    go("upload", { processingName: null });
  };

  const pickFile = async () => {
    if (processing) return;
    const selected = await open({
      multiple: false,
      title: "选择音频或视频文件",
      filters: TRANSCRIBE_FILE_FILTERS.map((f) => ({
        name: f.name,
        extensions: [...f.extensions],
      })),
    });
    if (typeof selected !== "string") return;
    acceptPath(selected);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          if (screen === "upload") setDragOver(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        if (event.payload.type === "drop") {
          setDragOver(false);
          if (screen !== "upload") return;
          const path = event.payload.paths.find(isMediaPath);
          if (!path) {
            toast.warning("请拖入音频或视频文件");
            return;
          }
          acceptPath(path);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* web / HMR */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // acceptPath closes over go; screen is the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const runTranscribe = async () => {
    if (!selectedPath || !canStart) return;

    const path = selectedPath;
    const name = fileName(path);

    // Switch away from upload immediately — before the backend round-trip.
    historyLenRef.current = sessionEntries.length;
    go("upload", { processingName: name, clearSelection: true });
    markSession("transcribe");

    try {
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", { path });
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      setSelectedPath(path);
      go("upload", { processingName: null });
      toast.danger(`转写失败: ${error}`);
    }
  };

  const languageLabel =
    config.language === "auto" ? "自动检测" : config.language;
  const selectedIsVideo = selectedPath ? isVideoPath(selectedPath) : false;

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        title="转写"
        subtitle={
          screen === "processing"
            ? "正在识别…"
            : screen === "result"
              ? "播放时跟随当前一句。"
              : undefined
        }
        action={
          screen === "result" ? (
            <Button variant="primary" onPress={enterUpload}>
              <Plus size={16} aria-hidden />
              新转写
            </Button>
          ) : screen === "upload" && sessionEntries.length > 0 ? (
            <Button
              variant="secondary"
              onPress={() =>
                go("result", {
                  id: activeEntry?.id ?? sessionEntries[0].id,
                  processingName: null,
                })
              }
            >
              查看结果
            </Button>
          ) : null
        }
      />

      <div key={screen} className="page-enter">
        {screen === "upload" ? (
          <UploadPhase
            selectedPath={selectedPath}
            selectedIsVideo={selectedIsVideo}
            dragOver={dragOver}
            modelBlocked={modelBlocked}
            canStart={canStart}
            provider={providerLabel(config.asr_provider)}
            languageLabel={languageLabel}
            onPick={() => void pickFile()}
            onStart={() => void runTranscribe()}
          />
        ) : null}

        {screen === "processing" ? (
          <ProcessingPhase
            fileName={processingName}
            provider={providerLabel(config.asr_provider)}
            languageLabel={languageLabel}
          />
        ) : null}

        {screen === "result" ? (
          <ResultPhase
            activeEntry={activeEntry}
            sessionEntries={sessionEntries}
            languageLabel={languageLabel}
            onSelect={selectEntry}
            onDelete={(id) => void removeEntry(id)}
            onNew={enterUpload}
          />
        ) : null}
      </div>
    </PageShell>
  );
}

function UploadPhase({
  selectedPath,
  selectedIsVideo,
  dragOver,
  modelBlocked,
  canStart,
  provider,
  languageLabel,
  onPick,
  onStart,
}: {
  selectedPath: string | null;
  selectedIsVideo: boolean;
  dragOver: boolean;
  modelBlocked: boolean;
  canStart: boolean;
  provider: string;
  languageLabel: string;
  onPick: () => void;
  onStart: () => void;
}) {
  return (
    <SectionCard className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">选择媒体</div>
          <div className="text-xs text-muted">
            {provider} · {languageLabel}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onPress={onPick}>
            <Upload size={16} aria-hidden />
            选择文件
          </Button>
          <Button variant="primary" isDisabled={!canStart} onPress={onStart}>
            {selectedIsVideo ? (
              <FileVideo size={16} aria-hidden />
            ) : (
              <FileAudio size={16} aria-hidden />
            )}
            开始转写
          </Button>
        </div>
      </div>

      {modelBlocked ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          Qwen 模型加载中或未加载。若已配置模型目录，启动时会自动加载。
        </div>
      ) : null}

      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition",
          dragOver
            ? "border-accent/50 bg-accent/10"
            : "border-border bg-surface-secondary/40 hover:border-foreground/25 hover:bg-surface-secondary/60",
        )}
      >
        {selectedPath ? (
          <>
            {selectedIsVideo ? (
              <FileVideo
                className="block text-foreground"
                size={28}
                aria-hidden
              />
            ) : (
              <FileAudio
                className="block text-foreground"
                size={28}
                aria-hidden
              />
            )}
            <div className="max-w-full truncate text-sm font-medium text-foreground">
              {fileName(selectedPath)}
            </div>
            <p className="text-[12px] text-muted">
              {selectedIsVideo
                ? "将提取音轨 · 点击可更换文件"
                : "点击可更换文件"}
            </p>
          </>
        ) : (
          <>
            <Upload
              className="block text-muted opacity-70"
              size={28}
              aria-hidden
            />
            <div className="text-sm font-medium text-foreground">
              {dragOver ? "松开以添加文件" : "拖拽到此处，或点击选择"}
            </div>
            <p className="max-w-md text-[12px] leading-relaxed text-muted">
              {TRANSCRIBE_FORMAT_HINT}
            </p>
          </>
        )}
      </button>
    </SectionCard>
  );
}

function ProcessingPhase({
  fileName: name,
  provider,
  languageLabel,
}: {
  fileName: string | null;
  provider: string;
  languageLabel: string;
}) {
  return (
    <SectionCard className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 py-16 text-center">
      <div className="processing-pulse grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent ring-1 ring-accent/20">
        <FileAudio size={24} aria-hidden />
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">正在识别…</div>
        {name ? (
          <p className="mt-1.5 max-w-sm truncate text-[13px] text-muted">
            {name}
          </p>
        ) : null}
        <p className="mt-1 text-[12px] text-muted">
          {provider} · {languageLabel}
        </p>
      </div>
    </SectionCard>
  );
}

function ResultPhase({
  activeEntry,
  sessionEntries,
  languageLabel,
  onSelect,
  onDelete,
  onNew,
}: {
  activeEntry: HistoryEntry | null;
  sessionEntries: HistoryEntry[];
  languageLabel: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const openedForIdRef = useRef<string | null>(null);

  // Open cover when landing on / selecting a result; don't re-open after dismiss.
  useEffect(() => {
    if (!activeEntry) {
      setDetailOpen(false);
      openedForIdRef.current = null;
      return;
    }
    if (openedForIdRef.current === activeEntry.id) return;
    openedForIdRef.current = activeEntry.id;
    setDetailOpen(true);
  }, [activeEntry]);

  const selectAndOpen = (id: string) => {
    if (activeEntry?.id === id) {
      setDetailOpen(true);
      return;
    }
    openedForIdRef.current = null;
    onSelect(id);
  };

  return (
    <>
      <SectionCard title="转写记录" className="mx-auto w-full max-w-2xl">
        <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-2 overflow-y-auto">
          {sessionEntries.length === 0 ? (
            <div className="grid min-h-[200px] place-items-center gap-3 text-center">
              <p className="text-sm text-muted">还没有转写结果</p>
              <Button variant="primary" onPress={onNew}>
                <Plus size={16} aria-hidden />
                开始转写
              </Button>
            </div>
          ) : (
            sessionEntries.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                active={activeEntry?.id === entry.id}
                onSelect={() => selectAndOpen(entry.id)}
                onDelete={() => onDelete(entry.id)}
              />
            ))
          )}
        </div>
      </SectionCard>

      {activeEntry ? (
        <Modal.Backdrop
          isOpen={detailOpen}
          onOpenChange={setDetailOpen}
          variant="opaque"
        >
          <Modal.Container scroll="inside">
            <Modal.Dialog className="flex w-full max-w-6xl max-h-[calc(100dvh-1rem)] flex-col overflow-hidden sm:max-h-[calc(100dvh-5rem)]">
              <TranscriptViewer.Root
                key={activeEntry.id}
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
              >
                <Modal.CloseTrigger />
                <Modal.Body className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex min-h-0 flex-1 flex-col gap-4">
                    <div className="flex w-full shrink-0 flex-wrap items-start justify-between gap-2 pr-8">
                      <div className="min-w-0">
                        <Modal.Heading>转写详情</Modal.Heading>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span>
                            {new Date(activeEntry.created_at).toLocaleString()}
                          </span>
                          <span>{activeEntry.duration_seconds.toFixed(1)}s</span>
                          <Chip size="sm" variant="soft" color="default">
                            <Chip.Label>
                              {activeEntry.language || languageLabel}
                            </Chip.Label>
                          </Chip>
                        </div>
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

                    <div className="flex min-h-0  gap-6">
                      <div className="flex flex-3 w-[min(64%,24rem)] shrink-0 flex-col items-center justify-center gap-4 px-3">
                        <TranscriptViewer.Media />
                        <TranscriptViewer.Controls className="w-full" />
                      </div>

                      <div className="flex min-h-0 min-w-0 flex-2 flex-col gap-3">
                        <TranscriptViewer.ModeToggle className="shrink-0" />
                        <TranscriptViewer.Content
                          scroll
                          fill
                          className="min-h-0"
                        />
                      </div>
                    </div>
                  </div>
                </Modal.Body>
              </TranscriptViewer.Root>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </>
  );
}

function HistoryRow({
  entry,
  active,
  onSelect,
  onDelete,
}: {
  entry: HistoryEntry;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`flex w-full gap-2 rounded-xl items-center border px-3 py-2.5 transition ${active
          ? "border-accent/40 bg-accent/10"
          : "border-border bg-surface-secondary/30 hover:bg-surface-secondary/60"
        }`}
    >
      <div
        onClick={onSelect}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>{new Date(entry.created_at).toLocaleString()}</span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground">
          {entry.text || "（空）"}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        className="mt-0.5 shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-danger/10 hover:text-danger"
        aria-label="删除"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </div>
  );
}
