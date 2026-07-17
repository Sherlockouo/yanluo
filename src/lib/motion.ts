import { useMemo } from "react";
import { useReducedMotion, type Transition, type Variants } from "framer-motion";

/** Compositor-friendly ease. Keep transitions short — no springs on route/nav. */
export const easeOut = [0.22, 1, 0.36, 1] as const;

export const duration = {
  fast: 0.14,
  normal: 0.18,
  slow: 0.24,
} as const;

/** Nav pill — tween only (spring + layoutId = main-thread jank). */
export const navIndicatorTransition: Transition = {
  type: "tween",
  duration: duration.normal,
  ease: easeOut,
};

type MotionBundle = {
  initial: { opacity: number; y?: number };
  animate: { opacity: number; y?: number };
  exit: { opacity: number; y?: number };
  transition: Transition;
};

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
    transition: { duration: duration.fast, ease: easeOut },
  };
}

export const pageEnterVariants: Variants = {
  initial: { opacity: 0.96, y: 8 },
  animate: { opacity: 1, y: 0 },
};

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
