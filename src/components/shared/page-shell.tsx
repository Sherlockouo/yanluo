import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          {subtitle}
        </p>
      </div>
      {action ? <div className="shrink-0 pt-1">{action}</div> : null}
    </header>
  );
}

export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-4xl flex-col gap-6 pb-10",
        className,
      )}
    >
      {children}
    </section>
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
  description?: string;
}) {
  return (
    <div className={cn("panel", className)}>
      {(title || description) && (
        <div className="mb-5">
          {title ? (
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
          ) : null}
          {description ? (
            <p className="mt-1 text-sm text-muted">{description}</p>
          ) : null}
        </div>
      )}
      {children}
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
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
          {label}
        </div>
        <div className="mt-1 truncate text-lg font-semibold text-foreground">
          {value}
        </div>
        <div className="truncate text-xs text-muted">{hint}</div>
      </div>
    </div>
  );
}
