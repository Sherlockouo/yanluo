/**
 * Node smoke test for paragraph grouping (no vitest in repo).
 * Run: node --experimental-strip-types src/lib/alignment.test.ts
 */
import {
  groupWordsIntoParagraphs,
  type TranscriptWord,
} from "./alignment.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function w(text: string, start: number, end: number, i: number): TranscriptWord {
  return {
    kind: "word",
    segmentIndex: i,
    wordIndex: i,
    text,
    startTime: start,
    endTime: end,
  };
}

// softMax flush then sentence-end punct → must not orphan `。`
const long =
  "如果你现在的条件不优越那你更应该去学习";
const words: TranscriptWord[] = [];
let t = 0;
for (const ch of long) {
  words.push(w(ch, t, t + 0.05, words.length));
  t += 0.05;
}
words.push(w("。", t, t + 0.05, words.length));

const paras = groupWordsIntoParagraphs(words, { softMaxChars: 20 });
assert(
  paras.every((p) => p.text !== "。" && !/^[,.!?;:…，。！？]+$/.test(p.text)),
  `no punct-only paragraph, got: ${JSON.stringify(paras.map((p) => p.text))}`,
);
assert(
  paras.some((p) => p.text.endsWith("。")),
  "period should glue to a content paragraph",
);

// ASCII `?` after silence gap — still merge
const qWords = [
  w("学习", 0, 0.2, 0),
  w("什么", 0.2, 0.4, 1),
  w("?", 1.2, 1.25, 2), // gap > silenceGap
];
const qParas = groupWordsIntoParagraphs(qWords, { silenceGapSec: 0.55 });
assert(qParas.length === 1, `expected 1 para, got ${qParas.length}`);
assert(qParas[0].text === "学习什么?", `got "${qParas[0].text}"`);

console.log("alignment.test.ts: ok");
