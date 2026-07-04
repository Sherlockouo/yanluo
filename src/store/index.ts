import { createSignal } from "solid-js";

/**
 * ASR app state — granular signals for per-property reactivity.
 *
 * Backend wiring is deferred. The shapes here are the contract the UI expects;
 * the actions are placeholders that will be wired to Tauri commands later.
 */

export type AsrMode = "stream" | "offline";

export type RecState = "idle" | "recording" | "processing";

export type HistoryStatus = "pending" | "done" | "failed";

export interface HistoryEntry {
  id: string;
  mode: AsrMode;
  language: string | null; // null = auto-detect
  text: string;
  durationSeconds: number;
  createdAt: string; // ISO
  status: HistoryStatus;
  error: string | null;
}

export interface AsrSettings {
  modelDir: string;
  language: string | null; // null = auto-detect
}

// --- App-level signals ---
const [mode, setMode] = createSignal<AsrMode>("stream");
const [recState, setRecState] = createSignal<RecState>("idle");
const [partialText, setPartialText] = createSignal(""); // streaming incremental text
const [finalText, setFinalText] = createSignal(""); // last completed transcription
const [elapsedMs, setElapsedMs] = createSignal(0); // recording elapsed
const [processing, setProcessing] = createSignal(false);
const [toastMessage, setToastMessage] = createSignal<string | null>(null);

// --- Settings ---
const [modelDir, setModelDir] = createSignal("");
const [language, setLanguage] = createSignal<string | null>(null);

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
