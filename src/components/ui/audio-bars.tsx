import { useBandHeights } from "@/hooks/useAudioBars";
import { cn } from "@/lib/cn";

/** Compact spectrum: 5 bands across speech-range Hz (hud.md spec). */
export const SPECTRUM_BAR_COUNT = 5;
const WAVE_W = 19; /* 5 bars × 3px + 4 gaps × 1px = 19px */
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
  if (level <= 0.001) {
    return Array.from({ length: n }, () => 0);
  }

  // Loudness is primary. Bands only modulate shape — never peak-norm into a
  // static wedge that ignores volume after VAD silence commits.
  if (bands && bands.length > 0) {
    const peak = Math.max(...bands.map((v) => Math.max(0, v)), 1e-6);
    return Array.from({ length: n }, (_, i) => {
      const rel = Math.max(0, bands[i] ?? 0) / peak;
      return level * (0.28 + 0.72 * rel);
    });
  }

  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return level * (0.45 + 0.55 * Math.sin(Math.PI * t));
  });
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
