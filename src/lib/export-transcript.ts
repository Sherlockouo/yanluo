import type { HistoryEntry } from "@/types";

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

export function exportHistoryEntry(
  entry: HistoryEntry,
  format: "md" | "txt",
  textOverride?: string,
): void {
  const base = historyEntryTitle(entry)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 40);
  if (format === "md") {
    downloadTextFile(
      `${base || "yanluo"}.md`,
      historyEntryToMarkdown(entry, textOverride),
      "text/markdown;charset=utf-8",
    );
  } else {
    downloadTextFile(
      `${base || "yanluo"}.txt`,
      historyEntryToText(entry, textOverride),
    );
  }
}
