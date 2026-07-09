import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toast } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProvider } from "@/app-context";
import { MainLayout } from "@/layouts/main-layout";
import { AsrHud } from "@/windows/asr-hud";
import { OverviewPage } from "@/views/overview-page";
import { TranscribePage } from "@/views/transcribe-page";
import { AsrPage } from "@/views/asr-page";
import { LlmPage } from "@/views/llm-page";
import { VocabularyPage } from "@/views/vocabulary-page";
import { HistoryPage } from "@/views/history-page";
import { SettingsPage } from "@/views/settings-page";

function resolveIsFloatingWindow() {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __ASR_FLOATING__?: boolean };
  if (w.__ASR_FLOATING__) return true;
  if (new URLSearchParams(window.location.search).get("window") === "floating") {
    return true;
  }
  try {
    return getCurrentWindow().label === "floating";
  } catch {
    return false;
  }
}

/**
 * Two-window entry:
 * - main     → control panel (React Router)
 * - floating → ASR HUD capsule
 *
 * IMPORTANT: HeroUI Toast.Provider children are toast *content renderers*,
 * not app wrappers. Keep Provider as a sibling of the routed app.
 */
export function App() {
  const isFloating = resolveIsFloatingWindow();

  if (isFloating) return <AsrHud />;

  return (
    <HashRouter>
      <AppProvider>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="transcribe" element={<TranscribePage />} />
            <Route path="asr" element={<AsrPage />} />
            <Route path="llm" element={<LlmPage />} />
            <Route path="vocabulary" element={<VocabularyPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
      <Toast.Provider placement="bottom" />
    </HashRouter>
  );
}
