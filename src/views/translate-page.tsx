import { useMemo } from "react";
import { Label, ListBox, Select } from "@heroui/react";
import { Languages } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { SemanticPair } from "@/components/ui/refine-diff";
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
      <PageHeader title="翻译" subtitle={config.hotkey_translate.label} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <SectionCard className="flex h-fit flex-col gap-5">
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
                  <ListBox.Item key={value} id={value} textValue={`${label} ${value}`}>
                    <span>{label}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted">{value}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <div className="rounded-2xl border border-border bg-surface-secondary/40 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
            <p>
              <span className="text-foreground">{config.hotkey_translate.label}</span>
              {" · "}
              {llmReady ? (
                <span className="text-success">
                  {config.llm_model}
                </span>
              ) : (
                <span className="text-danger">LLM 未配置</span>
              )}
            </p>
          </div>
        </SectionCard>

        <SectionCard title="翻译记录">
          {entries.length === 0 ? (
            <EmptyState
              title="还没有翻译记录"
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
                      <Languages size={10} aria-hidden />
                      {translateTargetLabel(entry.translate_target_language) ||
                        targetLabel}
                    </span>
                  </div>
                  <SemanticPair
                    before={entry.raw_text || "（空）"}
                    after={entry.text || "（空）"}
                    compact
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
