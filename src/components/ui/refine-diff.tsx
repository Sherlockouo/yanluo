/**
 * Inline red/green refine diff: deletions (raw) → insertions (refined).
 * Character-level LCS — works for CJK ASR corrections.
 */
import { useMemo } from "react";
import { cn } from "@/lib/cn";

export type DiffPart = {
  type: "eq" | "del" | "ins";
  text: string;
};

/** Myers-ish LCS on Unicode code points; merges adjacent same-type runs. */
export function diffTexts(before: string, after: string): DiffPart[] {
  if (before === after) {
    return before ? [{ type: "eq", text: before }] : [];
  }
  if (!before) return after ? [{ type: "ins", text: after }] : [];
  if (!after) return [{ type: "del", text: before }];

  const a = Array.from(before);
  const b = Array.from(after);
  const n = a.length;
  const m = b.length;

  // DP table: dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: Uint16Array[] = Array.from(
    { length: n + 1 },
    () => new Uint16Array(m + 1),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const raw: DiffPart[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.push({ type: "eq", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: "ins", text: b[j - 1] });
      j--;
    } else {
      raw.push({ type: "del", text: a[i - 1] });
      i--;
    }
  }
  raw.reverse();

  const merged: DiffPart[] = [];
  for (const part of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

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
  const parts = useMemo(() => diffTexts(before, after), [before, after]);

  if (!before && !after) {
    return <span className={cn("text-muted", className)}>（空）</span>;
  }

  if (before === after) {
    return (
      <span className={cn("text-foreground", className)}>{after || "（空）"}</span>
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

/** Two-line from → to when you want explicit before/after, not inline mix. */
export function RefineFromTo({
  before,
  after,
  className,
  beforeLabel = "原",
  afterLabel = "纠",
}: {
  before: string;
  after: string;
  className?: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="text-[13px] leading-snug">
        <span className="mr-1.5 text-[10px] font-medium uppercase tracking-wide text-danger">
          {beforeLabel}
        </span>
        <span className="text-danger line-through decoration-(--danger)/50">
          {before || "（空）"}
        </span>
      </p>
      <p className="text-[13px] leading-snug">
        <span className="mr-1.5 text-[10px] font-medium uppercase tracking-wide text-success">
          {afterLabel}
        </span>
        <span className="font-medium text-success">
          {after || "（空）"}
        </span>
      </p>
    </div>
  );
}
