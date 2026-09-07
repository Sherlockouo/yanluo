import { lazy, Suspense, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const MainApp = lazy(() => import("@/main-app").then(named("MainApp")));
const AsrHud = lazy(() => import("@/windows/asr-hud").then(named("AsrHud")));
const AsrHudLangChip = lazy(() =>
  import("@/windows/asr-hud-lang").then(named("AsrHudLangChip")),
);
const AsrHudAgentMenu = lazy(() =>
  import("@/windows/asr-hud-agent-menu").then(named("AsrHudAgentMenu")),
);

function named<T extends Record<K, ComponentType>, K extends keyof T>(key: K) {
  return (module: T) => ({ default: module[key] });
}

function resolveFloatingKind(): "hud" | "lang" | "agent-menu" | null {
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
    // Browser preview.
  }
  return new URLSearchParams(window.location.search).get("window") === "floating"
    ? "hud"
    : null;
}

/** Each window downloads only its own entry chunk. */
export function App() {
  const floatingKind = resolveFloatingKind();
  const content =
    floatingKind === "agent-menu" ? (
      <AsrHudAgentMenu />
    ) : floatingKind === "lang" ? (
      <AsrHudLangChip />
    ) : floatingKind === "hud" ? (
      <AsrHud />
    ) : (
      <MainApp />
    );
  return <Suspense fallback={null}>{content}</Suspense>;
}
