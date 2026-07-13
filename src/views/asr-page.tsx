import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
  toast,
} from "@heroui/react";
import { Download, FolderOpen, Save } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import { LANGUAGES, QWEN_ASR_MODELS, providerLabel } from "@/lib/constants";
import {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadAligner, setDownloadAligner] = useState(false);

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

  return (
    <PageShell>
      <PageHeader title="ASR" />

      <p className="max-w-2xl text-[13px] text-muted">
        当前引擎：{providerLabel(config.asr_provider)}（在{" "}
        <Link to="/settings?tab=asr" className="text-accent hover:underline">
          设置 → ASR
        </Link>{" "}
        切换）
      </p>

      <SectionCard className="max-w-2xl flex flex-col gap-5">
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
      </SectionCard>

      {config.asr_provider === "elevenlabs" ? (
        <SectionCard className="max-w-2xl flex flex-col gap-5" title="ElevenLabs 型号">
          <TextField
            fullWidth
            variant="secondary"
            value={config.elevenlabs_model}
            onChange={(value) => updateConfig("elevenlabs_model", value)}
          >
            <Label>Model</Label>
            <Input placeholder="scribe_v2" />
          </TextField>
          <p className="text-[12px] text-muted">
            API Key 在{" "}
            <Link to="/settings?tab=asr" className="text-accent hover:underline">
              设置 → ASR
            </Link>
            。
          </p>
          <Button
            fullWidth
            variant="primary"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存
          </Button>
          {savedHint ? (
            <p className="text-[12px] text-muted">{savedHint}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {config.asr_provider === "apple" ? (
        <SectionCard className="max-w-2xl flex flex-col gap-4" title="Apple Speech">
          <p className="text-[13px] text-muted">
            使用系统语音识别，无需下载模型。请确认{" "}
            <Link
              to="/settings?tab=permissions"
              className="text-accent hover:underline"
            >
              设置 → 权限
            </Link>{" "}
            已授权麦克风与语音识别。
          </p>
          <Button
            fullWidth
            variant="primary"
            isPending={saving}
            onPress={() => void persist()}
          >
            <Save size={16} />
            保存
          </Button>
          {savedHint ? (
            <p className="text-[12px] text-muted">{savedHint}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {config.asr_provider === "qwen" ? (
        <>
          {needsDownload ? (
            <SectionCard
              className="max-w-2xl flex flex-col gap-4 border-accent/30"
              title="首次就绪：下载 Qwen 模型"
            >
              <p className="text-[13px] leading-relaxed text-muted">
                一键下载{" "}
                <span className="text-foreground">
                  {config.asr_model_id || "Qwen3-ASR-0.6B"}
                </span>
                （约 2GB，含 tokenizer.json）到 Application Support，完成后自动加载。
              </p>
              <label className="flex items-center gap-2 text-[13px] text-muted">
                <input
                  type="checkbox"
                  checked={downloadAligner}
                  onChange={(e) => setDownloadAligner(e.target.checked)}
                />
                同时下载 ForcedAligner（可选）
              </label>
              {downloading && progress ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-[12px] text-muted">
                    <span>
                      {progress.file}（{progress.file_index}/
                      {progress.file_count}）
                    </span>
                    <span>
                      {progress.percent != null
                        ? `${progress.percent.toFixed(0)}%`
                        : formatBytes(progress.downloaded)}
                      {progress.total
                        ? ` / ${formatBytes(progress.total)}`
                        : ""}
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
              <Button
                fullWidth
                variant="primary"
                isPending={downloading}
                onPress={() => void startDownload()}
              >
                <Download size={16} />
                {downloading ? "下载中…" : "一键下载并安装"}
              </Button>
            </SectionCard>
          ) : null}

          <SectionCard className="max-w-2xl flex flex-col gap-5" title="Qwen 本地">
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

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                isPending={downloading}
                onPress={() => void startDownload()}
              >
                <Download size={16} />
                {status?.installed ? "重新下载" : "下载并安装"}
              </Button>
              {status?.installed ? (
                <span className="self-center text-[12px] text-muted">
                  已安装 · {status.path}
                </span>
              ) : null}
            </div>

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

            <div className="grid grid-cols-2 gap-3">
              <TextField
                fullWidth
                variant="secondary"
                type="number"
                value={String(config.chunk_size_sec ?? 1.5)}
                onChange={(value) => {
                  const n = Number(value);
                  if (!Number.isFinite(n)) return;
                  updateConfig("chunk_size_sec", Math.max(0.2, Math.min(5, n)));
                }}
              >
                <Label>chunk_size_sec</Label>
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
                  updateConfig("unfixed_token_num", Math.max(1, Math.min(32, n)));
                }}
              >
                <Label>unfixed_token_num</Label>
                <Input className="font-mono text-[13px]" />
              </TextField>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-3">
              <p className="text-[12px] text-muted">
                流式切段（VAD）— 默认 WebRTC；噪声大可提高 aggression，远麦可改 Energy
              </p>
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
                  <Label>vad_backend</Label>
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
                        Silero (需 silero-vad feature)
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
                    updateConfig("vad_aggression", Math.max(0, Math.min(3, n)));
                  }}
                >
                  <Label>vad_aggression (0–3)</Label>
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
                  <Label>min_silence_ms</Label>
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
                  <Label>commit_hold_ms</Label>
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
                  <Label>min_segment_ms</Label>
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
                  <Label>max_segment_sec</Label>
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
                  <Label>overlap_ms</Label>
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
                  <Label>prefix_tokens (0=off)</Label>
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
                  <Label>energy_threshold</Label>
                  <Input className="font-mono text-[13px]" />
                </TextField>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                fullWidth
                variant="secondary"
                isPending={saving}
                onPress={() => void persist()}
              >
                <Save size={16} />
                保存
              </Button>
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
            {savedHint ? (
              <p className="text-[12px] text-muted">{savedHint}</p>
            ) : null}
          </SectionCard>
        </>
      ) : null}
    </PageShell>
  );
}
