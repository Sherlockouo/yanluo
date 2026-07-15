import type { LearnCandidate } from "@/lib/learn-from-refine";

export type PendingLearn = {
  terms: LearnCandidate[];
  sourceIds: string[];
};

export function mergePendingLearn(
  prev: PendingLearn | null,
  terms: LearnCandidate[],
  sourceIds: string[],
): PendingLearn {
  const seen = new Set(
    (prev?.terms ?? []).map((c) => c.term.toLocaleLowerCase()),
  );
  const mergedTerms = [...(prev?.terms ?? [])];
  for (const c of terms) {
    const key = c.term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mergedTerms.push(c);
  }
  const idSet = new Set([...(prev?.sourceIds ?? []), ...sourceIds]);
  return { terms: mergedTerms, sourceIds: Array.from(idSet) };
}
