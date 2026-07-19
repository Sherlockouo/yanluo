import { useCallback, useEffect, useState } from "react";
import { Button, toast } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, useReducedMotion } from "framer-motion";
import { PageShell, SectionCard } from "@/components/shared/page-shell";
import { duration, easeOut, springUI } from "@/lib/motion";
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

export function OverviewPage() {
  const { config, modelLoaded, updateConfig, loadModel, agentJobs } = useApp();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const reduceMotion = useReducedMotion();

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

  const dispatchHint =
    activeAgents > 0
      ? `${activeAgents} 运行中`
      : agentJobs.length > 0
        ? `${agentJobs.length} 任务`
        : "说完派给 Claude / Codex";

  const draftKey = config.hotkey_transcribe.label;
  const translateKey = config.hotkey_translate.label;
  const agentKey = config.hotkey_agent?.label ?? "Fn+Space";

  return (
    <PageShell className="page-fill mx-0 max-w-[860px] gap-0 pb-0">
      <span className="home-eyebrow">Local · Mac</span>
      <h1 className="home-headline mt-3.5">
        今天开口
        <br />
        要什么结果？
      </h1>

      {needsInstall ? (
        <SectionCard className="panel-static mt-8 flex flex-col gap-4 border-accent/30">
          <div>
            <div className="type-section">下载本机识别（约 2GB）</div>
            <p className="mt-1 type-meta">
              型号 {config.asr_model_id || "Qwen3-ASR-0.6B"} ·
              装好即可开口出稿
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
      ) : null}

      <div className="mt-9 grid gap-3.5 sm:grid-cols-2">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0.92, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springUI}
        >
          <NavLink to="/draft" className="dest-card dest-card-primary h-full">
            <div>
              <div className="dest-label dest-label-primary">出稿</div>
              <div className="dest-hint">
                开会 · 口述 · 文件转写
                <br />
                说完有一版能发的稿
              </div>
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{draftKey}</span>
            </div>
          </NavLink>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0.92, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...springUI, delay: 0.07 }}
        >
          <NavLink to="/dispatch" className="dest-card h-full">
            <div>
              <div className="dest-label">派活</div>
              <div className="dest-hint">
                {dispatchHint}
                <br />
                任务自己跑
              </div>
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{agentKey}</span>
            </div>
          </NavLink>
        </motion.div>
      </div>

      <motion.div
        className="home-legend mt-auto pt-10"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{
          duration: duration.slow,
          ease: easeOut,
          delay: reduceMotion ? 0 : 0.18,
        }}
      >
        <span>
          <b>{draftKey}</b> 出稿
        </span>
        <span>
          <b>{translateKey}</b> 翻译
        </span>
        <span>
          <b>{agentKey}</b> 派活
        </span>
      </motion.div>
    </PageShell>
  );
}
