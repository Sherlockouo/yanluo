import { Kbd } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { AudioLines, Brain, BookOpen, Wand2 } from "lucide-react";
import { providerLabel, stateLabel } from "@/lib/constants";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

const LINKS = [
  { to: "/transcribe", icon: AudioLines, title: "转写", hint: "上传与回放" },
  { to: "/asr", icon: Brain, title: "ASR", hint: "引擎与语言" },
  { to: "/vocabulary", icon: BookOpen, title: "词库", hint: "术语替换" },
  { to: "/llm", icon: Wand2, title: "LLM", hint: "保守纠错" },
] as const;

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
      <PageHeader title="ASR Workshop" subtitle="点按 Fn 开始，再点结束并粘贴。" />

      <SectionCard className="max-w-xl">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          <span className="inline-flex items-center gap-2 text-foreground">
            <Kbd>Fn</Kbd>
            开关
          </span>
          <span className="inline-flex items-center gap-2">
            <Kbd>Esc</Kbd>
            取消
          </span>
          <span className="text-border">·</span>
          <span>{statusBits.join(" · ")}</span>
        </div>
      </SectionCard>

      <div className="grid max-w-xl gap-2.5 sm:grid-cols-2">
        {LINKS.map(({ to, icon: Icon, title, hint }) => (
          <NavLink
            key={to}
            to={to}
            className="group rounded-2xl border border-border bg-surface px-4 py-4 transition duration-200 hover:border-accent/25 hover:bg-surface-secondary/40"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-default text-foreground transition group-hover:bg-accent/10 group-hover:text-accent">
                <Icon size={16} />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {title}
                </div>
                <div className="text-[12px] text-muted">{hint}</div>
              </div>
            </div>
          </NavLink>
        ))}
      </div>
    </PageShell>
  );
}
