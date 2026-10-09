/**
 * Dev-only Tauri IPC mock so the frontend runs in a plain browser for
 * performance profiling. Self-gates: only active with `?mock=1` in the URL
 * (and only in dev builds). Imported for its side effect from main.tsx.
 */
import { defaultConfig } from "@/lib/constants";
import type { HistoryEntry } from "@/types";

const ENABLED =
  new URLSearchParams(window.location.search).get("mock") === "1";

function fakeEntry(i: number, source: string, chars: number): HistoryEntry {
  const seed =
    "那些公募基金他们能看到的是一年或者三年然后巴菲特还能看到五年十年二十年那么在这个角度上巴菲特获得了超额收益" +
    "我们今天因为是直面对A股市场那么你要获得超额收益的话你应该更多的去学习过去的经验";
  let text = "";
  while (text.length < chars) text += seed;
  text = text.slice(0, chars);
  return {
    id: `mock-${source}-${i}`,
    text,
    raw_text: text,
    llm_text: null,
    user_text: null,
    language: "zh",
    duration_seconds: 127 + i * 137.3,
    created_at: new Date(Date.now() - i * 86400000 * 7).toISOString(),
    refined: true,
    audio_path: `/tmp/mock-${i}.mp4`,
    media_kind: i % 2 === 0 ? "video" : "audio",
    source,
    quality_rating: null,
    rated_at: null,
    learn_status: null,
  };
}

const MOCK_HISTORY: HistoryEntry[] = [
  // Mirror the real dataset: ~821 entries / 3.4MB (user's actual history.json).
  ...Array.from({ length: 60 }, (_, i) => fakeEntry(i, "transcribe", 1400)),
  ...Array.from({ length: 700 }, (_, i) => fakeEntry(i + 100, "fn", 80)),
  ...Array.from({ length: 61 }, (_, i) => fakeEntry(i + 900, "translate", 70)),
];

const MOCK_JOBS = Array.from({ length: 9 }, (_, i) => ({
  id: `job-${i}`,
  agent: "claude",
  prompt: `mock job ${i}`,
  cwd: "/tmp",
  status: i === 0 ? "running" : "done",
  created_at: new Date(Date.now() - i * 3600000).toISOString(),
  updated_at: new Date(Date.now() - i * 3600000).toISOString(),
  progress: null,
  session_id: null,
  events: [],
  attachments: [],
}));

function respond(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "get_app_config":
      return defaultConfig;
    case "get_history":
      return MOCK_HISTORY;
    case "get_history_entry":
      return MOCK_HISTORY[0];
    case "list_agent_jobs":
      return MOCK_JOBS;
    case "get_agent_models":
    case "refresh_agent_models":
      return null;
    case "get_ytdlp_status":
      return {
        available: true,
        path: "/opt/homebrew/bin/yt-dlp",
        version: "2024.1.1",
        ffmpeg_available: true,
        hint: null,
      };
    case "plugin:event|listen": {
      const event = args?.event as string | undefined;
      const handler = args?.handler as number | undefined;
      const eventId = Math.floor(Math.random() * 1e9);
      if (event && handler != null) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      }
      return eventId;
    }
    case "plugin:event|unlisten":
    case "save_app_config":
    case "set_model_dir":
    case "load_model":
      return null;
    default:
      return null;
  }
}

const eventHandlers = new Map<string, number[]>();

/** Emit a fake backend event to all JS listeners of `event`. */
function emit(event: string, payload: unknown): void {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { callbacks: Map<number, (d: unknown) => void> };
  };
  for (const id of eventHandlers.get(event) ?? []) {
    w.__TAURI_INTERNALS__.callbacks.get(id)?.({ event, id: 0, payload });
  }
}

/** Simulate a running agent job streaming deltas (the real app has one). */
function startStreamSimulation(): void {
  let n = 0;
  window.setInterval(() => {
    n += 1;
    emit("agent-job-stream", {
      id: "job-0",
      progress: Math.min(99, n),
      event: {
        ts: new Date().toISOString(),
        kind: "text",
        text: `stream delta ${n} — 正在处理转写文本……`,
      },
    });
  }, 100);
}

if (ENABLED) {
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let nextCb = 1;
  const w = window as unknown as {
    __TAURI_INTERNALS__: Record<string, unknown>;
  };
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    invoke: (cmd: string, args?: Record<string, unknown>) =>
      Promise.resolve(respond(cmd, args)),
    transformCallback: (cb: (...args: unknown[]) => void) => {
      const id = nextCb++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id);
    },
    convertFileSrc: (p: string) => p,
    plugins: {},
    callbacks,
  };
  // eslint-disable-next-line no-console
  console.info("[tauri-mock] active — IPC returns canned data");
  startStreamSimulation();
}
