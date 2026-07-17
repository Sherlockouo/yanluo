import { startTransition, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageShell } from "@/components/shared/page-shell";
import { AsrPage } from "@/views/asr-page";
import { TranscribePage } from "@/views/transcribe-page";
import { HistoryPage } from "@/views/history-page";
import { TranslatePage } from "@/views/translate-page";
import { providerLabel, LANGUAGES } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
type DraftMode = "file" | "live" | "translate" | "history";

const MODES: { id: DraftMode; label: string }[] = [
  { id: "file", label: "文件" },
  { id: "live", label: "实时" },
  { id: "translate", label: "翻译" },
  { id: "history", label: "历史" },
];

/**
 * 出稿 — file/URL transcript · live draft · translate · history as
 * mutual-exclusive internal modes.
 *
 * Perf: panels are KEEP-ALIVE. A mode mounts on first visit and then stays
 * mounted (visibility-toggled via `hidden`) so re-selecting a tab is instant
 * and each panel keeps its own state/scroll/history — no remount, no re-run of
 * its IPC/listeners, no layout-animated indicator to measure. That removes the
 * click hitch and the "history resets on tab switch" bug.
 */
export function DraftPage() {
  const { config, modelLoaded } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = (searchParams.get("mode") as DraftMode | null) ?? "file";
  const [mode, setMode] = useState<DraftMode>(
    MODES.some((m) => m.id === initial) ? initial : "file",
  );
  const [visited, setVisited] = useState<Set<DraftMode>>(() => new Set([mode]));
  // Masthead top-right slot. Each mode's active panel portals its contextual
  // action here (keeps the panel's own state fresh — no node-in-effect churn).
  const [actionEl, setActionEl] = useState<HTMLDivElement | null>(null);
  // Set when selectMode initiates the URL change — the searchParams effect
  // must ignore that navigation, otherwise it reads the STALE param in the
  // render between setMode and the router commit and reverts the click
  // (first click on 文件 deleted `mode`, next=null never corrected it back).
  const urlFromClick = useRef(false);

  useEffect(() => {
    if (urlFromClick.current) {
      urlFromClick.current = false;
      return;
    }
    const next = searchParams.get("mode") as DraftMode | null;
    if (next && MODES.some((m) => m.id === next) && next !== mode) {
      setMode(next);
      // URL-driven switch (deep link) — not the click path, but keep the
      // mount off the urgent render anyway.
      startTransition(() => {
        setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
      });
    }
  }, [searchParams, mode]);

  const selectMode = (id: DraftMode) => {
    if (id === mode) return; // no-op click must not churn URL / re-render
    setMode(id); // urgent — tab underline paints first
    // Panel mount is heavy (first visit): transition so it never blocks the
    // click task. Mounting in an effect would flush synchronously for
    // discrete clicks and stall the underline paint.
    startTransition(() => {
      setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    });
    // Preserve sibling params (view/id used by keep-alive TranscribePage) —
    // wiping them re-derives + re-renders the hidden panel on every switch.
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

  const languageLabel =
    config.language === "auto"
      ? "自动检测语言"
      : (LANGUAGES.find(([v]) => v === config.language)?.[1] ??
        config.language);

  return (
    <PageShell className="max-w-3xl">
      <div className="dmast">
        <div className="dmast-top">
          <span className="dmast-kicker">
            {providerLabel(config.asr_provider)} ·{" "}
            {modelLoaded ? "已就绪" : "未就绪"}
          </span>
          <div className="dmast-action" ref={setActionEl} />
        </div>
        <div className="dmast-row">
          <h1 className="dmast-title">出稿</h1>
          <nav className="dmodes" role="tablist" aria-label="出稿模式">
            {MODES.map((item) => {
              const active = mode === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={cn("dmode", active && "is-active")}
                  onClick={() => selectMode(item.id)}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="dmast-sub">
          <span>
            <b>{config.hotkey_transcribe.label}</b> 出稿
          </span>
          <span className="dot" />
          <span>
            <b>{config.hotkey_translate.label}</b> 翻译
          </span>
          <span className="dot" />
          <span>{languageLabel}</span>
        </div>
      </div>

      {MODES.map((item) =>
        visited.has(item.id) ? (
          <div
            key={item.id}
            className={mode === item.id ? "dpanel contents" : "hidden"}
            aria-hidden={mode !== item.id}
          >
            {item.id === "file" ? (
              <TranscribePage
                embedded
                active={mode === "file"}
                actionSlot={actionEl}
              />
            ) : null}
            {item.id === "live" ? (
              <AsrPage embedded active={mode === "live"} actionSlot={actionEl} />
            ) : null}
            {item.id === "translate" ? (
              <TranslatePage
                embedded
                active={mode === "translate"}
                actionSlot={actionEl}
              />
            ) : null}
            {item.id === "history" ? (
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
