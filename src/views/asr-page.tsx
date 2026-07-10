import { useEffect, useState } from "react";
import { Button, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { FolderOpen, Save } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AsrProvider } from "@/types";
import { LANGUAGES } from "@/lib/constants";
import {
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function AsrPage() {
  const {
    config,
    modelLoaded,
    modelLoading,
    updateConfig,
    chooseModelDir,
    loadModel,
    saveConfig,
  } = useApp();
  const [appleAvailable, setAppleAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    void invoke<{ apple_speech_available?: boolean; platform?: string }>(
      "get_app_info",
    )
      .then((info) => {
        const ok = info.apple_speech_available ?? info.platform === "macos";
        setAppleAvailable(ok);
        if (!ok && config.asr_provider === "apple") {
          updateConfig("asr_provider", "elevenlabs");
        }
      })
      .catch(() => setAppleAvailable(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProvider = (next: AsrProvider) => {
    if (next === "apple" && !appleAvailable) return;
    updateConfig("asr_provider", next);
    setSavedHint(null);
  };

  const persist = async () => {
    setSaving(true);
    setSavedHint(null);
    try {
      await saveConfig();
      setSavedHint("已保存到本地");
    } catch (error) {
      setSavedHint(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell>
      <PageHeader title="ASR" subtitle="选择引擎后配置对应参数，保存到本地。" />

      <SectionCard className="max-w-2xl flex flex-col gap-5">
        <Select
          className="w-full flex"
          selectedKey={config.asr_provider}
          onSelectionChange={(key) => {
            if (key == null) return;
            selectProvider(String(key) as AsrProvider);
          }}
        >
          <Label>引擎</Label>
          <Select.Trigger className="flex items-center justify-between p-4">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="gap-3 p-3">
              {appleAvailable ? (
                <ListBox.Item id="apple" textValue="Apple Speech">
                  Apple Speech
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ) : null}
              <ListBox.Item id="elevenlabs" textValue="ElevenLabs Scribe">
                ElevenLabs Scribe
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="qwen" textValue="Qwen 本地">
                Qwen 本地
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>

        {!appleAvailable ? (
          <p className="text-[12px] leading-relaxed text-muted">
            Apple Speech 仅在 macOS 可用；当前平台请使用 ElevenLabs 或 Qwen。
          </p>
        ) : null}

        <Select
          className="w-full"
          selectedKey={config.language}
          onSelectionChange={(key) => {
            if (key == null) return;
            updateConfig("language", String(key));
          }}
        >
          <Label>语言</Label>
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
      </SectionCard>

      {config.asr_provider === "elevenlabs" ? (
        <SectionCard
          className="max-w-2xl flex flex-col gap-5"
          title="ElevenLabs 设置"
          description="API Key 与模型写入本地 config.json，仅本机使用。"
        >
          <TextField
            fullWidth
            variant="secondary"
            type="password"
            value={config.elevenlabs_api_key}
            onChange={(value) => updateConfig("elevenlabs_api_key", value)}
          >
            <Label>API Key</Label>
            <Input />
          </TextField>

          <TextField
            fullWidth
            variant="secondary"
            value={config.elevenlabs_model}
            onChange={(value) => updateConfig("elevenlabs_model", value)}
          >
            <Label>Model</Label>
            <Input />
          </TextField>

          <Button
            fullWidth
            variant="primary"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存凭证
          </Button>
          {savedHint ? (
            <p className="text-[12px] text-muted">{savedHint}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {config.asr_provider === "qwen" ? (
        <SectionCard
          className="max-w-2xl flex flex-col gap-5"
          title="Qwen 本地设置"
          description="模型目录与 Aligner 路径保存到本地。"
        >
          <TextField
            fullWidth
            variant="secondary"
            value={config.asr_model_dir}
            onChange={(value) => updateConfig("asr_model_dir", value)}
          >
            <Label>模型目录</Label>
            <div className="flex gap-2">
              <Input className="min-w-0 flex items-center font-mono text-[13px]" />
              <Button
                variant="secondary"
                onPress={() => void chooseModelDir()}
              >
                <FolderOpen size={16} />
                浏览
              </Button>
            </div>
          </TextField>

          <TextField
            fullWidth
            variant="secondary"
            value={config.align_model_dir ?? ""}
            onChange={(value) => updateConfig("align_model_dir", value)}
          >
            <Label>Aligner（可选）</Label>
            <Input className="min-w-0 flex items-center font-mono text-[13px]" />
          </TextField>

          <div className="grid grid-cols-2 gap-2">
            <Button
              fullWidth
              variant="secondary"
              isPending={saving}
              onPress={() => void persist()}
            >
              <Save size={16} />
              保存路径
            </Button>
            <Button
              fullWidth
              variant="primary"
              isPending={modelLoading}
              onPress={() => void loadModel()}
            >
              {modelLoading
                ? "加载中…"
                : modelLoaded
                  ? "重新加载"
                  : "加载模型"}
            </Button>
          </div>
          {savedHint ? (
            <p className="text-[12px] text-muted">{savedHint}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {config.asr_provider === "apple" ? (
        <SectionCard
          className="max-w-2xl flex flex-col gap-4"
          title="Apple Speech"
          description="使用系统语音识别，无需云端密钥。"
        >
          <p className="text-[13px] leading-relaxed text-muted">
            请在「设置 → 权限」中授权麦克风与语音识别。开发模式下列表名多为{" "}
            <code className="text-foreground">asr-workshop</code>。
          </p>
          <Button
            fullWidth
            variant="primary"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存引擎选择
          </Button>
          {savedHint ? (
            <p className="text-[12px] text-muted">{savedHint}</p>
          ) : null}
        </SectionCard>
      ) : null}
    </PageShell>
  );
}
