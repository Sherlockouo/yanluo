import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  CheckCircle2,
  CircleAlert,
  Ear,
  ExternalLink,
  Keyboard,
  Mic,
  Save,
  Shield,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";

type PermissionStatus = {
  accessibility: boolean;
  input_monitoring: boolean;
  microphone: boolean;
  speech_recognition: boolean;
};

type PermKind =
  | "accessibility"
  | "input_monitoring"
  | "microphone"
  | "speech_recognition";

const PERMS: {
  kind: PermKind;
  title: string;
  description: string;
  icon: typeof Shield;
}[] = [
  {
    kind: "accessibility",
    title: "辅助功能",
    description: "Fn 全局监听与粘贴到前台应用需要此权限。",
    icon: Shield,
  },
  {
    kind: "input_monitoring",
    title: "输入监视",
    description: "监听 Fn 键按下 / 松开事件。",
    icon: Keyboard,
  },
  {
    kind: "microphone",
    title: "麦克风",
    description: "录音转写需要麦克风访问。",
    icon: Mic,
  },
  {
    kind: "speech_recognition",
    title: "语音识别",
    description: "使用 Apple Speech 时需要此权限。",
    icon: Ear,
  },
];

export function SettingsPage() {
  const { config, updateConfig, saveConfig } = useApp();
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await invoke<PermissionStatus>("get_permission_status");
      setPerms(status);
    } catch {
      /* ignore during HMR */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [refresh]);

  const openSettings = async (kind: PermKind) => {
    setBusy(kind);
    try {
      await invoke("open_permission_settings", { kind });
      window.setTimeout(() => void refresh(), 1200);
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="设置"
        subtitle="凭证与系统权限。未授权时可打开系统设置页完成授权。"
      />

      <SectionCard
        title="系统权限"
        description="以下为当前授权状态。未授权时点击「打开系统设置」前往授权。"
        className="max-w-3xl"
      >
        <div>
          {PERMS.map((item) => {
            const granted = perms?.[item.kind] ?? false;
            const Icon = item.icon;
            return (
              <div key={item.kind} className="perm-row">
                <div
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl border",
                    granted
                      ? "border-white/10 bg-white/8 text-foreground"
                      : "border-border bg-default/40 text-muted",
                  )}
                >
                  <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">
                    {item.title}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                    {item.description}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={cn(
                      "perm-status",
                      granted ? "perm-status-ok" : "perm-status-off",
                    )}
                  >
                    {granted ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <CircleAlert size={12} />
                    )}
                    {granted ? "已授权" : "未授权"}
                  </span>
                  {!granted ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={busy === item.kind}
                      onPress={() => void openSettings(item.kind)}
                    >
                      <ExternalLink size={16} />
                      打开系统设置
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard className="max-w-3xl flex flex-col gap-5" title="云端凭证">
        <TextField
          fullWidth
          variant="secondary"
          type="password"
          value={config.elevenlabs_api_key}
          onChange={(value) => updateConfig("elevenlabs_api_key", value)}
        >
          <Label>ElevenLabs API Key</Label>
          <Input />
        </TextField>

        <TextField
          fullWidth
          variant="secondary"
          value={config.elevenlabs_model}
          onChange={(value) => updateConfig("elevenlabs_model", value)}
        >
          <Label>ElevenLabs Model</Label>
          <Input />
        </TextField>

        <Button fullWidth variant="primary" onPress={() => void saveConfig()}>
          <Save size={16} />
          保存
        </Button>
      </SectionCard>
    </PageShell>
  );
}
