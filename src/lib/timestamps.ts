/** Hash prefix for in-document seek links produced by `linkifyTimestamps`. */
export const SEEK_HASH = "#t=";

/**
 * Turn `[mm:ss]` / `[h:mm:ss]` anchors into seek links (`[mm:ss](#t=secs)`),
 * including the `([mm:ss])` form the prompts ask for. Existing links are left alone.
 */
export function linkifyTimestamps(text: string): string {
  return text.replace(
    /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g,
    (_, stamp: string) => `[${stamp}](${SEEK_HASH}${timestampToSeconds(stamp)})`,
  );
}

export function timestampToSeconds(stamp: string): number {
  return stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}
