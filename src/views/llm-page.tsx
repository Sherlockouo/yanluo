import { useMemo } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  Switch,
  TextField,
} from "@heroui/react";
import { Save, Sparkles } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import {
  hasRefineDiff,
  RefineDiff,
  RefineFromTo,
} from "@/components/ui/refine-diff";
import { useApp } from "@/app-context";

export function LlmPage() {
  const { config, updateConfig, saveConfig, testLlm, history } = useApp();

  const refinedEntries = useMemo(
    () =>
      history
        .filter(
          (e) =>
            e.refined && hasRefineDiff(e.raw_text, e.text),
        )
        .slice(0, 40),
    [history],
  );

  return (
    <PageShell className="max-w-5xl">
      <PageHeader title="LLM" subtitle="保守纠错，不改写。" />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <SectionCard className="flex h-fit flex-col gap-5">
          <div className="rounded-2xl border border-border bg-surface-secondary/50 px-3 py-2">
            <Switch
              isSelected={config.llm_enabled}
              onChange={(value) => updateConfig("llm_enabled", value)}
            >
              <Switch.Content className="w-full justify-between gap-2 p-2">
                <div className="min-w-0 pr-2">
                  <div className="text-sm font-semibold text-foreground">
                    启用纠错
                  </div>
                  <Description>仅修复明显识别错误。</Description>
                </div>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          <TextField
            fullWidth
            variant="secondary"
            value={config.llm_api_base_url}
            onChange={(value) => updateConfig("llm_api_base_url", value)}
          >
            <Label>API Base URL</Label>
            <Input placeholder="https://api.openai.com/v1" />
          </TextField>

          <TextField
            fullWidth
            variant="secondary"
            type="password"
            value={config.llm_api_key}
            onChange={(value) => updateConfig("llm_api_key", value)}
          >
            <Label>API Key</Label>
            <Input placeholder="可留空（Ollama 等本地服务）" />
          </TextField>

          <TextField
            fullWidth
            variant="secondary"
            value={config.llm_model}
            onChange={(value) => updateConfig("llm_model", value)}
          >
            <Label>Model</Label>
            <Input placeholder="gpt-4o-mini" />
          </TextField>

          <div className="form-actions">
            <Button fullWidth variant="secondary" onPress={() => void testLlm()}>
              <Sparkles size={16} aria-hidden />
              测试
            </Button>
            <Button fullWidth variant="primary" onPress={() => void saveConfig()}>
              <Save size={16} aria-hidden />
              保存
            </Button>
          </div>
        </SectionCard>

        <SectionCard
          title="纠错记录"
          description={
            refinedEntries.length
              ? "红为原文，绿为纠错后。"
              : "开启纠错后，有改动的结果会出现在这里。"
          }
        >
          {refinedEntries.length === 0 ? (
            <EmptyState
              title="还没有纠错记录"
              description="Fn 录音或转写完成后，若 LLM 改动了文本，会显示在此。"
              icon={<Sparkles size={18} />}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {refinedEntries.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-2xl border border-border bg-surface-secondary/30 px-3.5 py-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span>{new Date(entry.created_at).toLocaleString()}</span>
                    <span>{entry.duration_seconds.toFixed(1)}s</span>
                    <span>
                      {(entry.source ?? "fn") === "transcribe"
                        ? "转写"
                        : (entry.source ?? "fn") === "translate"
                          ? "翻译"
                          : "Fn"}
                    </span>
                    <span className="inline-flex items-center gap-1 text-success">
                      <Sparkles size={10} aria-hidden />
                      refined
                    </span>
                  </div>
                  <RefineDiff
                    before={entry.raw_text}
                    after={entry.text}
                    compact
                  />
                  <details className="mt-2">
                    <summary className="cursor-pointer select-none text-[11px] text-muted hover:text-foreground">
                      分列对照
                    </summary>
                    <RefineFromTo
                      className="mt-2"
                      before={entry.raw_text}
                      after={entry.text}
                    />
                  </details>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
