import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@heroui/react";
import { duration, easeOut } from "@/lib/motion";
import {
  ONBOARD_STORAGE_KEY,
  TOUR_START_EVENT,
  TOUR_STORAGE_KEY,
} from "@/lib/first-run";

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
  title: string;
  body: string;
};

const STEPS: TourStep[] = [
  {
    id: "draft",
    anchor: "rail-draft",
    path: "/draft",
    title: "出稿",
    body: "开口出稿。开会、口述、文件转写，说完桌上有稿。",
  },
  {
    id: "live",
    anchor: "draft-hotkeys",
    path: "/draft?mode=live",
    title: "热键出稿",
    body: "按住出稿键说话，松开关闭；翻译用旁边那组热键。",
  },
  {
    id: "dispatch",
    anchor: "rail-dispatch",
    path: "/dispatch",
    title: "派活",
    body: "开口派活。把事交给本机 Claude / Codex / Pi。",
  },
  {
    id: "asr",
    anchor: "settings-asr",
    path: "/settings?tab=asr",
    title: "识别",
    body: "模型目录与场景在这里。切得太碎就调低灵敏度。",
  },
  {
    id: "hotkeys",
    anchor: "settings-hotkeys",
    path: "/settings?tab=system&sub=hotkeys",
    title: "快捷键",
    body: "出稿、翻译、派活热键都可改。权限也在系统里。",
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
 */
export function SpotlightTour() {
  const navigate = useNavigate();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [hole, setHole] = useState<Hole | null>(null);

  const finish = useCallback(() => {
    markTourDone();
    setActive(false);
    setIndex(0);
    setHole(null);
  }, []);

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
  }, []);

  useEffect(() => {
    const onStart = () => start();
    window.addEventListener(TOUR_START_EVENT, onStart);
    const id = window.requestAnimationFrame(() => {
      if (readOnboardedFlag() && !readTourDone()) start();
    });
    return () => {
      window.removeEventListener(TOUR_START_EVENT, onStart);
      window.cancelAnimationFrame(id);
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
        await new Promise((r) => window.setTimeout(r, 120));
      }
      const tick = () => {
        if (cancelled) return;
        const next = measureAnchor(step.anchor);
        if (next) {
          setHole(next);
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
    if (index + 1 >= STEPS.length) {
      finish();
      return;
    }
    setHole(null);
    setIndex((i) => i + 1);
  };

  if (!active || !step) return null;

  const tipStyle: CSSProperties = hole
    ? {
        top: Math.min(window.innerHeight - 140, hole.top + hole.height + 12),
        left: Math.min(window.innerWidth - 320, Math.max(16, hole.left)),
      }
    : { top: "40%", left: "50%", transform: "translateX(-50%)" };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="tour-root"
        className="spotlight-root"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: duration.normal, ease: easeOut }}
      >
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
          className="spotlight-tip"
          style={tipStyle}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.fast, ease: easeOut }}
          role="dialog"
          aria-label={step.title}
        >
          <div className="spotlight-tip-kicker">
            {index + 1} / {STEPS.length}
          </div>
          <div className="spotlight-tip-title">{step.title}</div>
          <p className="spotlight-tip-body">{step.body}</p>
          <div className="spotlight-tip-actions">
            <button type="button" className="spotlight-skip" onClick={finish}>
              跳过
            </button>
            <Button variant="primary" className="btn-press" onPress={next}>
              {index + 1 >= STEPS.length ? "完成" : "下一步"}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
