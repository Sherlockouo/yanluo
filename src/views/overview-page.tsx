import { Kbd } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { AudioLines, Brain, BookOpen, Languages, Wand2 } from "lucide-react";
import { hotkeySegments, providerLabel, stateLabel } from "@/lib/constants";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

const LINKS = [
  { to: "/transcribe", icon: AudioLines, title: "转写" },
  { to: "/translate", icon: Languages, title: "翻译" },
  { to: "/asr", icon: Brain, title: "ASR" },
  { to: "/vocabulary", icon: BookOpen, title: "词库" },
  { to: "/llm", icon: Wand2, title: "LLM" },
] as const;

function HotkeyKbd({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {hotkeySegments(label).map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-border">+</span> : null}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function OverviewPage() {
  const { config, state, modelLoaded } = useApp();

  const statusBits = [
    providerLabel(config.asr_provider),
    config.asr_provider === "qwen"
      ? modelLoaded
        ? "已加载"
        : "未加载"
      : null,
    stateLabel(state),
    config.language === "auto" ? "自动检测" : config.language,
  ].filter(Boolean);

  return (
    <PageShell>
      <PageHeader title="ASR Workshop" />

      <SectionCard className="max-w-xl">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          <span className="inline-flex items-center gap-2 text-foreground">
            <HotkeyKbd label={config.hotkey_transcribe.label} />
            转录
          </span>
          <span className="inline-flex items-center gap-2 text-foreground">
            <HotkeyKbd label={config.hotkey_translate.label} />
            翻译
          </span>
          <span className="inline-flex items-center gap-2">
            <HotkeyKbd label={config.hotkey_cancel.label} />
            取消
          </span>
          <span className="text-border">·</span>
          <span>{statusBits.join(" · ")}</span>
        </div>
      </SectionCard>

      <div className="grid max-w-xl gap-2.5 sm:grid-cols-2">
        {LINKS.map(({ to, icon: Icon, title }) => (
          <NavLink
            key={to}
            to={to}
            className="group rounded-2xl border border-border bg-surface px-4 py-4 transition duration-200 hover:border-accent/25 hover:bg-surface-secondary/40"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-default text-foreground transition group-hover:bg-accent/10 group-hover:text-accent">
                <Icon size={16} />
              </div>
              <div className="text-sm font-semibold text-foreground">
                {title}
              </div>
            </div>
          </NavLink>
        ))}
      </div>
    </PageShell>
  );
}
