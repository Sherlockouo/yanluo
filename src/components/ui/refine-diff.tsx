/**
 * Inline red/green refine diff: deletions (raw) → insertions (refined).
 * Character-level LCS — works for CJK ASR corrections.
 * SemanticPair: stacked source → result without edit marks (translate etc.).
 */
import { useMemo } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { diffTexts } from "@/lib/text-diff";
export { diffTexts } from "@/lib/text-diff";

export function hasRefineDiff(raw: string | null | undefined, text: string) {
  const before = (raw ?? "").trim();
  const after = text.trim();
  return Boolean(before && after && before !== after);
}

export function RefineDiff({
  before,
  after,
  className,
  compact,
}: {
  before: string;
  after: string;
  className?: string;
  /** Tighter line-height for list previews. */
  compact?: boolean;
}) {
  const t = useT();
  const parts = useMemo(() => diffTexts(before, after), [before, after]);

  if (!before && !after) {
    return <span className={cn("text-muted", className)}>{t("common.emptyParen")}</span>;
  }

  if (before === after) {
    return (
      <span className={cn("text-foreground", className)}>
        {after || t("common.emptyParen")}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "text-pretty wrap-break-word",
        compact ? "text-[13px] leading-snug" : "text-[14px] leading-relaxed",
        className,
      )}
    >
      {parts.map((part, index) => {
        if (part.type === "eq") {
          return (
            <span key={index} className="text-foreground">
              {part.text}
            </span>
          );
        }
        if (part.type === "del") {
          return (
            <span
              key={index}
              className="mx-px rounded-[3px] bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] px-px text-danger line-through decoration-(--danger)/70"
            >
              {part.text}
            </span>
          );
        }
        return (
          <span
            key={index}
            className="mx-px rounded-[3px] bg-[color-mix(in_oklab,var(--success)_16%,transparent)] px-px font-medium text-success"
          >
            {part.text}
          </span>
        );
      })}
    </span>
  );
}

/** Stacked source → result without labels or strikethrough (translate etc.). */
export function SemanticPair({
  before,
  after,
  className,
  compact,
}: {
  before: string;
  after: string;
  className?: string;
  compact?: boolean;
}) {
  const t = useT();
  const textClass = compact
    ? "text-[13px] leading-snug"
    : "text-[14px] leading-relaxed";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className={cn("text-pretty wrap-break-word text-muted", textClass)}>
        {before || t("common.emptyParen")}
      </p>
      <ArrowDown
        size={12}
        className="shrink-0 text-muted/70"
        aria-hidden
      />
      <p
        className={cn(
          "text-pretty wrap-break-word font-medium text-foreground",
          textClass,
        )}
      >
        {after || t("common.emptyParen")}
      </p>
    </div>
  );
}
