/** File extensions that look like real attachments / artifacts. */
const FILE_EXT =
  /\.(?:png|jpe?g|gif|webp|svg|bmp|heic|pdf|html?|xhtml|md|markdown|mdx|txt|csv|json|ya?ml|toml|xml|svgz?|mp[34]|wav|m4a|aac|ogg|flac|opus|aiff?|mov|m4v|mkv|avi|webm|ogv|docx?|xlsx?|pptx?|rtf|pages|numbers|key|zip|tar|gz|tgz|7z|rar|dmg|pkg|app|swift|ts|tsx|js|jsx|py|rs|go|java|kt|c|cc|cpp|h|hpp|m|mm|rb|php|sh|zsh|bash|fish|sql|proto|gradle|lock|log|srt|vtt)$/i;

const UNIX_ROOT = /^(?:\/Users\/|\/home\/|\/var\/|\/tmp\/|\/private\/|\/opt\/|\/Volumes\/)/;

/** Escape-ish Windows junk: `f:\n`, `C:\t`, drive with only junk. */
const WIN_JUNK = /^[A-Za-z]:\\[nrt]$/i;

const GENERIC_DIR = new Set(
  [
    "documents",
    "downloads",
    "desktop",
    "library",
    "movies",
    "music",
    "pictures",
    "public",
    "applications",
    "application support",
    "tmp",
    "temp",
    "var",
    "users",
    "home",
  ].map((s) => s.toLowerCase()),
);

function stripTrail(p: string): string {
  return p
    .replace(/[\r\n\t]+/g, "")
    .replace(/[\\/]+$/, "")
    .replace(/[.,;:!?)\]}'"…]+$/g, "")
    .trim();
}

function lastSeg(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function depth(p: string): number {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).length;
}

function hasFileExt(p: string): boolean {
  const name = lastSeg(p);
  return FILE_EXT.test(name);
}

function looksLikePathChars(p: string): boolean {
  // Reject book-title crumbs / CJK punctuation noise in the path body.
  if (/[《》「」『』【】〈〉]/.test(p)) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return true;
}

/**
 * Keep only absolute local paths that look real — not `f:\n`, bare dirs,
 * trailing-slash crumbs, or mid-sentence fragments.
 */
export function isPlausibleLocalPath(raw: string): boolean {
  const p = stripTrail(raw);
  if (p.length < 10) return false;
  if (!looksLikePathChars(p)) return false;
  if (WIN_JUNK.test(p)) return false;

  const isUnix = UNIX_ROOT.test(p);
  const isWin = /^[A-Za-z]:[\\/]/.test(p);
  if (!isUnix && !isWin) return false;

  // Drive root / near-root only
  if (isWin && /^[A-Za-z]:\\?$/i.test(p)) return false;
  if (isWin && /^[A-Za-z]:\\[^\\/]+$/i.test(p) && !hasFileExt(p)) {
    // `C:\Documents` without deeper path — too vague
    return false;
  }

  const seg = lastSeg(p);
  if (!seg || seg.length < 2) return false;

  // Prefer files; allow deep project dirs (cwd-like) but drop generic home folders.
  if (!hasFileExt(p)) {
    if (GENERIC_DIR.has(seg.toLowerCase())) return false;
    // Need real depth: /Users/u/proj/... (≥4) or Win ≥3 segments
    if (isUnix && depth(p) < 4) return false;
    if (isWin && depth(p) < 3) return false;
  }

  return true;
}

/**
 * Pull absolute local paths out of agent text. Conservative — false positives
 * are worse than misses (sidebar "files" that can't open).
 */
export function extractPaths(text: string): string[] {
  if (!text) return [];
  const re =
    /(?:^|[\s`"'(（【])((?:\/Users\/|\/home\/|\/var\/|\/tmp\/|\/private\/|\/opt\/|\/Volumes\/|[A-Za-z]:\\)[^\s`"')\]】）》]+)/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = stripTrail(m[1]);
    if (!isPlausibleLocalPath(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 40);
}

/**
 * Turn bare http(s) URLs into markdown links. Skips fenced/inline code and
 * URLs already inside `](...)`.
 */
export function linkifyBareUrls(text: string): string {
  if (!text || !/https?:\/\//i.test(text)) return text;
  const chunks = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return chunks
    .map((chunk) => {
      if (!chunk || chunk.startsWith("```") || chunk.startsWith("`")) {
        return chunk;
      }
      return chunk.replace(
        /(^|[^\](])(https?:\/\/[^\s<>\[\]（）"'`]+)/g,
        (_full, pre: string, url: string) => {
          // Already markdown-linked: ...](https://...)
          if (pre === "(") return `${pre}${url}`;
          let core = url;
          let trail = "";
          const trailMatch = url.match(/([),.;:!?。，；！？]+)$/);
          if (trailMatch) {
            // Keep balanced trailing ) if open parens inside URL
            const opens = (url.match(/\(/g) || []).length;
            const closes = (url.match(/\)/g) || []).length;
            if (trailMatch[1].startsWith(")") && closes > opens) {
              core = url.slice(0, -1);
              trail = ")";
              const more = core.match(/([.,.;:!?。，；！？]+)$/);
              if (more) {
                trail = more[1] + trail;
                core = core.slice(0, -more[1].length);
              }
            } else if (!/[)\]）]/.test(trailMatch[1][0])) {
              core = url.slice(0, -trailMatch[1].length);
              trail = trailMatch[1];
            }
          }
          if (!/^https?:\/\/.+\..+/i.test(core) && !/^https?:\/\/localhost\b/i.test(core)) {
            return `${pre}${url}`;
          }
          return `${pre}[${core}](${core})${trail}`;
        },
      );
    })
    .join("");
}
