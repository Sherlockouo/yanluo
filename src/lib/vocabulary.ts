export type VocabularyDraft = { standard: string; alias: string };

export type VocabularyError =
  | "standardRequired"
  | "invalidSeparator"
  | "aliasSame"
  | "aliasSingleCjk"
  | "duplicate"
  | "aliasConflict";

export type VocabularyValidation =
  | { ok: true; entry: string; draft: VocabularyDraft; error?: undefined }
  | { ok: false; error: VocabularyError; entry?: undefined; draft?: undefined };

const SEPARATOR = /(?:=|→|->)/;

export function parseVocabularyEntry(raw: string): VocabularyDraft {
  const value = raw.trim();
  const match = SEPARATOR.exec(value);
  if (!match) return { standard: value, alias: "" };
  return {
    standard: value.slice(match.index + match[0].length).trim(),
    alias: value.slice(0, match.index).trim(),
  };
}

function isSingleCjk(value: string): boolean {
  return Array.from(value).length === 1 && /\p{Script=Han}/u.test(value);
}

export function validateVocabularyDraft(
  value: VocabularyDraft,
  existing: string[],
  editingIndex = -1,
): VocabularyValidation {
  const draft = { standard: value.standard.trim(), alias: value.alias.trim() };
  if (!draft.standard) return { ok: false, error: "standardRequired" };
  if (SEPARATOR.test(draft.standard) || SEPARATOR.test(draft.alias)) {
    return { ok: false, error: "invalidSeparator" };
  }
  if (draft.alias.toLocaleLowerCase() === draft.standard.toLocaleLowerCase()) {
    return { ok: false, error: "aliasSame" };
  }
  if (isSingleCjk(draft.alias)) return { ok: false, error: "aliasSingleCjk" };

  const entry = draft.alias ? `${draft.alias}=${draft.standard}` : draft.standard;
  const key = entry.toLocaleLowerCase();
  const aliasKey = draft.alias.toLocaleLowerCase();
  for (let i = 0; i < existing.length; i++) {
    if (i === editingIndex) continue;
    const parsed = parseVocabularyEntry(existing[i]);
    if (existing[i].trim().toLocaleLowerCase() === key) {
      return { ok: false, error: "duplicate" };
    }
    if (aliasKey && parsed.alias.toLocaleLowerCase() === aliasKey) {
      return { ok: false, error: "aliasConflict" };
    }
  }
  return { ok: true, entry, draft };
}
