import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import {
  activateLlmProviderPatch,
  listLlmProviders,
  llmPreset,
  llmProviderLabel,
  resolveLlmCreds,
} from "@/lib/constants";
import { useApp } from "@/app-context";
import { cn } from "@/lib/cn";
import type { LlmProvider } from "@/types";

const CUSTOM = "__custom__";

const boxedTriggerCls = cn(
  "h-7 gap-1 rounded-lg border border-border/80 bg-surface px-2.5",
  "shadow-[0_1px_0_color-mix(in_oklab,var(--foreground)_4%,transparent)_inset]",
  "text-[12px] font-medium text-foreground items-center",
  "transition-[border-color,background-color] duration-150",
  "hover:border-foreground/20 hover:bg-surface-secondary/60",
);

/*
  Quiet mono variant (出稿 masthead contract): no box, no shadow — a text item
  with a ▾ chevron, muted ink → foreground on hover. Matches .dlink language.
*/
const quietTriggerCls = cn(
  "h-7 gap-1 rounded-none border-0 bg-transparent px-0 shadow-none",
  "font-mono text-[12px] font-normal text-muted items-center",
  "transition-[color,opacity] duration-150",
  "hover:bg-transparent hover:text-foreground",
  "data-[hovered=true]:bg-transparent data-[hovered=true]:text-foreground",
  "data-[pressed=true]:opacity-60",
);

/**
 * Compact provider + model picker for feature-page headers.
 * Credentials live in Settings; this only switches the active provider/model
 * (mirroring stored per-provider creds into the flat active fields on save).
 */
export function LlmProviderSelect({
  className,
  quiet = false,
  triggerCls,
}: {
  className?: string;
  /** De-boxed mono text triggers for editorial mastheads (出稿 翻译). */
  quiet?: boolean;
  /** Explicit trigger class override (e.g. "qsel-quiet") — wins over quiet/default. */
  triggerCls?: string;
}) {
  const trigger = triggerCls ?? (quiet ? quietTriggerCls : boxedTriggerCls);
  const { config, saveConfig } = useApp();
  const reduce = useReducedMotion();
  const provider = config.llm_provider;
  const preset = useMemo(() => llmPreset(provider), [provider]);
  const providers = useMemo(() => listLlmProviders(config), [config]);
  const providerLabel = llmProviderLabel(config, provider);
  const modelInList = preset.models.includes(config.llm_model);
  const [customOpen, setCustomOpen] = useState(false);
  const showCustomField =
    customOpen || (!modelInList && preset.models.length > 0) ||
    preset.models.length === 0;

  const creds = resolveLlmCreds(config, provider);
  const ready = Boolean(
    creds.api_base_url.trim() && config.llm_model.trim(),
  );

  const activate = (next: LlmProvider) => {
    setCustomOpen(false);
    void saveConfig(
      { ...config, ...activateLlmProviderPatch(config, next) },
      { silent: true },
    );
  };

  const setModel = (model: string) => {
    void saveConfig(
      {
        ...config,
        llm_model: model,
        llm_credentials: {
          ...config.llm_credentials,
          [provider]: { ...resolveLlmCreds(config, provider), model },
        },
      },
      { silent: true },
    );
  };

  return (
    <motion.div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      initial={reduce ? false : { opacity: 0.6, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      style={{ willChange: "opacity, transform" }}
    >
      <Select
        className="inline-flex w-auto"
        aria-label="LLM Provider"
        selectedKey={provider}
        onSelectionChange={(key) => {
          if (key == null) return;
          activate(String(key) as LlmProvider);
        }}
      >
        <Select.Trigger className={trigger}>
          <Select.Value>{() => providerLabel}</Select.Value>
          <ChevronDown size={12} className="shrink-0 text-muted" />
        </Select.Trigger>
        <Select.Popover className="min-w-[9rem]">
          <ListBox>
            {providers.map((p) => (
              <ListBox.Item key={p.id} id={p.id} textValue={p.label}>
                {p.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>

      {preset.models.length > 0 && !showCustomField ? (
        <Select
          className="inline-flex w-auto"
          aria-label="LLM Model"
          selectedKey={config.llm_model}
          onSelectionChange={(key) => {
            if (key == null) return;
            const id = String(key);
            if (id === CUSTOM) {
              setCustomOpen(true);
              return;
            }
            setModel(id);
          }}
        >
          <Select.Trigger className={trigger}>
            <Select.Value>
              {() => config.llm_model || "选择模型"}
            </Select.Value>
            <ChevronDown size={12} className="shrink-0 text-muted" />
          </Select.Trigger>
          <Select.Popover className="min-w-[10rem]">
            <ListBox>
              {preset.models.map((m) => (
                <ListBox.Item key={m} id={m} textValue={m}>
                  {m}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <ListBox.Item id={CUSTOM} textValue="自定义">
                自定义…
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <TextField
          aria-label="自定义模型"
          className="inline-flex w-[9rem]"
          variant="secondary"
          value={config.llm_model}
          onChange={setModel}
        >
          <Label className="sr-only">模型</Label>
          <Input
            className="h-7 !py-0 font-mono !text-[12px]"
            placeholder="模型名"
          />
        </TextField>
      )}

      {!ready ? (
        <Link
          to="/settings?tab=llm"
          className="text-[12px] text-accent-soft-foreground hover:underline"
        >
          配置
        </Link>
      ) : null}
    </motion.div>
  );
}
