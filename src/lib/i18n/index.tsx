/**
 * Lightweight i18n — no external deps.
 *
 * Usage:
 *   const t = useT();            // inside React components
 *   t("draft.title")             // key lookup, falls back: locale → en → key itself
 *   t("hud.learned", { n: 3 })   // {n} placeholder interpolation
 *
 * Adding strings: put them in ./locales/en/<ns>.ts and ./locales/zh/<ns>.ts.
 * Each namespace file exports a flat Record<string, string>; keys are
 * referenced as "<ns>.<key>". Register new namespace files in ./locales/en.ts
 * and ./locales/zh.ts aggregators.
 *
 * Locale resolution: localStorage("app-locale") → navigator.language → "en".
 * English is the default/base locale; zh is the alternate.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { en } from "./locales/en";
import { zh } from "./locales/zh";

export type Locale = "en" | "zh";

const DICTS: Record<Locale, Record<string, string>> = { en, zh };
const STORAGE_KEY = "app-locale";

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFunc;
}

const Ctx = createContext<I18nCtx | null>(null);

/** Cross-window locale sync: settings window emits, every window (incl. HUD) listens. */
const LOCALE_EVENT = "app-locale-changed";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    // Each Tauri window is its own webview — broadcast so HUD/lang/agent-menu
    // windows flip immediately instead of waiting for a restart.
    void emit(LOCALE_EVENT, l).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<Locale>(LOCALE_EVENT, (e) => {
      if (e.payload === "en" || e.payload === "zh") setLocaleState(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const t = useCallback<TFunc>(
    (key, vars) => {
      const hit = DICTS[locale][key] ?? DICTS.en[key] ?? key;
      return interpolate(hit, vars);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function useT(): TFunc {
  return useI18n().t;
}

/** Non-hook lookup for rare non-React call sites (uses detected locale, no reactivity). */
export function tStatic(key: string, vars?: Record<string, string | number>): string {
  const locale = detectLocale();
  const hit = DICTS[locale][key] ?? DICTS.en[key] ?? key;
  return interpolate(hit, vars);
}
