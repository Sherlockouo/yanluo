import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronUp } from "lucide-react";
import type { FloatingPayload } from "@/types";
import {
  TRANSLATE_LANGUAGES,
  hudTargetShort,
  translateTargetLabel,
} from "@/lib/constants";
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
 * Opens an in-window menu (native NSMenu fails over fullscreen apps).
 */
export function AsrHudLangChip() {
  const [payload, setPayload] = useState<FloatingPayload>({
    visible: false,
    state: "idle",
    text: "",
    rms: 0,
  });
  const [menuOpen, setMenuOpen] = useState(false);

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
    let unlistenMenu: UnlistenFn | null = null;

    void invoke<FloatingPayload>("get_floating_status")
      .then((status) => {
        if (!disposed) setPayload(status);
      })
      .catch(() => {});

    void listen<FloatingPayload>("floating-status", (event) => {
      setPayload(event.payload);
      if (!event.payload.visible) {
        setMenuOpen(false);
        void invoke("set_floating_lang_menu_open", { open: false }).catch(
          () => {},
        );
      }
    }).then((u) => {
      unlistenStatus = u;
    });
    void listen<"light" | "dark">("theme-changed", (event) => {
      applyHudTheme(event.payload);
    }).then((u) => {
      unlistenTheme = u;
    });
    void listen<boolean>("floating-lang-menu", (event) => {
      setMenuOpen(Boolean(event.payload));
    }).then((u) => {
      unlistenMenu = u;
    });

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlistenStatus?.();
      unlistenTheme?.();
      unlistenMenu?.();
      // Do NOT invoke set_floating_lang_menu_open(false) here — HMR/unmount
      // used to orderFront the chip and flash EN on launch.
    };
  }, []);

  // Esc is handled by the global event tap (NonactivatingPanel never gets keydown).
  // Keep a local listener only as a no-op fallback when the chip somehow has focus.

  const switching = Boolean(payload.switching);
  const target = payload.target_language ?? "en-US";
  const short = hudTargetShort(target) || "EN";
  const busy =
    switching ||
    payload.state === "refining" ||
    payload.state === "processing";

  const closeMenu = () => {
    setMenuOpen(false);
    void invoke("set_floating_lang_menu_open", { open: false }).catch(() => {});
  };

  const openMenu = () => {
    if (busy) return;
    setMenuOpen(true);
    void invoke("set_floating_lang_menu_open", { open: true }).catch(() => {});
  };

  const pick = (code: string) => {
    void invoke("set_translate_target_language", { language: code })
      .then(() => setMenuOpen(false))
      .catch(() => {
        closeMenu();
      });
  };

  return (
    <div
      className={cn("hud-lang-root", menuOpen && "is-menu-open")}
      onMouseLeave={() => {
        if (menuOpen) closeMenu();
      }}
    >
      {menuOpen ? (
        <div className="hud-lang-menu" role="listbox" aria-label="翻译目标语言">
          {TRANSLATE_LANGUAGES.map(([code, label]) => {
            const selected = code === target;
            return (
              <button
                key={code}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn("hud-lang-option", selected && "is-selected")}
                onClick={() => pick(code)}
              >
                <span className="hud-lang-option-short">
                  {hudTargetShort(code)}
                </span>
                <span className="hud-lang-option-label">{label}</span>
                <span className="hud-lang-option-code">{code}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <button
        type="button"
        className={cn(
          "hud-lang-chip",
          switching && "hud-target-switching",
          busy && "is-busy",
          menuOpen && "is-open",
        )}
        aria-label={`${translateTargetLabel(target) || short}`}
        aria-expanded={menuOpen}
        aria-haspopup="listbox"
        disabled={busy}
        onClick={() => {
          if (menuOpen) closeMenu();
          else openMenu();
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
        <ChevronUp
          size={11}
          strokeWidth={2.5}
          aria-hidden
          className={cn(menuOpen && "hud-lang-chevron-open")}
        />
      </button>
    </div>
  );
}
