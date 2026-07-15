import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Toast } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProvider } from "@/app-context";
import { MainLayout } from "@/layouts/main-layout";
import { AsrHud } from "@/windows/asr-hud";
import { AsrHudLangChip } from "@/windows/asr-hud-lang";
import { AsrHudAgentMenu } from "@/windows/asr-hud-agent-menu";
import { OverviewPage } from "@/views/overview-page";
import { DraftPage } from "@/views/draft-page";
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

/** `/transcribe` `/asr` `/history` `/translate` → 出稿 modes (old bookmarks/deep-links). */
function RedirectToDraft({ mode }: { mode?: string }) {
  const [search] = useSearchParams();
  const target = mode ?? search.get("mode") ?? undefined;
  return <Navigate to={target ? `/draft?mode=${target}` : "/draft"} replace />;
}

/** `/llm` `/vocabulary` → 设置 tabs (absorbed capability pages). */
function RedirectToSettings({ tab }: { tab: string }) {
  return <Navigate to={`/settings?tab=${tab}`} replace />;
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
            <Route path="draft" element={<DraftPage />} />
            <Route path="dispatch" element={<AgentPage />} />
            <Route path="dispatch/:id" element={<AgentJobPage />} />
            <Route path="settings" element={<SettingsPage />} />

            {/* Redirects — old routes keep working, nothing 404s. */}
            <Route path="transcribe" element={<RedirectToDraft mode="file" />} />
            <Route path="asr" element={<RedirectToDraft mode="live" />} />
            <Route path="history" element={<RedirectToDraft mode="history" />} />
            <Route path="translate" element={<RedirectToDraft mode="translate" />} />
            <Route path="llm" element={<RedirectToSettings tab="refine" />} />
            <Route path="vocabulary" element={<RedirectToSettings tab="vocabulary" />} />
            <Route path="agent" element={<Navigate to="/dispatch" replace />} />
            <Route path="agent/:id" element={<LegacyAgentJobRedirect />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
      <Toast.Provider placement="bottom" />
    </HashRouter>
  );
}

function LegacyAgentJobRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/dispatch/${id ?? ""}`} replace />;
}
