import { Component, Show, createSignal } from "solid-js";
import { appState, appActions, type HistoryEntry } from "../store";
import { cn } from "../lib/cn";
import {
  HiOutlineDocumentArrowUp,
  HiOutlinePlay,
  HiOutlineTrash,
  HiOutlineClipboard,
  HiOutlineCheckCircle,
  HiOutlineExclamationCircle,
} from "solid-icons/hi";

/**
 * Offline file transcription panel.
 *
 * Upload an audio file → transcribe → show result.
 * Backend wiring (Tauri command for file-based inference) is deferred.
 */
export const OfflinePanel: Component = () => {
  const [audioFile, setAudioFile] = createSignal<File | null>(null);
  const [audioUrl, setAudioUrl] = createSignal<string | null>(null);
  const [transcribing, setTranscribing] = createSignal(false);
  const [result, setResult] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);

  const pickFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => handleFile(input.files?.[0] || null);
    input.click();
  };

  const handleFile = (file: File | null) => {
    if (!file) return;
    setAudioFile(file);
    setResult(null);
    setError(null);
    if (audioUrl()) URL.revokeObjectURL(audioUrl()!);
    setAudioUrl(URL.createObjectURL(file));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("audio/")) handleFile(file);
  };

  const transcribe = async () => {
    const file = audioFile();
    if (!file) return;
    setTranscribing(true);
    setError(null);
    setResult(null);

    const historyId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const entry: HistoryEntry = {
      id: historyId,
      mode: "offline",
      language: appState.language,
      text: "",
      durationSeconds: 0,
      createdAt: new Date().toISOString(),
      status: "pending",
      error: null,
    };
    appActions.addHistory(entry);

    try {
      // TODO: invoke("transcribe_file", { path, modelDir, language })
      //       — pass file path to Rust, get back { text, language, duration }
      // For now, mock after a delay.
      await new Promise((r) => setTimeout(r, 1500));
      const mockText = "这是离线转写的示例文本。接入后端后将替换为真实识别结果。";
      setResult(mockText);
      appActions.updateHistory(historyId, {
        text: mockText,
        status: "done",
        durationSeconds: file.size / 32000, // placeholder
      });
      appActions.showToast("Transcription complete");
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      appActions.updateHistory(historyId, { status: "failed", error: msg });
      appActions.showToast(`Failed: ${msg}`);
    } finally {
      setTranscribing(false);
    }
  };

  const reset = () => {
    if (audioUrl()) URL.revokeObjectURL(audioUrl()!);
    setAudioFile(null);
    setAudioUrl(null);
    setResult(null);
    setError(null);
  };

  const copyText = async () => {
    if (!result()) return;
    await navigator.clipboard.writeText(result()!);
    appActions.showToast("Copied to clipboard");
  };

  return (
    <div class="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div class="px-6 pt-5 pb-4 border-b border-border">
        <h2 class="text-base font-semibold text-content-primary">离线文件转写</h2>
        <p class="text-xs text-content-tertiary mt-0.5">上传音频文件，整段转写</p>
      </div>

      {/* Main area */}
      <div class="flex-1 overflow-y-auto px-6 py-6">
        <div class="max-w-3xl mx-auto space-y-5">
          {/* Drop zone / file picker */}
          <Show
            when={!audioFile()}
            fallback={
              <div class="rounded-xl border border-border bg-surface-secondary p-4 animate-slide-up">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                    <HiOutlineDocumentArrowUp class="w-5 h-5 text-accent" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-content-primary truncate">
                      {audioFile()!.name}
                    </p>
                    <p class="text-2xs text-content-tertiary">
                      {(audioFile()!.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <button class="btn-icon" onClick={reset} title="Remove">
                    <HiOutlineTrash class="w-4 h-4" />
                  </button>
                </div>
              </div>
            }
          >
            <div
              class={cn(
                "rounded-xl border-2 border-dashed p-10 text-center transition-all duration-150 cursor-pointer",
                dragging()
                  ? "border-accent bg-accent/5"
                  : "border-border hover:border-accent/50 hover:bg-surface-secondary"
              )}
              onClick={pickFile}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <div class="w-14 h-14 mx-auto rounded-full bg-surface-secondary flex items-center justify-center mb-3">
                <HiOutlineDocumentArrowUp class="w-7 h-7 text-content-tertiary" />
              </div>
              <p class="text-sm font-medium text-content-primary">拖拽音频文件到此处</p>
              <p class="text-xs text-content-tertiary mt-1">或点击选择 · WAV / MP3 / FLAC / OGG</p>
            </div>
          </Show>

          {/* Audio preview */}
          <Show when={audioUrl()}>
            <div class="rounded-xl border border-border bg-surface-secondary p-4">
              <div class="flex items-center gap-2 mb-2">
                <HiOutlinePlay class="w-4 h-4 text-accent" />
                <span class="text-xs font-medium text-content-secondary">预览</span>
              </div>
              <audio controls src={audioUrl()!} class="w-full h-10 rounded-lg" />
            </div>
          </Show>

          {/* Transcribe button */}
          <Show when={audioFile()}>
            <button
              class={cn(
                "btn-primary w-full py-3 text-sm font-semibold",
                transcribing() && "animate-pulse"
              )}
              onClick={transcribe}
              disabled={transcribing()}
            >
              <Show
                when={transcribing()}
                fallback={
                  <>
                    <HiOutlinePlay class="w-4 h-4" />
                    开始转写
                  </>
                }
              >
                <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                转写中…
              </Show>
            </button>
          </Show>

          {/* Result */}
          <Show when={result()}>
            <div class="rounded-xl border border-border bg-surface-secondary p-5 animate-slide-up">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <HiOutlineCheckCircle class="w-4 h-4 text-green-500" />
                  <span class="text-sm font-medium text-content-primary">转写结果</span>
                </div>
                <button class="btn-icon !p-1.5" onClick={copyText} title="Copy">
                  <HiOutlineClipboard class="w-3.5 h-3.5" />
                </button>
              </div>
              <p class="text-base leading-relaxed text-content-primary whitespace-pre-wrap">
                {result()}
              </p>
            </div>
          </Show>

          {/* Error */}
          <Show when={error()}>
            <div class="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <div class="flex items-center gap-2">
                <HiOutlineExclamationCircle class="w-4 h-4 text-red-500" />
                <span class="text-sm font-medium text-red-500">转写失败</span>
              </div>
              <p class="mt-1.5 text-xs text-content-secondary">{error()}</p>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};
