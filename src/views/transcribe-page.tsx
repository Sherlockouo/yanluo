import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

/** File/URL transcribe mode panel — upload/processing/result mutual-exclusive. Used standalone or embedded in 出稿. */
export function TranscribePage({
  embedded = false,
  active = true,
  actionSlot,
}: {
  embedded?: boolean;
  active?: boolean;
  actionSlot?: HTMLElement | null;
} = {}) {
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

  // Contextual action portaled into the 出稿 masthead top-right (file mode only).
  const mastAction =
    embedded && active && actionSlot
      ? createPortal(
          screen === "result" ? (
            <button type="button" className="dlink" onClick={enterUpload}>
              ＋ 新转写
            </button>
          ) : screen === "upload" && sessionEntries.length > 0 ? (
            <button
              type="button"
              className="dlink muted"
              onClick={() => go("result")}
            >
              ← 转写记录 · {sessionEntries.length}
            </button>
          ) : null,
          actionSlot,
        )
      : null;

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
    // Kept mounted but hidden (parent tab away) → don't grab OS file drops.
    if (!active || screen !== "upload") return;
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
    // acceptPath closes over go; only wire while upload is visible + active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, active]);

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

  const headerStatus =
    screen === "processing"
      ? "识别中"
      : screen === "result"
        ? languageLabel
        : `${providerLabel(config.asr_provider)} · ${languageLabel}`;
  const headerAction =
    screen === "result" ? (
      <Button variant="primary" onPress={enterUpload}>
        <Plus size={16} aria-hidden />
        新转写
      </Button>
    ) : null;

  const content = (
    <>
      {mastAction}
      {embedded ? null : (
        <PageHeader title="转写" status={headerStatus} action={headerAction} />
      )}

      {/* Embedded (出稿 文件): 新转写 / 转写记录 toggle lives in the masthead. */}

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
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-5xl">{content}</PageShell>;
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
    <div className="flex w-full flex-col gap-5">
      <div className="tswitch" role="tablist" aria-label="来源">
        <button
          type="button"
          role="tab"
          aria-selected={source === "file"}
          className={cn("o", source === "file" && "is-active")}
          onClick={() => setSource("file")}
        >
          本地文件
        </button>
        <span className="sep">/</span>
        <button
          type="button"
          role="tab"
          aria-selected={source === "link"}
          className={cn("o", source === "link" && "is-active")}
          onClick={() => setSource("link")}
        >
          网络链接
        </button>
      </div>

      <ModeSwitch modeKey={source}>
        {source === "file" ? (
          <div className="flex flex-col gap-5">
            {modelBlocked ? (
              <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 type-meta text-warning">
                模型未就绪
              </div>
            ) : null}

            <button
              type="button"
              aria-label={selectedPath ? "更换文件" : "选择文件"}
              onClick={onPick}
              className={cn("dropzone", dragOver && "is-drag")}
            >
              {selectedPath ? (
                <>
                  <span className="dropzone-ic">
                    {selectedIsVideo ? (
                      <FileVideo size={26} aria-hidden />
                    ) : (
                      <FileAudio size={26} aria-hidden />
                    )}
                  </span>
                  <span className="dropzone-t max-w-full truncate">
                    {fileName(selectedPath)}
                  </span>
                  <span className="dropzone-fmt">点击更换</span>
                </>
              ) : (
                <>
                  <span className="dropzone-ic">
                    <Upload size={26} aria-hidden />
                  </span>
                  <span className="dropzone-t">
                    {dragOver ? "松开以添加" : "拖拽或点击选择"}
                  </span>
                  <span className="dropzone-fmt">{TRANSCRIBE_FORMAT_HINT}</span>
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
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="type-meta font-mono">{provider}</p>
              <div className="tswitch" role="tablist" aria-label="媒体类型">
                <button
                  type="button"
                  role="tab"
                  aria-selected={urlMode === "audio"}
                  className={cn("o", urlMode === "audio" && "is-active")}
                  onClick={() => onUrlModeChange("audio")}
                >
                  音频
                </button>
                <span className="sep">/</span>
                <button
                  type="button"
                  role="tab"
                  aria-selected={urlMode === "video"}
                  className={cn("o", urlMode === "video" && "is-active")}
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
          </div>
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
      <div className="w-full">
        {sessionEntries.length === 0 ? (
          <div className="dropzone" style={{ minHeight: 220 }}>
            <span className="dropzone-t">还没有转写结果</span>
            <Button variant="primary" onPress={onNew}>
              <Plus size={16} aria-hidden />
              开始转写
            </Button>
          </div>
        ) : (
          <>
            <div className="rlist">
              {rows.map((entry, i) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  index={i + 1}
                  active={activeEntry?.id === entry.id}
                  onSelect={() => selectAndOpen(entry.id)}
                  onDelete={() => onDelete(entry.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

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
  index,
  active,
  onSelect,
  onDelete,
}: {
  entry: HistoryEntry;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const isVideo = isVideoMediaKind(entry.media_kind, entry.audio_path);
  const raw = entry.text || "（空）";
  const preview =
    raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS)}…` : raw;

  return (
    <div className={cn("ritem group", active && "is-open")}>
      <span className="ritem-n">{String(index).padStart(2, "0")}</span>
      <button
        type="button"
        onClick={onSelect}
        className="ritem-body text-left"
      >
        <div className="rmeta">
          <span>{new Date(entry.created_at).toLocaleString()}</span>
          <span className="tag inline-flex items-center gap-1">
            {isVideo ? (
              <FileVideo size={11} aria-hidden />
            ) : (
              <FileAudio size={11} aria-hidden />
            )}
            {isVideo ? "视频" : "音频"}
          </span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
        </div>
        <p className="rtext">{preview}</p>
      </button>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-danger/10 hover:text-danger data-[hovered=true]:bg-danger/10 data-[hovered=true]:text-danger"
        aria-label="删除"
        onPress={onDelete}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </div>
  );
});
