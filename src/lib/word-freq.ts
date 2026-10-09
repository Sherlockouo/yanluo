import type { HistoryEntry } from "@/types";

export type CloudSource = "fn" | "translate" | "transcribe";

export type WordWeight = {
  word: string;
  count: number;
  /** sqrt(count) for layout / font mapping */
  weight: number;
  /** Newest history entry that contains this word (for deep-link). */
  entryId?: string;
};

const STOP_ZH = new Set([
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "什么",
  "可以",
  "这个",
  "那个",
  "我们",
  "你们",
  "他们",
]);

const STOP_EN = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "but",
  "with",
  "at",
  "by",
  "from",
  "as",
  "it",
  "this",
  "that",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "my",
  "your",
  "our",
  "not",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "about",
  "into",
  "out",
  "up",
  "down",
  "can",
  "will",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
]);

const EN_RE = /[A-Za-z][A-Za-z0-9'-]{1,}/g;
const ZH_RUN_RE = /[\u4e00-\u9fff]+/g;

export function entryGoldText(entry: HistoryEntry): string {
  const user = entry.user_text?.trim();
  if (user) return user;
  const text = entry.text?.trim();
  if (text) return text;
  return (entry.raw_text ?? "").trim();
}

export function entryMatchesSource(
  entry: HistoryEntry,
  source: CloudSource,
): boolean {
  const s = (entry.source ?? "fn").trim() || "fn";
  return s === source;
}

/** Tokenize one string into candidate words (lowercase EN; ZH 2-grams + rare unigrams). */
export function tokenize(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];

  for (const m of text.matchAll(EN_RE)) {
    const w = m[0].toLowerCase();
    if (w.length < 2 || STOP_EN.has(w)) continue;
    out.push(w);
  }

  for (const m of text.matchAll(ZH_RUN_RE)) {
    const run = m[0];
    if (run.length === 1) {
      if (!STOP_ZH.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      const bi = a + b;
      if (STOP_ZH.has(bi)) continue;
      // Pure stop glue (的了 / 了是) — drop
      if (STOP_ZH.has(a) && STOP_ZH.has(b)) continue;
      out.push(bi);
    }
  }

  return out;
}

function finalizeCounts(
  counts: Map<string, number>,
  newest: Map<string, { id: string; at: string }>,
  topN: number,
): WordWeight[] {
  // Prefer bigrams over unigrams when both appear: demote single CJK if count low
  const rows: WordWeight[] = [...counts.entries()]
    .filter(([w, c]) => {
      if (c < 1) return false;
      // drop single CJK with count 1 (noise)
      if (/^[一-鿿]$/.test(w) && c < 2) return false;
      return true;
    })
    .map(([word, count]) => ({
      word,
      count,
      weight: Math.sqrt(count),
      entryId: newest.get(word)?.id,
    }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  return rows.slice(0, topN);
}

/**
 * One pass over history aggregating every cloud source at once — each entry is
 * tokenized once, so switching the home-cloud tab reuses cached results and
 * never re-walks the full history on the click's main-thread frame.
 */
export function aggregateAllSources(
  entries: HistoryEntry[],
  topN = 40,
): Record<CloudSource, WordWeight[]> {
  const buckets = new Map<
    CloudSource,
    { counts: Map<string, number>; newest: Map<string, { id: string; at: string }> }
  >();
  for (const s of CLOUD_SOURCES) {
    buckets.set(s.id, { counts: new Map(), newest: new Map() });
  }
  for (const e of entries) {
    const source = ((e.source ?? "fn").trim() || "fn") as CloudSource;
    const bucket = buckets.get(source);
    if (!bucket) continue;
    const text = entryGoldText(e);
    for (const w of tokenize(text)) {
      bucket.counts.set(w, (bucket.counts.get(w) ?? 0) + 1);
      const prev = bucket.newest.get(w);
      if (!prev || e.created_at > prev.at) {
        bucket.newest.set(w, { id: e.id, at: e.created_at });
      }
    }
  }
  const out = {} as Record<CloudSource, WordWeight[]>;
  for (const s of CLOUD_SOURCES) {
    const b = buckets.get(s.id)!;
    out[s.id] = finalizeCounts(b.counts, b.newest, topN);
  }
  return out;
}

export function aggregateWordFreq(
  entries: HistoryEntry[],
  source: CloudSource,
  topN = 40,
): WordWeight[] {
  const counts = new Map<string, number>();
  const newest = new Map<string, { id: string; at: string }>();
  for (const e of entries) {
    if (!entryMatchesSource(e, source)) continue;
    const text = entryGoldText(e);
    for (const w of tokenize(text)) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
      const prev = newest.get(w);
      if (!prev || e.created_at > prev.at) {
        newest.set(w, { id: e.id, at: e.created_at });
      }
    }
  }

  return finalizeCounts(counts, newest, topN);
}

export const CLOUD_SOURCES: { id: CloudSource; label: string }[] = [
  { id: "fn", label: "出稿" },
  { id: "translate", label: "翻译" },
  { id: "transcribe", label: "转写" },
];
