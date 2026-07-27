import { useMemo } from "react";
import { useReducedMotion, type Transition } from "framer-motion";

/** Compositor-friendly ease. Keep transitions short — no springs on route/nav. */
export const easeOut = [0.22, 1, 0.36, 1] as const;

export const duration = {
  fast: 0.14,
  normal: 0.18,
  /** Cap: short motion must stay ≤220ms. */
  slow: 0.22,
} as const;

/** Nav pill — tween only (spring + layoutId = main-thread jank). */
export const navIndicatorTransition: Transition = {
  type: "tween",
  duration: duration.normal,
  ease: easeOut,
};

/**
 * UI-element spring (cards, panels, popovers). bounce:0 = critically damped —
 * interruptible with no overshoot. Never for route/nav (those stay tween).
 */
export const springUI = { type: "spring", bounce: 0, duration: 0.2 } as const;

/**
 * Delight spring — visual-enjoyment moments only (modal appear / card landing /
 * popover pop). Slight overshoot is the point. Never for route/nav.
 */
export const springBounce = {
  type: "spring",
  bounce: 0.25,
  duration: 0.35,
} as const;

type MotionBundle = {
  initial: { opacity: number; y?: number };
  animate: { opacity: number; y?: number };
  exit: { opacity: number; y?: number };
  transition: Transition;
};

/*
 * ─── Motion presets ───────────────────────────────────────────────────────────
 * • fadeSlide — mode-level enter (tab/mode switch within a page, e.g. 出稿 modes).
 *   Enter-only; no AnimatePresence exit to avoid ghosting in-flow swaps.
 * • PageShell uses its own page-level enter (opacity 0.92→1, y 12→0, scale 0.995→1,
 *   180ms tween) defined inline. Do not conflate with fadeSlide.
 * ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Page / screen enter. Never start at opacity 0 — blank frame reads as hitch.
 * Transform + opacity only (GPU). Enter-only for mode/tab swaps — exit+enter
 * in document flow (AnimatePresence sync) stacks both panels = ghosting.
 */
function fadeSlide(reduce: boolean | null | undefined): MotionBundle {
  if (reduce) {
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: { duration: 0 },
    };
  }
  return {
    initial: { opacity: 0.96, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0 },
    transition: { duration: duration.normal, ease: easeOut },
  };
}

function fadeOnly(reduce: boolean | null | undefined): MotionBundle {
  if (reduce) {
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: { duration: 0 },
    };
  }
  return {
    initial: { opacity: 0.96 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: duration.fast, ease: easeOut },
  };
}

/** Expand: skip height:auto (layout thrash). Opacity + slight y only. */
export type SoftCollapseMotion = {
  initial: { opacity: number; y: number };
  animate: { opacity: number; y: number };
  exit: { opacity: number; y: number };
  transition: Transition;
};

function softCollapse(reduce: boolean | null | undefined): SoftCollapseMotion {
  if (reduce) {
    return {
      initial: { opacity: 1, y: 0 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 1, y: 0 },
      transition: { duration: 0 },
    };
  }
  return {
    initial: { opacity: 0.92, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: springUI,
  };
}

/** Cap list stagger: first 4 items, ≤40ms delay each. */
export function revealDelay(index: number): number {
  return Math.min(Math.max(index, 0), 3) * 0.04;
}

/** Route / screen enter-exit with slight vertical travel. */
export function useFadeSlide() {
  const reduce = useReducedMotion();
  return useMemo(() => fadeSlide(reduce), [reduce]);
}

/** Opacity-only (settings tabs). */
export function useFade() {
  const reduce = useReducedMotion();
  return useMemo(() => fadeOnly(reduce), [reduce]);
}

/** Soft expand/collapse without height:auto measurement. */
export function useCollapse() {
  const reduce = useReducedMotion();
  return useMemo(() => softCollapse(reduce), [reduce]);
}
