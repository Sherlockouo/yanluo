import { NavLink } from "react-router-dom";
import {
  Activity,
  AudioLines,
  BookOpen,
  Brain,
  Mic,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
  Wand2,
} from "lucide-react";
import type { Page } from "@/types";
import { NAV } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";

const ICONS: Record<Page, typeof Mic> = {
  overview: PanelsTopLeft,
  transcribe: AudioLines,
  asr: Brain,
  llm: Wand2,
  vocabulary: BookOpen,
  history: Activity,
  settings: Settings,
};

const PATHS: Record<Page, string> = {
  overview: "/",
  transcribe: "/transcribe",
  asr: "/asr",
  llm: "/llm",
  vocabulary: "/vocabulary",
  history: "/history",
  settings: "/settings",
};

export function Sidebar() {
  const { theme, setTheme } = useApp();

  return (
    <aside className="app-sidebar">
      <div className="flex items-center gap-3 px-2">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-default text-foreground ring-1 ring-border">
          <Mic size={18} />
        </div>
        <div className="min-w-0">
          <div className="truncate font-display text-sm font-semibold text-foreground">
            ASR Workshop
          </div>
          <div className="truncate text-[11px] text-muted">按住 Fn 说话</div>
        </div>
      </div>

      <nav className="mt-8 flex flex-1 flex-col gap-1">
        {NAV.filter((item) => item.id !== "settings").map((item) => {
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
              <Icon size={16} className="shrink-0 opacity-80" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-[11px] text-muted">{item.hint}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto grid grid-cols-2 gap-2">
        <button
          type="button"
          className="nav-item justify-center gap-2 !px-2"
          onClick={() =>
            setTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
          title={theme === "dark" ? "切换浅色" : "切换深色"}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          <span className="text-sm font-medium">
            {theme === "dark" ? "浅色" : "深色"}
          </span>
        </button>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn("nav-item justify-center gap-2 !px-2", isActive && "nav-item-active")
          }
        >
          <Settings size={15} />
          <span className="text-sm font-medium">设置</span>
        </NavLink>
      </div>
    </aside>
  );
}
