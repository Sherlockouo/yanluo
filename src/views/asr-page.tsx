import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
} from "@heroui/react";
import { Link } from "react-router-dom";
import { Mic, Save } from "lucide-react";
import { LANGUAGES, QWEN_ASR_MODELS, providerLabel } from "@/lib/constants";
import {
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
import { useApp } from "@/app-context";

/** Live-draft mode panel — recent Fn transcriptions + engine config. Used standalone or embedded in 出稿. */
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
  const [engineOpen, setEngineOpen] = useState(false);

  const entries = useMemo(
    () => history.filter((e) => (e.source ?? "fn") === "fn").slice(0, 40),
    [history],
  );

  const isQwen = config.asr_provider === "qwen";
  const hasModelDir = Boolean(config.asr_model_dir?.trim());
  const alignConfigured = Boolean(config.align_model_dir?.trim());

  const saveAndLoad = async () => {
    await saveConfig(config, { silent: true });
    if (isQwen) await loadModel();
  };

  const header = (
    <>
      {providerLabel(config.asr_provider)}
      {isQwen ? (modelLoaded ? " · 已加载" : " · 未加载") : null}
      {" · "}
      <Link to="/settings?tab=asr" className="text-accent hover:underline">
        设置
      </Link>
    </>
  );
  const headerAction = (
    <Button
      size="sm"
      variant={engineOpen ? "primary" : "secondary"}
      onPress={() => setEngineOpen((v) => !v)}
    >
      模型
    </Button>
  );

  const content = (
    <>
      {embedded && active && actionSlot
        ? createPortal(
            <button
              type="button"
              className="dlink muted"
              onClick={() => setEngineOpen((v) => !v)}
            >
              模型{engineOpen ? " ▴" : " ▾"}
            </button>,
            actionSlot,
          )
        : null}
      {embedded ? null : (
        <PageHeader title="实时" status={header} action={headerAction} />
      )}

      <SoftCollapse open={engineOpen}>
        <div className="surface-card mb-1 flex flex-col gap-5 p-4">
          {isQwen ? (
            <>
              <Select
                className="w-full"
                selectedKey={config.language}
                onSelectionChange={(key) => {
                  if (key == null) return;
                  updateConfig("language", String(key));
                }}
              >
                <Label>识别语言</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {LANGUAGES.map(([value, label]) => (
                      <ListBox.Item key={value} id={value} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <Select
                className="w-full flex"
                selectedKey={config.asr_model_id || "Qwen3-ASR-0.6B"}
                onSelectionChange={(key) => {
                  if (key == null) return;
                  updateConfig("asr_model_id", String(key));
                }}
              >
                <Label>型号</Label>
                <Select.Trigger className="flex items-center justify-between p-4">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox className="gap-2 p-2">
                    {QWEN_ASR_MODELS.map((m) => (
                      <ListBox.Item key={m.id} id={m.id} textValue={m.label}>
                        {m.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <div className="rounded-2xl border border-border bg-surface-secondary/40 px-3 py-2">
                <Switch
                  isSelected={alignConfigured && config.align_enabled}
                  isDisabled={!alignConfigured}
                  onChange={(value) => updateConfig("align_enabled", value)}
                >
                  <Switch.Content className="w-full justify-between gap-2 p-2">
                    <div className="min-w-0 pr-2">
                      <div className="type-ui">逐字对齐</div>
                      <div className="mt-0.5 type-meta">
                        {alignConfigured
                          ? "ForcedAligner 字级时间戳"
                          : "需在设置配置对齐模型"}
                      </div>
                    </div>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>

              {!hasModelDir ? (
                <p className="type-meta">
                  未安装模型 ·{" "}
                  <Link
                    to="/settings?tab=asr"
                    className="text-accent hover:underline"
                  >
                    去设置下载
                  </Link>
                </p>
              ) : null}

              <Button
                fullWidth
                variant="primary"
                className="btn-press"
                isPending={modelLoading}
                onPress={() => void saveAndLoad()}
              >
                <Save size={16} />
                {modelLoading
                  ? "加载中…"
                  : modelLoaded
                    ? "保存并重新加载"
                    : "保存并加载"}
              </Button>
            </>
          ) : config.asr_provider === "elevenlabs" ? (
            <>
              <TextField
                fullWidth
                variant="secondary"
                value={config.elevenlabs_model}
                onChange={(value) => updateConfig("elevenlabs_model", value)}
              >
                <Label>Model</Label>
                <Input placeholder="scribe_v2" />
              </TextField>
              <p className="type-meta">
                API Key 在{" "}
                <Link
                  to="/settings?tab=asr"
                  className="text-accent hover:underline"
                >
                  设置
                </Link>
                {" 配置。"}
              </p>
              <Button
                fullWidth
                variant="primary"
                className="btn-press"
                onPress={() => void saveConfig()}
              >
                <Save size={16} />
                保存
              </Button>
            </>
          ) : (
            <p className="type-meta">Apple 系统语音识别，无需选择型号。</p>
          )}
        </div>
      </SoftCollapse>

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
            return (
              <Reveal key={entry.id} index={i}>
                <article className="rec">
                  <div className="rec-l">
                    <span>{new Date(entry.created_at).toLocaleString()}</span>
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
              </Reveal>
            );
          })}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
