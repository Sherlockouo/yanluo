import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, Link } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Input,
  Label,
  Modal,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Download,
  FileAudio,
  FileVideo,
  FolderOpen,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { AsrProvider, HistoryEntry, TranscriptionResult } from "@/types";
import {
  cloudAsrPreset,
  providerLabel,
  resolveCloudAsrCreds,
  TRANSCRIBE_FILE_FILTERS,
} from "@/lib/constants";
import { isVideoMediaKind } from "@/lib/alignment";
import { ModeSwitch, PageHeader, PageShell, Reveal } from "@/components/shared/page-shell";
import { TranscriptExportMenu } from "@/components/ui/transcript-export-menu";
import { WorkArtifactsPanel } from "@/components/ui/work-artifacts";
import { WorkResearchPanel } from "@/components/ui/work-research";
import { useApp } from "@/app-context";
import { springUI, easeOut } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

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
  const reducedMotion = useReducedMotion();
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

  // History is already in-memory (app context) — the filter is µs even at ~1k
  // entries. Render rows in the FIRST frame: an empty→list staged swap would
  // invalidate the whole section texture mid enter-animation (WKWebView
  // re-raster = the tab-click hitch).
  const sessionEntries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "fn") === "transcribe")
        .slice(0, 30),
    [history],
  );

  const modelBlocked = config.asr_provider === "qwen" && !modelLoaded;
  // 云端识别: blocked until the active vendor has an API key (settings → 识别).
  const cloudCreds = resolveCloudAsrCreds(config, config.cloud_asr_provider);
  const cloudBlocked =
    config.asr_provider === "cloud" && !cloudCreds.api_key.trim();
  const engineBlocked = modelBlocked || cloudBlocked;
  const canStart = Boolean(selectedPath) && !engineBlocked && !processing;

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
                <motion.span
                  key={sessionEntries.length}
                  className="dmast-meta"
                  initial={reducedMotion ? false : { opacity: 0.92, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "tween", duration: 0.16, ease: easeOut }}
                >
                  {t("transcribe.recordsCount", { n: sessionEntries.length })}
                </motion.span>
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
    if (engineBlocked || processing) return;
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

  const engineLabel =
    config.asr_provider === "cloud"
      ? `${providerLabel("cloud")} · ${cloudAsrPreset(config.cloud_asr_provider).label}`
      : providerLabel(config.asr_provider);
  const headerStatus =
    screen === "processing"
      ? t("transcribe.recognizing")
      : screen === "result"
        ? languageLabel
        : `${engineLabel} · ${languageLabel}`;
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

      {/* Enter-only phase swap — no AnimatePresence exit (ghost stack). */}
      {screen === "upload" ? (
        <ModeSwitch modeKey="upload">
          <UploadPhase
            selectedPath={selectedPath}
            selectedIsVideo={selectedIsVideo}
            dragOver={dragOver}
            modelBlocked={modelBlocked}
            cloudBlocked={cloudBlocked}
            canStart={canStart}
            provider={engineLabel}
            urlMode={urlMode}
            ytdlp={ytdlp}
            processing={processing}
            onUrlModeChange={setUrlMode}
            onPick={() => void pickFile()}
            onStart={() => void runTranscribe()}
            onUrlStart={(url) => void runUrlDownloadAndTranscribe(url)}
          />
        </ModeSwitch>
      ) : null}

      {screen === "processing" ? (
        <ModeSwitch modeKey="processing">
          <ProcessingPhase
            fileName={processingName}
            provider={engineLabel}
            languageLabel={languageLabel}
            downloadPercent={downloadPercent}
            downloadMessage={downloadMessage}
            onCancel={() => void cancelProcessing()}
          />
        </ModeSwitch>
      ) : null}

      {screen === "result" ? (
        <ModeSwitch modeKey="result">
          <ResultPhase
            activeEntry={activeEntry}
            sessionEntries={sessionEntries}
            languageLabel={languageLabel}
            onSelect={selectEntry}
            onDelete={(id) => void removeEntry(id)}
            onNew={enterUpload}
          />
        </ModeSwitch>
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
  cloudBlocked,
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
  cloudBlocked: boolean;
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
  const { config, updateConfig } = useApp();
  const [source, setSource] = useState<"file" | "link">("file");
  // Local — keystrokes must not re-render TranscribePage + history tree.
  const [urlInput, setUrlInput] = useState("");
  const urlLooksValid = /^https?:\/\//i.test(urlInput.trim());
  const canUrlStart = urlLooksValid && !modelBlocked && !cloudBlocked && !processing;
  const cloudPreset = cloudAsrPreset(config.cloud_asr_provider);
  const cloudModel = resolveCloudAsrCreds(config, config.cloud_asr_provider).model;

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
            {cloudBlocked ? (
              <div className="rounded-xl bg-warning/10 px-3 py-2 type-meta text-warning">
                {t("cloudAsr.notConfigured", { label: cloudPreset.label })}{" "}
                <Link to="/settings?tab=asr" className="underline">
                  {t("cloudAsr.configureLink")}
                </Link>
              </div>
            ) : null}

            <button
              type="button"
              aria-label={selectedPath ? t("transcribe.changeFile") : t("transcribe.chooseFile")}
              onClick={onPick}
              className={cn("dropzone group cursor-pointer", dragOver && "is-drag")}
            >
              {selectedPath ? (
                <>
                  <span className="dropzone-ic transition-transform duration-150 ease-out group-hover:scale-105 motion-reduce:transition-none">
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
                  <span className="dropzone-ic transition-transform duration-150 ease-out group-hover:scale-105 motion-reduce:transition-none">
                    <Upload size={22} aria-hidden />
                  </span>
                  <span className="dropzone-t">
                    {dragOver
                      ? t("transcribe.releaseToAdd")
                      : t("transcribe.dropHint")}
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

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <ToggleButtonGroup
          aria-label={t("cloudAsr.engineAria")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[config.asr_provider]}
          onSelectionChange={(keys) => {
            const id = [...keys][0] as AsrProvider | undefined;
            if (id != null && id !== config.asr_provider) {
              updateConfig("asr_provider", id);
            }
          }}
          size="sm"
        >
          <ToggleButton id="qwen">{t("cloudAsr.engineQwen")}</ToggleButton>
          <ToggleButton id="apple">{t("cloudAsr.engineApple")}</ToggleButton>
          <ToggleButton id="cloud">{t("cloudAsr.engineCloud")}</ToggleButton>
        </ToggleButtonGroup>
        {config.asr_provider === "cloud" ? (
          <span className="text-[11px] text-muted">
            {cloudPreset.label}
            {cloudModel ? ` · ${cloudModel}` : ""}
          </span>
        ) : null}
        <ToggleButtonGroup
          aria-label={t("transcribe.sourceAria")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[source]}
          onSelectionChange={(keys) => {
            const id = [...keys][0] as "file" | "link" | undefined;
            if (id != null && id !== source) setSource(id);
          }}
          size="sm"
        >
          <ToggleButton id="file">{t("transcribe.localFile")}</ToggleButton>
          <ToggleButton id="link">{t("transcribe.webLink")}</ToggleButton>
        </ToggleButtonGroup>
        {source === "link" ? (
          <ToggleButtonGroup
            aria-label={t("transcribe.mediaTypeAria")}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[urlMode]}
            onSelectionChange={(keys) => {
              const id = [...keys][0] as UrlMode | undefined;
              if (id != null && id !== urlMode) onUrlModeChange(id);
            }}
            size="sm"
          >
            <ToggleButton id="audio">{t("transcribe.audio")}</ToggleButton>
            <ToggleButton id="video">{t("transcribe.video")}</ToggleButton>
          </ToggleButtonGroup>
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
            <p className="mt-1.5 text-[12px] tabular-nums text-muted">
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

  // More rows render on scroll approach — never a timed expansion. A fixed
  // 400ms 8→30 swap used to land right in the post-enter interaction window
  // and re-raster the whole page (WKWebView hitch).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= sessionEntries.length) return;
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(sessionEntries.length, c + 12));
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, sessionEntries.length]);

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
        <Reveal>
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
        </Reveal>
      ) : (
        <div className="rlist">
          <AnimatePresence initial={false}>
          {rows.map((entry, i) => {
            const row = (
              <HistoryRow
                entry={entry}
                index={i + 1}
                active={expandedId === entry.id}
                onSelect={() => openRow(entry.id)}
                onDelete={() => onDelete(entry.id)}
              />
            );
            return (
              <motion.div
                key={entry.id}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -12 }}
                transition={springUI}
              >
                {/* Reveal only for the first screenful — long lists stay cheap. */}
                {i < 8 ? <Reveal index={i}>{row}</Reveal> : row}
              </motion.div>
            );
          })}
          </AnimatePresence>
          {visibleCount < sessionEntries.length ? (
            <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
          ) : null}
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

