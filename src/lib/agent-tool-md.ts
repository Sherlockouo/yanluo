/**
 * Turn agent tool / tool_result event text into markdown.
 * Tool JSON parse fail → raw command/text (still markdown-safe).
 */

function fence(lang: string, body: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

function longestBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pickPath(o: Record<string, unknown>): string | null {
  return (
    str(o.file_path) ??
    str(o.filePath) ??
    str(o.path) ??
    str(o.filename) ??
    str(o.target_file) ??
    null
  );
}

function toolNameFromTitle(title: string): string {
  const m = /^tool\s*·\s*(.+)$/i.exec(title.trim());
  return m?.[1]?.trim() || title.replace(/^tool\s*·\s*/i, "").trim() || "tool";
}

/** Known Claude/Codex-style tool inputs → readable markdown. */
function objectToMarkdown(
  name: string,
  o: Record<string, unknown>,
): string | null {
  const desc = str(o.description);
  const command = str(o.command) ?? str(o.cmd);
  const path = pickPath(o);
  const pattern = str(o.pattern) ?? str(o.query) ?? str(o.regex);
  const content = str(o.content) ?? str(o.new_string) ?? str(o.newString);
  const oldString = str(o.old_string) ?? str(o.oldString);
  const prompt = str(o.prompt);
  const url = str(o.url);

  const parts: string[] = [];
  if (desc) parts.push(`*${desc}*`);

  const lower = name.toLowerCase();

  if (command) {
    parts.push(fence("bash", command));
    return parts.join("\n\n");
  }

  if (lower.includes("read") || lower.includes("write") || path) {
    if (path) parts.push(`\`${path}\``);
    if (pattern) parts.push(`pattern: \`${pattern}\``);
    if (oldString && content) {
      parts.push(fence("", oldString));
      parts.push(fence("", content));
    } else if (content && content.length <= 4000) {
      const lang = path?.includes(".") ? path.split(".").pop() || "" : "";
      parts.push(fence(lang === "tsx" || lang === "ts" || lang === "js" || lang === "py" || lang === "rs" || lang === "md" ? lang : "", content));
    } else if (prompt) {
      parts.push(prompt);
    }
    if (parts.length) return parts.join("\n\n");
  }

  if (pattern) {
    if (path) parts.push(`\`${path}\``);
    parts.push(`\`${pattern}\``);
    return parts.join("\n\n");
  }

  if (url) {
    parts.push(url);
    return parts.join("\n\n");
  }

  if (prompt) {
    parts.push(prompt);
    return parts.join("\n\n");
  }

  // Generic: prefer short scalar fields, dump rest as json
  const scalars: string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "description") continue;
    if (typeof v === "string" && v.length < 200 && !v.includes("\n")) {
      scalars.push(`**${k}:** \`${v}\``);
    } else {
      rest[k] = v;
    }
  }
  if (scalars.length) parts.push(scalars.join("  \n"));
  if (Object.keys(rest).length) {
    try {
      parts.push(fence("json", JSON.stringify(rest, null, 2)));
    } catch {
      /* ignore */
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * Tool call body → markdown.
 * Parse fail / unknown shape → original text (fenced if looks like JSON/code).
 */
export function toolCallToMarkdown(title: string, text: string): string {
  const raw = text.trim();
  if (!raw) return "";

  const name = toolNameFromTitle(title);

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const md = objectToMarkdown(name, parsed as Record<string, unknown>);
      if (md?.trim()) return md;
    }
    if (typeof parsed === "string") return parsed;
    return fence("json", JSON.stringify(parsed, null, 2));
  } catch {
    // Show original command / payload
    if (raw.startsWith("{") || raw.startsWith("[")) {
      return fence("", raw);
    }
    // Shell-ish one-liner
    if (/^[a-zA-Z0-9_./-]+\s/.test(raw) || raw.includes("&&") || raw.includes("|")) {
      return fence("bash", raw);
    }
    return raw;
  }
}

/** tool_result → markdown (fence plain shell dumps; pass through if already md-ish). */
export function toolResultToMarkdown(text: string): string {
  const raw = text.trim();
  if (!raw) return "";

  // Already has markdown structure
  if (
    /^#{1,6}\s/m.test(raw) ||
    /^```/m.test(raw) ||
    /^\*\s|\-\s|\d+\.\s/m.test(raw)
  ) {
    return raw;
  }

  // JSON blob
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]"))
  ) {
    try {
      return fence("json", JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      return fence("", raw);
    }
  }

  // Multi-line / shell output → code fence
  if (raw.includes("\n") || raw.length > 120) {
    return fence("", raw);
  }

  return raw;
}
