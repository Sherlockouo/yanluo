import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import type { AudioLevelPayload, FloatingPayload } from "@/types";
import { useSmoothedRms } from "@/hooks/useAudioBars";
import { AudioBars } from "@/components/ui/audio-bars";
import { cn } from "@/lib/cn";

/** Fixed HUD footprint — never resize with transcript length. */
const CAPSULE_W = 320;
const CAPSULE_H = 56;

function applyHudTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.setAttribute("data-theme", theme);
  void invoke("set_floating_theme", { theme }).catch(() => {});
}

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
    bands: [],
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-floating", "1");

    const syncTheme = () => {
      const theme =
        localStorage.getItem("asr-theme") === "light" ? "light" : "dark";
      applyHudTheme(theme);
    };
    syncTheme();

    const onStorage = (event: StorageEvent) => {
      if (event.key === "asr-theme") syncTheme();
    };
    window.addEventListener("storage", onStorage);

    let disposed = false;
    let unlistenStatus: UnlistenFn | null = null;
    let unlistenLevel: UnlistenFn | null = null;
    let unlistenPartial: UnlistenFn | null = null;
    let unlistenTheme: UnlistenFn | null = null;

    void invoke<FloatingPayload>("get_floating_status")
      .then((status) => {
        if (!disposed) setPayload(status);
      })
      .catch(() => {
        /* ignore — command may not be ready during HMR */
      });

    void listen<FloatingPayload>("floating-status", (event) =>
      setPayload((prev) => ({
        ...event.payload,
        // Never let status snapshots wipe the live meter.
        rms: event.payload.rms > 0 ? event.payload.rms : prev.rms,
      })),
    ).then((u) => {
      unlistenStatus = u;
    });
    void listen<AudioLevelPayload | number>("audio-level", (event) => {
      const raw = event.payload;
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return;
        setPayload((prev) => ({
          ...prev,
          rms: Math.max(0, Math.min(1, raw)),
        }));
        return;
      }
      const rms = Number(raw?.rms);
      if (!Number.isFinite(rms)) return;
      const bands = Array.isArray(raw.bands)
        ? raw.bands.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [];
      setPayload((prev) => ({
        ...prev,
        rms: Math.max(0, Math.min(1, rms)),
        bands,
      }));
    }).then((u) => {
      unlistenLevel = u;
    });
    void listen<{
      text: string;
      committed?: string;
      active?: string;
      segment_index?: number;
    }>("partial-result", (event) =>
      setPayload((prev) => ({
        ...prev,
        visible: true,
        state: prev.state === "idle" ? "recording" : prev.state,
        text: event.payload.text,
        switching:
          event.payload.text.trim() === "" ? prev.switching : false,
      })),
    ).then((u) => {
      unlistenPartial = u;
    });
    void listen<"light" | "dark">("theme-changed", (event) => {
      applyHudTheme(event.payload);
    }).then((u) => {
      unlistenTheme = u;
    });

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlistenStatus?.();
      unlistenLevel?.();
      unlistenPartial?.();
      unlistenTheme?.();
    };
  }, []);

  const show = payload.visible && payload.state !== "idle";

  return (
    <div
      className="hud-root"
      onPointerDown={(event) => {
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
  const processing = payload.state === "processing";
  const recording = payload.state === "recording";
  const switching = Boolean(payload.switching);
  const loading = refining || processing || switching;
  const translating = payload.intention === "translate";
  const lastTextRef = useRef("");
  const prevShownRef = useRef("");
  const textViewportRef = useRef<HTMLDivElement>(null);
  const sizedRef = useRef(false);
  const [justRefined, setJustRefined] = useState(false);

  if (payload.text.trim()) {
    lastTextRef.current = payload.text;
  } else if (recording || switching) {
    lastTextRef.current = "";
  }

  const sourceText =
    payload.text.trim() ||
    (loading && !switching ? lastTextRef.current : "");
  const displayText = switching ? "" : sourceText;

  useEffect(() => {
    if (!displayText || displayText === prevShownRef.current) return;
    const prev = prevShownRef.current;
    prevShownRef.current = displayText;
    if (!prev || refining || recording || switching) return;
    if (!processing) return;
    setJustRefined(true);
    const t = window.setTimeout(() => setJustRefined(false), 900);
    return () => window.clearTimeout(t);
  }, [displayText, processing, refining, recording, switching]);

  const [overflowing, setOverflowing] = useState(false);
  const smoothed = useSmoothedRms(payload.rms, recording && !switching);

  useEffect(() => {
    if (sizedRef.current) return;
    sizedRef.current = true;
    const win = getCurrentWindow();
    void win.setSize(new LogicalSize(CAPSULE_W, CAPSULE_H)).catch(() => {});
    void invoke("recenter_floating_hud", { width: CAPSULE_W }).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    const el = textViewportRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setOverflowing(el.scrollWidth > el.clientWidth + 1);
  }, [displayText, loading, switching]);

  return (
    <motion.div
      className={cn(
        "hud-capsule",
        loading && "hud-capsule-refining",
        switching && "hud-capsule-switching",
        justRefined && "hud-capsule-refined",
      )}
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
        {loading ? (
          <span
            className="hud-spinner"
            aria-label={
              switching ? "切换目标语言" : translating ? "翻译中" : "处理中"
            }
          />
        ) : (
          <AudioBars
            rms={smoothed}
            bands={payload.bands}
            active={recording}
          />
        )}
        <span className="hud-colon" aria-hidden>
          :
        </span>
        <div
          ref={textViewportRef}
          className={cn(
            "hud-text-viewport",
            overflowing && "hud-text-overflow",
            loading && "hud-text-refining",
            switching && "hud-text-switching",
            justRefined && "hud-text-refined",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={switching ? "switching" : "content"}
              className="hud-text-scroll"
              initial={
                switching
                  ? { opacity: 0, filter: "blur(4px)" }
                  : { opacity: 0.7 }
              }
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(3px)" }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {switching
                ? "切换中"
                : displayText ||
                  (loading ? (translating ? "翻译中" : "处理中") : "")}
              {(loading || switching) && (displayText || switching) ? (
                <span className="hud-loading-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
