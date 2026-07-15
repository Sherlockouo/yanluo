import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  duration,
  easeOut,
  revealDelay,
  useCollapse,
  useFadeSlide,
} from "@/lib/motion";

export function PageHeader({
  title,
  status,
  action,
}: {
  title: string;
  /** One muted status line (hotkey / engine). Prefer over explanatory subtitle. */
  status?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="type-display">{title}</h1>
        {status ? <div className="mt-2 type-meta max-w-xl">{status}</div> : null}
      </div>
      {action ? <div className="shrink-0 pb-0.5">{action}</div> : null}
    </header>
  );
}

/**
 * Slim secondary header for a mode panel embedded inside a parent page
 * (e.g. 出稿 modes). No <h1> — the parent page already owns the title.
 */
export function PanelHeader({
  status,
  action,
}: {
  status?: ReactNode;
  action?: ReactNode;
}) {
  if (!status && !action) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1 type-meta">{status}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Page enter lives HERE — not around <Outlet />.
 * Enter-only: no AnimatePresence exit (Outlet is a singleton; exit hangs).
 */
export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      className={cn(
        "mx-auto flex w-full max-w-4xl flex-col gap-7 pb-12",
        className,
      )}
      initial={reduce ? false : { opacity: 0.96, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.normal, ease: easeOut }}
      style={{ willChange: "opacity, transform" }}
    >
      {children}
    </motion.section>
  );
}

export function SectionCard({
  children,
  className,
  title,
  description,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  /** Prefer layout over description; avoid new explanatory copy. */
  description?: string;
}) {
  return (
    <div className={cn("panel flex flex-col justify-center", className)}>
      {(title || description) && (
        <div className="mb-5">
          {title ? <h2 className="type-section">{title}</h2> : null}
          {description ? (
            <p className="mt-1.5 type-meta">{description}</p>
          ) : null}
        </div>
      )}
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="grid min-h-[200px] place-items-center px-6 py-12 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        {icon ? (
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-default text-muted ring-1 ring-border">
            {icon}
          </div>
        ) : null}
        <div>
          <p className="type-ui">{title}</p>
          {description ? (
            <p className="mt-1 type-meta">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-icon">{icon}</div>
      <div className="min-w-0">
        <div className="type-micro">{label}</div>
        <div className="mt-1 truncate type-section">{value}</div>
        <div className="truncate type-meta">{hint}</div>
      </div>
    </div>
  );
}

/** Shared collapse header — chevron + type-ui. */
export function CollapseTrigger({
  open,
  onToggle,
  children,
  className,
  trailing,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "h-auto min-h-0 w-full items-center justify-start gap-2 rounded-xl px-1 py-2 text-left font-normal shadow-none",
        "hover:bg-default/60 data-[hovered=true]:bg-default/60",
        "data-[pressed=true]:scale-100",
        className,
      )}
      onPress={onToggle}
      aria-expanded={open}
    >
      <span className="type-ui min-w-0 flex-1">{children}</span>
      {trailing}
      <motion.span
        className="shrink-0 text-muted"
        animate={{ rotate: open ? 180 : 0 }}
        transition={{ duration: duration.fast, ease: easeOut }}
      >
        <ChevronDown size={16} aria-hidden />
      </motion.span>
    </Button>
  );
}

/** Mutual-exclusive modes — enter-only. Never AnimatePresence sync (exit+enter stack = ghost). */
export function ModeSwitch({
  modeKey,
  children,
  className,
}: {
  modeKey: string;
  children: ReactNode;
  className?: string;
}) {
  const fade = useFadeSlide();
  return (
    <motion.div
      key={modeKey}
      className={className}
      initial={fade.initial}
      animate={fade.animate}
      transition={fade.transition}
      style={{ willChange: "opacity, transform" }}
    >
      {children}
    </motion.div>
  );
}

/** Soft enter for secondary panels / list rows (delay capped). */
export function Reveal({
  children,
  className,
  index = 0,
}: {
  children: ReactNode;
  className?: string;
  index?: number;
}) {
  const collapse = useCollapse();
  const reduce = useReducedMotion();
  const delay = reduce ? 0 : revealDelay(index);

  return (
    <motion.div
      className={className}
      initial={collapse.initial}
      animate={collapse.animate}
      transition={{ ...collapse.transition, delay }}
      style={{ willChange: "opacity, transform" }}
    >
      {children}
    </motion.div>
  );
}

/** Collapsible secondary block — enter-only; close unmounts immediately (no exit ghost). */
export function SoftCollapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const collapse = useCollapse();
  if (!open) return null;
  return (
    <motion.div
      className={className}
      initial={collapse.initial}
      animate={collapse.animate}
      transition={collapse.transition}
      style={{ willChange: "opacity, transform" }}
    >
      {children}
    </motion.div>
  );
}
