import { useCallback, useEffect, useState } from "react";
import { Button, Kbd, toast } from "@heroui/react";
import { NavLink } from "react-router-dom";
import {
  AudioLines,
  Brain,
  BookOpen,
  Download,
  Languages,
  Wand2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hotkeySegments, providerLabel, stateLabel } from "@/lib/constants";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

const LINKS = [
  { to: "/transcribe", icon: AudioLines, title: "转写" },
  { to: "/translate", icon: Languages, title: "翻译" },
  { to: "/asr", icon: Brain, title: "ASR" },
  { to: "/vocabulary", icon: BookOpen, title: "词库" },
  { to: "/llm", icon: Wand2, title: "LLM" },
] as const;

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

  const showBanner =
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
    <PageShell>
      <PageHeader title="ASR Workshop" />

      {showBanner ? (
        <SectionCard className="max-w-xl flex flex-col gap-3 border-accent/30">
          <div className="text-sm font-semibold text-foreground">
            尚未安装 Qwen 模型
          </div>
          <p className="text-[13px] text-muted">
            一键下载 {config.asr_model_id || "Qwen3-ASR-0.6B"}
            （约 2GB）后即可本地识别。也可稍后在 ASR 页操作。
          </p>
          {downloading && progress ? (
            <div className="text-[12px] text-muted">
              {progress.file} ·{" "}
              {progress.percent != null
                ? `${progress.percent.toFixed(0)}%`
                : `${progress.file_index}/${progress.file_count}`}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              isPending={downloading}
              onPress={() => void startDownload()}
            >
              <Download size={14} />
              {downloading ? "下载中…" : "立即下载"}
            </Button>
            <NavLink
              to="/asr"
              className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted hover:text-foreground"
            >
              前往 ASR 页
            </NavLink>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard className="max-w-xl">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          <span className="inline-flex items-center gap-2 text-foreground">
            <HotkeyKbd label={config.hotkey_transcribe.label} />
            转录
          </span>
          <span className="inline-flex items-center gap-2 text-foreground">
            <HotkeyKbd label={config.hotkey_translate.label} />
            翻译
          </span>
          <span className="inline-flex items-center gap-2">
            <HotkeyKbd label={config.hotkey_cancel.label} />
            取消
          </span>
          <span className="text-border">·</span>
          <span>{statusBits.join(" · ")}</span>
        </div>
      </SectionCard>

      <div className="grid max-w-xl gap-2.5 sm:grid-cols-2">
        {LINKS.map(({ to, icon: Icon, title }) => (
          <NavLink
            key={to}
            to={to}
            className="group rounded-2xl border border-border bg-surface px-4 py-4 transition duration-200 hover:border-accent/25 hover:bg-surface-secondary/40"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-default text-foreground transition group-hover:bg-accent/10 group-hover:text-accent">
                <Icon size={16} />
              </div>
              <div className="text-sm font-semibold text-foreground">
                {title}
              </div>
            </div>
          </NavLink>
        ))}
      </div>
    </PageShell>
  );
}
