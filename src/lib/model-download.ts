/** Shared types + helpers for one-click Qwen model download (weights + tokenizer). */

export type ModelStatus = {
  model_id: string;
  path: string;
  installed: boolean;
  needs_download: boolean;
  has_tokenizer: boolean;
};

export type ModelDownloadProgress = {
  model_id: string;
  file: string;
  downloaded: number;
  total: number | null;
  file_index: number;
  file_count: number;
  percent: number | null;
};

export function progressLabel(p: ModelDownloadProgress): string {
  if (p.file === "(done)") return "完成";
  const pct =
    p.percent != null ? `${p.percent.toFixed(0)}%` : `${p.file_index}/${p.file_count}`;
  return `${p.file} · ${pct}`;
}
