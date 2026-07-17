import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageShell } from "@/components/shared/page-shell";
import { AsrPage } from "@/views/asr-page";
import { TranscribePage } from "@/views/transcribe-page";
import { HistoryPage } from "@/views/history-page";
import { TranslatePage } from "@/views/translate-page";
import { providerLabel } from "@/lib/constants";
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

  useEffect(() => {
    const next = searchParams.get("mode") as DraftMode | null;
    if (next && MODES.some((m) => m.id === next) && next !== mode) {
      setMode(next);
    }
  }, [searchParams, mode]);

  useEffect(() => {
    setVisited((v) => (v.has(mode) ? v : new Set(v).add(mode)));
  }, [mode]);

  const selectMode = (id: DraftMode) => {
    if (id === mode) return; // no-op click must not churn URL / re-render
    setMode(id);
    if (id === "file") setSearchParams({}, { replace: true });
    else setSearchParams({ mode: id }, { replace: true });
  };

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
      </div>

      {MODES.map((item) =>
        visited.has(item.id) ? (
          <div
            key={item.id}
            className={mode === item.id ? "contents" : "hidden"}
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
