import { useEffect, useRef, useState } from "react";

/**
 * Fast envelope for overall loudness.
 */
export function useSmoothedRms(rms: number, active: boolean) {
  const [smoothed, setSmoothed] = useState(0);
  const currentRef = useRef(0);
  const targetRef = useRef(0);

  useEffect(() => {
    targetRef.current = active ? Math.max(0, Math.min(1, rms)) : 0;
  }, [rms, active]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const target = targetRef.current;
      const current = currentRef.current;
      const rate = target > current ? 0.55 : 0.22;
      currentRef.current = current + (target - current) * rate;
      setSmoothed(currentRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return smoothed;
}

/**
 * Per-band attack/release (Apple Music–style): fast rise, slower fall,
 * independent springs so the spectrum feels fluid rather than locked.
 */
export function useBandHeights(
  bands: number[],
  active: boolean,
  maxH: number,
) {
  const count = Math.max(1, bands.length);
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: count }, () => Math.max(2, maxH * 0.12)),
  );
  const bandsRef = useRef(bands);
  const activeRef = useRef(active);
  const levelsRef = useRef<number[]>(Array.from({ length: count }, () => 0));
  bandsRef.current = bands;
  activeRef.current = active;

  useEffect(() => {
    if (levelsRef.current.length !== count) {
      levelsRef.current = Array.from({ length: count }, () => 0);
    }
    let raf = 0;
    const floor = Math.max(2, maxH * 0.1);

    const tick = () => {
      const src = bandsRef.current;
      const levels = levelsRef.current;
      const next = new Array<number>(count);

      for (let i = 0; i < count; i++) {
        const target = activeRef.current
          ? Math.max(0, Math.min(1, src[i] ?? 0))
          : 0;
        // High bands release a bit faster (presence), low bands linger (body).
        const t = count === 1 ? 0.5 : i / (count - 1);
        const attack = 0.42 + t * 0.2;
        const release = 0.14 + (1 - t) * 0.1;
        const rate = target > levels[i]! ? attack : release;
        levels[i] = levels[i]! + (target - levels[i]!) * rate;
        next[i] = floor + (maxH - floor) * levels[i]!;
      }

      setHeights(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [count, maxH]);

  return heights;
}

/** @deprecated Prefer useBandHeights with real spectrum bands. */
export function useBarHeights(rms: number, active: boolean, maxH: number) {
  const bands = [0.55, 0.7, 0.85, 1, 0.85, 0.7, 0.55].map((w) => rms * w);
  return useBandHeights(bands, active, maxH);
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
            Math.sin(now / 280 + i * 0.22) * 0.12 +
            Math.cos(now / 410 - i * 0.14) * 0.08;
          return Math.max(0.06, (0.18 + wave) * center);
        }

        if (!activeRef.current) {
          return 0.08 * center;
        }

        const raw = Math.max(0, Math.min(1, rmsRef.current));
        const level =
          raw < 0.02 ? 0.08 : Math.min(1, Math.pow(raw, 0.55) * 1.15);
        return Math.max(0.08, level * center);
      });
      setBands(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bandCount]);

  return bands;
}
