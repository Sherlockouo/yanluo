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

/**
 * Group timed words into paragraphs for reading.
 * Breaks on silence gaps, sentence punctuation, or soft length limits.
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
    paragraphs.push({
      id: paragraphs.length,
      startTime: buf[0].startTime,
      endTime: buf[buf.length - 1].endTime,
      words: buf,
      text: buf.map((w) => w.text).join(""),
    });
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
  const cleaned = text.replace(/\s+/g, "").trim();
  if (!cleaned) return [];

  const parts = cleaned
    .split(/(?<=[。！？!?；;…])/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    // No punctuation — soft-wrap every ~40 chars at a comma if possible.
    const soft: string[] = [];
    let buf = "";
    for (const ch of Array.from(cleaned)) {
      buf += ch;
      if (
        buf.length >= 40 &&
        /[，,、：:]/.test(ch)
      ) {
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

  // Merge very short fragments into the previous sentence.
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length && part.length < 8) {
      merged[merged.length - 1] += part;
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
        /[A-Za-z0-9]/.test(seg.text) &&
        /[A-Za-z0-9]/.test(next.text);
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

    if (isStandaloneChar(char) || /[，。！？、；：""''（）【】《》…—·]/.test(char)) {
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
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "3gp", "3g2"].includes(
    ext,
  );
}
