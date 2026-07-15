import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Chip, Input, Label, Modal, TextField, toast } from "@heroui/react";
import {
  Clipboard,
  Download,
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
  ModeSwitch,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";

type TranscriptViewerType =
  typeof import("@/components/ui/transcript-viewer").TranscriptViewer;

type UrlMode = "audio" | "video";

type YtdlpStatus = {
  available: boolean;
  path: string | null;
  version: string | null;
  ffmpeg_available: boolean;
  hint: string;
};

type UrlDownloadProgress = {
  phase: string;
  percent: number | null;
  message: string;
};

type UrlDownloadResult = {
  path: string;
  media_kind: string;
  title: string | null;
  job_dir: string;
};

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
  /** Newest transcribe history id when job started (completion detection). */
  jobBaselineId: string | null;
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
      jobBaselineId: parsed.jobBaselineId ?? null,
    };
  } catch {
    return null;
  }
}

function writeStored(next: StoredView) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

/** Schedule after paint; prefer idle so tab-enter stays free. */
function deferWork(fn: () => void, timeoutMs: number): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 0);
  return () => window.clearTimeout(id);
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
      : (stored?.view ??
        (history.some((e) => (e.source ?? "fn") === "transcribe")
          ? "result"
          : "upload"));
  const activeId = idParam ?? stored?.activeId ?? null;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [processingName, setProcessingName] = useState<string | null>(
    () => stored?.processingName ?? null,
  );
  const [dragOver, setDragOver] = useState(false);
  const [urlMode, setUrlMode] = useState<UrlMode>("audio");
  const [ytdlp, setYtdlp] = useState<YtdlpStatus | null>(null);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [jobBaselineId, setJobBaselineId] = useState<string | null>(
    () => stored?.jobBaselineId ?? null,
  );
  const jobDirRef = useRef<string | null>(null);
  const bootedRef = useRef(false);

  const processing = processingName != null;
  const screen: "upload" | "processing" | "result" = processing
    ? "processing"
    : view;

  // List after paint — history IPC / filter must not block tab enter.
  const [listReady, setListReady] = useState(false);
  useEffect(() => deferWork(() => setListReady(true), 0), []);

  const sessionEntries = useMemo(() => {
    if (!listReady) return [];
    return history
      .filter((e) => (e.source ?? "fn") === "transcribe")
      .slice(0, 30);
  }, [history, listReady]);

  const modelBlocked = config.asr_provider === "qwen" && !modelLoaded;
  const canStart = Boolean(selectedPath) && !modelBlocked && !processing;

  useEffect(() => {
    let cancelled = false;
    // Defer IPC off first paint so page enter stays smooth.
    const id = window.requestAnimationFrame(() => {
      void invoke<YtdlpStatus>("get_ytdlp_status")
        .then((status) => {
          if (!cancelled) setYtdlp(status);
        })
        .catch(() => {
          if (!cancelled) {
            setYtdlp({
              available: false,
              path: null,
              version: null,
              ffmpeg_available: false,
              hint: "无法检测 yt-dlp",
            });
          }
        });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // Idle — not on the tab-click critical path.
    const cancelDefer = deferWork(() => {
      if (cancelled) return;
      void listen<UrlDownloadProgress>("url-download-progress", (event) => {
        const { percent, message } = event.payload;
        if (percent != null) {
          const next = percent;
          setDownloadPercent((prev) =>
            prev != null && Math.abs(prev - next) < 0.5 ? prev : next,
          );
        }
        if (message) {
          setDownloadMessage((prev) => (prev === message ? prev : message));
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    }, 800);
    return () => {
      cancelled = true;
      cancelDefer();
      unlisten?.();
    };
  }, []);

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
        jobBaselineId?: string | null;
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
      const nextBaseline =
        opts?.jobBaselineId !== undefined
          ? opts.jobBaselineId
          : jobBaselineId;

      writeStored({
        view: next,
        activeId: nextId,
        processingName: nextProcessing,
        jobBaselineId: nextBaseline,
      });

      const params = new URLSearchParams();
      params.set("view", next);
      if (next === "result" && nextId) params.set("id", nextId);
      setSearchParams(params, { replace: true });

      if (opts?.processingName !== undefined) {
        setProcessingName(opts.processingName);
      }
      if (opts?.jobBaselineId !== undefined) {
        setJobBaselineId(opts.jobBaselineId);
      }
      if (opts?.clearSelection) setSelectedPath(null);
    },
    [activeId, jobBaselineId, processingName, setSearchParams],
  );

  const beginJob = useCallback(
    (name: string) => {
      const baseline = sessionEntries[0]?.id ?? null;
      setJobBaselineId(baseline);
      setDownloadPercent(null);
      setDownloadMessage(null);
      go("upload", {
        processingName: name,
        clearSelection: true,
        jobBaselineId: baseline,
      });
    },
    [go, sessionEntries],
  );

  // Hydrate URL once from already-painted view. Never re-fetch history / never
  // go() when params already match — that remount cascade is the tab-click hitch.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    if (stored?.processingName) {
      setProcessingName(stored.processingName);
      setJobBaselineId(stored.jobBaselineId ?? null);
    }

    const paintedView = view;
    const paintedId =
      paintedView === "result"
        ? (activeId ?? sessionEntries[0]?.id ?? null)
        : null;

    writeStored({
      view: paintedView,
      activeId: paintedId,
      processingName: stored?.processingName ?? null,
      jobBaselineId: stored?.jobBaselineId ?? null,
    });

    if (viewParam === "upload" || viewParam === "result") return;

    const id = window.requestAnimationFrame(() => {
      const params = new URLSearchParams();
      params.set("view", paintedView);
      if (paintedView === "result" && paintedId) params.set("id", paintedId);
      setSearchParams(params, { replace: true });
    });
    return () => window.cancelAnimationFrame(id);
    // intentionally once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Job finished → newest result (by id, not capped list length).
  useEffect(() => {
    if (!processingName) return;
    const newest = sessionEntries[0];
    if (!newest) return;
    if (newest.id === jobBaselineId) return;
    // New entry appeared (or first entry after empty baseline).
    if (jobBaselineId == null || newest.id !== jobBaselineId) {
      go("result", {
        id: newest.id,
        processingName: null,
        clearSelection: true,
        jobBaselineId: null,
      });
      setDownloadPercent(null);
      setDownloadMessage(null);
      if (jobDirRef.current) {
        const dir = jobDirRef.current;
        jobDirRef.current = null;
        void invoke("cleanup_download_job", { jobDir: dir }).catch(() => {});
      }
    }
  }, [go, jobBaselineId, processingName, sessionEntries]);

  // Backend error while processing — also success path refreshes history.
  useEffect(() => {
    if (!processingName) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<TranscriptionResult>("transcription-result", (event) => {
      if (event.payload.error) {
        go("upload", { processingName: null, jobBaselineId: null });
        setDownloadPercent(null);
        setDownloadMessage(null);
        return;
      }
      void loadHistory();
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
      jobBaselineId,
    });
  }, [activeEntry?.id, activeId, jobBaselineId, processingName, view]);

  const enterUpload = () => {
    go("upload", { processingName: null, jobBaselineId: null, clearSelection: true });
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
    if (screen !== "upload") return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const cancelDefer = deferWork(() => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
            return;
          }
          if (event.payload.type === "leave") {
            setDragOver(false);
            return;
          }
          if (event.payload.type === "drop") {
            setDragOver(false);
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
    }, 1200);
    return () => {
      disposed = true;
      cancelDefer();
      unlisten?.();
    };
    // acceptPath closes over go; only wire while upload is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const cancelProcessing = async () => {
    try {
      await invoke("cancel_url_download");
    } catch {
      /* ignore */
    }
    go("upload", { processingName: null, jobBaselineId: null });
    setDownloadPercent(null);
    setDownloadMessage(null);
    if (jobDirRef.current) {
      const dir = jobDirRef.current;
      jobDirRef.current = null;
      void invoke("cleanup_download_job", { jobDir: dir }).catch(() => {});
    }
    toast.success("已取消");
  };

  const languageLabel =
    config.language === "auto" ? "自动检测" : config.language;
  const selectedIsVideo = selectedPath ? isVideoPath(selectedPath) : false;

  const runTranscribe = async () => {
    if (!selectedPath || !canStart) return;

    const path = selectedPath;
    const name = fileName(path);
    const kind = isVideoPath(path) ? "video" : "audio";
    beginJob(name);
    markSession("transcribe");

    try {
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", {
        path,
        mediaKind: kind,
      });
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      setSelectedPath(path);
      go("upload", { processingName: null, jobBaselineId: null });
      toast.danger(`转写失败: ${error}`);
    }
  };

  const runUrlDownloadAndTranscribe = async (rawUrl: string) => {
    if (modelBlocked || processing) return;
    const url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!ytdlp?.available) {
      toast.danger(ytdlp?.hint || "请先安装 yt-dlp");
      return;
    }
    if (!ytdlp.ffmpeg_available) {
      toast.danger("需要本机 ffmpeg（brew install ffmpeg）");
      return;
    }

    const label = urlMode === "audio" ? "下载音频中…" : "下载视频中…";
    beginJob(label);
    markSession("transcribe");

    try {
      const result = await invoke<UrlDownloadResult>("download_url_media", {
        url,
        mode: urlMode,
      });
      jobDirRef.current = result.job_dir;
      const name =
        result.title?.trim() ||
        fileName(result.path) ||
        (urlMode === "audio" ? "网络音频" : "网络视频");
      go("upload", { processingName: `识别中 · ${name}` });
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", {
        path: result.path,
        mediaKind: result.media_kind,
      });
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      go("upload", { processingName: null, jobBaselineId: null });
      toast.danger(`下载/转写失败: ${error}`);
      if (jobDirRef.current) {
        const dir = jobDirRef.current;
        jobDirRef.current = null;
        void invoke("cleanup_download_job", { jobDir: dir }).catch(() => {});
      }
    } finally {
      setDownloadPercent(null);
    }
  };

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        title="转写"
        status={
          screen === "processing"
            ? "识别中"
            : screen === "result"
              ? languageLabel
              : `${providerLabel(config.asr_provider)} · ${languageLabel}`
        }
        action={
          screen === "result" ? (
            <Button variant="primary" onPress={enterUpload}>
              <Plus size={16} aria-hidden />
              新转写
            </Button>
          ) : null
        }
      />

      {/* No nested AnimatePresence — PageShell already owns enter. Double motion = tab hitch. */}
      {screen === "upload" ? (
        <UploadPhase
          selectedPath={selectedPath}
          selectedIsVideo={selectedIsVideo}
          dragOver={dragOver}
          modelBlocked={modelBlocked}
          canStart={canStart}
          provider={providerLabel(config.asr_provider)}
          urlMode={urlMode}
          ytdlp={ytdlp}
          processing={processing}
          onUrlModeChange={setUrlMode}
          onPick={() => void pickFile()}
          onStart={() => void runTranscribe()}
          onUrlStart={(url) => void runUrlDownloadAndTranscribe(url)}
        />
      ) : null}

      {screen === "processing" ? (
        <ProcessingPhase
          fileName={processingName}
          provider={providerLabel(config.asr_provider)}
          languageLabel={languageLabel}
          downloadPercent={downloadPercent}
          downloadMessage={downloadMessage}
          onCancel={() => void cancelProcessing()}
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
  urlMode,
  ytdlp,
  processing,
  onUrlModeChange,
  onPick,
  onStart,
  onUrlStart,
}: {
  selectedPath: string | null;
  selectedIsVideo: boolean;
  dragOver: boolean;
  modelBlocked: boolean;
  canStart: boolean;
  provider: string;
  urlMode: UrlMode;
  ytdlp: YtdlpStatus | null;
  processing: boolean;
  onUrlModeChange: (m: UrlMode) => void;
  onPick: () => void;
  onStart: () => void;
  onUrlStart: (url: string) => void;
}) {
  const [source, setSource] = useState<"file" | "link">("file");
  // Local — keystrokes must not re-render TranscribePage + history tree.
  const [urlInput, setUrlInput] = useState("");
  const urlLooksValid = /^https?:\/\//i.test(urlInput.trim());
  const canUrlStart = urlLooksValid && !modelBlocked && !processing;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex gap-1 rounded-xl border border-border p-1 self-start">
        <button
          type="button"
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition",
            source === "file"
              ? "bg-default text-foreground"
              : "text-muted hover:text-foreground",
          )}
          onClick={() => setSource("file")}
        >
          文件
        </button>
        <button
          type="button"
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition",
            source === "link"
              ? "bg-default text-foreground"
              : "text-muted hover:text-foreground",
          )}
          onClick={() => setSource("link")}
        >
          链接
        </button>
      </div>

      <ModeSwitch modeKey={source}>
        {source === "file" ? (
          <SectionCard className="flex flex-col gap-4">
            {modelBlocked ? (
              <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 type-meta text-warning">
                模型未就绪
              </div>
            ) : null}

            <button
              type="button"
              onClick={onPick}
              className={cn(
                "flex min-h-[180px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition",
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
                  <p className="text-[12px] text-muted">点击更换</p>
                </>
              ) : (
                <>
                  <Upload
                    className="block text-muted opacity-70"
                    size={28}
                    aria-hidden
                  />
                  <div className="text-sm font-medium text-foreground">
                    {dragOver ? "松开以添加" : "拖拽或点击选择"}
                  </div>
                  <p className="max-w-md text-[12px] text-muted">
                    {TRANSCRIBE_FORMAT_HINT}
                  </p>
                </>
              )}
            </button>

            <Button
              fullWidth
              variant="primary"
              isDisabled={!canStart}
              onPress={onStart}
            >
              {selectedIsVideo ? (
                <FileVideo size={16} aria-hidden />
              ) : (
                <FileAudio size={16} aria-hidden />
              )}
              开始转写
            </Button>
          </SectionCard>
        ) : (
          <SectionCard className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-muted">{provider}</p>
              <div className="flex shrink-0 gap-1 rounded-xl border border-border p-1">
                <button
                  type="button"
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[12px] font-medium transition",
                    urlMode === "audio"
                      ? "bg-default text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                  onClick={() => onUrlModeChange("audio")}
                >
                  音频
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[12px] font-medium transition",
                    urlMode === "video"
                      ? "bg-default text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                  onClick={() => onUrlModeChange("video")}
                >
                  视频
                </button>
              </div>
            </div>

            <TextField
              fullWidth
              variant="secondary"
              value={urlInput}
              onChange={setUrlInput}
            >
              <Label>媒体链接</Label>
              <Input placeholder="https://…" />
            </TextField>

            {ytdlp && !ytdlp.available ? (
              <p className="text-[12px] text-warning">{ytdlp.hint}</p>
            ) : null}

            <Button
              fullWidth
              variant="primary"
              isDisabled={
                !canUrlStart ||
                ytdlp?.available === false ||
                ytdlp?.ffmpeg_available === false
              }
              onPress={() => onUrlStart(urlInput)}
            >
              <Download size={16} aria-hidden />
              开始转写
            </Button>
          </SectionCard>
        )}
      </ModeSwitch>
    </div>
  );
}

