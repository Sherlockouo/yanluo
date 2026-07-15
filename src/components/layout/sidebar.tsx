import { NavLink } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AudioLines, Bot, Moon, Settings, Sun } from "lucide-react";
import type { Page } from "@/types";
import { navIndicatorTransition } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
import { Button } from "@heroui/react";

const ICONS: Record<Page, typeof AudioLines> = {
  overview: AudioLines,
  draft: AudioLines,
  dispatch: Bot,
  settings: Settings,
};

const PATHS: Record<Page, string> = {
  overview: "/",
  draft: "/draft",
  dispatch: "/dispatch",
  settings: "/settings",
};

const RAIL_ITEMS: { id: Page; label: string }[] = [
  { id: "draft", label: "出稿" },
  { id: "dispatch", label: "派活" },
];

/**
 * Narrow icon rail — 言 mark (home) + 出稿 / 派活 + 设置 footer.
 * Not a wide labeled workbench sidebar (DESIGN.md IA).
 */
export function Sidebar() {
  const { theme, setTheme } = useApp();
  const reduce = useReducedMotion();

  return (
    <aside className="app-rail">
      <NavLink to="/" end aria-label="言落 主页" className="app-rail-mark">
        言
      </NavLink>

      <nav className="mt-2 flex flex-1 flex-col items-center gap-1.5">
        {RAIL_ITEMS.map((item) => {
          const Icon = ICONS[item.id];
          return (
            <NavLink
              key={item.id}
              to={PATHS[item.id]}
              aria-label={item.label}
              className={({ isActive }) =>
                cn("rail-item", isActive && "rail-item-active")
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && !reduce ? (
                    <motion.span
                      layoutId="rail-active"
                      className="rail-item-indicator"
                      transition={navIndicatorTransition}
                    />
                  ) : isActive ? (
                    <span className="rail-item-indicator" />
                  ) : null}
                  <Icon size={17} className="relative z-10 shrink-0" />
                  <span className="rail-item-label relative z-10">
                    {item.label}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <NavLink
          to="/settings"
          aria-label="设置"
          className={({ isActive }) =>
            cn("rail-item", isActive && "rail-item-active")
          }
        >
          {({ isActive }) => (
            <>
              {isActive && !reduce ? (
                <motion.span
                  layoutId="rail-active"
                  className="rail-item-indicator"
                  transition={navIndicatorTransition}
                />
              ) : isActive ? (
                <span className="rail-item-indicator" />
              ) : null}
              <Settings size={16} className="relative z-10" />
              <span className="rail-item-label relative z-10">设置</span>
            </>
          )}
        </NavLink>
        <Button
          type="button"
          aria-label={theme === "dark" ? "切换浅色" : "切换深色"}
          className="rail-item !w-11 shrink-0 justify-center !px-0 opacity-70 hover:opacity-100"
          onClick={() =>
            setTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
      </div>
    </aside>
  );
}
