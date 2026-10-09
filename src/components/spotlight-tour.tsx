import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@heroui/react";
import { duration, easeOut } from "@/lib/motion";
import { useT } from "@/lib/i18n";
import {
  ONBOARD_STORAGE_KEY,
  TOUR_START_EVENT,
  TOUR_STORAGE_KEY,
  INTRO_DONE_EVENT,
  readIntroDone,
  setTourActive,
} from "@/lib/first-run";
import { playSfx, unlockSfx } from "@/lib/sfx";

export { TOUR_STORAGE_KEY, TOUR_START_EVENT };

function readOnboardedFlag(): boolean {
  try {
    return localStorage.getItem(ONBOARD_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function readTourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTourDone() {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function requestStartTour() {
  try {
    localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(TOUR_START_EVENT));
}

type TourStep = {
  id: string;
  anchor: string;
  path?: string;
  titleKey: string;
  bodyKey: string;
};

const STEPS: TourStep[] = [
  {
    id: "draft",
    anchor: "rail-draft",
    path: "/draft",
    titleKey: "common.tour.draftTitle",
    bodyKey: "common.tour.draftBody",
  },
  {
    id: "live",
    anchor: "draft-hotkeys",
    path: "/draft?mode=live",
    titleKey: "common.tour.liveTitle",
    bodyKey: "common.tour.liveBody",
  },
  {
    id: "dispatch",
    anchor: "rail-dispatch",
    path: "/dispatch",
    titleKey: "common.tour.dispatchTitle",
    bodyKey: "common.tour.dispatchBody",
  },
  {
    id: "asr",
    anchor: "settings-asr",
    path: "/settings?tab=asr",
    titleKey: "common.tour.asrTitle",
    bodyKey: "common.tour.asrBody",
  },
  {
    id: "hotkeys",
    anchor: "settings-hotkeys",
    path: "/settings?tab=system&sub=hotkeys",
    titleKey: "common.tour.hotkeysTitle",
    bodyKey: "common.tour.hotkeysBody",
  },
];

type Hole = { top: number; left: number; width: number; height: number };

function measureAnchor(anchor: string): Hole | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const pad = 6;
  return {
    top: Math.max(8, r.top - pad),
    left: Math.max(8, r.left - pad),
    width: Math.min(window.innerWidth - 16, r.width + pad * 2),
    height: Math.min(window.innerHeight - 16, r.height + pad * 2),
  };
}

/**
 * Quiet spotlight tour — one short line per step, copper hole, no manual wall.
 * Keeps previous hole while measuring next → no full-dim flash on step change.
 */
export function SpotlightTour() {
  const navigate = useNavigate();
  const t = useT();
  const reduce = useReducedMotion();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [hole, setHole] = useState<Hole | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const finish = useCallback(() => {
    markTourDone();
    setTourActive(false);
    setActive(false);
    setIndex(0);
    setHole(null);
  }, []);

  // Escape skips the tour; keep it on window so the tip need not be focused.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, finish]);

  // Move keyboard focus to the step card on each step change.
  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => tipRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [active, index]);

  const start = useCallback(() => {
    unlockSfx();
    setTourActive(true);
    setIndex(0);
    setActive(true);
  }, []);

  useEffect(() => {
    const onStart = () => start();
    window.addEventListener(TOUR_START_EVENT, onStart);
    const tryAuto = () => {
      if (!readIntroDone()) return;
      if (readOnboardedFlag() && !readTourDone()) start();
    };
    const id = window.requestAnimationFrame(tryAuto);
    window.addEventListener(INTRO_DONE_EVENT, tryAuto);
    return () => {
      window.removeEventListener(TOUR_START_EVENT, onStart);
      window.removeEventListener(INTRO_DONE_EVENT, tryAuto);
      window.cancelAnimationFrame(id);
      setTourActive(false);
    };
  }, [start]);

  const step = STEPS[index] ?? null;

  useEffect(() => {
    if (!active || !step) return;
    let cancelled = false;
    let tries = 0;

    const run = async () => {
      if (step.path) {
        navigate(step.path);
        // Let route paint under veil (tour-active disables PageShell enter).
        await new Promise((r) => window.setTimeout(r, 80));
      }
      const tick = () => {
        if (cancelled) return;
        const next = measureAnchor(step.anchor);
        if (next) {
          setHole(next);
          playSfx("tourStep");
          return;
        }
        tries += 1;
        if (tries > 20) {
          setIndex((i) => {
            if (i + 1 >= STEPS.length) {
              finish();
              return i;
            }
            return i + 1;
          });
          return;
        }
        window.setTimeout(tick, 50);
      };
      tick();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [active, step, navigate, finish]);

  useLayoutEffect(() => {
    if (!active || !step) return;
    const onResize = () => setHole(measureAnchor(step.anchor));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active, step]);

  const next = () => {
    unlockSfx();
    playSfx("uiTap");
    if (index + 1 >= STEPS.length) {
      finish();
      return;
    }
    // Keep current hole until next measures — no flash to full dim.
    setIndex((i) => i + 1);
  };

  if (!active || !step) return null;

  const tipStyle: CSSProperties = hole
    ? {
        top: Math.min(window.innerHeight - 140, hole.top + hole.height + 12),
        left: Math.min(window.innerWidth - 320, Math.max(16, hole.left)),
      }
    : // Margin, not transform: framer-motion owns transform while animating.
      { top: "40%", left: "50%", marginLeft: -150 };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="tour-root"
        className="spotlight-root"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0.1 : duration.normal, ease: easeOut }}
      >
        <div className="spotlight-blocker" aria-hidden />
        {hole ? (
          <div
            className="spotlight-hole"
            style={{
              top: hole.top,
              left: hole.left,
              width: hole.width,
              height: hole.height,
            }}
          />
        ) : (
          <div className="spotlight-dim" />
        )}

        <motion.div
          key={step.id}
          ref={tipRef}
          tabIndex={-1}
          className="spotlight-tip outline-none"
          style={tipStyle}
          initial={reduce ? { opacity: 1 } : { opacity: 0.92, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: reduce ? 0 : duration.fast, ease: easeOut }}
          role="dialog"
          aria-label={t(step.titleKey)}
        >
          <div className="spotlight-tip-kicker">
            {index + 1} / {STEPS.length}
          </div>
          <div className="spotlight-tip-title">{t(step.titleKey)}</div>
          <p className="spotlight-tip-body">{t(step.bodyKey)}</p>
          <div className="spotlight-tip-actions">
            <button
              type="button"
              className="spotlight-skip rounded transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
              onClick={finish}
            >
              {t("common.tour.skip")}
            </button>
            <Button variant="primary" className="btn-press" onPress={next}>
              {index + 1 >= STEPS.length
                ? t("common.tour.done")
                : t("common.tour.next")}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
