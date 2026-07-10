import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronUp } from "lucide-react";
import type { FloatingPayload } from "@/types";
import { hudTargetShort, translateTargetLabel } from "@/lib/constants";
import { cn } from "@/lib/cn";

function applyHudTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.setAttribute("data-theme", theme);
  void invoke("set_floating_theme", { theme }).catch(() => {});
}

/**
 * Separate frosted chip appended to the right of the ASR capsule.
 * Opens a native system menu — never grows the HUD window.
 */
export function AsrHudLangChip() {
  const [payload, setPayload] = useState<FloatingPayload>({
    visible: false,
    state: "idle",
    text: "",
    rms: 0,
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-floating", "1");
    document.documentElement.setAttribute("data-floating-lang", "1");

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
    let unlistenTheme: UnlistenFn | null = null;

    void invoke<FloatingPayload>("get_floating_status")
      .then((status) => {
        if (!disposed) setPayload(status);
      })
      .catch(() => {});

    void listen<FloatingPayload>("floating-status", (event) => {
      setPayload(event.payload);
    }).then((u) => {
      unlistenStatus = u;
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
      unlistenTheme?.();
    };
  }, []);

  const switching = Boolean(payload.switching);
  const target = payload.target_language ?? "en-US";
  const short = hudTargetShort(target) || "EN";
  const busy =
    switching ||
    payload.state === "refining" ||
    payload.state === "processing";

  return (
    <div className="hud-lang-root">
      <button
        type="button"
        className={cn(
          "hud-lang-chip",
          switching && "hud-target-switching",
          busy && "is-busy",
        )}
        aria-label={`翻译到 ${translateTargetLabel(target) || short}`}
        disabled={busy}
        onClick={() => {
          void invoke("popup_translate_target_menu").catch(() => {});
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={target}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.16 }}
          >
            {short}
          </motion.span>
        </AnimatePresence>
        <ChevronUp size={11} strokeWidth={2.5} aria-hidden />
      </button>
    </div>
  );
}
