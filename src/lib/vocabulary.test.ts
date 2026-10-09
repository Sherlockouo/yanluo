import {
  parseVocabularyEntry,
  validateVocabularyDraft,
} from "./vocabulary.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  JSON.stringify(parseVocabularyEntry(" 配森 = Python ")) ===
    JSON.stringify({ standard: "Python", alias: "配森" }),
  "pair storage must map to standard + alias",
);
assert(
  JSON.stringify(parseVocabularyEntry(" OpenAI ")) ===
    JSON.stringify({ standard: "OpenAI", alias: "" }),
  "plain storage must map to a standard term",
);

const valid = validateVocabularyDraft(
  { standard: " Python ", alias: " 配森 " },
  ["OpenAI"],
);
assert(valid.ok && valid.entry === "配森=Python", "valid pair must trim and serialize");
assert(
  validateVocabularyDraft({ standard: " ", alias: "" }, []).error ===
    "standardRequired",
  "blank standard must be rejected",
);
assert(
  validateVocabularyDraft({ standard: "数据库", alias: "数" }, []).error ===
    "aliasSingleCjk",
  "single-CJK alias must be rejected",
);
assert(
  validateVocabularyDraft({ standard: "Python", alias: "配森" }, ["配森=python"]).error ===
    "duplicate",
  "duplicates must be case-insensitive",
);
assert(
  validateVocabularyDraft({ standard: "MySQL", alias: "配森" }, ["配森=Python"]).error ===
    "aliasConflict",
  "one alias must not silently target two standards",
);

console.log("vocabulary.test.ts OK");
