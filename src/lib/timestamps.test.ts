/**
 * Smoke tests for timestamps (run: node --experimental-strip-types src/lib/timestamps.test.ts)
 */
import { linkifyTimestamps, timestampToSeconds } from "./timestamps.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    throw new Error(`FAIL: ${msg}`);
  }
}

assert(timestampToSeconds("01:05") === 65, "mm:ss to seconds");
assert(timestampToSeconds("1:02:03") === 3723, "h:mm:ss to seconds");

assert(
  linkifyTimestamps("结论 [01:05] 和 ([02:10])") ===
    "结论 [01:05](#t=65) 和 ([02:10](#t=130))",
  "bracket and parenthesised anchors become seek links",
);

assert(
  linkifyTimestamps("[01:05](#t=65) 保持不变") === "[01:05](#t=65) 保持不变",
  "existing links are not rewrapped",
);

assert(
  linkifyTimestamps("普通 [注意] 文本") === "普通 [注意] 文本",
  "non-timestamp brackets are untouched",
);

console.log("timestamps.test.ts: ok");
