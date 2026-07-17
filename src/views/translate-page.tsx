import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Kbd,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { ChevronDown, Languages, RotateCcw, Save } from "lucide-react";
import {
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { SemanticPair } from "@/components/ui/refine-diff";
import { LlmProviderSelect } from "@/components/ui/llm-provider-select";
import {
  DEFAULT_LLM_TRANSLATE_PROMPT,
  TRANSLATE_LANGUAGES,
  translateTargetLabel,
} from "@/lib/constants";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";

/** Translate mode panel — ⇧Fn results. Used standalone or embedded in 出稿. */
export function TranslatePage({
  embedded = false,
  active = true,
  actionSlot,
}: {
  embedded?: boolean;
  active?: boolean;
  actionSlot?: HTMLElement | null;
} = {}) {
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

  const setTargetLanguage = (code: string) => {
    updateConfig("translate_target_language", code);
    void saveConfig(
      { ...config, translate_target_language: code },
      { silent: true },
    );
  };

  const targetSelect = (
    <Select
      className="inline-flex w-auto"
      aria-label="翻译到"
      selectedKey={config.translate_target_language}
      onSelectionChange={(key) => {
        if (key == null) return;
        setTargetLanguage(String(key));
      }}
    >
      <Select.Trigger
        className={cn(
          "h-7 gap-1 rounded-lg border border-border/80 bg-surface px-2.5",
          "shadow-[0_1px_0_color-mix(in_oklab,var(--foreground)_4%,transparent)_inset]",
          "text-[12px] font-medium text-foreground items-center",
          "transition-[border-color,background-color] duration-150",
          "hover:border-foreground/20 hover:bg-surface-secondary/60",
        )}
      >
        <Select.Value>
          {() => (
            <span className="inline-flex items-center gap-1.5">
              <span>{targetLabel}</span>
            </span>
          )}
        </Select.Value>
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </Select.Trigger>
      <Select.Popover className="min-w-[10rem]">
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
  );

  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <Kbd>{config.hotkey_translate.label}</Kbd>
      <span className="text-muted/40">·</span>
      {targetSelect}
      <span className="text-muted/40">·</span>
      <LlmProviderSelect />
    </div>
  );
  const headerAction = (
    <Button
      size="sm"
      variant={configOpen ? "primary" : "secondary"}
      onPress={() => setConfigOpen((v) => !v)}
    >
      配置
    </Button>
  );

  const content = (
    <>
      {embedded && active && actionSlot
        ? createPortal(
            <>
              {targetSelect}
              <LlmProviderSelect />
              <button
                type="button"
                className="dlink muted"
                onClick={() => setConfigOpen((v) => !v)}
              >
                配置{configOpen ? " ▴" : " ▾"}
              </button>
            </>,
            actionSlot,
          )
        : null}
      {embedded ? null : (
        <PageHeader title="翻译" status={header} action={headerAction} />
      )}

      <SoftCollapse open={configOpen}>
        <div className="surface-card mb-1 flex flex-col gap-5 p-4">
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
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-ic">
            <Languages size={22} aria-hidden />
          </span>
          <span className="dropzone-t">还没有翻译</span>
          <span className="dropzone-fmt">{config.hotkey_translate.label} 开始</span>
        </div>
      ) : (
        <div className="recs">
          {entries.map((entry, i) => (
            <Reveal key={entry.id} index={i}>
              <article className="rec">
                <div className="rec-l">
                  <span>{new Date(entry.created_at).toLocaleString()}</span>
                  <span>{entry.duration_seconds.toFixed(1)}s</span>
                  <span className="tag">
                    {translateTargetLabel(entry.translate_target_language) ||
                      targetLabel}
                  </span>
                </div>
                <div className="rec-pair">
                  <SemanticPair
                    before={entry.raw_text || "（空）"}
                    after={entry.text || "（空）"}
                  />
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
