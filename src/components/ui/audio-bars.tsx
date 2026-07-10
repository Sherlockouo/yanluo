import { useBandHeights } from "@/hooks/useAudioBars";
import { cn } from "@/lib/cn";

/** Compact spectrum: 6 bands across speech-range Hz. */
export const SPECTRUM_BAR_COUNT = 6;
const WAVE_W = 28;
const WAVE_H = 22;

type AudioBarsProps = {
  /** Overall loudness 0–1 (fall啊。嗯。back if bands empty). */
  rms: number;
  /** Log-spaced speech bands from Goertzel (preferred). */
  bands?: number[];
  active: boolean;
  className?: string;
};

/**
 * Thin frequency-band bars (Apple Music–inspired).
 * Each bar tracks a different speech frequency range with independent attack/release.
 */
export function AudioBars({ rms, bands, active, className }: AudioBarsProps) {
  const spectrum =
    bands && bands.length > 0
      ? bands
      : Array.from({ length: SPECTRUM_BAR_COUNT }, (_, i) => {
          const t = i / (SPECTRUM_BAR_COUNT - 1);
          // Soft center bias when only RMS is available.
          const shape = 0.55 + 0.45 * Math.sin(Math.PI * t);
          return rms * shape;
        });

  const heights = useBandHeights(spectrum, active, WAVE_H);

  return (
    <div
      className={cn("audio-bars", active && "audio-bars-active", className)}
      style={{ width: WAVE_W, height: WAVE_H }}
      aria-hidden
    >
      {heights.map((h, i) => (
        <div
          key={i}
          className="audio-bar"
          style={{ height: `${(h * 1.4).toFixed(1)}px` }}
        ></div>
      ))}
    </div>
  );
}
