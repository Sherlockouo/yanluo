import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
  toast,
} from "@heroui/react";
import { Download, FolderOpen, Mic, Save } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import { LANGUAGES, QWEN_ASR_MODELS, providerLabel } from "@/lib/constants";
import {
  CollapseTrigger,
  EmptyState,
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { hasRefineDiff, RefineDiff } from "@/components/ui/refine-diff";
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AsrPage() {
  const {
    config,
    history,
    modelLoaded,
    modelLoading,
    updateConfig,
    chooseModelDir,
    loadModel,
    saveConfig,
  } = useApp();
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadAligner, setDownloadAligner] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);

  const entries = useMemo(
    () =>
      history
        .filter((e) => (e.source ?? "fn") === "fn")
        .slice(0, 40),
    [history],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await invoke<ModelStatus>("get_model_status", {
        modelId: config.asr_model_id || "Qwen3-ASR-0.6B",
      });
      setStatus(next);
    } catch {
      /* ignore */
    }
  }, [config.asr_model_id]);

  useEffect(() => {
    if (config.asr_provider === "qwen") void refreshStatus();
  }, [config.asr_provider, refreshStatus]);

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

  const persist = async () => {
    setSaving(true);
    setSavedHint(null);
    try {
      await saveConfig();
      setSavedHint("已保存");
    } catch (error) {
      setSavedHint(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const startDownload = async () => {
    const modelId = config.asr_model_id || "Qwen3-ASR-0.6B";
    setDownloading(true);
    setProgress(null);
    try {
      const path = await invoke<string>("download_qwen_asr_model", {
        modelId,
        downloadAligner,
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

  const needsDownload =
    config.asr_provider === "qwen" &&
    (status?.needs_download ?? !config.asr_model_dir?.trim());

  useEffect(() => {
    if (needsDownload) setEngineOpen(true);
  }, [needsDownload]);

  const primaryAction = async () => {
    if (needsDownload) {
      await startDownload();
      return;
    }
    await persist();
    await loadModel();
  };

  const primaryLabel = needsDownload
    ? downloading
      ? "下载中…"
      : "下载并加载"
    : modelLoading
      ? "加载中…"
      : modelLoaded
        ? "保存并重新加载"
        : "保存并加载";

  return (
    <PageShell className="max-w-2xl">
      <PageHeader
        title="ASR"
        status={
          <>
            {providerLabel(config.asr_provider)}
            {config.asr_provider === "qwen"
              ? modelLoaded
                ? " · 已加载"
                : " · 未加载"
              : null}
            {" · "}
            <Link to="/settings?tab=asr" className="text-accent hover:underline">
              设置
            </Link>
          </>
        }
        action={
          <Button
            size="sm"
            variant={engineOpen ? "primary" : "secondary"}
            onPress={() => setEngineOpen((v) => !v)}
          >
            引擎
          </Button>
        }
      />

      <SoftCollapse open={engineOpen}>
        <div className="mb-1 flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
      {config.asr_provider === "elevenlabs" ? (
        <div className="flex flex-col gap-5">
          <TextField
            fullWidth
            variant="secondary"
            value={config.elevenlabs_model}
            onChange={(value) => updateConfig("elevenlabs_model", value)}
          >
            <Label>Model</Label>
            <Input placeholder="scribe_v2" />
          </TextField>
          <Button
            fullWidth
            variant="primary"
            className="btn-press"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存
          </Button>
          {savedHint ? (
            <p className="type-meta">{savedHint}</p>
          ) : null}
        </div>
      ) : null}

      {config.asr_provider === "apple" ? (
        <div className="flex flex-col gap-4">
          <p className="type-meta">系统语音识别</p>
          <Button
            fullWidth
            variant="primary"
            className="btn-press"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存
          </Button>
          {savedHint ? (
            <p className="type-meta">{savedHint}</p>
          ) : null}
        </div>
      ) : null}

      {config.asr_provider === "qwen" ? (
        <div className="flex flex-col gap-5">
          <Select
            className="w-full"
            selectedKey={config.language}
            onSelectionChange={(key) => {
              if (key == null) return;
              updateConfig("language", String(key));
            }}
          >
            <Label>识别语言</Label>
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

          <Select
            className="w-full flex"
            selectedKey={config.asr_model_id || "Qwen3-ASR-0.6B"}
            onSelectionChange={(key) => {
              if (key == null) return;
              updateConfig("asr_model_id", String(key));
            }}
          >
            <Label>型号</Label>
            <Select.Trigger className="flex items-center justify-between p-4">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox className="gap-2 p-2">
                {QWEN_ASR_MODELS.map((m) => (
                  <ListBox.Item key={m.id} id={m.id} textValue={m.label}>
                    {m.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          {status?.installed ? (
            <p className="truncate type-meta">
              已安装 · {status.path}
            </p>
          ) : null}

          {downloading && progress ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between type-meta">
                <span>
                  {progress.file}（{progress.file_index}/{progress.file_count}）
                </span>
                <span>
                  {progress.percent != null
                    ? `${progress.percent.toFixed(0)}%`
                    : formatBytes(progress.downloaded)}
                  {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
                </span>
              </div>
              <div className="update-progress-track">
                <div
                  className="update-progress-bar"
                  style={{
                    width:
                      progress.percent != null
                        ? `${Math.min(100, Math.max(0, progress.percent))}%`
                        : "30%",
                  }}
                />
              </div>
            </div>
          ) : null}

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

          <CollapseTrigger
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
            className="rounded-xl border border-border/60 px-3"
          >
            高级
          </CollapseTrigger>

          <SoftCollapse open={advancedOpen}>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 type-meta">
                <input
                  type="checkbox"
                  checked={downloadAligner}
                  onChange={(e) => setDownloadAligner(e.target.checked)}
                />
                下载 ForcedAligner
              </label>

              <TextField
                fullWidth
                variant="secondary"
                value={config.align_model_dir ?? ""}
                onChange={(value) => updateConfig("align_model_dir", value)}
              >
                <Label>对齐模型目录</Label>
                <Input className="min-w-0 flex items-center font-mono text-[13px]" />
              </TextField>

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.chunk_size_sec ?? 1.5)}
                  onChange={(value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "chunk_size_sec",
                      Math.max(0.2, Math.min(5, n)),
                    );
                  }}
                >
                  <Label>分片秒数</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.unfixed_token_num ?? 5)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "unfixed_token_num",
                      Math.max(1, Math.min(32, n)),
                    );
                  }}
                >
                  <Label>未固定 token</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Select
                  className="w-full flex"
                  selectedKey={
                    config.vad_backend === "energy"
                      ? "energy"
                      : config.vad_backend === "silero"
                        ? "silero"
                        : "webrtc"
                  }
                  onSelectionChange={(key) => {
                    if (key == null) return;
                    updateConfig("vad_backend", String(key));
                  }}
                >
                  <Label>VAD 后端</Label>
                  <Select.Trigger className="flex items-center justify-between p-3">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox className="gap-2 p-2">
                      <ListBox.Item id="webrtc" textValue="WebRTC">
                        WebRTC
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="silero" textValue="Silero">
                        Silero
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="energy" textValue="Energy">
                        Energy
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_aggression ?? 2)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "vad_aggression",
                      Math.max(0, Math.min(3, n)),
                    );
                  }}
                >
                  <Label>灵敏度</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_min_silence_ms ?? 900)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig("vad_min_silence_ms", Math.max(400, n));
                  }}
                >
                  <Label>最短静音 ms</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_commit_hold_ms ?? 500)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig("vad_commit_hold_ms", Math.max(200, n));
                  }}
                >
                  <Label>提交等待 ms</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_min_segment_ms ?? 2500)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig("vad_min_segment_ms", Math.max(1000, n));
                  }}
                >
                  <Label>最短段 ms</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_max_segment_sec ?? 90)}
                  onChange={(value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "vad_max_segment_sec",
                      Math.max(10, Math.min(180, n)),
                    );
                  }}
                >
                  <Label>最长段 秒</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_overlap_ms ?? 500)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig("vad_overlap_ms", Math.max(200, n));
                  }}
                >
                  <Label>重叠 ms</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.cross_segment_prefix_tokens ?? 64)}
                  onChange={(value) => {
                    const n = Number.parseInt(value, 10);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "cross_segment_prefix_tokens",
                      Math.max(0, Math.min(256, n)),
                    );
                  }}
                >
                  <Label>跨段前缀</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              </div>

              {config.vad_backend === "energy" ? (
                <TextField
                  fullWidth
                  variant="secondary"
                  type="number"
                  value={String(config.vad_energy_threshold ?? 0.01)}
                  onChange={(value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    updateConfig(
                      "vad_energy_threshold",
                      Math.max(0.001, Math.min(0.05, n)),
                    );
                  }}
                >
                  <Label>能量阈值</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              ) : null}

              {!needsDownload ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={downloading}
                  onPress={() => void startDownload()}
                >
                  <Download size={14} />
                  重新下载
                </Button>
              ) : null}
            </div>
          </SoftCollapse>

          <Button
            fullWidth
            variant="primary"
            isPending={downloading || modelLoading || saving}
            className="btn-press"
            onPress={() => void primaryAction()}
          >
            {needsDownload ? <Download size={16} /> : <Save size={16} />}
            {primaryLabel}
          </Button>
          {savedHint ? (
            <p className="type-meta">{savedHint}</p>
          ) : null}
        </div>
      ) : null}
        </div>
      </SoftCollapse>

      {entries.length === 0 ? (
        <EmptyState
          title="还没有识别记录"
          description="Fn 开始"
          icon={<Mic size={18} />}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((entry, i) => {
            const showDiff = hasRefineDiff(entry.raw_text, entry.text);
            return (
              <Reveal key={entry.id} index={i}>
                <article className="rounded-2xl border border-border bg-surface px-4 py-3.5">
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 type-meta">
                    <span>
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                    <span>{entry.duration_seconds.toFixed(1)}s</span>
                    {entry.language ? <span>{entry.language}</span> : null}
                  </div>
                  {showDiff ? (
                    <RefineDiff
                      before={entry.raw_text}
                      after={entry.text}
                    />
                  ) : (
                    <p className="type-body whitespace-pre-wrap">
                      {entry.text || "（空）"}
                    </p>
                  )}
                </article>
              </Reveal>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
