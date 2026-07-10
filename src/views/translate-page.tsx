import { useMemo } from "react";
import {
  Description,
  Label,
  ListBox,
  Select,
} from "@heroui/react";
import { Languages, Sparkles } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { RefineFromTo } from "@/components/ui/refine-diff";
import { TRANSLATE_LANGUAGES, translateTargetLabel } from "@/lib/constants";
import { useApp } from "@/app-context";

export function TranslatePage() {
  const { config, updateConfig, saveConfig, history } = useApp();

  const entries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "") === "translate")
        .slice(0, 40),
    [history],
  );

  const targetLabel =
    TRANSLATE_LANGUAGES.find(([v]) => v === config.translate_target_language)?.[1] ??
    config.translate_target_language;

  const llmReady = Boolean(
    config.llm_api_base_url?.trim() && config.llm_model?.trim(),
  );

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        title="翻译"
        subtitle={`${config.hotkey_translate.label} · 只显示译文 · 稳定前缀流式译`}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <SectionCard className="flex h-fit flex-col gap-5">
          <div>
            <p className="text-sm font-semibold text-foreground">目标语言</p>
            <p className="mt-1 text-[13px] text-muted">
              识别稳定后异步翻译；松键补译尾巴后粘贴。
            </p>
          </div>

          <Select
            selectedKey={config.translate_target_language}
            onSelectionChange={(key) => {
              if (key == null) return;
              const next = {
                ...config,
                translate_target_language: String(key),
              };
              updateConfig("translate_target_language", String(key));
              void saveConfig(next, { silent: true });
            }}
          >
            <Label>翻译到</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {TRANSLATE_LANGUAGES.map(([value, label]) => (
                  <ListBox.Item key={value} id={value} textValue={label} onClick={() => {
                    updateConfig("translate_target_language", value);
                  }}>
                    {label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <div className="rounded-2xl border border-border bg-surface-secondary/40 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
            <p>
              热键 <span className="text-foreground">{config.hotkey_translate.label}</span>
            </p>
            <p className="mt-1">
              LLM：{llmReady ? (
                <span className="text-success">
                  {config.llm_model} @ {config.llm_api_base_url}
                </span>
              ) : (
                <span className="text-danger">请先在 LLM 页配置 Base URL 与 Model</span>
              )}
            </p>
            <Description className="mt-2">
              HUD 不显示原文，只显示译文。流式译需 Qwen；Apple / ElevenLabs 为松键后整段译。
            </Description>
          </div>
        </SectionCard>

        <SectionCard
          title="翻译记录"
          description={
            entries.length
              ? `目标 ${targetLabel} · 上为原文，下为译文`
              : "⇧+Fn 录音翻译后会出现在这里。"
          }
        >
          {entries.length === 0 ? (
            <EmptyState
              title="还没有翻译记录"
              description="按住翻译热键说话，松键后粘贴译文。"
              icon={<Languages size={18} />}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-2xl border border-border bg-surface-secondary/30 px-3.5 py-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span>{new Date(entry.created_at).toLocaleString()}</span>
                    <span>{entry.duration_seconds.toFixed(1)}s</span>
                    <span className="inline-flex items-center gap-1 text-accent">
                      <Sparkles size={10} aria-hidden />
                      译为{" "}
                      {translateTargetLabel(entry.translate_target_language) ||
                        targetLabel}
                    </span>
                  </div>
                  <RefineFromTo
                    before={entry.raw_text || "（空）"}
                    after={entry.text || "（空）"}
                    beforeLabel="原"
                    afterLabel="译"
                  />
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
