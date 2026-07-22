/**
 * ASR → LLM refine → user adjust triples → few-shot / learn harvest.
 */
import type { HistoryEntry } from "@/types";
import { harvestLearnCandidates, type LearnCandidate } from "./learn-from-refine";

export type LearnTriple = {
  id: string;
  asr: string;
  llm: string;
  user: string;
  /** Best supervision target: user > llm > text */
  gold: string;
  hasUser: boolean;
};

const FEW_SHOT_MARK_START = "<!-- few-shot:begin -->";
const FEW_SHOT_MARK_END = "<!-- few-shot:end -->";
const MAX_FEW_SHOT = 8;
const MAX_SIDE_CHARS = 80;

export function learnGold(entry: Pick<HistoryEntry, "text" | "llm_text" | "user_text">): string {
  const user = entry.user_text?.trim();
  if (user) return user;
  const llm = entry.llm_text?.trim();
  if (llm) return llm;
  return (entry.text ?? "").trim();
}

export function toLearnTriple(entry: HistoryEntry): LearnTriple | null {
  const asr = (entry.raw_text ?? "").trim();
  if (!asr) return null;
  const llm = (entry.llm_text ?? "").trim();
  const user = (entry.user_text ?? "").trim();
  const gold = learnGold(entry);
  if (!gold || gold === asr) return null;
  return {
    id: entry.id,
    asr,
    llm,
    user,
    gold,
    hasUser: Boolean(user),
  };
}

/** Cases useful for few-shot / vocab: user adjust, or bad-rated refine. */
export function collectLearnTriples(
  history: HistoryEntry[],
  opts?: { requireUser?: boolean; max?: number },
): LearnTriple[] {
  const requireUser = opts?.requireUser ?? false;
  const max = opts?.max ?? 40;
  const out: LearnTriple[] = [];
  for (const e of history) {
    if ((e.source ?? "fn") === "translate") continue;
    const t = toLearnTriple(e);
    if (!t) continue;
    if (requireUser && !t.hasUser) continue;
    if (!t.hasUser && e.quality_rating !== "bad") continue;
    out.push(t);
    if (out.length >= max) break;
  }
  // User-adjusted first.
  out.sort((a, b) => Number(b.hasUser) - Number(a.hasUser));
  return out;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_SIDE_CHARS) return t;
  return `${t.slice(0, MAX_SIDE_CHARS)}…`;
}

/** Few-shot block for refine prompt (qwen3-friendly 输入/输出). */
export function formatFewShotBlock(triples: LearnTriple[]): string {
  const picked = triples
    .filter((t) => t.asr.length <= MAX_SIDE_CHARS * 2 && t.gold.length <= MAX_SIDE_CHARS * 2)
    .slice(0, MAX_FEW_SHOT);
  if (!picked.length) return "";
  const lines = ["示例："];
  for (const t of picked) {
    lines.push(`输入：${clip(t.asr)}`);
    lines.push(`输出：${clip(t.gold)}`);
  }
  return `${FEW_SHOT_MARK_START}\n${lines.join("\n")}\n${FEW_SHOT_MARK_END}`;
}

/**
 * Weak-model few-shot gate (see `doc/plan/refine-eval.md`; mirrors Rust
 * `model_allows_fewshot` in `src-tauri/src/transcription/mod.rs`). The eval
 * found few-shot value scales with model strength: deepseek-chat +8.9%,
 * qwen3:1.7b / gemma:12b +3.5% — but `qwen2.5:1.5b` **regressed -7.5%** (plus
 * an over-edit), so few-shot is denied only for that confirmed-weak list;
 * unknown models default to allowed.
 */
export function modelAllowsFewshot(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m.includes("qwen2.5") && (m.includes("1.5b") || m.includes("0.5b"))) {
    return false;
  }
  return true;
}

/** Merge/replace few-shot section in refine prompt. */
export function mergeFewShotIntoPrompt(basePrompt: string, triples: LearnTriple[]): string {
  const block = formatFewShotBlock(triples);
  if (!block) return basePrompt;
  const start = basePrompt.indexOf(FEW_SHOT_MARK_START);
  const end = basePrompt.indexOf(FEW_SHOT_MARK_END);
  if (start >= 0 && end > start) {
    const after = end + FEW_SHOT_MARK_END.length;
    return `${basePrompt.slice(0, start).trimEnd()}\n\n${block}\n${basePrompt.slice(after).trimStart()}`.trim();
  }
  // Replace trailing 「示例：」 section of default prompt if present.
  const exampleIdx = basePrompt.lastIndexOf("\n示例：");
  if (exampleIdx >= 0) {
    return `${basePrompt.slice(0, exampleIdx).trimEnd()}\n\n${block}`;
  }
  return `${basePrompt.trimEnd()}\n\n${block}`;
}

/** Harvest vocab preferring ASR → gold (user or llm). */
export function harvestFromTriples(
  entries: HistoryEntry[],
  existingVocab: string[] = [],
): LearnCandidate[] {
  const mapped = entries.map((e) => ({
    raw_text: e.raw_text,
    text: learnGold(e),
  }));
  return harvestLearnCandidates(mapped, existingVocab);
}
