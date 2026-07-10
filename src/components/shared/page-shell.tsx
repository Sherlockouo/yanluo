import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-[1.75rem] font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0 pb-0.5">{action}</div> : null}
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
        "page-enter mx-auto flex w-full max-w-4xl flex-col gap-7 pb-12",
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
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {description}
            </p>
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
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? (
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {description}
            </p>
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
