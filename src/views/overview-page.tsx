import { useCallback, useEffect, useState } from "react";
import { Button, Kbd, toast } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { AudioLines, Bot, Download } from "lucide-react";
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
  const { config, state, modelLoaded, updateConfig, loadModel, agentJobs } =
    useApp();
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

  // Local dir set → skip install CTA; only prompt download when no path.
  const needsInstall =
    config.asr_provider === "qwen" &&
    !config.asr_model_dir?.trim() &&
    (status?.needs_download ?? !modelLoaded);

  const activeAgents = agentJobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  ).length;

  const statusBits = [
    config.asr_provider === "qwen" && modelLoaded
      ? "本机就绪"
      : providerLabel(config.asr_provider),
    stateLabel(state),
    config.language === "auto" ? "自动检测" : config.language,
    activeAgents > 0 ? `派活中 ${activeAgents}` : null,
  ].filter(Boolean);

  return (
    <PageShell className="max-w-xl">
      <PageHeader
        title="言落"
        status={
          needsInstall ? undefined : (
            <>
              <HotkeyKbd label={config.hotkey_transcribe.label} />
              {" · "}
              <HotkeyKbd label={config.hotkey_translate.label} />
              {" · "}
              <HotkeyKbd
                label={config.hotkey_agent?.label ?? "Fn+Space"}
              />
              {" · "}
              <span>{statusBits.join(" · ")}</span>
            </>
          )
        }
      />

      <ModeSwitch modeKey={needsInstall ? "install" : "ready"}>
        {needsInstall ? (
          <SectionCard className="flex flex-col gap-4 border-accent/30">
            <div>
              <div className="type-section">下载本机识别（约 2GB）</div>
              <p className="mt-1 type-meta">
                声音留在本机 · 型号 {config.asr_model_id || "Qwen3-ASR-0.6B"}
              </p>
            </div>
            {downloading && progress ? (
              <div className="type-meta">
                {progress.file} ·{" "}
                {progress.percent != null
                  ? `${progress.percent.toFixed(0)}%`
                  : `${progress.file_index}/${progress.file_count}`}
              </div>
            ) : null}
            <Button
              fullWidth
              variant="primary"
              className="btn-press"
              isPending={downloading}
              onPress={() => void startDownload()}
            >
              <Download size={14} />
              {downloading ? "下载中…" : "下载本机识别"}
            </Button>
          </SectionCard>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <p className="type-display !text-2xl">今天开口要什么结果？</p>
              <p className="mt-1.5 type-meta">
                你的声音留在本机。开口出稿，开口派活。
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <NavLink
                to="/draft"
                className="group flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-5 transition duration-200 hover:border-accent/30 hover:bg-surface-secondary/40"
              >
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent transition group-hover:scale-[1.03]">
                  <AudioLines size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="type-section">出稿</div>
                  <div className="mt-0.5 type-meta">
                    实时 · 文件/链接 · 翻译 · 历史
                  </div>
                </div>
              </NavLink>
              <NavLink
                to="/dispatch"
                className="group flex items-center gap-3 rounded-2xl border border-border/70 bg-surface/70 px-4 py-4 transition duration-200 hover:border-accent/30 hover:bg-surface-secondary/40"
              >
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-default/50 text-muted transition group-hover:scale-[1.03] group-hover:text-accent">
                  <Bot size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="type-section">派活</div>
                  <div className="mt-0.5 type-meta">
                    {activeAgents > 0
                      ? `${activeAgents} 运行中`
                      : agentJobs.length > 0
                        ? `${agentJobs.length} 任务`
                        : (
                            <HotkeyKbd
                              label={config.hotkey_agent?.label ?? "Fn+Space"}
                            />
                          )}
                  </div>
                </div>
              </NavLink>
            </div>
          </div>
        )}
      </ModeSwitch>
    </PageShell>
  );
}
