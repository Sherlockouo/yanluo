import {
  Button,
  Description,
  Input,
  Label,
  Switch,
  TextField,
} from "@heroui/react";
import { Save, Sparkles } from "lucide-react";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function LlmPage() {
  const { config, updateConfig, saveConfig, testLlm } = useApp();

  return (
    <PageShell>
      <PageHeader
        title="LLM 纠错"
        subtitle="OpenAI 兼容 API，用于保守修复中英混杂语音识别错误（例如「配森」→ Python）。"
      />

      <SectionCard className="max-w-3xl flex flex-col gap-5">
        <div className="rounded-2xl border border-border bg-surface-secondary/60 px-4 py-3">
          <Switch
            isSelected={config.llm_enabled}
            onChange={(value) => updateConfig("llm_enabled", value)}
          >
            <Switch.Content className="w-full justify-between gap-2 p-2">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-semibold text-foreground">
                  启用 LLM Refine
                </div>
                <Description>仅保守纠错，不做润色或改写。</Description>
              </div>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>

        <TextField
          fullWidth
          variant="secondary"
          value={config.llm_api_base_url}
          onChange={(value) => updateConfig("llm_api_base_url", value)}
        >
          <Label>API Base URL</Label>
          <Input placeholder="https://api.openai.com/v1" />
        </TextField>

        <TextField
          fullWidth
          variant="secondary"
          type="password"
          value={config.llm_api_key}
          onChange={(value) => updateConfig("llm_api_key", value)}
        >
          <Label>API Key</Label>
          <Input placeholder="可完全清空" />
        </TextField>

        <TextField
          fullWidth
          variant="secondary"
          value={config.llm_model}
          onChange={(value) => updateConfig("llm_model", value)}
        >
          <Label>Model</Label>
          <Input placeholder="gpt-4o-mini" />
        </TextField>

        <div className="form-actions">
          <Button fullWidth variant="secondary" onPress={() => void testLlm()}>
            <Sparkles size={15} /> 测试
          </Button>
          <Button fullWidth variant="primary" onPress={() => void saveConfig()}>
            <Save size={15} /> 保存
          </Button>
        </div>
      </SectionCard>
    </PageShell>
  );
}
