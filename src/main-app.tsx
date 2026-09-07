import { lazy, Suspense } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Toast } from "@heroui/react";
import { AppProvider } from "@/app-context";
import { MainLayout } from "@/layouts/main-layout";

const OverviewPage = lazy(() =>
  import("@/views/overview-page").then((m) => ({ default: m.OverviewPage })),
);
const DraftPage = lazy(() =>
  import("@/views/draft-page").then((m) => ({ default: m.DraftPage })),
);
const AgentPage = lazy(() =>
  import("@/views/agent-page").then((m) => ({ default: m.AgentPage })),
);
const AgentJobPage = lazy(() =>
  import("@/views/agent-job-page").then((m) => ({ default: m.AgentJobPage })),
);
const SettingsPage = lazy(() =>
  import("@/views/settings-page").then((m) => ({ default: m.SettingsPage })),
);

function RedirectToDraft({ mode }: { mode?: string }) {
  const [search] = useSearchParams();
  const target = mode ?? search.get("mode") ?? undefined;
  return <Navigate to={target ? `/draft?mode=${target}` : "/draft"} replace />;
}

function RedirectToSettings({ tab }: { tab: string }) {
  return <Navigate to={`/settings?tab=${tab}`} replace />;
}

function LegacyAgentJobRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/dispatch/${id ?? ""}`} replace />;
}

export function MainApp() {
  return (
    <HashRouter>
      <AppProvider>
        <Suspense fallback={null}>
          <Routes>
            <Route element={<MainLayout />}>
              <Route index element={<OverviewPage />} />
              <Route path="draft" element={<DraftPage />} />
              <Route path="dispatch" element={<AgentPage />} />
              <Route path="dispatch/:id" element={<AgentJobPage />} />
              <Route path="settings" element={<SettingsPage />} />
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
        </Suspense>
      </AppProvider>
      <Toast.Provider placement="top end" maxVisibleToasts={2} />
    </HashRouter>
  );
}