/** Full-screen transcript reader dialog — HeroUI Modal (native enter/exit, Esc/backdrop close, scroll lock). */
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
  // Retain the last entry so the exit animation keeps its content.
  const [lastEntry, setLastEntry] = useState<HistoryEntry | null>(null);
  if (entry && entry !== lastEntry) setLastEntry(entry);
  const shown = entry ?? lastEntry;
  // Transcript vs AI-artifact pane; resets when a different entry opens.
  const [pane, setPane] = useState<WorkPane>("transcript");
  const shownId = shown?.id ?? null;
  useEffect(() => {
    setPane("transcript");
  }, [shownId]);

  const isVideo = shown
    ? isVideoMediaKind(shown.media_kind, shown.audio_path)
    : false;
  const fileName = shown?.audio_path
    ? (shown.audio_path.split("/").filter(Boolean).pop() ?? "")
    : "";

  return (
    <Modal
      isOpen={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog
            aria-label={t("transcribe.detailAria")}
            className="h-[min(85vh,44rem)] w-[min(64rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:w-[min(64rem,calc(100vw-5rem))]"
          >
            {shown ? (
              <>
                <Modal.Header className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
                  <Modal.Heading className="flex flex-wrap items-center gap-3 font-mono text-[12px] font-normal text-muted">
                    <span>{new Date(shown.created_at).toLocaleString()}</span>
                    <span>{shown.duration_seconds.toFixed(1)}s</span>
                    <span className="text-accent-soft-foreground">
                      {shown.language || languageLabel}
                    </span>
                  </Modal.Heading>
                  <div className="flex items-center gap-1.5">
                    <TranscriptExportMenu entry={shown} variant="copy-export" />
                    <Modal.CloseTrigger
                      aria-label={t("transcribe.close")}
                      className="static shrink-0"
                    />
                  </div>
                </Modal.Header>
                {shown.work_id ? (
                  <WorkCard workId={shown.work_id} pane={pane} onPaneChange={setPane} />
                ) : null}
                <Modal.Body className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden p-0 text-foreground">
                  {Viewer ? (
                    <Viewer.Root
                      key={shown.id}
                      text={shown.text}
                      mediaSrc={
                        shown.audio_path ? convertFileSrc(shown.audio_path) : null
                      }
                      mediaKind={isVideo ? "video" : "audio"}
                      durationSeconds={shown.duration_seconds}
                      segments={shown.segments}
                      alignment={shown.alignment}
                      emptyLabel={t("transcribe.emptyResult")}
                    >
                      <div className="flex min-h-0 flex-1">
                        {/* Left: media column — video player, or audio placeholder card */}
                        <div className="flex w-[60%] shrink-0 flex-col border-r border-border bg-surface-secondary/60">
                          {shown.audio_path ? (
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
                                      {shown.duration_seconds.toFixed(1)}s · {t("transcribe.audio")}
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
                        </div>
                        {/* Right: transcript, or work panes that keep the media in view */}
                        <div className="flex min-w-0 flex-1 flex-col">
                          {pane === "artifacts" && shown.work_id ? (
                            <WorkArtifactsPanel workId={shown.work_id} />
                          ) : pane === "research" && shown.work_id ? (
                            <WorkResearchPanel workId={shown.work_id} />
                          ) : (
                            <>
                              <Viewer.ModeToggle className="shrink-0 border-b border-border/60 px-5 py-2.5" />
                              <Viewer.Content
                                fill
                                className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                              />
                            </>
                          )}
                        </div>
                      </div>
                    </Viewer.Root>
                  ) : (
                    <div className="grid flex-1 place-items-center text-[12px] text-muted">
                      {t("transcribe.loadingReader")}
                    </div>
                  )}
                </Modal.Body>
              </>
            ) : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
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
          "mt-0.5 shrink-0 btn-press transition-opacity",
          confirmingDelete
            ? "opacity-100 text-danger text-[12px] font-medium"
            : "text-muted opacity-70 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-danger/10 hover:text-danger data-[hovered=true]:bg-danger/10 data-[hovered=true]:text-danger",
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

/** "已存为作品" strip — linked work folder + transcript/AI-artifact pane toggle. */
type WorkPane = "transcript" | "artifacts" | "research";

const WORK_PANES: { id: WorkPane; labelKey: string }[] = [
  { id: "transcript", labelKey: "works.tabTranscript" },
  { id: "artifacts", labelKey: "works.tabArtifacts" },
  { id: "research", labelKey: "works.tabResearch" },
];

function WorkCard({
  workId,
  pane,
  onPaneChange,
}: {
  workId: string;
  pane: WorkPane;
  onPaneChange: (pane: WorkPane) => void;
}) {
  const t = useT();
  const { works, renameWork, openWorkInFinder } = useApp();
  const work = works.find((w) => w.id === workId);
  const [title, setTitle] = useState(work?.title ?? "");

  useEffect(() => {
    setTitle(work?.title ?? "");
  }, [work?.id, work?.title]);

  if (!work) return null;

  const commitTitle = () => {
    const next = title.trim();
    if (!next || next === work.title) {
      setTitle(work.title);
      return;
    }
    renameWork(work.id, next).catch((error) => {
      setTitle(work.title);
      toast.danger(String(error));
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-5 py-2">
      <FolderOpen size={13} className="shrink-0 text-muted" aria-hidden />
      <input
        value={title}
        aria-label={t("transcribe.work.titleAria")}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setTitle(work.title);
        }}
        className="min-w-0 flex-1 rounded-sm border-b border-transparent bg-transparent text-[13px] font-medium outline-none transition-colors focus:border-accent"
      />
      <div className="flex shrink-0 items-center gap-1" role="tablist">
        {WORK_PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pane === p.id}
            onClick={() => onPaneChange(p.id)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[12px] transition-colors",
              pane === p.id
                ? "bg-accent-soft font-medium text-accent-soft-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="dlink shrink-0"
        onClick={() => void openWorkInFinder(work.id).catch(() => {})}
      >
        {t("transcribe.work.openFolder")}
      </button>
    </div>
  );
}
