import { useEffect, useRef, useState } from "react";

/**
 * Smooth character reveal for streaming captions (typewriter).
 *
 * ASR partials arrive in bursts (every ~0.5-0.6s, several characters each).
 * Rendering them verbatim reads as "chunk by chunk". This hook drips newly
 * appended characters in at an adaptive rate — small bursts drain before the
 * next one lands, large catch-ups pour faster — so the caption reads as one
 * continuous stream. Hypothesis revisions (mid-string changes) snap
 * immediately: smoothing would only keep wrong text on screen longer.
 *
 * `prefers-reduced-motion`: returns the target unchanged.
 */

/** Slowest drip (chars/sec) — below this the stream feels choppy again. */
const MIN_CPS = 16;
/** Reveal rate targets draining the current backlog in this long (sec). */
const DRAIN_SEC = 0.42;
/** Cap for huge catch-ups (chars/sec). */
const MAX_CPS = 110;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `n` must not land inside a surrogate pair (emoji). */
function skipLowSurrogate(text: string, n: number): number {
  if (n > 0 && n < text.length) {
    const code = text.charCodeAt(n);
    // Low surrogate = second half of a pair → advance one.
    if (code >= 0xdc00 && code <= 0xdfff) return n + 1;
  }
  return n;
}

export function useStreamingReveal(target: string, enabled: boolean): string {
  const [revealed, setRevealed] = useState(target);
  const stateRef = useRef({ target, revealed: target, cursor: target.length });
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);

  useEffect(() => {
    const s = stateRef.current;
    s.target = target;

    const stop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      lastTsRef.current = 0;
    };

    if (!enabled || prefersReducedMotion()) {
      stop();
      s.revealed = target;
      s.cursor = target.length;
      setRevealed(target);
      return;
    }

    // Hypothesis revision / shrink → snap now, drip only future growth.
    if (!target.startsWith(s.revealed)) {
      stop();
      s.revealed = target;
      s.cursor = target.length;
      setRevealed(target);
      return;
    }

    const tick = (now: number) => {
      rafRef.current = 0;
      const st = stateRef.current;
      const prev = lastTsRef.current || now;
      lastTsRef.current = now;
      const dt = Math.min(0.05, (now - prev) / 1000);
      const pending = st.target.length - st.revealed.length;
      if (pending <= 0) {
        lastTsRef.current = 0;
        return;
      }
      if (st.cursor < st.revealed.length) st.cursor = st.revealed.length;
      const cps = Math.min(MAX_CPS, Math.max(MIN_CPS, pending / DRAIN_SEC));
      st.cursor = Math.min(st.target.length, st.cursor + cps * dt);
      const n = skipLowSurrogate(st.target, Math.floor(st.cursor));
      if (n > st.revealed.length) {
        st.revealed = st.target.slice(0, n);
        setRevealed(st.revealed);
      }
      if (st.revealed.length < st.target.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        lastTsRef.current = 0;
      }
    };

    if (target.length > s.revealed.length && !rafRef.current) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [target, enabled]);

  // Cancel any in-flight frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return revealed;
}
