import { NavLink } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AudioLines, Bot, Moon, Settings, Sun } from "lucide-react";
import type { Page } from "@/types";
import { easeOut } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
import { Button } from "@heroui/react";
import { useT } from "@/lib/i18n";

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

const RAIL_ITEMS: { id: Page; labelKey: string }[] = [
  { id: "draft", labelKey: "nav.drafts" },
  { id: "dispatch", labelKey: "nav.dispatch" },
];

/**
 * Narrow icon rail — 言 mark (home) + 出稿 / 派活 + 设置 footer.
 * Not a wide labeled workbench sidebar (DESIGN.md IA).
 */
export function Sidebar() {
  const { theme, setTheme } = useApp();
  const reduce = useReducedMotion();
  const t = useT();

  return (
    <aside className="app-rail">
      <NavLink to="/" end aria-label={t("nav.homeAria")} className="app-rail-mark">
        言
      </NavLink>

      <nav className="flex flex-1 flex-col items-center gap-2">
        {RAIL_ITEMS.map((item) => {
          const Icon = ICONS[item.id];
          return (
            <NavLink
              key={item.id}
              to={PATHS[item.id]}
              aria-label={t(item.labelKey)}
              data-tour={item.id === "draft" ? "rail-draft" : "rail-dispatch"}
              className={({ isActive }) =>
                cn("rail-item", isActive && "rail-item-active")
              }
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <motion.span
                      className="rail-item-indicator"
                      layoutId="rail-mark"
                      transition={
                        reduce
                          ? { duration: 0 }
                          : { type: "tween", duration: 0.18, ease: easeOut }
                      }
                    />
                  ) : null}
                  <Icon size={16} className="relative z-10 shrink-0" />
                  <span className="rail-item-label relative z-10">
                    {t(item.labelKey)}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <NavLink
          to="/settings"
          aria-label={t("nav.settings")}
          data-tour="rail-settings"
          className={({ isActive }) =>
            cn("rail-item", isActive && "rail-item-active")
          }
        >
          {({ isActive }) => (
            <>
              {isActive ? (
                <motion.span
                  className="rail-item-indicator"
                  layoutId="rail-mark"
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: "tween", duration: 0.18, ease: easeOut }
                  }
                />
              ) : null}
              <Settings size={16} className="relative z-10" />
              <span className="rail-item-label relative z-10">{t("nav.settings")}</span>
            </>
          )}
        </NavLink>
        <Button
          type="button"
          aria-label={theme === "dark" ? t("nav.toggleLight") : t("nav.toggleDark")}
          className="rail-item !w-11 shrink-0 justify-center !px-0 opacity-70 hover:opacity-100"
          onPress={() =>
            setTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
      </div>
    </aside>
  );
}
