/**
 * Smoke tests for word-freq (run: npx tsx src/lib/word-freq.test.ts)
 */
import {
  aggregateWordFreq,
  entryMatchesSource,
  tokenize,
  type CloudSource,
} from "./word-freq.ts";
import type { HistoryEntry } from "../types/index.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const base = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: "1",
  text: "",
  raw_text: "",
  language: "zh",
  duration_seconds: 1,
  created_at: "2026-01-01",
  refined: false,
  ...over,
});

assert(tokenize("Hello world Hello").includes("hello"), "en token");
assert(tokenize("的了是").length === 0, "zh stop");
assert(tokenize("人工智能人工智能").some((w) => w === "人工"), "zh bigram");

assert(entryMatchesSource(base({ source: undefined }), "fn"), "default fn");
assert(
  entryMatchesSource(base({ source: "translate" }), "translate"),
  "translate match",
);

const entries = [
  base({
    id: "a",
    source: "fn",
    text: "Kubernetes Kubernetes Docker",
  }),
  base({
    id: "b",
    source: "translate",
    text: "security security incident",
  }),
  base({
    id: "c",
    source: "transcribe",
    text: "会议会议记录",
  }),
];

const fn = aggregateWordFreq(entries, "fn" as CloudSource, 10);
assert(fn[0]?.word === "kubernetes", `fn top=${fn[0]?.word}`);
assert(fn[0]?.entryId === "a", "fn entryId");
const tr = aggregateWordFreq(entries, "translate", 10);
assert(tr.some((w) => w.word === "security"), "translate has security");
assert(
  tr.find((w) => w.word === "security")?.entryId === "b",
  "translate entryId",
);
const tx = aggregateWordFreq(entries, "transcribe", 10);
assert(tx.some((w) => w.word === "会议"), "transcribe bigram");

console.log("word-freq.test.ts: ok");
