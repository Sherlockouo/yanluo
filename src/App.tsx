import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toast } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProvider } from "@/app-context";
import { MainLayout } from "@/layouts/main-layout";
import { AsrHud } from "@/windows/asr-hud";
import { AsrHudLangChip } from "@/windows/asr-hud-lang";
import { AsrHudAgentMenu } from "@/windows/asr-hud-agent-menu";
import { OverviewPage } from "@/views/overview-page";
import { TranscribePage } from "@/views/transcribe-page";
import { AsrPage } from "@/views/asr-page";
import { LlmPage } from "@/views/llm-page";
import { TranslatePage } from "@/views/translate-page";
import { VocabularyPage } from "@/views/vocabulary-page";
import { HistoryPage } from "@/views/history-page";
import { AgentPage } from "@/views/agent-page";
import { AgentJobPage } from "@/views/agent-job-page";
import { SettingsPage } from "@/views/settings-page";

function resolveFloatingKind():
  | "hud"
  | "lang"
  | "agent-menu"
  | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    __ASR_FLOATING__?: boolean;
    __ASR_FLOATING_LANG__?: boolean;
    __ASR_FLOATING_AGENT_MENU__?: boolean;
  };
  if (w.__ASR_FLOATING_AGENT_MENU__) return "agent-menu";
  if (w.__ASR_FLOATING_LANG__) return "lang";
  if (w.__ASR_FLOATING__) return "hud";
  try {
    const label = getCurrentWindow().label;
    if (label === "floating-agent-menu") return "agent-menu";
    if (label === "floating-lang") return "lang";
    if (label === "floating") return "hud";
  } catch {
    /* ignore */
  }
  if (new URLSearchParams(window.location.search).get("window") === "floating") {
    return "hud";
  }
  return null;
}

/**
 * Multi-window entry:
 * - main                 → control panel (React Router)
 * - floating             → ASR + Agent HUD capsule
 * - floating-lang        → translate target chip
 * - floating-agent-menu  → agent/cwd picker (outside HUD)
 */
export function App() {
  const floatingKind = resolveFloatingKind();

  if (floatingKind === "agent-menu") return <AsrHudAgentMenu />;
  if (floatingKind === "lang") return <AsrHudLangChip />;
  if (floatingKind === "hud") return <AsrHud />;

  return (
    <HashRouter>
      <AppProvider>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="transcribe" element={<TranscribePage />} />
            <Route path="translate" element={<TranslatePage />} />
            <Route path="asr" element={<AsrPage />} />
            <Route path="llm" element={<LlmPage />} />
            <Route path="vocabulary" element={<VocabularyPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="agent" element={<AgentPage />} />
            <Route path="agent/:id" element={<AgentJobPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
      <Toast.Provider placement="bottom" />
    </HashRouter>
  );
}
