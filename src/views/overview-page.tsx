import { Chip, Kbd } from "@heroui/react";
import { Activity, BookOpen, Brain, Wand2 } from "lucide-react";
import { providerLabel, stateLabel } from "@/lib/constants";
import {
  PageHeader,
  PageShell,
  SectionCard,
  StatTile,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function OverviewPage() {
  const { config, history, state } = useApp();
  const recording = state === "recording";
  const processing = state === "processing" || state === "refining";

  return (
    <PageShell>
      <PageHeader
        title="控制面板"
        subtitle="这里只负责配置与状态。识别界面在独立悬浮窗中显示，按住 Fn 即可开始。"
      />

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.4fr)_320px]">
        <SectionCard className="relative overflow-hidden">
          <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-white/5 blur-3xl" />
          <div className="relative flex flex-wrap gap-2">
            <Chip size="sm" variant="soft">
              <Chip.Label>双窗口架构</Chip.Label>
            </Chip>
            <Chip size="sm" variant="soft" color="accent">
              <Chip.Label>
                {providerLabel(config.asr_provider)} · {config.language}
              </Chip.Label>
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={config.llm_enabled ? "success" : "default"}
            >
              <Chip.Label>
                {config.llm_enabled ? "LLM 已启用" : "LLM 已关闭"}
              </Chip.Label>
            </Chip>
          </div>

          <h2 className="relative mt-6 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-5xl">
            按住 <span className="text-foreground">Fn</span>，
            <br />
            悬浮窗识别。
          </h2>
          <p className="relative mt-4 max-w-xl text-sm leading-relaxed text-muted">
            控制面板保持打开用于改设置。真正的波形、实时转写与状态反馈，都在屏幕底部的独立透明悬浮窗里完成。
          </p>
          <div className="relative mt-6 flex items-center gap-2 text-sm text-muted">
            <span>快捷键</span>
            <Kbd>Fn</Kbd>
            <span>按住说话 · 松开结束</span>
          </div>
        </SectionCard>

        <SectionCard
          title="识别窗口"
          description="独立 always-on-top 悬浮窗，不嵌入本面板。"
        >
          <div className="mb-4 flex items-center gap-3">
            <span
              className={`status-dot ${recording ? "status-dot-live" : processing ? "status-dot-busy" : ""}`}
            />
            <span className="text-lg font-semibold text-foreground">
              {stateLabel(state)}
            </span>
          </div>
          <ul className="flex flex-col gap-2 text-sm leading-relaxed text-muted">
            <li>· 录音时自动显示在屏幕底部</li>
            <li>· 展示实时波形与转写尾部</li>
            <li>· 结束后自动隐藏并注入文本</li>
          </ul>
        </SectionCard>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={<Brain size={17} />}
          label="ASR"
          value={providerLabel(config.asr_provider)}
          hint={config.language}
        />
        <StatTile
          icon={<Wand2 size={17} />}
          label="LLM"
          value={config.llm_enabled ? "Enabled" : "Disabled"}
          hint={config.llm_model}
        />
        <StatTile
          icon={<BookOpen size={17} />}
          label="词库"
          value={`${config.vocabulary.length}`}
          hint="terms"
        />
        <StatTile
          icon={<Activity size={17} />}
          label="历史"
          value={`${history.length}`}
          hint="records"
        />
      </section>
    </PageShell>
  );
}
