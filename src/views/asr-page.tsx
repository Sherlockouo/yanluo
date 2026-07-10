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
      <PageHeader title="ASR" subtitle="选择引擎与语言。" />

      <SectionCard className="max-w-2xl flex flex-col gap-5">
        <Select
          className="w-full flex"
          selectedKey={config.asr_provider}
          onSelectionChange={(key) => {
            if (key == null) return;
            updateConfig("asr_provider", String(key) as AsrProvider);
          }}
        >
          <Label>引擎</Label>
          <Select.Trigger className="flex items-center justify-between p-4">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="gap-3 p-3">
              <ListBox.Item id="apple" textValue="Apple Speech">
                Apple Speech
                <ListBox.ItemIndicator />
              </ListBox.Item>
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

        {config.asr_provider === "qwen" ? (
          <div className="flex flex-col gap-4 border-t border-border/70 pt-5">
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
        ) : null}

        <Button fullWidth variant="secondary" onPress={() => void saveConfig()}>
          <Save size={16} />
          保存
        </Button>
      </SectionCard>
    </PageShell>
  );
}
