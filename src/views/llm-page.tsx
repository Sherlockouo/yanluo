import { useMemo, useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { Link } from "react-router-dom";
import { RotateCcw, Save, Sparkles } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import { useApp } from "@/app-context";
import {
  DEFAULT_LLM_REFINE_PROMPT,
  DEFAULT_LLM_TRANSLATE_PROMPT,
  LLM_PROVIDER_PRESETS,
} from "@/lib/constants";

export function LlmPage() {
  const { config, updateConfig, saveConfig, testLlm, history } = useApp();
  const [customModel, setCustomModel] = useState(false);

  const preset = useMemo(
    () =>
      LLM_PROVIDER_PRESETS.find((p) => p.id === config.llm_provider) ??
      LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1],
    [config.llm_provider],
  );

  const modelInList = preset.models.includes(config.llm_model);
  const showCustomField = customModel || !modelInList || preset.models.length === 0;

  const refinedEntries = useMemo(
    () =>
      history
        .filter(
          (e) =>
            e.refined &&
            (e.source ?? "fn") !== "translate" &&
            hasRefineDiff(e.raw_text, e.text),
        )
        .slice(0, 40),
    [history],
  );

  const refineValue = config.llm_refine_prompt || DEFAULT_LLM_REFINE_PROMPT;
  const translateValue =
    config.llm_translate_prompt || DEFAULT_LLM_TRANSLATE_PROMPT;

  return (
    <PageShell className="max-w-5xl">
      <PageHeader title="LLM" />

      <p className="text-[13px] text-muted">
        Provider / Base URL / API Key 在{" "}
        <Link to="/settings?tab=llm" className="text-accent hover:underline">
          设置 → LLM
        </Link>
        。
      </p>

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
                </div>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>

          {preset.models.length > 0 ? (
            <Select
              className="w-full flex"
              selectedKey={
                showCustomField && !modelInList ? "__custom__" : config.llm_model
              }
              onSelectionChange={(key) => {
                if (key == null) return;
                const id = String(key);
                if (id === "__custom__") {
                  setCustomModel(true);
                  return;
                }
                setCustomModel(false);
                updateConfig("llm_model", id);
              }}
            >
              <Label>Model（{preset.label}）</Label>
              <Select.Trigger className="flex items-center justify-between p-4">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="gap-2 p-2">
                  {preset.models.map((m) => (
                    <ListBox.Item key={m} id={m} textValue={m}>
                      {m}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                  <ListBox.Item id="__custom__" textValue="自定义">
                    自定义…
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          ) : null}

          {showCustomField ? (
            <TextField
              fullWidth
              variant="secondary"
              value={config.llm_model}
              onChange={(value) => updateConfig("llm_model", value)}
            >
              <Label>自定义 Model</Label>
              <Input placeholder="gpt-4o-mini" />
            </TextField>
          ) : null}

          <TextField
            fullWidth
            variant="secondary"
            value={refineValue}
            onChange={(value) => updateConfig("llm_refine_prompt", value)}
          >
            <Label>纠错 Prompt</Label>
            <TextArea rows={8} className="min-h-[10rem] font-mono text-[12px]" />
          </TextField>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => updateConfig("llm_refine_prompt", "")}
          >
            <RotateCcw size={14} />
            恢复默认纠错 Prompt
          </Button>

          <TextField
            fullWidth
            variant="secondary"
            value={translateValue}
            onChange={(value) => updateConfig("llm_translate_prompt", value)}
          >
            <Label>翻译 Prompt（{"{target}"} 占位）</Label>
            <TextArea rows={10} className="min-h-[12rem] font-mono text-[12px]" />
          </TextField>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => updateConfig("llm_translate_prompt", "")}
          >
            <RotateCcw size={14} />
            恢复默认翻译 Prompt
          </Button>

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

        <SectionCard title="纠错记录">
          {refinedEntries.length === 0 ? (
            <EmptyState
              title="还没有纠错记录"
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
                      {(entry.source ?? "fn") === "transcribe" ? "转写" : "Fn"}
                    </span>
                    <Sparkles
                      size={10}
                      className="text-success"
                      aria-label="refined"
                    />
                  </div>
                  <RefineDiff
                    before={entry.raw_text}
                    after={entry.text}
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
