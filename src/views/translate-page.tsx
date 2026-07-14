import { useMemo, useState } from "react";
import {
  Button,
  Kbd,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { Languages, RotateCcw, Save } from "lucide-react";
import { Link } from "react-router-dom";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { SemanticPair } from "@/components/ui/refine-diff";
import {
  DEFAULT_LLM_TRANSLATE_PROMPT,
  TRANSLATE_LANGUAGES,
  translateTargetLabel,
} from "@/lib/constants";
import { useApp } from "@/app-context";

export function TranslatePage() {
  const { config, updateConfig, saveConfig, history } = useApp();
  const [configOpen, setConfigOpen] = useState(false);
  const translateValue =
    config.llm_translate_prompt || DEFAULT_LLM_TRANSLATE_PROMPT;

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
    <PageShell className="max-w-2xl">
      <PageHeader
        title="翻译"
        status={
          <>
            <Kbd>{config.hotkey_translate.label}</Kbd>
            {" · "}
            <span className="text-foreground">{targetLabel}</span>
            {" · "}
            {llmReady ? (
              <span>{config.llm_model}</span>
            ) : (
              <Link
                to="/settings?tab=llm"
                className="text-accent hover:underline"
              >
                配置 LLM
              </Link>
            )}
          </>
        }
        action={
          <Button
            size="sm"
            variant={configOpen ? "primary" : "secondary"}
            onPress={() => setConfigOpen((v) => !v)}
          >
            配置
          </Button>
        }
      />

      <SoftCollapse open={configOpen}>
        <div className="mb-1 flex flex-col gap-5 rounded-2xl border border-border bg-surface p-4">
          <Select
            selectedKey={config.translate_target_language}
            onSelectionChange={(key) => {
              if (key == null) return;
              updateConfig("translate_target_language", String(key));
              void saveConfig(
                { ...config, translate_target_language: String(key) },
                { silent: true },
              );
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
                  <ListBox.Item
                    key={value}
                    id={value}
                    textValue={`${label} ${value}`}
                  >
                    <span>{label}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <TextField
            fullWidth
            variant="secondary"
            value={translateValue}
            onChange={(value) => updateConfig("llm_translate_prompt", value)}
          >
            <Label>翻译 Prompt</Label>
            <TextArea
              rows={8}
              className="min-h-[10rem] font-mono type-meta !text-[12px]"
              placeholder={"{target} → 目标语言名"}
            />
          </TextField>

          <div className="form-actions">
            <div className="form-actions-secondary">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => updateConfig("llm_translate_prompt", "")}
              >
                <RotateCcw size={14} />
                恢复默认
              </Button>
            </div>
            <Button
              className="form-actions-primary btn-press"
              fullWidth
              variant="primary"
              onPress={() => void saveConfig()}
            >
              <Save size={14} />
              保存
            </Button>
          </div>
        </div>
      </SoftCollapse>

      {entries.length === 0 ? (
        <EmptyState
          title="还没有翻译"
          description={`${config.hotkey_translate.label} 开始`}
          icon={<Languages size={18} />}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((entry, i) => (
            <Reveal key={entry.id} index={i}>
              <article className="rounded-2xl border border-border bg-surface px-4 py-3.5">
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 type-meta">
                  <span>
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                  <span>{entry.duration_seconds.toFixed(1)}s</span>
                  <span>
                    {translateTargetLabel(entry.translate_target_language) ||
                      targetLabel}
                  </span>
                </div>
                <SemanticPair
                  before={entry.raw_text || "（空）"}
                  after={entry.text || "（空）"}
                />
              </article>
            </Reveal>
          ))}
        </div>
      )}
    </PageShell>
  );
}
