import { useEffect, useRef, useState } from "react";

/**
 * Smooth character reveal for streaming captions (typewriter).
 *
 * ASR partials arrive in bursts (every ~0.3-0.6s, several characters each).
 * Rendering them verbatim reads as "chunk by chunk"; draining each burst on a
 * fixed timer merely chops the jumpiness into "flow … stall … flow …".
 *
 * The cadence model here is the one streaming captions actually need: the
 * reveal rate tracks the *character arrival rate*. When a burst lands we
 * measure the inter-burst interval (EMA, clamped), then drain the backlog at
 * backlog/interval characters per second — i.e. the burst finishes revealing
 * exactly when the next burst is predicted to land. Bursts chain seamlessly,
 * so the caption advances like a constant-rate stream regardless of burst
 * size or cadence. Small bursts (user speaking slowly) drain at MIN_CPS, which
 * also matches their rhythm — burst sizes are auto-correlated with speech.
 *
 * Revisions are diff-aware: a segment commit re-decodes the whole sentence,
 * so its text almost always differs from the drip mid-flight by a few
 * characters near the tail. Snapping the whole line on every commit is what
 * makes later words "jump" after a fluent opening. Instead, keep the stable
 * prefix, snap only the changed region, and keep dripping the new tail.
 * Deep rewrites (beyond the drip tail — language relock, LLM refine) snap
 * wholesale; smoothing those would reshuffle the line anyway.
 * `prefers-reduced-motion`: target is returned unchanged.
 */

/** Inter-burst interval estimates are clamped before entering the EMA. */
const MIN_INTERVAL = 0.2;
/** Long segments decode slower (KV growth + rollback re-encode) — bursts can
 * legitimately space out past 1s; clamping lower than real cadence makes the
 * backlog drain early and reintroduces flow-stall-flow. */
const MAX_INTERVAL = 1.5;
/** Fallback before any measurement (matches the backend cadence ballpark). */
const DEFAULT_INTERVAL = 0.6;
/** Slowest drip (chars/sec) — small/slow bursts still move visibly. */
const MIN_CPS = 6;
/** Cap for large catch-ups (chars/sec). */
const MAX_CPS = 90;
/** EMA smoothing factor for the interval estimate. */
const EMA_ALPHA = 0.3;
/** Revisions within this many chars of the drip tail get a smooth re-drip;
 * deeper rewrites snap (the line is being reshuffled anyway). */
const REVISE_TAIL_CHARS = 8;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
  const stateRef = useRef({
    target,
    revealed: target,
    cursor: target.length,
    intervalEma: DEFAULT_INTERVAL,
    lastGrowthAt: 0,
    cps: MIN_CPS,
  });
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);

  useEffect(() => {
    const s = stateRef.current;
    const prevTarget = s.target;
    s.target = target;

    const stop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      lastTsRef.current = 0;
    };

    const snap = (text: string) => {
      stop();
      s.revealed = text;
      s.cursor = text.length;
      setRevealed(text);
    };

    if (!enabled || prefersReducedMotion()) {
      snap(target);
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
      st.cursor = Math.min(st.target.length, st.cursor + st.cps * dt);
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

    // Revision (commit re-decode, rollback, language relock): diff-aware.
    if (!target.startsWith(s.revealed)) {
      let p = 0;
      const min = Math.min(s.revealed.length, target.length);
      while (p < min && s.revealed.charCodeAt(p) === target.charCodeAt(p)) p++;
      p = skipLowSurrogate(target, p);
      const deepRewrite = p + REVISE_TAIL_CHARS < s.revealed.length;
      if (deepRewrite) {
        snap(target);
        return;
      }
      // Tail revision: keep the stable prefix, snap the changed region up to
      // the divergence point, and keep dripping from there.
      s.revealed = target.slice(0, p);
      s.cursor = p;
      setRevealed(s.revealed);
      if (target.length > prevTarget.length) {
        const now = performance.now() / 1000;
        if (s.lastGrowthAt > 0) {
          const sample = clamp(now - s.lastGrowthAt, MIN_INTERVAL, MAX_INTERVAL);
          s.intervalEma += (sample - s.intervalEma) * EMA_ALPHA;
        }
        s.lastGrowthAt = now;
      }
      const backlog = target.length - s.revealed.length;
      if (backlog > 0) {
        s.cps = clamp(backlog / s.intervalEma, MIN_CPS, MAX_CPS);
        if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
      }
      return;
    }

    if (target.length > prevTarget.length) {
      // New burst: update the cadence model from its arrival interval, then
      // size the drain rate so this backlog finishes as the next one lands.
      const now = performance.now() / 1000;
      if (s.lastGrowthAt > 0) {
        const sample = clamp(now - s.lastGrowthAt, MIN_INTERVAL, MAX_INTERVAL);
        s.intervalEma += (sample - s.intervalEma) * EMA_ALPHA;
      }
      s.lastGrowthAt = now;
      const backlog = target.length - s.revealed.length;
      s.cps = clamp(backlog / s.intervalEma, MIN_CPS, MAX_CPS);
    }

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
