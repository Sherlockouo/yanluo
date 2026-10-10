import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Input, Label, ListBox, Select, TextField } from "@heroui/react";
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
import { useT } from "@/lib/i18n";
import { duration, easeOut } from "@/lib/motion";
import type { LlmProvider } from "@/types";

const CUSTOM = "__custom__";

/**
 * Compact provider + model picker for feature-page headers.
 * Credentials live in Settings; this only switches the active provider/model
 * (mirroring stored per-provider creds into the flat active fields on save).
 */
export function LlmProviderSelect({
  className,
}: {
  className?: string;
}) {
  const t = useT();
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
      initial={reduce ? false : { opacity: 0.92, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.fast, ease: easeOut }}
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
        <Select.Trigger>
          <Select.Value>{() => providerLabel}</Select.Value>
          <Select.Indicator />
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

      <motion.span
        key={
          preset.models.length > 0 && !showCustomField ? "preset" : "custom"
        }
        className="inline-flex items-center"
        initial={reduce ? false : { opacity: 0.92 }}
        animate={{ opacity: 1 }}
        transition={{ duration: duration.fast, ease: easeOut }}
      >
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
          <Select.Trigger>
            <Select.Value>
              {() => config.llm_model || t("common.llm.selectModel")}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="min-w-[10rem]">
            <ListBox>
              {preset.models.map((m) => (
                <ListBox.Item key={m} id={m} textValue={m}>
                  {m}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <ListBox.Item id={CUSTOM} textValue={t("common.llm.custom")}>
                {t("common.llm.customEllipsis")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <TextField
          aria-label={t("common.llm.customModelAria")}
          className="inline-flex w-[9rem]"
          variant="secondary"
          value={config.llm_model}
          onChange={setModel}
        >
          <Label className="sr-only">{t("common.llm.model")}</Label>
          <Input
            className="h-7 !py-0 font-mono !text-[12px]"
            placeholder={t("common.llm.modelPlaceholder")}
            autoFocus={customOpen}
          />
        </TextField>
      )}
      </motion.span>

      {!ready ? (
        <Link
          to="/settings?tab=llm"
          className="text-[12px] text-accent-soft-foreground hover:underline"
        >
          {t("common.llm.configure")}
        </Link>
      ) : null}
    </motion.div>
  );
}
