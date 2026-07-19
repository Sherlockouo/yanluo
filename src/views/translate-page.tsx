import { useMemo } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Kbd, ListBox, Select } from "@heroui/react";
import { ChevronDown, Languages } from "lucide-react";
import { PageHeader, PageShell, Reveal } from "@/components/shared/page-shell";
import { SemanticPair } from "@/components/ui/refine-diff";
import { LlmProviderSelect } from "@/components/ui/llm-provider-select";
import { translateLanguageOptions, translateTargetLabel } from "@/lib/constants";
import { useApp } from "@/app-context";

/** 翻译 Prompt 编辑已收敛到 设置 → 润色 → 配置。 */
const PROMPT_SETTINGS_URL = "/settings?tab=polish&sub=config";

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

  const entries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "") === "translate")
        .slice(0, 40),
    [history],
  );

  const langOptions = translateLanguageOptions(config.extra_languages);
  const targetLabel = translateTargetLabel(
    config.translate_target_language,
    config.extra_languages,
  );

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
      <Select.Trigger className="qsel-quiet">
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
          {langOptions.map(([value, label]) => (
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
      <LlmProviderSelect triggerCls="qsel-quiet" />
    </div>
  );
  const headerAction = (
    <Link to={PROMPT_SETTINGS_URL} className="dlink muted">
      配置 ▾
    </Link>
  );

  const content = (
    <>
      {embedded && actionSlot
        ? createPortal(
            // Keep the slot content MOUNTED across tab switches (visibility
            // toggle only) — unmount/remount replayed LlmProviderSelect's
            // mount motion inside the masthead → the 切换闪烁 bug.
            <span
              className="dmast-actgrp"
              style={active ? undefined : { display: "none" }}
            >
              {targetSelect}
              <LlmProviderSelect triggerCls="qsel-quiet" />
              <Link to={PROMPT_SETTINGS_URL} className="dlink muted">
                配置 ▾
              </Link>
            </span>,
            actionSlot,
          )
        : null}
      {embedded ? null : (
        <PageHeader title="翻译" status={header} action={headerAction} />
      )}

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
          {entries.map((entry, i) => {
            const row = (
              <article className="rec">
                <div className="rec-l">
                  <span>{new Date(entry.created_at).toLocaleString()}</span>
                  <span>{entry.duration_seconds.toFixed(1)}s</span>
                  <span className="tag">
                    {translateTargetLabel(
                      entry.translate_target_language,
                      config.extra_languages,
                    ) ||
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
            );
            // Reveal (framer, willChange) only for the first screenful —
            // beyond that a plain div keeps long lists cheap.
            return i < 8 ? (
              <Reveal key={entry.id} index={i}>
                {row}
              </Reveal>
            ) : (
              <div key={entry.id}>{row}</div>
            );
          })}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
