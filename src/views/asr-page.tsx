import { useMemo } from "react";
import { createPortal } from "react-dom";
import { ListBox, Select } from "@heroui/react";
import { Link } from "react-router-dom";
import { ChevronDown, Mic } from "lucide-react";
import { QWEN_ASR_MODELS, providerLabel } from "@/lib/constants";
import { PageHeader, PageShell, Reveal } from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import { useApp } from "@/app-context";

/** Live-draft mode panel — recent Fn transcriptions. Engine config lives in 设置;
 *  the masthead only keeps a quiet model picker + a link there. */
export function AsrPage({
  embedded = false,
  active = true,
  actionSlot,
}: {
  embedded?: boolean;
  active?: boolean;
  actionSlot?: HTMLElement | null;
} = {}) {
  const {
    config,
    history,
    modelLoaded,
    modelLoading,
    updateConfig,
    loadModel,
    saveConfig,
  } = useApp();

  const entries = useMemo(
    () => history.filter((e) => (e.source ?? "fn") === "fn").slice(0, 40),
    [history],
  );

  const isQwen = config.asr_provider === "qwen";
  const currentModelId = config.asr_model_id || "Qwen3-ASR-0.6B";

  // Pick a model → persist + reload immediately (no big save button).
  const selectModel = async (id: string) => {
    if (id === currentModelId) return;
    updateConfig("asr_model_id", id);
    await saveConfig({ ...config, asr_model_id: id }, { silent: true });
    if (isQwen) await loadModel();
  };

  const modelSelect = isQwen ? (
    <Select
      className="inline-flex w-auto"
      aria-label="模型"
      isDisabled={modelLoading}
      selectedKey={currentModelId}
      onSelectionChange={(key) => {
        if (key == null) return;
        void selectModel(String(key));
      }}
    >
      <Select.Trigger className="qsel-quiet">
        <Select.Value />
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </Select.Trigger>
      <Select.Popover className="min-w-[10rem]">
        <ListBox>
          {QWEN_ASR_MODELS.map((m) => (
            <ListBox.Item key={m.id} id={m.id} textValue={m.label}>
              {m.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  ) : null;

  const configLink = (
    <Link to="/settings?tab=asr" className="dlink muted">
      配置
    </Link>
  );

  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span>{providerLabel(config.asr_provider)}</span>
      {isQwen ? (
        <span className="text-muted">
          {modelLoading ? "加载中…" : modelLoaded ? "已加载" : "未加载"}
        </span>
      ) : null}
      {modelSelect ? <span className="text-muted/40">·</span> : null}
      {modelSelect}
      <span className="text-muted/40">·</span>
      {configLink}
    </div>
  );

  const content = (
    <>
      {embedded && actionSlot
        ? createPortal(
            // Keep the slot content MOUNTED across tab switches (visibility
            // toggle only) — same pattern as translate-page.
            <span
              className="dmast-actgrp"
              style={active ? undefined : { display: "none" }}
            >
              {modelSelect}
              {configLink}
            </span>,
            actionSlot,
          )
        : null}
      {embedded ? null : <PageHeader title="实时" status={header} />}

      {entries.length === 0 ? (
        <div className="dropzone" style={{ minHeight: 200 }}>
          <span className="dropzone-ic">
            <Mic size={22} aria-hidden />
          </span>
          <span className="dropzone-t">还没有识别记录</span>
          <span className="dropzone-fmt">按住 Fn 开始</span>
        </div>
      ) : (
        <div className="recs">
          {entries.map((entry, i) => {
            const showDiff = hasRefineDiff(entry.raw_text, entry.text);
            const row = (
              <article className="rec">
                <div className="rec-l">
                  <span>{new Date(entry.created_at).toLocaleString()}</span>
                  <span className="tag">Fn</span>
                  <span>{entry.duration_seconds.toFixed(1)}s</span>
                  {entry.language ? <span>{entry.language}</span> : null}
                </div>
                {showDiff ? (
                  <div className="rec-c">
                    <RefineDiff before={entry.raw_text} after={entry.text} />
                  </div>
                ) : (
                  <p className="rec-c whitespace-pre-wrap">
                    {entry.text || "（空）"}
                  </p>
                )}
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
