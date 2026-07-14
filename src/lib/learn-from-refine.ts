/**
 * Mine vocabulary candidates from ASR refine diffs.
 * Emits `错词=正确` pairs and plain hotwords; filters sentence rewrites.
 */
import { diffTexts, type DiffPart } from "@/components/ui/refine-diff";

export type LearnCandidate = {
  /** Ready for vocabulary: `wrong=right` or plain term. */
  term: string;
  kind: "pair" | "term";
  from?: string;
  to?: string;
  score?: number;
};

export const SCORE_THRESHOLD = 0.55;

const MAX_SIDE = 24;

function compact(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function charLen(s: string): number {
  return Array.from(s).length;
}

function isCjk(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

function cjkCount(s: string): number {
  return Array.from(s).filter(isCjk).length;
}

function letterCount(s: string): number {
  return Array.from(s).filter((c) => /\p{L}|\p{N}/u.test(c)).length;
}

function isMostlyPunct(s: string): boolean {
  return letterCount(s) === 0;
}

function sentenceTerminators(s: string): number {
  return (s.match(/[。.!?？]/g) ?? []).length;
}

function latinWordCount(s: string): number {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  // If mostly CJK, treat as char-based (not Latin words).
  if (cjkCount(s) >= Math.max(2, charLen(s) / 2)) return 0;
  return words.length;
}

function isWhitespaceOnlyDiff(from: string, to: string): boolean {
  return from.replace(/\s+/g, "") === to.replace(/\s+/g, "");
}

function isLatinCaseOnly(from: string, to: string): boolean {
  return (
    /^[A-Za-z0-9._+-]+$/.test(from) &&
    /^[A-Za-z0-9._+-]+$/.test(to) &&
    from.toLowerCase() === to.toLowerCase() &&
    from !== to
  );
}

function isCjkHeavy(s: string): boolean {
  const n = charLen(s);
  if (n === 0) return false;
  return cjkCount(s) / n >= 0.5;
}

function isLatinHeavy(s: string): boolean {
  const letters = Array.from(s).filter((c) => /[A-Za-z]/.test(c)).length;
  return letters >= 2 && letters / Math.max(1, charLen(s)) >= 0.5;
}

/** Accept side for vocab: length 1–24, not punct soup, not multi-sentence. */
export function isTermSized(s: string): boolean {
  const t = compact(s);
  if (!t || isMostlyPunct(t)) return false;
  const n = charLen(t);
  if (n < 1 || n > MAX_SIDE) return false;
  if (sentenceTerminators(t) >= 2) return false;
  const words = latinWordCount(t);
  if (words > 4) return false;
  if (cjkCount(t) > 8) return false;
  return true;
}

function lengthRatioOk(a: string, b: string): boolean {
  const la = charLen(a);
  const lb = charLen(b);
  if (la === 0 || lb === 0) return false;
  const r = la / lb;
  return r >= 0.3 && r <= 3.0;
}

export function scoreCandidate(c: LearnCandidate): number {
  const from = compact(c.from ?? "");
  const to = compact(c.to ?? c.term);
  if (!to) return 0;

  let score = 0.4;

  if (c.kind === "pair" && from) {
    if (from === to) return 0;
    if (isWhitespaceOnlyDiff(from, to)) return 0;
    if (!lengthRatioOk(from, to)) score -= 0.25;
    if (isCjkHeavy(from) && isLatinHeavy(to)) score += 0.45; // 谐音 boost
    else if (isCjkHeavy(from) && isCjkHeavy(to)) score += 0.15;
    else if (isLatinHeavy(from) && isLatinHeavy(to)) score += 0.1;
    const maxLen = Math.max(charLen(from), charLen(to));
    if (maxLen <= 12) score += 0.1;
    if (maxLen > 18) score -= 0.15;
  } else {
    // plain term
    if (/^[A-Za-z][A-Za-z0-9._+-]{1,23}$/.test(to)) score += 0.35;
    else if (cjkCount(to) >= 2 && charLen(to) <= 12) score += 0.2;
    else score += 0.05;
  }

  if (sentenceTerminators(from) + sentenceTerminators(to) > 0) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

function looksLikeHotword(s: string): boolean {
  const t = compact(s);
  if (!isTermSized(t)) return false;
  if (/^[A-Za-z][A-Za-z0-9._+-]{1,23}$/.test(t)) return true;
  if (
    /^[A-Za-z0-9][A-Za-z0-9 ._/+-]{1,22}$/.test(t) &&
    latinWordCount(t) <= 4
  ) {
    return true;
  }
  if (cjkCount(t) >= 2 && charLen(t) <= 12) return true;
  return false;
}

function pairKey(from: string, to: string): string {
  return `${compact(from)}=${compact(to)}`;
}

/** Collapse del/ins runs that may be separated by tiny eq (spaces). */
function coalesceParts(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    if (
      part.type === "eq" &&
      /^\s+$/.test(part.text) &&
      out.length &&
      (out[out.length - 1].type === "del" || out[out.length - 1].type === "ins")
    ) {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.type === part.type) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

export function extractLearnCandidates(
  before: string,
  after: string,
): LearnCandidate[] {
  if (!before.trim() || !after.trim() || before === after) return [];

  const parts = coalesceParts(diffTexts(before, after));
  const seen = new Set<string>();
  const out: LearnCandidate[] = [];

  const push = (c: LearnCandidate) => {
    const scored = { ...c, score: scoreCandidate(c) };
    if ((scored.score ?? 0) < SCORE_THRESHOLD) return;
    const key = scored.term.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(scored);
  };

  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    const next = parts[i + 1];

    if (cur.type === "del" && next?.type === "ins") {
      const from = compact(cur.text);
      const to = compact(next.text);

      if (from && to && isLatinCaseOnly(from, to)) {
        push({ term: to, kind: "term", to });
        i += 1;
        continue;
      }

      if (
        from &&
        to &&
        from !== to &&
        !isWhitespaceOnlyDiff(from, to) &&
        isTermSized(from) &&
        isTermSized(to) &&
        lengthRatioOk(from, to)
      ) {
        push({
          term: pairKey(from, to),
          kind: "pair",
          from,
          to,
        });
      } else if (to && looksLikeHotword(to)) {
        push({ term: to, kind: "term", to });
      }
      i += 1;
      continue;
    }

    if (cur.type === "ins" && looksLikeHotword(cur.text)) {
      const to = compact(cur.text);
      push({ term: to, kind: "term", to });
    }
  }

  return out;
}

/** Parse + score a distill/vocab line; reject sentence-level garbage. */
export function acceptVocabLine(line: string): LearnCandidate | null {
  const t = line.trim();
  if (!t) return null;
  const eq = t.indexOf("=");
  let c: LearnCandidate;
  if (eq > 0 && eq < t.length - 1) {
    const from = compact(t.slice(0, eq));
    const to = compact(t.slice(eq + 1));
    if (!from || !to) return null;
    if (!isTermSized(from) || !isTermSized(to)) return null;
    c = { term: pairKey(from, to), kind: "pair", from, to };
  } else {
    if (!isTermSized(t) || !looksLikeHotword(t)) return null;
    c = { term: compact(t), kind: "term", to: compact(t) };
  }
  const score = scoreCandidate(c);
  if (score < SCORE_THRESHOLD) return null;
  return { ...c, score };
}

/** Harvest unique candidates across many refine entries. */
export function harvestLearnCandidates(
  entries: Array<{ raw_text?: string | null; text: string }>,
  existingVocab: string[] = [],
): LearnCandidate[] {
  const existing = new Set(
    existingVocab.map((t) => t.trim().toLocaleLowerCase()).filter(Boolean),
  );
  const seen = new Set<string>();
  const out: LearnCandidate[] = [];

  for (const entry of entries) {
    const before = entry.raw_text ?? "";
    const after = entry.text;
    for (const c of extractLearnCandidates(before, after)) {
      const key = c.term.toLocaleLowerCase();
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }

  // 谐音 pairs first, then by score.
  out.sort((a, b) => {
    const sa = a.score ?? scoreCandidate(a);
    const sb = b.score ?? scoreCandidate(b);
    if (sa !== sb) return sb - sa;
    if (a.kind !== b.kind) return a.kind === "pair" ? -1 : 1;
    return a.term.localeCompare(b.term);
  });
  return out;
}
