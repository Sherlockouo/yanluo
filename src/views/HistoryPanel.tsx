import { Component, For, Show } from "solid-js";
import { appState, appActions } from "../store";
import {
  HiOutlineClock,
  HiOutlineTrash,
  HiOutlineClipboard,
  HiOutlineSignal,
  HiOutlineDocumentArrowUp,
} from "solid-icons/hi";

/**
 * Right panel — transcription history.
 */
export const HistoryPanel: Component = () => {
  return (
    <aside class="flex flex-col h-screen bg-surface-sidebar border-l border-border overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-4 pt-4 pb-2">
        <div class="flex items-center gap-2">
          <HiOutlineClock class="w-4 h-4 text-accent" />
          <h2 class="text-sm font-semibold text-content-primary">历史记录</h2>
        </div>
        <Show when={appState.history.length > 0}>
          <button
            class="btn-icon !p-1"
            onClick={() => {
              if (confirm("清空所有历史记录？")) appActions.clearHistory();
            }}
            title="Clear all"
          >
            <HiOutlineTrash class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>

      {/* Count badge */}
      <div class="px-4 pb-2">
        <span class="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-accent/10 px-1.5 text-2xs font-medium text-accent">
          {appState.history.length}
        </span>
      </div>

      {/* List */}
      <nav class="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        <For each={appState.history}>
          {(entry) => (
            <HistoryItem entry={entry} />
          )}
        </For>

        <Show when={appState.history.length === 0}>
          <div class="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div class="w-12 h-12 rounded-full bg-surface-secondary flex items-center justify-center mb-3">
              <HiOutlineClock class="w-6 h-6 text-content-tertiary" />
            </div>
            <p class="text-xs text-content-tertiary">暂无转写记录</p>
          </div>
        </Show>
      </nav>
    </aside>
  );
};

const HistoryItem: Component<{ entry: any }> = (props) => {
  const copy = async () => {
    await navigator.clipboard.writeText(props.entry.text);
    appActions.showToast("Copied");
  };

  return (
    <div class="group rounded-lg border border-border bg-surface-primary p-3 hover:border-accent/30 transition-colors duration-150">
      <div class="flex items-center gap-2 mb-1.5">
        <Show
          when={props.entry.mode === "stream"}
          fallback={<HiOutlineDocumentArrowUp class="w-3.5 h-3.5 text-content-tertiary shrink-0" />}
        >
          <HiOutlineSignal class="w-3.5 h-3.5 text-accent shrink-0" />
        </Show>
        <span class="text-2xs text-content-tertiary">
          {formatTime(props.entry.createdAt)}
        </span>
        <Show when={props.entry.language}>
          <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-secondary text-content-tertiary capitalize">
            {props.entry.language}
          </span>
        </Show>
        <div class="flex-1" />
        <Show when={props.entry.status === "done"}>
          <button class="btn-icon !p-0.5 opacity-0 group-hover:opacity-100" onClick={copy} title="Copy">
            <HiOutlineClipboard class="w-3 h-3" />
          </button>
        </Show>
        <button
          class="btn-icon !p-0.5 opacity-0 group-hover:opacity-100 hover:!text-red-500"
          onClick={() => appActions.removeHistory(props.entry.id)}
          title="Delete"
        >
          <HiOutlineTrash class="w-3 h-3" />
        </button>
      </div>

      <Show
        when={props.entry.status === "done"}
        fallback={
          <div class="flex items-center gap-1.5">
            <Show
              when={props.entry.status === "pending"}
              fallback={<span class="text-xs text-red-500">失败</span>}
            >
              <span class="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <span class="text-xs text-content-tertiary">处理中…</span>
            </Show>
          </div>
        }
      >
        <p class="text-xs text-content-primary leading-relaxed line-clamp-3">
          {props.entry.text}
        </p>
        <Show when={props.entry.durationSeconds > 0}>
          <p class="mt-1 text-2xs text-content-tertiary">
            {props.entry.durationSeconds.toFixed(1)}s
          </p>
        </Show>
      </Show>
    </div>
  );
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
