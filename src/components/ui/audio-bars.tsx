import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";

/** Compact spectrum: 5 bands across speech-range Hz (hud.md spec). */
export const SPECTRUM_BAR_COUNT = 5;
const WAVE_W = 19; /* 5 bars × 3px + 4 gaps × 1px = 19px */
/** Hard cap — bars must not exceed this (HUD glyph scale). */
const WAVE_H = 16;

export type LiveMeter = { rms: number; bands: number[] };

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
 *
 * Animated by one rAF loop writing bar heights straight to the DOM. The HUD
 * shares this webview main thread with pointer input — driving these via
 * per-frame setState re-rendered the whole capsule 60–120×/s and made every
 * click/drag feel a beat behind (不跟手).
 */
export function AudioBars({
  meter,
  active,
  className,
}: {
  /** Live meter ref — mutated in place by the audio-level listener. */
  meter: RefObject<LiveMeter>;
  active: boolean;
  className?: string;
}) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const animRef = useRef({
    levels: Array.from({ length: SPECTRUM_BAR_COUNT }, () => 0),
    written: Array.from({ length: SPECTRUM_BAR_COUNT }, () => ""),
  });

  useEffect(() => {
    let raf = 0;
    const floor = Math.max(2, WAVE_H * 0.1);

    const tick = (now: number) => {
      raf = 0;
      void now;
      const { levels, written } = animRef.current;
      const src = spectrumFromRms(
        meter.current?.rms ?? 0,
        meter.current?.bands,
      );

      let settled = true;
      for (let i = 0; i < SPECTRUM_BAR_COUNT; i++) {
        const target = active ? Math.max(0, Math.min(1, src[i] ?? 0)) : 0;
        // Attack/release springs (fast rise, slower fall; highs release faster).
        const t = i / (SPECTRUM_BAR_COUNT - 1);
        const attack = 0.55;
        const release = 0.16 + (1 - t) * 0.12;
        const rate = target > levels[i]! ? attack : release;
        levels[i] = levels[i]! + (target - levels[i]!) * rate;
        if (Math.abs(target - levels[i]!) > 0.001) settled = false;
        const h = floor + (WAVE_H - floor) * levels[i]!;
        const next = `${h.toFixed(1)}px`;
        if (next !== written[i]) {
          written[i] = next;
          barRefs.current[i]?.style.setProperty("height", next);
        }
      }

      // Idle+settled: park the loop; `active` flipping restarts it.
      if (active || !settled) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, meter]);

  return (
    <div
      className={cn("audio-bars", active && "audio-bars-active", className)}
      style={{ width: WAVE_W, height: WAVE_H }}
      aria-hidden
    >
      {Array.from({ length: SPECTRUM_BAR_COUNT }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="audio-bar"
        />
      ))}
    </div>
  );
}
