import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import type { FloatingPayload } from "@/types";
import { CAPSULE_TAIL_CHARS, lastChars } from "@/lib/constants";
import { useSmoothedRms } from "@/hooks/useAudioBars";
import { AudioBars } from "@/components/ui/audio-bars";
import { cn } from "@/lib/cn";

const CAPSULE_H = 56;
const TEXT_MIN = 160;
const TEXT_MAX = 560;
/** Horizontal chrome: padding + waveform + gap + colon + trailing pad */
const CHROME_W = 16 + 44 + 12 + 10 + 18;

/**
 * Independent ASR HUD window content.
 * Mounted only when the Tauri window label is `floating`.
 * The native window itself is the frosted capsule (HudWindow vibrancy).
 */
export function AsrHud() {
  const [payload, setPayload] = useState<FloatingPayload>({
    visible: false,
    state: "idle",
    text: "",
    rms: 0,
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-floating", "1");
    document.documentElement.classList.add("dark");

    let disposed = false;
    let unlistenStatus: UnlistenFn | null = null;
    let unlistenLevel: UnlistenFn | null = null;
    let unlistenPartial: UnlistenFn | null = null;

    void invoke<FloatingPayload>("get_floating_status")
      .then((status) => {
        if (!disposed) setPayload(status);
      })
      .catch(() => {
        /* ignore — command may not be ready during HMR */
      });

    void listen<FloatingPayload>("floating-status", (event) =>
      setPayload(event.payload),
    ).then((u) => {
      unlistenStatus = u;
    });
    void listen<number>("audio-level", (event) =>
      setPayload((prev) => ({ ...prev, rms: event.payload })),
    ).then((u) => {
      unlistenLevel = u;
    });
    void listen<{ text: string }>("partial-result", (event) =>
      setPayload((prev) => ({
        ...prev,
        visible: true,
        state: prev.state === "idle" ? "recording" : prev.state,
        text: event.payload.text,
      })),
    ).then((u) => {
      unlistenPartial = u;
    });

    return () => {
      disposed = true;
      unlistenStatus?.();
      unlistenLevel?.();
      unlistenPartial?.();
    };
  }, []);

  const show = payload.visible && payload.state !== "idle";

  return (
    <div
      className="hud-root"
      onPointerDown={(event) => {
        // Left-button drag moves the native frosted capsule.
        if (event.button !== 0) return;
        void getCurrentWindow().startDragging().catch(() => {});
      }}
    >
      <AnimatePresence mode="wait">
        {show && <FloatingCapsule key="capsule" payload={payload} />}
      </AnimatePresence>
    </div>
  );
}

function FloatingCapsule({ payload }: { payload: FloatingPayload }) {
  const refining = payload.state === "refining";
  const recording = payload.state === "recording";
  const displayText = refining
    ? "Refining…"
    : payload.state === "processing"
      ? "Transcribing…"
      : payload.text
        ? lastChars(payload.text, CAPSULE_TAIL_CHARS)
        : "倾听中…";
  const smoothed = useSmoothedRms(payload.rms, recording);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [textW, setTextW] = useState(TEXT_MIN);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const measured = Math.ceil(el.getBoundingClientRect().width);
    setTextW(Math.max(TEXT_MIN, Math.min(TEXT_MAX, measured)));
  }, [displayText]);

  const capsuleW = useMemo(() => CHROME_W + textW, [textW]);

  // Keep the native window sized to the capsule so HudWindow vibrancy is pill-shaped.
  // Recenter only on X (preserve user-dragged Y).
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setSize(new LogicalSize(capsuleW, CAPSULE_H)).catch(() => {});
    void invoke("recenter_floating_hud", { width: capsuleW }).catch(() => {});
  }, [capsuleW]);

  return (
    <motion.div
      className={cn("hud-capsule", refining && "hud-capsule-refining")}
      initial={{ opacity: 0, scale: 0.86, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{
        opacity: 0,
        scale: 0.92,
        y: 6,
        transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        type: "spring",
        stiffness: 420,
        damping: 28,
        mass: 0.85,
        duration: 0.35,
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <div className="hud-inner">
        <AudioBars rms={smoothed} active={recording || refining} />
        <span className="hud-colon" aria-hidden>
          :
        </span>
        <motion.span
          className={cn("hud-text", refining && "hud-text-refining")}
          animate={{ width: textW }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {displayText}
        </motion.span>
        <span ref={measureRef} className="hud-text-measure" aria-hidden>
          {displayText}
        </span>
      </div>
    </motion.div>
  );
}
