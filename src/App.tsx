import { Component, Show } from "solid-js";
import { Sidebar } from "./views/Sidebar";
import { StreamPanel } from "./views/StreamPanel";
import { OfflinePanel } from "./views/OfflinePanel";
import { HistoryPanel } from "./views/HistoryPanel";
import { appState } from "./store";

/**
 * Three-column shell — Sidebar (modes+settings) · Main (active panel) · History.
 */
export const App: Component = () => {
  return (
    <div class="grid grid-cols-[260px_1fr_300px] h-screen w-screen overflow-hidden">
      <Sidebar />

      <main class="flex flex-col overflow-hidden bg-surface-primary">
        <Show when={appState.mode === "stream"} fallback={<OfflinePanel />}>
          <StreamPanel />
        </Show>
      </main>

      <HistoryPanel />

      {/* Toast */}
      <Show when={appState.toastMessage}>
        <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-slide-up">
          <div class="rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-sm font-medium text-content-primary shadow-elevated backdrop-blur-sm">
            {appState.toastMessage}
          </div>
        </div>
      </Show>
    </div>
  );
};
