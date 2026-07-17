import type { CharacterAlignment, TranscriptSegment } from "@/types";

/** Shared time formatting for transcript media controls. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type TranscriptWord = {
  kind: "word";
  segmentIndex: number;
  wordIndex: number;
  text: string;
  startTime: number;
  endTime: number;
};

export type TranscriptGap = {
  kind: "gap";
  segmentIndex: number;
  text: string;
};

export type ComposedSegment = TranscriptWord | TranscriptGap;

/** A breathable reading unit — one spoken thought / sentence. */
export type TranscriptParagraph = {
  id: number;
  startTime: number;
  endTime: number;
  words: TranscriptWord[];
  text: string;
};

const SENTENCE_END = /[。！？!?；;…]$/;
const SOFT_BREAK = /[，,、：:]$/;
/** Closing / trailing punct units — never stand alone as a paragraph. */
const PUNCT_ONLY = /^[,.!?;:…，。！？、；：）】》」』'"’”)\]]+$/;

function joinWordTexts(words: TranscriptWord[]): string {
  return words
    .map((w, i) => {
      if (i === 0) return w.text;
      const prev = words[i - 1];
      return needsLatinWordSpace(prev.text, w.text) ? ` ${w.text}` : w.text;
    })
    .join("");
}

export function isPunctOnlyText(text: string): boolean {
  return PUNCT_ONLY.test(text.trim());
}

/** Latin word gap: keep glued punctuation (`Hello,` `world!`) and apostrophes (`It's`). */
export function needsLatinWordSpace(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  // Never pad before a closing/trailing punct-only unit.
  if (PUNCT_ONLY.test(next)) return false;
  // Never pad after an opening punct-only unit.
  if (/^[(（【《「『"“‘[]+$/.test(prev)) return false;
  const prevLatin = /[A-Za-z0-9]/.test(prev);
  const nextLatin = /^[('"“‘]*[A-Za-z0-9]/.test(next);
  return prevLatin && nextLatin;
}

/**
 * Group timed words into paragraphs for reading.
 * Breaks on silence gaps, sentence punctuation, or soft length limits.
 * Punct-only buffers merge into the previous paragraph (softMax/silence
 * can otherwise orphan `。` / `?` as their own timed rows).
 */
export function groupWordsIntoParagraphs(
  words: TranscriptWord[],
  options?: {
    silenceGapSec?: number;
    softMaxChars?: number;
    hardMaxChars?: number;
  },
): TranscriptParagraph[] {
  if (!words.length) return [];
  const silenceGap = options?.silenceGapSec ?? 0.55;
  const softMax = options?.softMaxChars ?? 42;
  const hardMax = options?.hardMaxChars ?? 72;

  const paragraphs: TranscriptParagraph[] = [];
  let buf: TranscriptWord[] = [];
  let charCount = 0;

  const flush = () => {
    if (!buf.length) return;
    const punctOnly = buf.every((w) => isPunctOnlyText(w.text));
    if (punctOnly && paragraphs.length > 0) {
      const prev = paragraphs[paragraphs.length - 1];
      prev.words = [...prev.words, ...buf];
      prev.endTime = buf[buf.length - 1].endTime;
      prev.text = joinWordTexts(prev.words);
    } else {
      paragraphs.push({
        id: paragraphs.length,
        startTime: buf[0].startTime,
        endTime: buf[buf.length - 1].endTime,
        words: buf,
        text: joinWordTexts(buf),
      });
    }
    buf = [];
    charCount = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = buf[buf.length - 1];
    const gap = prev ? word.startTime - prev.endTime : 0;
    const nextLen = charCount + word.text.length;

    if (buf.length && gap >= silenceGap) flush();
    if (buf.length && nextLen > hardMax) flush();

    buf.push(word);
    charCount += word.text.length;

    const endsSentence = SENTENCE_END.test(word.text);
    const softBreak =
      SOFT_BREAK.test(word.text) && charCount >= softMax * 0.65;
    if (endsSentence || softBreak || charCount >= softMax) {
      flush();
    }
  }
  flush();
  return paragraphs;
}

/** Split plain (untimed) transcript into readable paragraphs. */
export function splitPlainTextParagraphs(text: string): string[] {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return [];

  const latin = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const cjk = Array.from(trimmed).filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x4e00 && code <= 0x9fff;
  }).length;
  const preferLatin = latin > cjk * 2;

  // CJK-only layout historically stripped spaces; keep spaces for English.
  const cleaned = preferLatin
    ? trimmed.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ")
    : trimmed.replace(/\s+/g, "").trim();
  if (!cleaned) return [];

  const parts = cleaned
    .split(preferLatin ? /(?<=[.!?…])\s+/ : /(?<=[。！？!?；;…])/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    if (preferLatin) {
      // Soft-wrap long English blobs without sentence punct.
      const soft: string[] = [];
      let buf = "";
      for (const word of cleaned.split(/\s+/)) {
        if (!word) continue;
        const next = buf ? `${buf} ${word}` : word;
        if (next.length >= 72 && buf) {
          soft.push(buf);
          buf = word;
        } else {
          buf = next;
        }
      }
      if (buf) soft.push(buf);
      return soft.length ? soft : [cleaned];
    }
    const soft: string[] = [];
    let buf = "";
    for (const ch of Array.from(cleaned)) {
      buf += ch;
      if (buf.length >= 40 && /[，,、：:]/.test(ch)) {
        soft.push(buf);
        buf = "";
      } else if (buf.length >= 56) {
        soft.push(buf);
        buf = "";
      }
    }
    if (buf) soft.push(buf);
    return soft.length ? soft : [cleaned];
  }

  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length && part.length < (preferLatin ? 12 : 8)) {
      merged[merged.length - 1] += preferLatin ? ` ${part}` : part;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/** CJK + fullwidth punctuation — ForcedAligner emits these as single units. */
function isStandaloneChar(char: string): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  // CJK Unified / Ext / Compatibility + kana + hangul + CJK punctuation / fullwidth
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * Expand ForcedAligner / ElevenLabs word segments into the ElevenLabs
 * CharacterAlignmentResponseModel shape used by TranscriptViewerContainer.
 */
export function segmentsToCharacterAlignment(
  segments: TranscriptSegment[],
): CharacterAlignment {
  const characters: string[] = [];
  const characterStartTimesSeconds: number[] = [];
  const characterEndTimesSeconds: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const chars = Array.from(seg.text);
    const n = Math.max(chars.length, 1);
    const span = Math.max(seg.end - seg.start, 0);
    for (let ci = 0; ci < chars.length; ci++) {
      const t0 = seg.start + span * (ci / n);
      const t1 = seg.start + span * ((ci + 1) / n);
      characters.push(chars[ci]);
      characterStartTimesSeconds.push(t0);
      characterEndTimesSeconds.push(t1);
    }
    if (i + 1 < segments.length) {
      const next = segments[i + 1];
      const needsSpace =
        !/\s$/.test(seg.text) &&
        !/^\s/.test(next.text) &&
        needsLatinWordSpace(seg.text, next.text);
      if (needsSpace) {
        characters.push(" ");
        characterStartTimesSeconds.push(seg.end);
        characterEndTimesSeconds.push(Math.max(next.start, seg.end));
      }
    }
  }

  return {
    characters,
    characterStartTimesSeconds,
    characterEndTimesSeconds,
  };
}

/**
 * ElevenLabs-compatible segment composer.
 * Latin: space-delimited words. CJK/kana/hangul: one highlight unit per character
 * (ForcedAligner already timestamps per char; default EL whitespace split would
 * collapse the whole Chinese transcript into a single "word").
 */
export function composeSegmentsFromAlignment(
  alignment: CharacterAlignment,
): { segments: ComposedSegment[]; words: TranscriptWord[] } {
  const {
    characters,
    characterStartTimesSeconds: starts,
    characterEndTimesSeconds: ends,
  } = alignment;
  const segments: ComposedSegment[] = [];
  const words: TranscriptWord[] = [];

  let wordBuffer = "";
  let whitespaceBuffer = "";
  let wordStart = 0;
  let wordEnd = 0;
  let segmentIndex = 0;
  let wordIndex = 0;

  const flushWhitespace = () => {
    if (!whitespaceBuffer) return;
    segments.push({
      kind: "gap",
      segmentIndex: segmentIndex++,
      text: whitespaceBuffer,
    });
    whitespaceBuffer = "";
  };

  const flushWord = () => {
    if (!wordBuffer) return;
    const word: TranscriptWord = {
      kind: "word",
      segmentIndex: segmentIndex++,
      wordIndex: wordIndex++,
      text: wordBuffer,
      startTime: wordStart,
      endTime: wordEnd,
    };
    segments.push(word);
    words.push(word);
    wordBuffer = "";
  };

  const pushStandalone = (char: string, start: number, end: number) => {
    flushWord();
    flushWhitespace();
    const word: TranscriptWord = {
      kind: "word",
      segmentIndex: segmentIndex++,
      wordIndex: wordIndex++,
      text: char,
      startTime: start,
      endTime: end,
    };
    segments.push(word);
    words.push(word);
  };

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i] ?? "";
    const start = starts[i] ?? 0;
    const end = ends[i] ?? start;

    if (/\s/.test(char)) {
      flushWord();
      whitespaceBuffer += char;
      continue;
    }

    // CJK / fullwidth punct as own highlight units. ASCII apostrophe stays inside words
    // (`It's`); curly quotes still standalone.
    if (
      isStandaloneChar(char) ||
      /[，。！？、；：""\u201c\u201d\u2018\u2019（）【】《》…—·]/.test(char)
    ) {
      pushStandalone(char, start, end);
      continue;
    }

    if (whitespaceBuffer) flushWhitespace();

    if (!wordBuffer) wordStart = start;
    wordBuffer += char;
    wordEnd = end;
  }

  flushWord();
  flushWhitespace();

  return { segments, words };
}

/** Prefer stored alignment; otherwise build from word segments. */
export function resolveAlignment(entry: {
  alignment?: CharacterAlignment | null;
  segments?: TranscriptSegment[] | null;
}): CharacterAlignment | null {
  if (
    entry.alignment &&
    entry.alignment.characters?.length &&
    entry.alignment.characterStartTimesSeconds?.length
  ) {
    return entry.alignment;
  }
  if (entry.segments && entry.segments.length > 0) {
    return segmentsToCharacterAlignment(entry.segments);
  }
  return null;
}

export function isVideoMediaKind(kind?: string | null, path?: string | null): boolean {
  if (kind === "video") return true;
  if (kind === "audio") return false;
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "3gp", "3g2"].includes(
    ext,
  );
}
