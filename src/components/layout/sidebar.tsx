import { NavLink } from "react-router-dom";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  AudioLines,
  BookOpen,
  Bot,
  Brain,
  Languages,
  Mic,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
  Wand2,
} from "lucide-react";
import type { Page } from "@/types";
import { NAV_GROUPS } from "@/lib/constants";
import { navIndicatorTransition } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
import { Button } from "@heroui/react";

const ICONS: Record<Page, typeof Mic> = {
  overview: PanelsTopLeft,
  transcribe: AudioLines,
  translate: Languages,
  asr: Brain,
  llm: Wand2,
  vocabulary: BookOpen,
  history: Activity,
  agent: Bot,
  settings: Settings,
};

const PATHS: Record<Page, string> = {
  overview: "/",
  transcribe: "/transcribe",
  translate: "/translate",
  asr: "/asr",
  llm: "/llm",
  vocabulary: "/vocabulary",
  history: "/history",
  agent: "/agent",
  settings: "/settings",
};

export function Sidebar() {
  const { theme, setTheme, config } = useApp();
  const reduce = useReducedMotion();
  const hint = `${config.hotkey_transcribe?.label ?? "Fn"} · ${config.hotkey_cancel?.label ?? "Esc"}`;

  return (
    <aside className="app-sidebar">
      <div className="flex items-center gap-3 px-2.5 pb-1">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-default text-foreground ring-1 ring-border">
          <Mic size={17} />
        </div>
        <div className="min-w-0">
          <div className="truncate type-ui font-display tracking-tight">
            ASR Workshop
          </div>
          <div className="truncate type-meta">{hint}</div>
        </div>
      </div>

      <LayoutGroup id="sidebar-nav">
        <nav className="mt-7 flex flex-1 flex-col gap-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = ICONS[item.id];
                return (
                  <NavLink
                    key={item.id}
                    to={PATHS[item.id]}
                    end={item.id === "overview"}
                    className={({ isActive }) =>
                      cn("nav-item", isActive && "nav-item-active")
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && !reduce ? (
                          <motion.span
                            layoutId="nav-active"
                            className="nav-item-indicator"
                            transition={navIndicatorTransition}
                          />
                        ) : isActive ? (
                          <span className="nav-item-indicator" />
                        ) : null}
                        <Icon
                          size={16}
                          className="relative z-10 shrink-0 opacity-75"
                        />
                        <span className="relative z-10 type-ui">
                          {item.label}
                        </span>
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex items-center gap-1.5">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "nav-item flex-1 justify-center gap-2 !px-2",
                isActive && "nav-item-active",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && !reduce ? (
                  <motion.span
                    layoutId="nav-active"
                    className="nav-item-indicator"
                    transition={navIndicatorTransition}
                  />
                ) : isActive ? (
                  <span className="nav-item-indicator" />
                ) : null}
                <Settings size={15} className="relative z-10" />
                <span className="relative z-10 type-ui">设置</span>
              </>
            )}
          </NavLink>
          <Button
            type="button"
            aria-label={theme === "dark" ? "切换浅色" : "切换深色"}
            className="nav-item !w-11 shrink-0 justify-center !px-0 rounded-lg opacity-70 hover:opacity-100"
            onClick={() =>
              setTheme((prev) => (prev === "dark" ? "light" : "dark"))
            }
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
        </div>
      </LayoutGroup>
    </aside>
  );
}
