import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import {
  INTRO_DONE_EVENT,
  INTRO_STORAGE_KEY,
  ONBOARD_STORAGE_KEY,
  markIntroDone,
  readIntroDone,
} from "@/lib/first-run";
import { playSfx, unlockSfx } from "@/lib/sfx";
import { readTourDone, requestStartTour } from "@/components/spotlight-tour";

let bootArmed = false;

/** Soft ease-in-out for gradual brand reveal (not UI chrome). */
const easeReveal = [0.4, 0, 0.2, 1] as const;

/** Fixed scatter vectors — transform only, no layout. */
const PARTICLES: ReadonlyArray<{ x: number; y: number; s: number }> = [
  { x: -48, y: -36, s: 0.9 },
  { x: -22, y: -52, s: 1.1 },
  { x: 8, y: -58, s: 0.8 },
  { x: 36, y: -44, s: 1 },
  { x: 56, y: -18, s: 0.85 },
  { x: 62, y: 14, s: 1.05 },
  { x: 44, y: 42, s: 0.9 },
  { x: 12, y: 56, s: 1.1 },
  { x: -18, y: 52, s: 0.8 },
  { x: -46, y: 34, s: 1 },
  { x: -60, y: 4, s: 0.95 },
  { x: -54, y: -22, s: 1.05 },
  { x: -8, y: -28, s: 0.7 },
  { x: 24, y: 8, s: 0.75 },
  { x: -28, y: 18, s: 0.85 },
  { x: 40, y: -8, s: 0.7 },
];

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARD_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * First-launch brand moment — gradual reveal, linear dissolve + CSS particles.
 * Covers the shell so onboarding / tour can mount underneath without flash.
 */
export function FirstRunIntro() {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"in" | "out">("in");

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      if (!readIntroDone()) setOpen(true);
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    unlockSfx();
    if (!bootArmed) {
      bootArmed = true;
      playSfx("boot");
    }

    // Brand moment: slow reveal settle, then linear dissolve (not UI chrome ≤220ms).
    const hold = reduce ? 360 : 1680;
    const fade = reduce ? 180 : 820;
    const tHold = window.setTimeout(() => setPhase("out"), hold);
    const tDone = window.setTimeout(() => {
      markIntroDone();
      setOpen(false);
      window.dispatchEvent(new Event(INTRO_DONE_EVENT));
      if (readOnboarded() && !readTourDone()) {
        window.setTimeout(() => requestStartTour(), 160);
      }
    }, hold + fade);

    return () => {
      window.clearTimeout(tHold);
      window.clearTimeout(tDone);
    };
  }, [open, reduce]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="first-run-intro"
          className={cn("first-run-intro", phase === "out" && "is-out")}
          initial={{ opacity: 1 }}
          animate={{ opacity: phase === "out" ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={
            reduce
              ? { duration: 0.18, ease: "linear" }
              : { duration: 0.82, ease: "linear" }
          }
          onPointerDown={() => unlockSfx()}
          aria-hidden
        >
          <div className="first-run-intro-stage">
            {!reduce ? (
              <div className="first-run-intro-particles" aria-hidden>
                {PARTICLES.map((p, i) => (
                  <span
                    key={i}
                    className="first-run-intro-dot"
                    style={
                      {
                        "--dx": `${p.x}px`,
                        "--dy": `${p.y}px`,
                        "--ds": p.s,
                        "--i": i,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            ) : null}

            <motion.div
              className="first-run-intro-mark"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 14 }}
              animate={
                phase === "out"
                  ? { opacity: 0, scale: 1.06, y: -4 }
                  : { opacity: 1, scale: 1, y: 0 }
              }
              transition={
                reduce
                  ? { duration: 0.18, ease: "linear" }
                  : phase === "out"
                    ? { duration: 0.72, ease: "linear" }
                    : { duration: 1.15, ease: easeReveal, delay: 0.1 }
              }
            >
              言落
            </motion.div>

            <motion.div
              className="first-run-intro-rule"
              initial={reduce ? { opacity: 1, scaleX: 1 } : { opacity: 0, scaleX: 0.12 }}
              animate={
                phase === "out"
                  ? { opacity: 0, scaleX: 0.4 }
                  : { opacity: 1, scaleX: 1 }
              }
              transition={
                reduce
                  ? { duration: 0.18, ease: "linear" }
                  : phase === "out"
                    ? { duration: 0.55, ease: "linear" }
                    : { duration: 0.95, ease: easeReveal, delay: 0.42 }
              }
            />

            <motion.div
              className="first-run-intro-tag"
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 10 }}
              animate={
                phase === "out"
                  ? { opacity: 0, y: -6 }
                  : { opacity: 1, y: 0 }
              }
              transition={
                reduce
                  ? { duration: 0.18, ease: "linear" }
                  : phase === "out"
                    ? { duration: 0.5, ease: "linear" }
                    : { duration: 0.9, ease: easeReveal, delay: 0.72 }
              }
            >
              开口有结果
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export { INTRO_STORAGE_KEY };
