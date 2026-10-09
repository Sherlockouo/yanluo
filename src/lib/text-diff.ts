export type DiffPart = {
  type: "eq" | "del" | "ins";
  text: string;
};

const DIFF_CELL_BUDGET = 250_000;

/** Character-level LCS diff. Over budget, return the final text unchanged. */
export function diffTexts(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "eq", text: before }] : [];
  if (!before) return after ? [{ type: "ins", text: after }] : [];
  if (!after) return [{ type: "del", text: before }];
  if (before.length * after.length > DIFF_CELL_BUDGET) {
    return [{ type: "eq", text: after }];
  }

  const a = Array.from(before);
  const b = Array.from(after);
  const dp: Uint16Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const raw: DiffPart[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.push({ type: "eq", text: a[--i] });
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: "ins", text: b[--j] });
    } else {
      raw.push({ type: "del", text: a[--i] });
    }
  }
  raw.reverse();

  const merged: DiffPart[] = [];
  for (const part of raw) {
    const last = merged[merged.length - 1];
    if (last?.type === part.type) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}
