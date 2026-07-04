import { Component, Show, onCleanup } from "solid-js";
import { appState, appActions, type HistoryEntry } from "../store";
import { cn } from "../lib/cn";
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
 * Record → live transcription appears incrementally as you speak.
 * Backend wiring (Tauri commands for mic capture + streaming inference)
 * is deferred. UI is fully functional against the store.
 */
export const StreamPanel: Component = () => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;

  const startRecording = async () => {
    // TODO: invoke("start_stream_asr", { modelDir, language })
    appActions.clearText();
    appActions.setRecState("recording");
    startTime = Date.now();
    timer = setInterval(() => {
      appActions.setElapsedMs(Date.now() - startTime);
    }, 100);

    // --- MOCK streaming text (remove when backend wired) ---
    mockStream();
  };

  const stopRecording = async () => {
    // TODO: invoke("stop_stream_asr")
    if (timer) { clearInterval(timer); timer = null; }
    appActions.setRecState("processing");
    appActions.setProcessing(true);

    const finalText = appState.partialText;
    appActions.setFinalText(finalText);

    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      mode: "stream",
      language: appState.language,
      text: finalText,
      durationSeconds: appState.elapsedMs / 1000,
      createdAt: new Date().toISOString(),
      status: "done",
      error: null,
    };
    appActions.addHistory(entry);

    appActions.setProcessing(false);
    appActions.setRecState("idle");
    appActions.showToast(`Transcribed ${(appState.elapsedMs / 1000).toFixed(1)}s audio`);
  };

  const copyText = async () => {
    const text = appState.partialText || appState.finalText;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    appActions.showToast("Copied to clipboard");
  };

  const clearAll = () => {
    appActions.clearText();
    appActions.setElapsedMs(0);
  };

  onCleanup(() => { if (timer) clearInterval(timer); });

  // --- MOCK: simulate streaming partials ---
  const mockPhrases = [
    "这是一段 ",
    "实时语音识别的 ",
    "演示文本。 ",
    "当后端接入后， ",
    "这里会显示 ",
    "流式增量结果。",
  ];
  let mockIdx = 0;
  const mockStream = () => {
    const tick = () => {
      if (appState.recState !== "recording") return;
      if (mockIdx < mockPhrases.length) {
        appActions.appendPartial(mockPhrases[mockIdx++]);
        setTimeout(tick, 800);
      }
    };
    setTimeout(tick, 600);
  };

  return (
    <div class="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
        <div>
          <h2 class="text-base font-semibold text-content-primary">实时流式识别</h2>
          <p class="text-xs text-content-tertiary mt-0.5">边录音边转写，实时输出</p>
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
                  : "bg-accent hover:bg-accent-hover",
                appState.recState === "processing" && "opacity-50 cursor-wait"
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

              {/* Pulsing ring while recording */}
              <Show when={appState.recState === "recording"}>
                <span class="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-20" />
              </Show>
            </button>
            <p class="mt-4 text-sm font-medium text-content-secondary">
              <Show
                when={appState.recState === "recording"}
                fallback={
                  appState.recState === "processing" ? "处理中…" : "点击开始录音"
                }
              >
                点击停止
              </Show>
            </p>
          </div>

          {/* Transcription output */}
          <Show when={appState.partialText || appState.finalText}>
            <div class="rounded-xl border border-border bg-surface-secondary p-5 animate-slide-up">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <HiOutlineCheckCircle class="w-4 h-4 text-accent" />
                  <span class="text-sm font-medium text-content-primary">转写结果</span>
                  <Show when={appState.recState === "recording"}>
                    <span class="flex items-center gap-1 text-2xs text-content-tertiary">
                      <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                      live
                    </span>
                  </Show>
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
                {appState.partialText || appState.finalText}
                <Show when={appState.recState === "recording"}>
                  <span class="inline-block w-0.5 h-5 bg-accent ml-0.5 animate-pulse align-middle" />
                </Show>
              </p>
            </div>
          </Show>

          {/* Empty hint */}
          <Show when={!appState.partialText && !appState.finalText && appState.recState === "idle"}>
            <div class="text-center py-8">
              <p class="text-sm text-content-tertiary">
                录音后，转写文本将实时显示在这里
              </p>
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
