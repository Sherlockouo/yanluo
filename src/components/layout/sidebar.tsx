import { NavLink } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AudioLines, Bot, LibraryBig, Moon, Settings, Sun } from "lucide-react";
import type { Page } from "@/types";
import { duration, easeOut } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
import { Button } from "@heroui/react";
import { useT } from "@/lib/i18n";

const ICONS: Record<Page, typeof AudioLines> = {
  overview: AudioLines,
  draft: AudioLines,
  works: LibraryBig,
  dispatch: Bot,
  settings: Settings,
};

const PATHS: Record<Page, string> = {
  overview: "/",
  draft: "/draft",
  works: "/works",
  dispatch: "/dispatch",
  settings: "/settings",
};

const RAIL_ITEMS: { id: Page; labelKey: string }[] = [
  { id: "draft", labelKey: "nav.drafts" },
  { id: "works", labelKey: "nav.works" },
  { id: "dispatch", labelKey: "nav.dispatch" },
];

const RAIL_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60";

/** Soft hover wash — child span so Tailwind's transition survives .rail-item's transition list. */
function RailHoverWash() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[11px] bg-foreground/[0.045] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
    />
  );
}

function RailIndicator({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  if (!active) return null;
  // Fade + subtle scale (no layoutId — shared-layout nav jank, see git log).
  // Origin center is correct: the pill fills the whole rail item.
  return (
    <motion.span
      className="rail-item-indicator"
      initial={reduce ? false : { opacity: 0.92, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reduce ? { duration: 0 } : { type: "tween", duration: 0.16, ease: easeOut }
      }
    />
  );
}

function RailLink({
  to,
  end,
  label,
  tour,
  icon: Icon,
}: {
  to: string;
  end?: boolean;
  label: string;
  tour?: string;
  icon: typeof AudioLines;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      data-tour={tour}
      className={({ isActive }) =>
        cn("rail-item group", RAIL_FOCUS, isActive && "rail-item-active")
      }
    >
      {({ isActive }) => (
        <>
          <RailIndicator active={isActive} />
          {!isActive ? <RailHoverWash /> : null}
          <Icon
            size={16}
            className="relative z-10 shrink-0 transition-transform duration-150 ease-out motion-safe:group-hover:scale-110 motion-reduce:transition-none"
          />
          <span className="rail-item-label relative z-10">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * Narrow icon rail — Say mark (home) + 听写 / 智能体 + 设置 footer.
 * Not a wide labeled workbench sidebar (DESIGN.md IA).
 */
export function Sidebar() {
  const { theme, setTheme } = useApp();
  const t = useT();
  const reduce = useReducedMotion();

  return (
    <motion.aside
      className="app-rail"
      initial={reduce ? false : { opacity: 0.92, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: duration.normal, ease: easeOut }}
    >
      <NavLink
        to="/"
        end
        aria-label={t("nav.homeAria")}
        className={cn("app-rail-mark", RAIL_FOCUS)}
      >
        Say
      </NavLink>

      <nav className="flex flex-1 flex-col items-center gap-2">
        {RAIL_ITEMS.map((item) => (
          <RailLink
            key={item.id}
            to={PATHS[item.id]}
            label={t(item.labelKey)}
            tour={item.id === "draft" ? "rail-draft" : "rail-dispatch"}
            icon={ICONS[item.id]}
          />
        ))}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <RailLink
          to="/settings"
          label={t("nav.settings")}
          tour="rail-settings"
          icon={Settings}
        />
        <Button
          type="button"
          aria-label={theme === "dark" ? t("nav.toggleLight") : t("nav.toggleDark")}
          className={cn(
            "rail-item group !w-11 shrink-0 justify-center !px-0",
            RAIL_FOCUS,
          )}
          onPress={() =>
            setTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
        >
          <RailHoverWash />
          <span className="relative z-10 grid place-items-center opacity-75 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none">
            <motion.span
              key={theme}
              className="grid place-items-center"
              initial={reduce ? false : { opacity: 0.92, rotate: -30, scale: 0.8 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { duration: duration.normal, ease: easeOut }
              }
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </motion.span>
          </span>
        </Button>
      </div>
    </motion.aside>
  );
}
