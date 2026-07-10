import { NavLink } from "react-router-dom";
import {
  Activity,
  AudioLines,
  BookOpen,
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
import { NAV } from "@/lib/constants";
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
  settings: "/settings",
};

export function Sidebar() {
  const { theme, setTheme, config } = useApp();
  const hint = `${config.hotkey_transcribe?.label ?? "Fn"} · ${config.hotkey_cancel?.label ?? "Esc"}`;

  return (
    <aside className="app-sidebar">
      <div className="flex items-center gap-3 px-2.5 pb-1">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-default text-foreground ring-1 ring-border">
          <Mic size={17} />
        </div>
        <div className="min-w-0">
          <div className="truncate font-display text-[13px] font-semibold tracking-tight text-foreground">
            ASR Workshop
          </div>
          <div className="truncate text-[11px] text-muted">{hint}</div>
        </div>
      </div>

      <nav className="mt-7 flex flex-1 flex-col gap-0.5">
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
              <Icon size={16} className="shrink-0 opacity-75" />
              <span className="text-sm font-medium">{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto grid grid-cols-2 gap-1.5">
      <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "nav-item justify-center gap-2 !px-2",
              isActive && "nav-item-active",
            )
          }
        >
          <Settings size={15} />
          <span className="text-[13px] font-medium">设置</span>
        </NavLink>
        <Button
          type="button"
          className="nav-item justify-center gap-2 rounded-lg"
          onClick={() =>
            setTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          <span className="text-[13px] font-medium">
            {theme === "dark" ? "浅色" : "深色"}
          </span>
        </Button>
        
      </div>
    </aside>
  );
}