function ProcessingPhase({
  fileName: name,
  provider,
  languageLabel,
  downloadPercent,
  downloadMessage,
  onCancel,
}: {
  fileName: string | null;
  provider: string;
  languageLabel: string;
  downloadPercent: number | null;
  downloadMessage: string | null;
  onCancel: () => void;
}) {
  const downloading =
    name?.includes("下载") === true || downloadPercent != null;
  return (
    <SectionCard className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent ring-1 ring-accent/20">
        {downloading ? (
          <Download size={24} aria-hidden />
        ) : (
          <FileAudio size={24} aria-hidden />
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">
          {downloading ? "正在下载…" : "正在识别…"}
        </div>
        {name ? (
          <p className="mt-1.5 max-w-sm truncate text-[13px] text-muted">
            {name}
          </p>
        ) : null}
        {downloadPercent != null ? (
          <p className="mt-1 text-[12px] text-muted">
            {downloadPercent.toFixed(0)}%
          </p>
        ) : null}
        {downloadMessage ? (
          <p className="mt-1 max-w-md truncate text-[11px] text-muted">
            {downloadMessage}
          </p>
        ) : null}
        <p className="mt-1 text-[12px] text-muted">
          {provider} · {languageLabel}
        </p>
      </div>
      <Button size="sm" variant="secondary" onPress={onCancel}>
        取消
      </Button>
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
  const [Viewer, setViewer] = useState<TranscriptViewerType | null>(null);
  /** Full entry w/ alignment — fetched only when modal opens. */
  const [detailEntry, setDetailEntry] = useState<HistoryEntry | null>(null);
  // First paint: few rows. Rest after idle — tab-click must stay light.
  const [visibleCount, setVisibleCount] = useState(8);

  useEffect(() => {
    if (!activeEntry) {
      setDetailOpen(false);
      setDetailEntry(null);
    }
  }, [activeEntry]);

  useEffect(() => {
    const cancelDefer = deferWork(() => setVisibleCount(30), 400);
    return cancelDefer;
  }, []);

  const ensureViewer = useCallback(async () => {
    if (Viewer) return Viewer;
    const mod = await import("@/components/ui/transcript-viewer");
    setViewer(() => mod.TranscriptViewer);
    return mod.TranscriptViewer;
  }, [Viewer]);

  const selectAndOpen = (id: string) => {
    if (activeEntry?.id !== id) onSelect(id);
    setDetailOpen(true);
    setDetailEntry(null);
    void (async () => {
      const [full] = await Promise.all([
        invoke<HistoryEntry | null>("get_history_entry", { id }).catch(
          () => null,
        ),
        ensureViewer(),
      ]);
      setDetailEntry(full ?? sessionEntries.find((e) => e.id === id) ?? null);
    })();
  };

  const rows = sessionEntries.slice(0, visibleCount);
  const viewerEntry = detailEntry;

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
            rows.map((entry) => (
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

      {viewerEntry && detailOpen && Viewer ? (
        <Modal.Backdrop
          isOpen={detailOpen}
          onOpenChange={(open) => {
            setDetailOpen(open);
            if (!open) setDetailEntry(null);
          }}
          variant="opaque"
        >
          <Modal.Container scroll="inside">
            <Modal.Dialog className="flex w-full max-w-6xl max-h-[calc(100dvh-1rem)] flex-col overflow-hidden sm:max-h-[calc(100dvh-5rem)]">
              <Viewer.Root
                key={viewerEntry.id}
                text={viewerEntry.text}
                mediaSrc={
                  viewerEntry.audio_path
                    ? convertFileSrc(viewerEntry.audio_path)
                    : null
                }
                mediaKind={
                  isVideoMediaKind(
                    viewerEntry.media_kind,
                    viewerEntry.audio_path,
                  )
                    ? "video"
                    : "audio"
                }
                durationSeconds={viewerEntry.duration_seconds}
                segments={viewerEntry.segments}
                alignment={viewerEntry.alignment}
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
                            {new Date(viewerEntry.created_at).toLocaleString()}
                          </span>
                          <span>{viewerEntry.duration_seconds.toFixed(1)}s</span>
                          <Chip size="sm" variant="soft" color="default">
                            <Chip.Label>
                              {viewerEntry.language || languageLabel}
                            </Chip.Label>
                          </Chip>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => {
                          void navigator.clipboard.writeText(viewerEntry.text);
                          toast.success("已复制");
                        }}
                      >
                        <Clipboard size={14} aria-hidden />
                        复制
                      </Button>
                    </div>

                    <div className="flex min-h-0  gap-6">
                      <div className="flex flex-3 w-[min(64%,24rem)] shrink-0 flex-col items-center justify-center gap-4 px-3">
                        <Viewer.Media />
                        <Viewer.Controls className="w-full" />
                      </div>

                      <div className="flex min-h-0 min-w-0 flex-2 flex-col gap-3">
                        <Viewer.ModeToggle className="shrink-0" />
                        <Viewer.Content
                          scroll
                          fill
                          className="min-h-0"
                        />
                      </div>
                    </div>
                  </div>
                </Modal.Body>
              </Viewer.Root>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </>
  );
}

const PREVIEW_CHARS = 140;

const HistoryRow = memo(function HistoryRow({
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
  const isVideo = isVideoMediaKind(entry.media_kind, entry.audio_path);
  const raw = entry.text || "（空）";
  const preview =
    raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS)}…` : raw;

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
          <span className="inline-flex items-center gap-2">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            <div className=" inline-flex items-center gap-1 text-foreground/80">
              {isVideo ? (
                <FileVideo size={11} aria-hidden />
              ) : (
                <FileAudio size={11} aria-hidden />
               )}
              {isVideo ? "视频" : "音频"}
            </div>
          </span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground">
          {preview}
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
});
