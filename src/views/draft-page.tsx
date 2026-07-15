import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@heroui/react";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ModeSwitch,
  PageHeader,
  PageShell,
} from "@/components/shared/page-shell";
import { AsrPage } from "@/views/asr-page";
import { TranscribePage } from "@/views/transcribe-page";
import { HistoryPage } from "@/views/history-page";
import { TranslatePage } from "@/views/translate-page";
import { navIndicatorTransition } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";

type DraftMode = "file" | "live" | "translate" | "history";

const MODES: { id: DraftMode; label: string }[] = [
  { id: "file", label: "文件/链接" },
  { id: "live", label: "实时" },
  { id: "translate", label: "翻译" },
  { id: "history", label: "历史" },
];

/**
 * 出稿 — live draft + file/URL transcript + translate + history as
 * mutual-exclusive internal modes (Jobs: one primary job per screen,
 * config/mode switch lives in header secondary, not a feature grid).
 */
export function DraftPage() {
  const { config } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = (searchParams.get("mode") as DraftMode | null) ?? "file";
  const [mode, setMode] = useState<DraftMode>(
    MODES.some((m) => m.id === initial) ? initial : "file",
  );
  const reduce = useReducedMotion();

  useEffect(() => {
    const next = searchParams.get("mode") as DraftMode | null;
    if (next && MODES.some((m) => m.id === next) && next !== mode) {
      setMode(next);
    }
  }, [searchParams, mode]);

  const selectMode = (id: DraftMode) => {
    setMode(id);
    if (id === "file") setSearchParams({}, { replace: true });
    else setSearchParams({ mode: id }, { replace: true });
  };

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        title="出稿"
        status={`开口出稿 · ${config.hotkey_transcribe.label} 实时 · ${config.hotkey_translate.label} 翻译`}
      />

      <LayoutGroup id="draft-mode-tabs">
        <div className="settings-tabs max-w-xl">
          {MODES.map((item) => {
            const active = mode === item.id;
            return (
              <Button
                key={item.id}
                variant="ghost"
                data-selected={active || undefined}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "settings-tab h-auto min-h-0 shadow-none data-[pressed=true]:scale-100",
                  active && "settings-tab-active",
                )}
                onPress={() => selectMode(item.id)}
              >
                {active && !reduce ? (
                  <motion.span
                    layoutId="draft-tab-active"
                    className="settings-tab-indicator"
                    transition={navIndicatorTransition}
                  />
                ) : active ? (
                  <span className="settings-tab-indicator" />
                ) : null}
                <span className="relative z-10">{item.label}</span>
              </Button>
            );
          })}
        </div>
      </LayoutGroup>

      <ModeSwitch modeKey={mode}>
        {mode === "file" ? <TranscribePage embedded /> : null}
        {mode === "live" ? <AsrPage embedded /> : null}
        {mode === "translate" ? <TranslatePage embedded /> : null}
        {mode === "history" ? <HistoryPage embedded /> : null}
      </ModeSwitch>
    </PageShell>
  );
}
