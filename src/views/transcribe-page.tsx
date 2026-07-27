import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input, Label, TextField, toast } from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Clipboard,
  Download,
  FileAudio,
  FileVideo,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { HistoryEntry, TranscriptionResult } from "@/types";
import { providerLabel, TRANSCRIBE_FILE_FILTERS } from "@/lib/constants";
import { isVideoMediaKind } from "@/lib/alignment";
import { ModeSwitch, PageHeader, PageShell } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";
import { springUI, duration, easeOut } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

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
  const t = useT();
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
              hint: t("transcribe.ytdlpDetectFailed"),
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
      // Skip when the URL already says this — a redundant write re-renders
      // DraftPage on the default tab's first paint.
      const curId = searchParams.get("id");
      if (
        searchParams.get("view") === paintedView &&
        (curId ?? null) === (params.get("id") ?? null)
      ) {
        return;
      }
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
            <>
              {sessionEntries.length > 0 ? (
                <span className="dmast-meta">
                  {t("transcribe.recordsCount", { n: sessionEntries.length })}
                </span>
              ) : null}
              <button type="button" className="dlink" onClick={enterUpload}>
                ＋ {t("transcribe.newTranscription")}
              </button>
            </>
          ) : screen === "upload" && sessionEntries.length > 0 ? (
            <button
              type="button"
              className="dlink muted"
              onClick={() => go("result")}
            >
              ← {t("transcribe.recordsCount", { n: sessionEntries.length })}
            </button>
          ) : null,
          actionSlot,
        )
      : null;

  const selectEntry = (id: string) => {
    go("result", { id, processingName: null });
  };

  const removeEntry = async (id: string) => {
    const remaining = sessionEntries.filter((e) => e.id !== id);
    const nextId =
      activeId === id || activeEntry?.id === id
        ? (remaining[0]?.id ?? null)
        : activeId;
    try {
      await deleteHistory(id);
      toast.success(t("transcribe.deleted"));
      if (remaining.length === 0) {
        go("upload", { processingName: null });
      } else if (nextId && nextId !== activeId) {
        go("result", { id: nextId, processingName: null });
      }
    } catch (error) {
      toast.danger(t("transcribe.deleteFailed", { error: String(error) }));
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
      title: t("transcribe.pickFileTitle"),
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
              toast.warning(t("transcribe.dropMediaOnly"));
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
    toast.success(t("transcribe.cancelled"));
  };

  const languageLabel =
    config.language === "auto" ? t("transcribe.langAutoDetect") : config.language;
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
      toast.danger(t("transcribe.transcribeFailed", { error: String(error) }));
    }
  };

  const runUrlDownloadAndTranscribe = async (rawUrl: string) => {
    if (modelBlocked || processing) return;
    const url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!ytdlp?.available) {
      toast.danger(ytdlp?.hint || t("transcribe.installYtdlp"));
      return;
    }
    if (!ytdlp.ffmpeg_available) {
      toast.danger(t("transcribe.needFfmpeg"));
      return;
    }

    const label =
      urlMode === "audio"
        ? t("transcribe.downloadingAudio")
        : t("transcribe.downloadingVideo");
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
        (urlMode === "audio"
          ? t("transcribe.webAudio")
          : t("transcribe.webVideo"));
      go("upload", { processingName: t("transcribe.recognizingName", { name }) });
      await invoke("save_app_config", { config });
      await invoke("transcribe_file", {
        path: result.path,
        mediaKind: result.media_kind,
      });
      window.setTimeout(() => void loadHistory(), 800);
    } catch (error) {
      go("upload", { processingName: null, jobBaselineId: null });
      toast.danger(
        t("transcribe.downloadTranscribeFailed", { error: String(error) }),
      );
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
      ? t("transcribe.recognizing")
      : screen === "result"
        ? languageLabel
        : `${providerLabel(config.asr_provider)} · ${languageLabel}`;
  const headerAction =
    screen === "result" ? (
      <Button variant="primary" onPress={enterUpload}>
        <Plus size={16} aria-hidden />
        {t("transcribe.newTranscription")}
      </Button>
    ) : null;

  const content = (
    <>
      {mastAction}
      {embedded ? null : (
        <PageHeader title={t("transcribe.title")} status={headerStatus} action={headerAction} />
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
  const t = useT();
  const [source, setSource] = useState<"file" | "link">("file");
  // Local — keystrokes must not re-render TranscribePage + history tree.
  const [urlInput, setUrlInput] = useState("");
  const urlLooksValid = /^https?:\/\//i.test(urlInput.trim());
  const canUrlStart = urlLooksValid && !modelBlocked && !processing;

  return (
    <div className="flex w-full flex-col">
      <ModeSwitch modeKey={source}>
        {source === "file" ? (
          <div className="flex flex-col gap-5 pt-12">
            {modelBlocked ? (
              <div className="rounded-xl bg-warning/10 px-3 py-2 type-meta text-warning">
                {t("transcribe.modelBlockedBanner")}
              </div>
            ) : null}

            <button
              type="button"
              aria-label={selectedPath ? t("transcribe.changeFile") : t("transcribe.chooseFile")}
              onClick={onPick}
              className={cn("dropzone", dragOver && "is-drag")}
            >
              {selectedPath ? (
                <>
                  <span className="dropzone-ic">
                    {selectedIsVideo ? (
                      <FileVideo size={22} aria-hidden />
                    ) : (
                      <FileAudio size={22} aria-hidden />
                    )}
                  </span>
                  <span className="dropzone-t max-w-full truncate">
                    {fileName(selectedPath)}
                  </span>
                  <span className="dropzone-fmt">{t("transcribe.clickToChange")}</span>
                </>
              ) : (
                <>
                  <span className="dropzone-ic">
                    <Upload size={22} aria-hidden />
                  </span>
                  <span className="dropzone-t">
                    {dragOver
                      ? t("transcribe.releaseToAdd")
                      : t("transcribe.dropHint")}
                  </span>
                  <span className="dropzone-fmt">
                    {t("transcribe.formatHint")}
                  </span>
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
              {t("transcribe.start")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="type-meta font-mono">{provider}</p>

            <TextField
              fullWidth
              variant="secondary"
              value={urlInput}
              onChange={setUrlInput}
            >
              <Label>{t("transcribe.mediaLink")}</Label>
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
              {t("transcribe.start")}
            </Button>
          </div>
        )}
      </ModeSwitch>

      <div className="mt-5 flex items-center">
        <div className="tswitch" role="tablist" aria-label={t("transcribe.sourceAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={source === "file"}
            className={cn("o", source === "file" && "is-active")}
            onClick={() => setSource("file")}
          >
            {t("transcribe.localFile")}
          </button>
          <span className="sep">·</span>
          <button
            type="button"
            role="tab"
            aria-selected={source === "link"}
            className={cn("o", source === "link" && "is-active")}
            onClick={() => setSource("link")}
          >
            {t("transcribe.webLink")}
          </button>
        </div>
        {source === "link" ? (
          <>
            <span className="w-5" />
            <div className="tswitch" role="tablist" aria-label={t("transcribe.mediaTypeAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={urlMode === "audio"}
                className={cn("o", urlMode === "audio" && "is-active")}
                onClick={() => onUrlModeChange("audio")}
              >
                {t("transcribe.audio")}
              </button>
              <span className="sep">·</span>
              <button
                type="button"
                role="tab"
                aria-selected={urlMode === "video"}
                className={cn("o", urlMode === "video" && "is-active")}
                onClick={() => onUrlModeChange("video")}
              >
                {t("transcribe.video")}
              </button>
            </div>
          </>
        ) : null}
      </div>
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
  const t = useT();
  // processingName is a localized label — match either locale's download marker.
  const downloading =
    (name != null && /下载|Download/i.test(name)) || downloadPercent != null;
  return (
    <div className="proc mx-auto w-full max-w-2xl">
      <div className="proc-ic">
        {downloading ? (
          <Download size={24} aria-hidden />
        ) : (
          <FileAudio size={24} aria-hidden />
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">
          {downloading
            ? t("transcribe.downloading")
            : t("transcribe.recognizingEllipsis")}
        </div>
        {name ? (
          <p className="mt-1.5 max-w-sm truncate text-[13px] text-muted">
            {name}
          </p>
        ) : null}
        {downloadPercent != null ? (
          <>
            <div className="proc-prog mx-auto mt-3">
              <div
                style={{
                  width: `${Math.min(Math.max(downloadPercent, 0), 100)}%`,
                }}
              />
            </div>
            <p className="mt-1.5 text-[12px] text-muted">
              {downloadPercent.toFixed(0)}%
            </p>
          </>
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
        {t("transcribe.cancel")}
      </Button>
    </div>
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
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [Viewer, setViewer] = useState<TranscriptViewerType | null>(null);
  /** Full entry w/ alignment — fetched only when a row expands. */
  const [detailEntry, setDetailEntry] = useState<HistoryEntry | null>(null);
  // First paint: few rows. Rest after idle — tab-click must stay light.
  const [visibleCount, setVisibleCount] = useState(8);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!activeEntry) {
      setExpandedId(null);
      setDetailEntry(null);
    }
  }, [activeEntry]);

  // Expanded row deleted from under us → collapse.
  useEffect(() => {
    if (expandedId && !sessionEntries.some((e) => e.id === expandedId)) {
      setExpandedId(null);
      setDetailEntry(null);
    }
  }, [expandedId, sessionEntries]);

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

  // Modal reader: click a row → fetch full entry + open the dialog.
  // (Inline expansion replaced by user directive — full-screen reader is the
  // only way long transcripts stay readable.)
  const openRow = (id: string) => {
    if (activeEntry?.id !== id) onSelect(id);
    setExpandedId(id);
    setDetailEntry(null);
    void (async () => {
      const [full] = await Promise.all([
        invoke<HistoryEntry | null>("get_history_entry", { id }).catch(
          () => null,
        ),
        ensureViewer(),
      ]);
      // Render guards by id, so a stale resolve after close is ignored.
      if (full) setDetailEntry(full);
    })();
  };

  const closeModal = useCallback(() => {
    setExpandedId(null);
    setDetailEntry(null);
  }, []);

  const rows = sessionEntries.slice(0, visibleCount);
  const openEntry =
    detailEntry ?? sessionEntries.find((e) => e.id === expandedId) ?? null;

  return (
    <div className="w-full">
      {sessionEntries.length === 0 ? (
        <div className="dropzone dropzone-empty">
          <span className="dropzone-ic">
            <FileAudio size={22} aria-hidden />
          </span>
          <span className="dropzone-t">{t("transcribe.emptyTitle")}</span>
          <Button variant="primary" onPress={onNew}>
            <Plus size={16} aria-hidden />
            {t("transcribe.startDraft")}
          </Button>
        </div>
      ) : (
        <div className="rlist">
          <AnimatePresence initial={false}>
          {rows.map((entry, i) => (
            <motion.div
              key={entry.id}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -12 }}
              transition={springUI}
              style={{ willChange: "opacity, transform" }}
            >
              <HistoryRow
                entry={entry}
                index={i + 1}
                active={expandedId === entry.id}
                onSelect={() => openRow(entry.id)}
                onDelete={() => onDelete(entry.id)}
              />
            </motion.div>
          ))}
          </AnimatePresence>
        </div>
      )}

      <TranscriptResultModal
        open={Boolean(expandedId)}
        entry={openEntry}
        languageLabel={languageLabel}
        Viewer={Viewer}
        onClose={closeModal}
      />
    </div>
  );
}

/** Full-screen transcript reader dialog — silky enter/exit, Esc/backdrop close. */
function TranscriptResultModal({
  open,
  entry,
  languageLabel,
  Viewer,
  onClose,
}: {
  open: boolean;
  entry: HistoryEntry | null;
  languageLabel: string;
  Viewer: TranscriptViewerType | null;
  onClose: () => void;
}) {
  const t = useT();
  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const isVideo = entry
    ? isVideoMediaKind(entry.media_kind, entry.audio_path)
    : false;
  const fileName = entry?.audio_path
    ? (entry.audio_path.split("/").filter(Boolean).pop() ?? "")
    : "";

  return createPortal(
    <AnimatePresence>
      {open && entry ? (
        <motion.div
          key="trm-backdrop"
          className="trm-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 active:bg-black/50 transition-colors duration-100"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.normal, ease: easeOut }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            key="trm-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t("transcribe.detailAria")}
            className="flex h-[min(85vh,44rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{ type: "spring", bounce: 0.2, duration: 0.3 }}
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
              <div className="flex flex-wrap items-center gap-3 font-mono text-[12px] text-muted">
                <span>{new Date(entry.created_at).toLocaleString()}</span>
                <span>{entry.duration_seconds.toFixed(1)}s</span>
                <span className="text-accent-soft-foreground">
                  {entry.language || languageLabel}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <motion.span className="inline-flex" whileTap={{ scale: 0.94 }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      void navigator.clipboard.writeText(entry.text);
                      toast.success(t("transcribe.copied"));
                    }}
                  >
                    <Clipboard size={14} aria-hidden />
                    {t("transcribe.copy")}
                  </Button>
                </motion.span>
                <motion.span className="inline-flex" whileTap={{ scale: 0.94 }}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t("transcribe.close")}
                    onPress={onClose}
                  >
                    <X size={16} aria-hidden />
                  </Button>
                </motion.span>
              </div>
            </div>
            {Viewer ? (
              <Viewer.Root
                key={entry.id}
                text={entry.text}
                mediaSrc={
                  entry.audio_path ? convertFileSrc(entry.audio_path) : null
                }
                mediaKind={isVideo ? "video" : "audio"}
                durationSeconds={entry.duration_seconds}
                segments={entry.segments}
                alignment={entry.alignment}
                emptyLabel={t("transcribe.emptyResult")}
              >
                <div className="flex min-h-0 flex-1">
                  {/* Left: media column — video player, or audio placeholder card */}
                  <motion.div
                    className="flex w-[38%] shrink-0 flex-col border-r border-border bg-surface-secondary/60"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ ...springUI, delay: 0.08 }}
                  >
                    {entry.audio_path ? (
                      <>
                        {isVideo ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                            <Viewer.Media className="max-h-full" />
                          </div>
                        ) : (
                          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
                            <Viewer.Media />
                            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
                              <FileAudio size={26} aria-hidden />
                            </div>
                            <div className="w-full min-w-0 text-center">
                              <div className="truncate text-[13px] font-medium">
                                {fileName}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-muted">
                                {entry.duration_seconds.toFixed(1)}s · {t("transcribe.audio")}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="shrink-0 border-t border-border/60 p-3">
                          <Viewer.Controls />
                        </div>
                      </>
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-muted">
                        <FileAudio size={26} aria-hidden />
                        <p className="text-[12px]">{t("transcribe.noMedia")}</p>
                      </div>
                    )}
                  </motion.div>
                  {/* Right: transcript column — toggle + scrolling reader */}
                  <motion.div
                    className="flex min-w-0 flex-1 flex-col"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ ...springUI, delay: 0.14 }}
                  >
                    <Viewer.ModeToggle className="shrink-0 border-b border-border/60 px-5 py-2.5" />
                    <Viewer.Content
                      fill
                      className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                    />
                  </motion.div>
                </div>
              </Viewer.Root>
            ) : (
              <div className="grid flex-1 place-items-center text-[12px] text-muted">
                {t("transcribe.loadingReader")}
              </div>
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
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
  const t = useT();
  const isVideo = isVideoMediaKind(entry.media_kind, entry.audio_path);
  const raw = entry.text || t("transcribe.empty");
  const preview =
    raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS)}…` : raw;

  // Two-step inline confirm (P0-1): first press arms, second executes, 3s auto-reset.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
      }
    },
    [],
  );

  const pressDelete = () => {
    if (confirmingDelete) {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
      setConfirmingDelete(false);
      onDelete();
      return;
    }
    setConfirmingDelete(true);
    confirmTimer.current = window.setTimeout(() => {
      setConfirmingDelete(false);
      confirmTimer.current = null;
    }, 3000);
  };

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
            {isVideo ? t("transcribe.video") : t("transcribe.audio")}
          </span>
          <span>{entry.duration_seconds.toFixed(1)}s</span>
        </div>
        <p className="rtext">{preview}</p>
      </button>
      <Button
        isIconOnly={!confirmingDelete}
        size="sm"
        variant="ghost"
        className={cn(
          "mt-0.5 shrink-0 transition-opacity",
          confirmingDelete
            ? "opacity-100 text-danger text-[12px] font-medium"
            : "text-muted opacity-0 group-hover:opacity-100 hover:bg-danger/10 hover:text-danger data-[hovered=true]:bg-danger/10 data-[hovered=true]:text-danger",
        )}
        aria-label={confirmingDelete ? t("transcribe.confirmDelete") : t("transcribe.delete")}
        onPress={pressDelete}
      >
        {confirmingDelete ? (
          <>{t("transcribe.confirmDelete")}</>
        ) : (
          <Trash2 size={14} aria-hidden />
        )}
      </Button>
    </div>
  );
});
