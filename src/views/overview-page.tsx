import { useCallback, useEffect, useState } from "react";
import { Button, Kbd, toast } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { AudioLines, Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hotkeySegments, providerLabel, stateLabel } from "@/lib/constants";
import {
  ModeSwitch,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

type ModelStatus = {
  model_id: string;
  path: string;
  installed: boolean;
  needs_download: boolean;
  has_tokenizer: boolean;
};

type ModelDownloadProgress = {
  model_id: string;
  file: string;
  downloaded: number;
  total: number | null;
  file_index: number;
  file_count: number;
  percent: number | null;
};

function HotkeyKbd({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {hotkeySegments(label).map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-border">+</span> : null}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function OverviewPage() {
  const { config, state, modelLoaded, updateConfig, loadModel } = useApp();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);

  const refreshStatus = useCallback(async () => {
    if (config.asr_provider !== "qwen") {
      setStatus(null);
      return;
    }
    try {
      const next = await invoke<ModelStatus>("get_model_status", {
        modelId: config.asr_model_id || "Qwen3-ASR-0.6B",
      });
      setStatus(next);
    } catch {
      /* ignore */
    }
  }, [config.asr_provider, config.asr_model_id]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ModelDownloadProgress>("model-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const startDownload = async () => {
    const modelId = config.asr_model_id || "Qwen3-ASR-0.6B";
    setDownloading(true);
    setProgress(null);
    try {
      const path = await invoke<string>("download_qwen_asr_model", {
        modelId,
        downloadAligner: false,
      });
      updateConfig("asr_model_dir", path);
      updateConfig("asr_model_id", modelId);
      toast.success("模型已下载，正在加载…");
      await refreshStatus();
      await loadModel();
    } catch (error) {
      toast.danger(
        `下载失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setDownloading(false);
    }
  };

  const needsInstall =
    config.asr_provider === "qwen" &&
    (status?.needs_download ??
      (!modelLoaded && !config.asr_model_dir?.trim()));

  const statusBits = [
    providerLabel(config.asr_provider),
    config.asr_provider === "qwen"
      ? modelLoaded
        ? "已加载"
        : "未加载"
      : null,
    stateLabel(state),
    config.language === "auto" ? "自动检测" : config.language,
  ].filter(Boolean);

  return (
    <PageShell className="max-w-xl">
      <PageHeader
        title="ASR Workshop"
        status={
          needsInstall ? undefined : (
            <>
              <HotkeyKbd label={config.hotkey_transcribe.label} />
              {" · "}
              <HotkeyKbd label={config.hotkey_translate.label} />
              {" · "}
              <span>{statusBits.join(" · ")}</span>
            </>
          )
        }
      />

      <ModeSwitch modeKey={needsInstall ? "install" : "ready"}>
        {needsInstall ? (
          <SectionCard className="flex flex-col gap-4 border-accent/30">
            <div className="type-section">
              安装 {config.asr_model_id || "Qwen3-ASR-0.6B"}
            </div>
            {downloading && progress ? (
              <div className="type-meta">
                {progress.file} ·{" "}
                {progress.percent != null
                  ? `${progress.percent.toFixed(0)}%`
                  : `${progress.file_index}/${progress.file_count}`}
              </div>
            ) : (
              <p className="type-meta">约 2GB · 本地识别</p>
            )}
            <Button
              fullWidth
              variant="primary"
              className="btn-press"
              isPending={downloading}
              onPress={() => void startDownload()}
            >
              <Download size={14} />
              {downloading ? "下载中…" : "下载并加载"}
            </Button>
          </SectionCard>
        ) : (
          <NavLink
            to="/transcribe"
            className="group flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-5 transition duration-200 hover:border-accent/30 hover:bg-surface-secondary/40"
          >
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent transition group-hover:scale-[1.03]">
              <AudioLines size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="type-section">转写</div>
              <div className="mt-0.5 type-meta">文件或链接</div>
            </div>
          </NavLink>
        )}
      </ModeSwitch>
    </PageShell>
  );
}
