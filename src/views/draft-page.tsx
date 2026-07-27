import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageShell } from "@/components/shared/page-shell";
import { AsrPage } from "@/views/asr-page";
import { TranscribePage } from "@/views/transcribe-page";
import { HistoryPage } from "@/views/history-page";
import { TranslatePage } from "@/views/translate-page";
import { asrLanguageOptions, providerLabel } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { useApp } from "@/app-context";
import { useTabScroll } from "@/hooks/use-tab-scroll";
import {
  isDraftMode,
  patchDraftUi,
  readDraftUi,
  type DraftMode,
} from "@/lib/ui-session";

const MODES: DraftMode[] = ["file", "live", "translate", "history"];

function resolveInitialMode(param: string | null): {
  mode: DraftMode;
  fromStorage: boolean;
} {
  if (isDraftMode(param)) return { mode: param, fromStorage: false };
  const stored = readDraftUi();
  if (stored && isDraftMode(stored.mode)) {
    return { mode: stored.mode, fromStorage: true };
  }
  return { mode: "file", fromStorage: false };
}

/**
 * 出稿 — file/URL transcript · live draft · translate · history as
 * mutual-exclusive internal modes.
 *
 * Perf: panels are KEEP-ALIVE. A mode mounts on first visit and then stays
 * mounted (visibility-toggled via `hidden`) so re-selecting a tab is instant
 * and each panel keeps its own state/scroll/history — no remount, no re-run of
 * its IPC/listeners, no layout-animated indicator to measure. That removes the
 * click hitch and the "history resets on tab switch" bug.
 *
 * Session: bare `/draft` restores last mode + per-mode `.app-content` scroll;
 * URL `?mode=` wins and writes back to sessionStorage.
 */
export function DraftPage() {
  const t = useT();
  const { config, modelLoaded } = useApp();
  const languageLabel =
    asrLanguageOptions(config.extra_languages).find(
      ([id]) => id === config.language,
    )?.[1] ?? t("draft.langAuto");
  const [searchParams, setSearchParams] = useSearchParams();
  const seeded = useRef(resolveInitialMode(searchParams.get("mode")));
  const [mode, setMode] = useState<DraftMode>(seeded.current.mode);
  const [visited, setVisited] = useState<Set<DraftMode>>(
    () => new Set([seeded.current.mode]),
  );
  // Modes that have finished (or skipped) the one-shot panel enter — avoids
  // re-playing dpanel-in when keep-alive panels toggle hidden → visible.
  const [enteredModes, setEnteredModes] = useState<Set<DraftMode>>(
    () => new Set([seeded.current.mode]),
  );
  // Masthead top-right slot. Each mode's active panel portals its contextual
  // action here (keeps the panel's own state fresh — no node-in-effect churn).
  const [actionEl, setActionEl] = useState<HTMLDivElement | null>(null);
  // Set when selectMode initiates the URL change — the searchParams effect
  // must ignore that navigation, otherwise it reads the STALE param in the
  // render between setMode and the router commit and reverts the click
  // (first click on 文件 deleted `mode`, next=null never corrected it back).
  const urlFromClick = useRef(false);
  const urlHydrated = useRef(false);
  const scroll = useTabScroll(readDraftUi()?.scroll ?? {});
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const applyMode = (from: DraftMode, to: DraftMode) => {
    if (from === to) return;
    const y = scroll.save(from);
    patchDraftUi({ mode: to, scrollPatch: { [from]: y } });
    setMode(to);
    startTransition(() => {
      setVisited((v) => (v.has(to) ? v : new Set(v).add(to)));
    });
    requestAnimationFrame(() => scroll.restore(to));
  };

  // Bare `/draft` (no mode param): push stored mode into the URL once.
  useEffect(() => {
    if (!seeded.current.fromStorage) return;
    const m = seeded.current.mode;
    if (m === "file") return; // file = no mode param by convention
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("mode", m);
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Enter page: restore this mode's scroll (after paint).
  useLayoutEffect(() => {
    scroll.restore(mode);
    patchDraftUi({ mode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (enteredModes.has(mode)) return;
    const t = window.setTimeout(() => {
      setEnteredModes((prev) => {
        if (prev.has(mode)) return prev;
        return new Set(prev).add(mode);
      });
    }, 160);
    return () => window.clearTimeout(t);
  }, [mode, enteredModes]);

  // Leave page: persist current mode scroll.
  useEffect(() => {
    return () => {
      const y = scroll.save(modeRef.current);
      patchDraftUi({
        mode: modeRef.current,
        scrollPatch: { [modeRef.current]: y },
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (urlFromClick.current) {
      urlFromClick.current = false;
      return;
    }
    const next = searchParams.get("mode");
    // First commit after storage seed: URL still bare — don't treat as 「文件」.
    if (!urlHydrated.current) {
      urlHydrated.current = true;
      if (next == null && seeded.current.fromStorage) return;
    }
    if (next == null) {
      if (modeRef.current !== "file") applyMode(modeRef.current, "file");
      return;
    }
    if (isDraftMode(next) && next !== modeRef.current) {
      applyMode(modeRef.current, next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const selectMode = (id: DraftMode) => {
    if (id === mode) return;
    applyMode(mode, id);
    urlFromClick.current = true;
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (id === "file") p.delete("mode");
        else p.set("mode", id);
        return p;
      },
      { replace: true },
    );
  };

  return (
    <PageShell className="max-w-[880px]">
      <div className="dmast">
        <div className="dmast-top">
          <span className="dmast-kicker">
            {providerLabel(config.asr_provider)} ·{" "}
            {modelLoaded ? t("draft.ready") : t("draft.notReady")}
          </span>
          <div className="dmast-action" ref={setActionEl} />
        </div>
        <div className="dmast-row">
          <h1 className="dmast-title">{t("draft.title")}</h1>
          <nav className="dmodes" role="tablist" aria-label={t("draft.modesAria")}>
            {MODES.map((id) => {
              const active = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={cn("dmode", active && "is-active")}
                  onClick={() => selectMode(id)}
                >
                  {t(`draft.mode.${id}`)}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="dmast-sub" data-tour="draft-hotkeys">
          <span>
            <b>{config.hotkey_transcribe.label}</b> {t("draft.hotkeyDraft")}
          </span>
          <span className="dot" />
          <span>
            <b>{config.hotkey_translate.label}</b> {t("draft.hotkeyTranslate")}
          </span>
          <span className="dot" />
          <span>{languageLabel}</span>
        </div>
      </div>

      {MODES.map((id) =>
        visited.has(id) ? (
          <div
            key={id}
            className={cn(
              mode === id ? "dpanel contents" : "hidden",
              mode === id &&
                !enteredModes.has(id) &&
                "is-enter",
            )}
            aria-hidden={mode !== id}
          >
            {id === "file" ? (
              <TranscribePage
                embedded
                active={mode === "file"}
                actionSlot={actionEl}
              />
            ) : null}
            {id === "live" ? (
              <AsrPage embedded active={mode === "live"} actionSlot={actionEl} />
            ) : null}
            {id === "translate" ? (
              <TranslatePage
                embedded
                active={mode === "translate"}
                actionSlot={actionEl}
              />
            ) : null}
            {id === "history" ? (
              <HistoryPage
                embedded
                active={mode === "history"}
                actionSlot={actionEl}
              />
            ) : null}
          </div>
        ) : null,
      )}
    </PageShell>
  );
}
