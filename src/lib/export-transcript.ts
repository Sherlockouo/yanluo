import type { HistoryEntry, TranscriptSegment } from "@/types";

export type ExportFormat = "md" | "txt" | "srt" | "raw";

export function historyEntryTitle(entry: HistoryEntry): string {
  const body = (entry.text || entry.raw_text || "").trim();
  const first = body.split(/\n/).find((l) => l.trim())?.trim();
  if (first) {
    return first.length > 48 ? `${first.slice(0, 48)}…` : first;
  }
  const t = entry.created_at || entry.id;
  return `转写 · ${t}`;
}

export function historyEntryToMarkdown(
  entry: HistoryEntry,
  textOverride?: string,
): string {
  const title = historyEntryTitle(entry);
  const body = (textOverride ?? entry.text ?? entry.raw_text ?? "").trim();
  const meta = [
    entry.created_at ? `时间: ${entry.created_at}` : null,
    entry.source ? `来源: ${entry.source}` : null,
  ]
    .filter(Boolean)
    .join("  \n");
  return `# ${title}\n\n${meta ? `${meta}\n\n` : ""}${body}\n`;
}

export function historyEntryToText(
  entry: HistoryEntry,
  textOverride?: string,
): string {
  return (textOverride ?? entry.text ?? entry.raw_text ?? "").trim() + "\n";
}

/** True ASR output (pre-LLM / pre-user edit). Always persisted on history. */
export function historyEntryToRaw(entry: HistoryEntry): string {
  return (entry.raw_text || entry.text || "").trim() + "\n";
}

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

function pad3(n: number): string {
  return String(Math.floor(n)).padStart(3, "0");
}

/** SRT timestamp: `HH:MM:SS,mmm` */
export function formatSrtTimestamp(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)},${pad3(ms)}`;
}

function segmentsForSrt(entry: HistoryEntry): TranscriptSegment[] {
  if (entry.segments && entry.segments.length > 0) {
    return entry.segments.filter((seg) => seg.text.trim().length > 0);
  }
  const text = (entry.text || entry.raw_text || "").trim();
  if (!text) return [];
  return [
    {
      text,
      start: 0,
      end: Math.max(entry.duration_seconds || 0, 0.5),
    },
  ];
}

export function historyEntryToSrt(entry: HistoryEntry): string {
  const segs = segmentsForSrt(entry);
  if (segs.length === 0) return "";
  return (
    segs
      .map((seg, i) => {
        const start = formatSrtTimestamp(seg.start);
        const end = formatSrtTimestamp(
          seg.end > seg.start ? seg.end : seg.start + 0.5,
        );
        return `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n`;
      })
      .join("\n") + "\n"
  );
}

export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/plain;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeBaseName(entry: HistoryEntry): string {
  return historyEntryTitle(entry)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 40);
}

export function exportHistoryEntry(
  entry: HistoryEntry,
  format: ExportFormat,
  textOverride?: string,
): void {
  const base = safeBaseName(entry) || "yanluo";
  switch (format) {
    case "md":
      downloadTextFile(
        `${base}.md`,
        historyEntryToMarkdown(entry, textOverride),
        "text/markdown;charset=utf-8",
      );
      break;
    case "txt":
      downloadTextFile(
        `${base}.txt`,
        historyEntryToText(entry, textOverride),
      );
      break;
    case "srt":
      downloadTextFile(
        `${base}.srt`,
        historyEntryToSrt(entry),
        "application/x-subrip;charset=utf-8",
      );
      break;
    case "raw":
      downloadTextFile(`${base}.raw.txt`, historyEntryToRaw(entry));
      break;
  }
}

/** Clipboard payload for a format (not a file download). */
export function historyEntryClipboard(
  entry: HistoryEntry,
  format: ExportFormat,
  textOverride?: string,
): string {
  switch (format) {
    case "md":
      return historyEntryToMarkdown(entry, textOverride);
    case "txt":
      return historyEntryToText(entry, textOverride).trimEnd();
    case "srt":
      return historyEntryToSrt(entry).trimEnd();
    case "raw":
      return historyEntryToRaw(entry).trimEnd();
  }
}
