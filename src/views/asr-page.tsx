import { Button, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { FolderOpen, Save } from "lucide-react";
import type { AsrProvider } from "@/types";
import { LANGUAGES } from "@/lib/constants";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
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

  return (
    <PageShell>
      <PageHeader
        title="ASR 引擎"
        subtitle="选择本地 Apple Speech、ElevenLabs Scribe，或 Qwen3-ASR 本地流式。"
      />

      <SectionCard className="max-w-3xl flex flex-col gap-5">
        <Select
          className="w-full flex"
          selectedKey={config.asr_provider}
          onSelectionChange={(key) => {
            if (key == null) return;
            updateConfig("asr_provider", String(key) as AsrProvider);
          }}
        >
          <Label>Provider</Label>
          <Select.Trigger className="flex items-center justify-between p-4">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="gap-5 p-4 m-4">
              <ListBox.Item id="apple" textValue="Apple Speech Recognition">
                Apple Speech Recognition
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="elevenlabs" textValue="ElevenLabs Scribe">
                ElevenLabs Scribe
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="qwen" textValue="Qwen3-ASR local streaming">
                Qwen3-ASR local streaming
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>

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

        {config.asr_provider === "qwen" && (
          <>
            <TextField
              fullWidth
              variant="secondary"
              value={config.asr_model_dir}
              onChange={(value) => updateConfig("asr_model_dir", value)}
            >
              <Label>Qwen 模型目录</Label>
              <div className="flex gap-2">
                <Input className="min-w-0 flex items-center font-mono" />
                <Button variant="secondary" onPress={() => void chooseModelDir()}>
                  <FolderOpen size={15} /> 浏览
                </Button>
              </div>
            </TextField>

            <Button
              fullWidth
              variant="primary"
              isPending={modelLoading}
              onPress={() => void loadModel()}
            >
              {modelLoading
                ? "Loading…"
                : modelLoaded
                  ? "重新加载 Qwen 模型"
                  : "加载 Qwen 模型"}
            </Button>
          </>
        )}

        <Button fullWidth variant="secondary" onPress={() => void saveConfig()}>
          <Save size={15} /> 保存 ASR 设置
        </Button>
      </SectionCard>
    </PageShell>
  );
}
