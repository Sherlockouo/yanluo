import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  INTRO_DONE_EVENT,
  INTRO_STORAGE_KEY,
  ONBOARD_STORAGE_KEY,
  markIntroDone,
  readIntroDone,
} from "@/lib/first-run";
import { playSfx, unlockSfx } from "@/lib/sfx";
import { readTourDone, requestStartTour } from "@/components/spotlight-tour";
import { duration, easeOut } from "@/lib/motion";

let bootArmed = false;

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARD_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * First-launch brand moment — soft Arc-adjacent chime + serif wordmark.
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

    // Keep short — long hold stacked on cold start felt like white-screen lag.
    const hold = reduce ? 280 : 720;
    const fade = reduce ? 140 : 280;
    const tHold = window.setTimeout(() => setPhase("out"), hold);
    const tDone = window.setTimeout(() => {
      markIntroDone();
      setOpen(false);
      window.dispatchEvent(new Event(INTRO_DONE_EVENT));
      // Returning users who skipped tour earlier: start after intro.
      if (readOnboarded() && !readTourDone()) {
        window.setTimeout(() => requestStartTour(), 120);
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
          className="first-run-intro"
          initial={{ opacity: 1 }}
          animate={{ opacity: phase === "out" ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.14 : 0.42, ease: easeOut }}
          onPointerDown={() => unlockSfx()}
          aria-hidden
        >
          <motion.div
            className="first-run-intro-mark"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 1.04, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={
              reduce
                ? { duration: 0.14 }
                : { duration: 0.7, ease: easeOut, delay: 0.08 }
            }
          >
            言落
          </motion.div>
          <motion.div
            className="first-run-intro-rule"
            initial={reduce ? { opacity: 1, scaleX: 1 } : { opacity: 0, scaleX: 0.2 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={
              reduce
                ? { duration: 0.14 }
                : { duration: 0.55, ease: easeOut, delay: 0.28 }
            }
          />
          <motion.div
            className="first-run-intro-tag"
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduce
                ? { duration: 0.14 }
                : { duration: duration.slow, ease: easeOut, delay: 0.48 }
            }
          >
            开口有结果
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export { INTRO_STORAGE_KEY };
