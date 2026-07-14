/**
 * Node smoke test for learn-from-refine (no vitest in repo).
 * Run: node --experimental-strip-types src/lib/learn-from-refine.test.ts
 * or: npx tsx src/lib/learn-from-refine.test.ts
 */
import {
  acceptVocabLine,
  extractLearnCandidates,
  SCORE_THRESHOLD,
} from "./learn-from-refine.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const pairs = extractLearnCandidates("我用配森写代码", "我用Python写代码");
assert(
  pairs.some((c) => c.term === "配森=Python" && (c.score ?? 0) >= SCORE_THRESHOLD),
  "expected 配森=Python pair",
);

const junk = extractLearnCandidates(
  "今天天气不错。我们去吃饭吧。然后回家。",
  "今天天气很好。我们去吃饭吧。然后回家。",
);
assert(
  junk.every((c) => (c.from?.length ?? 0) <= 24),
  "junk sides must be term-sized",
);

assert(acceptVocabLine("配森=Python"), "accept homophone");
assert(!acceptVocabLine("今天天气不错。真的。=今天天气很好。是的。"), "reject sentence");
assert(acceptVocabLine("MySQL"), "accept hotword");

console.log("learn-from-refine.test.ts OK");
