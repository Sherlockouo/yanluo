import { createSignal } from "solid-js";

/**
 * ASR app state — granular signals for per-property reactivity.
 */

export type AsrMode = "stream" | "offline";

export type RecState = "idle" | "recording" | "processing";

export type HistoryStatus = "pending" | "done" | "failed";

export interface HistoryEntry {
  id: string;
  mode: AsrMode;
  language: string | null;
  text: string;
  durationSeconds: number;
  createdAt: string;
  status: HistoryStatus;
  error: string | null;
}

// --- App-level signals ---
const [mode, setMode] = createSignal<AsrMode>("stream");
const [recState, setRecState] = createSignal<RecState>("idle");
const [partialText, setPartialText] = createSignal("");
const [finalText, setFinalText] = createSignal("");
const [elapsedMs, setElapsedMs] = createSignal(0);
const [processing, setProcessing] = createSignal(false);
const [toastMessage, setToastMessage] = createSignal<string | null>(null);

// --- Settings ---
/// Default model path — update to match your local download.
const [modelDir, setModelDir] = createSignal("/Users/xbcoder/project/Qwen3-ASR/models");
const [language, setLanguage] = createSignal<string | null>(null);

// --- Engine status ---
const [modelLoaded, setModelLoaded] = createSignal(false);
const [modelLoading, setModelLoading] = createSignal(false);

// --- History ---
const [history, setHistory] = createSignal<HistoryEntry[]>([]);

export const appState = {
  get mode() { return mode(); },
  get recState() { return recState(); },
  get partialText() { return partialText(); },
  get finalText() { return finalText(); },
  get elapsedMs() { return elapsedMs(); },
  get processing() { return processing(); },
  get toastMessage() { return toastMessage(); },
  get modelDir() { return modelDir(); },
  get language() { return language(); },
  get modelLoaded() { return modelLoaded(); },
  get modelLoading() { return modelLoading(); },
  get history() { return history(); },
};

export const appActions = {
  setMode,
  setRecState,
  setPartialText,
  appendPartial: (chunk: string) => setPartialText((prev) => prev + chunk),
  setFinalText,
  setElapsedMs,
  setProcessing,
  setModelDir,
  setLanguage,
  setModelLoaded,
  setModelLoading,
  showToast: (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  },
  clearText: () => {
    setPartialText("");
    setFinalText("");
  },
  addHistory: (entry: HistoryEntry) => setHistory((prev) => [entry, ...prev]),
  updateHistory: (id: string, patch: Partial<HistoryEntry>) =>
    setHistory((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h))),
  removeHistory: (id: string) => setHistory((prev) => prev.filter((h) => h.id !== id)),
  clearHistory: () => setHistory([]),
};
