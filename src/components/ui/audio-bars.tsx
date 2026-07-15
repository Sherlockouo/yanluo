import { useBandHeights } from "@/hooks/useAudioBars";
import { cn } from "@/lib/cn";

/** Compact spectrum: 6 bands across speech-range Hz. */
export const SPECTRUM_BAR_COUNT = 6;
const WAVE_W = 28;
/** Hard cap — bars must not exceed this (HUD glyph scale). */
const WAVE_H = 16;

type AudioBarsProps = {
  /** Overall loudness 0–1 — drives bar amplitude. */
  rms: number;
  /** Log-spaced speech bands from Goertzel (relative shape only). */
  bands?: number[];
  active: boolean;
  className?: string;
};

function spectrumFromRms(rms: number, bands: number[] | undefined): number[] {
  const level = Math.max(0, Math.min(1, rms));
  const n = SPECTRUM_BAR_COUNT;

  // Relative shape: Goertzel mags often saturate, so normalize then scale by rms.
  // Amplitude must track loudness — otherwise HUD freezes as a static wedge.
  let shape: number[];
  if (bands && bands.length > 0) {
    const peak = Math.max(...bands.map((v) => Math.max(0, v)), 1e-6);
    shape = Array.from({ length: n }, (_, i) => {
      const v = Math.max(0, bands[i] ?? 0);
      return Math.max(0.15, Math.min(1, v / peak));
    });
  } else {
    shape = Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      return 0.55 + 0.45 * Math.sin(Math.PI * t);
    });
  }

  return shape.map((s) => s * level);
}

/**
 * Thin frequency-band bars (Apple Music–inspired).
 * Shape from spectrum bands; height from RMS so the meter tracks volume.
 */
export function AudioBars({ rms, bands, active, className }: AudioBarsProps) {
  const spectrum = spectrumFromRms(rms, bands);
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
          style={{ height: `${Math.min(h, WAVE_H).toFixed(1)}px` }}
        />
      ))}
    </div>
  );
}
