import { useEffect, useRef, useState } from "react";

/**
 * Smooth RMS with attack/release envelope so bars breathe naturally.
 * attack 40% → rising level catches up fast.
 * release 15% → falling level lingers, no jitter.
 */
export function useSmoothedRms(rms: number, active: boolean) {
  const [smoothed, setSmoothed] = useState(0);
  const rafRef = useRef<number | null>(null);
  const currentRef = useRef(0);
  const targetRef = useRef(0);

  useEffect(() => {
    targetRef.current = active ? Math.max(0, Math.min(1, rms)) : 0;
  }, [rms, active]);

  useEffect(() => {
    const tick = () => {
      const target = targetRef.current;
      const current = currentRef.current;
      const rate = target > current ? 0.4 : 0.15;
      const next = current + (target - current) * rate;
      currentRef.current = next;
      setSmoothed(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return smoothed;
}

const BAR_WEIGHTS = [0.5, 0.8, 1.0, 0.75, 0.55];

/**
 * Compute bar heights from smoothed RMS.
 * Driven by external RMS from Tauri — does not open the microphone.
 */
export function useBarHeights(rms: number, active: boolean, maxH: number) {
  const [heights, setHeights] = useState<number[]>(() =>
    BAR_WEIGHTS.map((w) => maxH * 0.14 * w),
  );
  const rmsRef = useRef(rms);
  const activeRef = useRef(active);
  rmsRef.current = rms;
  activeRef.current = active;

  useEffect(() => {
    let raf = 0;
    const min = maxH * 0.14;
    const compute = () => {
      // Backend already expands speech RMS into ~0–1; keep a mild boost only.
      const level = activeRef.current
        ? Math.max(0.08, Math.min(1, rmsRef.current * 1.35))
        : 0.06;
      const now = performance.now();
      const next = BAR_WEIGHTS.map((weight, i) => {
        const jitter = 1 + Math.sin(now / (140 + i * 23) + i * 1.7) * 0.12;
        return Math.max(min, level * weight * jitter * maxH);
      });
      setHeights(next);
      raf = requestAnimationFrame(compute);
    };
    raf = requestAnimationFrame(compute);
    return () => cancelAnimationFrame(raf);
  }, [maxH]);

  return heights;
}

/**
 * Dense band levels for ElevenLabs-style canvas waveform, driven by RMS.
 */
export function useWaveformBands(
  rms: number,
  active: boolean,
  processing: boolean,
  bandCount: number,
) {
  const [bands, setBands] = useState<number[]>(() =>
    Array.from({ length: bandCount }, () => 0.08),
  );
  const rmsRef = useRef(rms);
  const activeRef = useRef(active);
  const processingRef = useRef(processing);
  rmsRef.current = rms;
  activeRef.current = active;
  processingRef.current = processing;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const half = Math.floor(bandCount / 2);
      const next = Array.from({ length: bandCount }, (_, i) => {
        const dist = Math.abs(i - half) / Math.max(1, half);
        const center = 1 - dist * 0.45;

        if (processingRef.current && !activeRef.current) {
          const wave =
            Math.sin(now / 280 + i * 0.22) * 0.18 +
            Math.cos(now / 410 - i * 0.14) * 0.12;
          return Math.max(0.06, (0.22 + wave) * center);
        }

        if (!activeRef.current) {
          const breath = 0.06 + Math.sin(now / 900 + i * 0.08) * 0.02;
          return breath * center;
        }

        const level = Math.max(0.05, Math.min(1, rmsRef.current * 5.2));
        const jitter = 1 + Math.sin(now / (160 + i * 19) + i * 1.3) * 0.08;
        return Math.max(0.06, level * center * jitter);
      });
      setBands(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bandCount]);

  return bands;
}
