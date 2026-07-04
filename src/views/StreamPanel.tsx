import { Component, Show, onCleanup, onMount } from "solid-js";
import { appState, appActions, type HistoryEntry } from "../store";
import { cn } from "../lib/cn";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  HiOutlineMicrophone,
  HiOutlineStopCircle,
  HiOutlineTrash,
  HiOutlineClipboard,
  HiOutlineCheckCircle,
} from "solid-icons/hi";

/**
 * Real-time streaming ASR panel.
 *
 * Record audio → transcribe → display result.
 * Backend: Tauri commands (start_recording / stop_recording).
 * Result arrives via `transcription-result` event.
 */
export const StreamPanel: Component = () => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;
  let unlisten: UnlistenFn | null = null;

  onMount(async () => {
    unlisten = await listen<{
      text: string;
      language: string;
      duration_seconds: number;
      error: string | null;
    }>("transcription-result", (event) => {
      const r = event.payload;
      appActions.setRecState("idle");
      if (r.error) {
        appActions.showToast(r.error);
        return;
      }
      appActions.setFinalText(r.text);

      const entry: HistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        mode: "stream",
        language: r.language || appState.language,
        text: r.text,
        durationSeconds: r.duration_seconds,
        createdAt: new Date().toISOString(),
        status: "done",
        error: null,
      };
      appActions.addHistory(entry);
      appActions.showToast(`Transcribed ${r.duration_seconds.toFixed(1)}s audio`);
    });
  });

  onCleanup(() => {
    if (timer) clearInterval(timer);
    if (unlisten) unlisten();
  });

  const startRecording = async () => {
    if (!appState.modelLoaded) {
      appActions.showToast("Please load the model first");
      return;
    }
    try {
      await invoke("start_recording");
    } catch (e) {
      appActions.showToast(`Failed to start: ${e}`);
      return;
    }
    appActions.clearText();
    appActions.setRecState("recording");
    startTime = Date.now();
    timer = setInterval(() => {
      appActions.setElapsedMs(Date.now() - startTime);
    }, 100);
  };

  const stopRecording = async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    appActions.setRecState("processing");
    try {
      await invoke("stop_recording");
    } catch (e) {
      appActions.showToast(`Failed to stop: ${e}`);
    }
    // Result will arrive via transcription-result event
  };

  const copyText = async () => {
    const text = appState.finalText;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    appActions.showToast("Copied to clipboard");
  };

  const clearAll = () => {
    appActions.clearText();
    appActions.setElapsedMs(0);
  };

  return (
    <div class="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
        <div>
          <h2 class="text-base font-semibold text-content-primary">实时流式识别</h2>
          <p class="text-xs text-content-tertiary mt-0.5">录音 → 转写，一键完成</p>
        </div>
        <Show when={appState.recState === "recording"}>
          <div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10">
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span class="text-xs font-medium text-red-500 font-mono">
              {formatTime(appState.elapsedMs)}
            </span>
          </div>
        </Show>
      </div>

      {/* Main area */}
      <div class="flex-1 overflow-y-auto px-6 py-6">
        <div class="max-w-3xl mx-auto space-y-6">
          {/* Record control */}
          <div class="flex flex-col items-center py-8">
            <button
              class={cn(
                "relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-200 active:scale-95",
                appState.recState === "recording"
                  ? "bg-red-500 hover:bg-red-600"
                  : appState.recState === "processing"
                    ? "bg-yellow-500 cursor-wait"
                    : "bg-accent hover:bg-accent-hover"
              )}
              onClick={() =>
                appState.recState === "recording" ? stopRecording() : startRecording()
              }
              disabled={appState.recState === "processing"}
            >
              <Show
                when={appState.recState === "recording"}
                fallback={
                  appState.recState === "processing" ? (
                    <svg class="w-8 h-8 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <HiOutlineMicrophone class="w-9 h-9 text-white" />
                  )
                }
              >
                <HiOutlineStopCircle class="w-9 h-9 text-white" />
              </Show>

              <Show when={appState.recState === "recording"}>
                <span class="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-20" />
              </Show>
            </button>
            <p class="mt-4 text-sm font-medium text-content-secondary">
              <Show
                when={appState.recState === "recording"}
                fallback={
                  appState.recState === "processing" ? "转写中…" : "点击开始录音"
                }
              >
                点击停止
              </Show>
            </p>
          </div>

          {/* Transcription output */}
          <Show when={appState.finalText}>
            <div class="rounded-xl border border-border bg-surface-secondary p-5 animate-slide-up">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <HiOutlineCheckCircle class="w-4 h-4 text-green-500" />
                  <span class="text-sm font-medium text-content-primary">转写结果</span>
                </div>
                <div class="flex items-center gap-1">
                  <button class="btn-icon !p-1.5" onClick={copyText} title="Copy">
                    <HiOutlineClipboard class="w-3.5 h-3.5" />
                  </button>
                  <button class="btn-icon !p-1.5" onClick={clearAll} title="Clear">
                    <HiOutlineTrash class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <p class="text-base leading-relaxed text-content-primary whitespace-pre-wrap break-words min-h-[3rem]">
                {appState.finalText}
              </p>
            </div>
          </Show>

          {/* Empty hint */}
          <Show when={!appState.finalText && appState.recState === "idle"}>
            <div class="text-center py-8">
              <p class="text-sm text-content-tertiary">
                加载模型后，点击麦克风开始录音转写
              </p>
            </div>
          </Show>

          {/* Processing indicator */}
          <Show when={appState.recState === "processing"}>
            <div class="flex flex-col items-center py-6">
              <svg class="w-8 h-8 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p class="mt-3 text-sm text-content-secondary">正在转写，请稍候...</p>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}
