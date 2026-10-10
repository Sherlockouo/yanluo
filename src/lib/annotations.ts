/** Highlight colour ids as stored in `annotations.json`. */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const HIGHLIGHT_SWATCH: Record<HighlightColor, string> = {
  yellow: "#facc15",
  green: "#4ade80",
  blue: "#60a5fa",
  pink: "#f472b6",
};

/** Translucent fill for a highlighted run of words (35% alpha). */
export function highlightBackground(color: string): string | undefined {
  const swatch = HIGHLIGHT_SWATCH[color as HighlightColor];
  return swatch ? `${swatch}59` : undefined;
}
