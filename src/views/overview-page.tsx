import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Button, toast } from "@heroui/react";
import { NavLink } from "react-router-dom";
import { Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, useReducedMotion } from "framer-motion";
import { PageShell, SectionCard } from "@/components/shared/page-shell";
import { WordCloud } from "@/components/home/word-cloud";
import { duration, easeOut, springUI } from "@/lib/motion";
import {
  aggregateWordFreq,
  CLOUD_SOURCES,
  type CloudSource,
} from "@/lib/word-freq";
import { useApp } from "@/app-context";

const CLOUD_SOURCE_KEY = "yanluo:home-cloud-source";

function readCloudSource(): CloudSource {
  try {
    const v = sessionStorage.getItem(CLOUD_SOURCE_KEY);
    if (v === "fn" || v === "translate" || v === "transcribe") return v;
  } catch {
    /* ignore */
  }
  return "fn";
}

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
  const { config, modelLoaded, updateConfig, loadModel, agentJobs, history } =
    useApp();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [cloudSource, setCloudSource] = useState<CloudSource>(readCloudSource);
  const reduceMotion = useReducedMotion();

  const cloudWords = useMemo(
    () => aggregateWordFreq(history, cloudSource, 40),
    [history, cloudSource],
  );

  const setSource = (id: CloudSource) => {
    setCloudSource(id);
    try {
      sessionStorage.setItem(CLOUD_SOURCE_KEY, id);
    } catch {
      /* ignore */
    }
  };

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
        : "Claude / Codex 都行";

  const draftKey = config.hotkey_transcribe.label;
  const translateKey = config.hotkey_translate.label;
  const agentKey = config.hotkey_agent?.label ?? "Fn+Space";

  return (
    <PageShell className="page-fill mx-0 max-w-[1080px] gap-0 pb-0">
      <span className="home-eyebrow">声音留在本机 · Mac</span>
      <h1 className="home-headline mt-3.5">开口有结果</h1>

      {needsInstall ? (
        <SectionCard className="panel-static mt-8 flex flex-col gap-4">
          <div>
            <div className="type-section">先下载才能开口（约 2GB）</div>
            <p className="mt-1 type-meta">只需下载一次 · 装好后即可出稿</p>
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
            {downloading ? "下载中…" : "开始下载"}
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
                开会 · 口述 · 拖文件
                <br />
                说完有稿
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
                开口派活
              </div>
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{agentKey}</span>
            </div>
          </NavLink>
        </motion.div>
      </div>

      <div className="home-cloud">
        <div className="home-cloud-head">
          <span className="home-cloud-label">词云</span>
          <div className="tswitch" role="tablist" aria-label="词云来源">
            {CLOUD_SOURCES.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 ? (
                  <span className="sep" aria-hidden>
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={cloudSource === s.id}
                  className={`o${cloudSource === s.id ? " is-active" : ""}`}
                  onClick={() => setSource(s.id)}
                >
                  {s.label}
                </button>
              </Fragment>
            ))}
          </div>
        </div>
        <WordCloud words={cloudWords} />
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
        <span>声音留在本机</span>
      </motion.div>
    </PageShell>
  );
}
