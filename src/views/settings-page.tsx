import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Button,
  Checkbox,
  Input,
  InputGroup,
  Kbd,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cpu,
  Download,
  Ear,
  ExternalLink,
  FolderOpen,
  Keyboard,
  Mic,
  Monitor,
  Plus,
  RefreshCw,
  Save,
  Shield,
  SlidersHorizontal,
  Trash2,
  Wand2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  CollapseTrigger,
  PageHeader,
  PageShell,
  Reveal,
  SectionCard,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { cn } from "@/lib/cn";
import { useApp } from "@/app-context";
import {
  activateLlmProviderPatch,
  agentModelsFor,
  defaultConfig,
  hotkeySegments,
  listLlmProviders,
  llmPreset,
  llmProviderLabel,
  newCustomProviderId,
  LANGUAGES,
  QWEN_ASR_MODELS,
  resolveLlmCreds,
} from "@/lib/constants";
import { useFade } from "@/lib/motion";
import type {
  AgentKind,
  AgentProfile,
  AsrProvider,
  HotkeyBinding,
  LlmCredential,
  LlmProvider,
} from "@/types";
import {
  APP_RELEASES_URL,
  APP_REPO_URL,
  CHANGELOG,
  type ChangelogEntry,
} from "@/lib/changelog";
import { LlmPage } from "@/views/llm-page";
import { VocabularyPage } from "@/views/vocabulary-page";

type SettingsTab = "general" | "asr" | "polish" | "agent" | "system" | "updates";

type PolishSub = "config" | "refine" | "vocab";
type SystemSub = "hotkeys" | "permissions";

/**
 * Old 9-tab ids (pre-consolidation) map onto the new 6 product tabs, so
 * existing deep links (`?tab=refine`, tray menu events, in-app `<Link>`s)
 * keep landing on the right place instead of 404ing into 常规.
 */
const TAB_ALIASES: Record<string, { tab: SettingsTab; sub?: string }> = {
  llm: { tab: "polish", sub: "config" },
  refine: { tab: "polish", sub: "refine" },
  vocabulary: { tab: "polish", sub: "vocab" },
  hotkeys: { tab: "system", sub: "hotkeys" },
  permissions: { tab: "system", sub: "permissions" },
};

function resolveTabParam(raw: string | null): {
  tab: SettingsTab;
  sub?: string;
} {
  if (raw && TABS.some((t) => t.id === raw)) return { tab: raw as SettingsTab };
  if (raw && raw in TAB_ALIASES) return TAB_ALIASES[raw];
  return { tab: "general" };
}

type PermissionStatus = {
  accessibility: boolean;
  input_monitoring: boolean;
  microphone: boolean;
  speech_recognition: boolean;
  screen_recording: boolean;
  executable_path?: string;
  platform?: string;
  apple_speech_available?: boolean;
};

type PermissionRequestResult = {
  message: string;
  granted: boolean;
  open_settings: boolean;
};

type PermKind =
  | "accessibility"
  | "input_monitoring"
  | "microphone"
  | "speech_recognition"
  | "screen_recording";

type AppInfo = {
  version: string;
  name: string;
  platform?: string;
  executable_path?: string;
  apple_speech_available?: boolean;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type ReleaseInfo = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
};

type UpdateCheckResult = {
  current_version: string;
  update_available: boolean;
  latest: ReleaseInfo | null;
  asset: ReleaseAsset | null;
  releases: ReleaseInfo[];
};

type DownloadProgress = {
  downloaded: number;
  total: number | null;
  percent: number | null;
};

type DownloadInstallResult = {
  path: string;
  opened: boolean;
  message: string;
};

const TABS: { id: SettingsTab; label: string; icon: typeof Shield }[] = [
  { id: "general", label: "常规", icon: SlidersHorizontal },
  { id: "asr", label: "识别", icon: Mic },
  { id: "polish", label: "润色", icon: Wand2 },
  { id: "agent", label: "派活", icon: Bot },
  { id: "system", label: "系统", icon: Cpu },
  { id: "updates", label: "更新", icon: Download },
];

const POLISH_SUBS: { id: PolishSub; label: string }[] = [
  { id: "config", label: "配置" },
  { id: "refine", label: "纠错学习" },
  { id: "vocab", label: "词库" },
];

const SYSTEM_SUBS: { id: SystemSub; label: string }[] = [
  { id: "hotkeys", label: "快捷键" },
  { id: "permissions", label: "权限" },
];

const PERMS: {
  kind: PermKind;
  title: string;
  blurb: string;
  icon: typeof Shield;
}[] = [
  {
    kind: "accessibility",
    title: "辅助功能",
    blurb: "粘贴识别结果到其他应用",
    icon: Shield,
  },
  {
    kind: "input_monitoring",
    title: "输入监视",
    blurb: "全局快捷键（含 Fn）",
    icon: Keyboard,
  },
  {
    kind: "microphone",
    title: "麦克风",
    blurb: "录制外部声音",
    icon: Mic,
  },
  {
    kind: "speech_recognition",
    title: "语音识别",
    blurb: "Apple Speech 引擎",
    icon: Ear,
  },
  {
    kind: "screen_recording",
    title: "屏幕录制",
    blurb: "采集系统播放音频",
    icon: Monitor,
  },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared secondary (二级) tab row nested inside a merged settings tab. */
function SubTabs<T extends string>({
  items,
  active,
  onSelect,
}: {
  items: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  /** kept for call-site compatibility; no longer used. */
  layoutId?: string;
}) {
  return (
    <div className="set-subtabs" role="tablist">
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "true" : undefined}
            className={cn("set-subtab", isActive && "is-active")}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const resolved = resolveTabParam(searchParams.get("tab"));
  const [tab, setTab] = useState<SettingsTab>(resolved.tab);
  const [sub, setSub] = useState<string | undefined>(resolved.sub);

  // Old ids (?tab=refine etc.) resolve above; normalize the URL once so the
  // address reflects the canonical tab/sub instead of the retired alias.
  useEffect(() => {
    const raw = searchParams.get("tab");
    if (raw && !TABS.some((t) => t.id === raw) && raw in TAB_ALIASES) {
      const next = TAB_ALIASES[raw];
      const params: Record<string, string> = { tab: next.tab };
      if (next.sub) params.sub = next.sub;
      setSearchParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const resolvedNext = resolveTabParam(searchParams.get("tab"));
    if (resolvedNext.tab !== tab) setTab(resolvedNext.tab);
    const nextSub = searchParams.get("sub") ?? resolvedNext.sub;
    if (nextSub !== sub) setSub(nextSub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const selectTab = (id: SettingsTab) => {
    setTab(id);
    setSub(undefined);
    if (id === "general") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: id }, { replace: true });
    }
  };

  const selectSub = (nextSub: string) => {
    setSub(nextSub);
    setSearchParams({ tab, sub: nextSub }, { replace: true });
  };

  const fade = useFade();

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? "设置";

  return (
    <PageShell className="max-w-none!">
      <PageHeader title="设置" />

      {/* macOS System-Settings-style two-pane: left source list, right detail. */}
      <div className="set">
        <nav className="setnav" aria-label="设置分类">
          {TABS.map((item) => {
            const active = tab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "true" : undefined}
                className={cn("setnav-item", active && "setnav-item-active")}
                onClick={() => selectTab(item.id)}
              >
                <Icon size={15} className="setnav-icon" aria-hidden />
                <span className="relative z-10">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="setbody">
          <h2 className="set-sechead">{activeLabel}</h2>
          <motion.div
            key={tab}
            initial={fade.initial}
            animate={fade.animate}
            transition={fade.transition}
            style={{ willChange: "opacity" }}
          >
            {tab === "general" ? <GeneralPanel /> : null}
            {tab === "asr" ? <AsrProviderPanel /> : null}
            {tab === "polish" ? (
              <PolishPanel
                sub={POLISH_SUBS.some((s) => s.id === sub) ? (sub as PolishSub) : "config"}
                onSelectSub={selectSub}
              />
            ) : null}
            {tab === "agent" ? <AgentPanel /> : null}
            {tab === "system" ? (
              <SystemPanel
                sub={SYSTEM_SUBS.some((s) => s.id === sub) ? (sub as SystemSub) : "hotkeys"}
                onSelectSub={selectSub}
              />
            ) : null}
            {tab === "updates" ? <UpdatesPanel /> : null}
          </motion.div>
        </div>
      </div>
    </PageShell>
  );
}

/** 润色 — LLM 凭证 + 纠错学习 + 词库 as 二级 sub-sections (one product tab, not three). */
function PolishPanel({
  sub,
  onSelectSub,
}: {
  sub: PolishSub;
  onSelectSub: (id: string) => void;
}) {
  const fade = useFade();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <SubTabs
        items={POLISH_SUBS}
        active={sub}
        onSelect={onSelectSub}
        layoutId="polish-sub-tabs"
      />
      <motion.div
        key={sub}
        initial={fade.initial}
        animate={fade.animate}
        transition={fade.transition}
        style={{ willChange: "opacity" }}
      >
        {sub === "config" ? <LlmProviderPanel /> : null}
        {sub === "refine" ? <LlmPage embedded /> : null}
        {sub === "vocab" ? <VocabularyPage embedded /> : null}
      </motion.div>
    </div>
  );
}

/** 系统 — 快捷键 + 权限 as 二级 sub-sections. */
function SystemPanel({
  sub,
  onSelectSub,
}: {
  sub: SystemSub;
  onSelectSub: (id: string) => void;
}) {
  const fade = useFade();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <SubTabs
        items={SYSTEM_SUBS}
        active={sub}
        onSelect={onSelectSub}
        layoutId="system-sub-tabs"
      />
      <motion.div
        key={sub}
        initial={fade.initial}
        animate={fade.animate}
        transition={fade.transition}
        style={{ willChange: "opacity" }}
      >
        {sub === "hotkeys" ? <HotkeysPanel /> : null}
        {sub === "permissions" ? <PermissionsPanel /> : null}
      </motion.div>
    </div>
  );
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

function AsrProviderPanel() {
  const { config, updateConfig, saveConfig, chooseModelDir, loadModel } =
    useApp();
  const [appleAvailable, setAppleAvailable] = useState(true);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadAligner, setDownloadAligner] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    void invoke<{ apple_speech_available?: boolean; platform?: string }>(
      "get_app_info",
    )
      .then((info) => {
        const ok = info.apple_speech_available ?? info.platform === "macos";
        setAppleAvailable(ok);
        if (!ok && config.asr_provider === "apple") {
          updateConfig("asr_provider", "elevenlabs");
        }
      })
      .catch(() => setAppleAvailable(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    let unlisten: (() => void) | undefined;
    void listen<ModelDownloadProgress>("model-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (config.asr_provider === "qwen") void refreshStatus();
  }, [config.asr_provider, config.asr_model_dir, refreshStatus]);

  const selectProvider = (next: AsrProvider) => {
    if (next === "apple" && !appleAvailable) return;
    updateConfig("asr_provider", next);
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

  const alignReady = Boolean(config.align_model_dir?.trim());

  const isQwen = config.asr_provider === "qwen";

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Reveal index={0}>
      <SectionCard className="flex flex-col gap-5">
        <Select
          className="w-full flex"
          selectedKey={config.asr_provider}
          onSelectionChange={(key) => {
            if (key == null) return;
            selectProvider(String(key) as AsrProvider);
          }}
        >
          <Label>识别引擎</Label>
          <Select.Trigger className="flex items-center justify-between p-4">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="gap-3 p-3">
              {appleAvailable ? (
                <ListBox.Item id="apple" textValue="Apple Speech">
                  Apple Speech
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ) : null}
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

        {config.asr_provider === "elevenlabs" ? (
          <TextField
            fullWidth
            variant="secondary"
            type="password"
            value={config.elevenlabs_api_key}
            onChange={(value) => updateConfig("elevenlabs_api_key", value)}
          >
            <Label>API Key</Label>
            <Input />
          </TextField>
        ) : null}

        {config.asr_provider === "apple" ? (
          <p className="type-meta">系统语音识别，无需额外配置。</p>
        ) : null}

        {isQwen ? (
          <>
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
              <p className="-mt-2 truncate type-meta">
                <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-success">
                  已安装
                </span>{" "}
                {status.path}
              </p>
            ) : null}

            <div className="settings-switchrow">
              <Switch
                isSelected={alignReady && config.align_enabled}
                isDisabled={!alignReady}
                onChange={(value) => updateConfig("align_enabled", value)}
              >
                <Switch.Content className="w-full justify-between gap-2 p-3">
                  <div className="min-w-0 pr-2">
                    <div className="type-ui">逐字对齐</div>
                    <div className="mt-0.5 type-meta">
                      {alignReady
                        ? "字级时间戳 · 已配置"
                        : "在下方高级设置配置对齐模型目录后可用"}
                    </div>
                  </div>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>
          </>
        ) : null}
      </SectionCard>
      </Reveal>

      {isQwen ? (
        <Reveal index={1}>
        <SectionCard className="flex flex-col gap-3">
          <CollapseTrigger
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
          >
            模型目录与高级参数
          </CollapseTrigger>
          {!advancedOpen ? (
            <p className="-mt-1 type-meta">
              模型 / 对齐目录、VAD 后端与分段参数收在此处 · 多数用户无需调整。
            </p>
          ) : null}
          <SoftCollapse open={advancedOpen}>
            <div className="flex flex-col gap-5 pt-1">
              {downloading && progress ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between type-meta">
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

              <Checkbox
                isSelected={downloadAligner}
                onChange={setDownloadAligner}
              >
                <Checkbox.Content className="flex items-center gap-2 type-meta">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  下载时一并获取逐字对齐模型（ForcedAligner）
                </Checkbox.Content>
              </Checkbox>

              <TextField
                fullWidth
                variant="secondary"
                value={config.align_model_dir ?? ""}
                onChange={(value) => updateConfig("align_model_dir", value)}
              >
                <Label>对齐模型目录</Label>
                <Input className="min-w-0 flex items-center font-mono text-[13px]" />
              </TextField>

              <VadAdvancedFields config={config} updateConfig={updateConfig} />
            </div>
          </SoftCollapse>
        </SectionCard>
        </Reveal>
      ) : null}

      <div className="form-actions">
        {isQwen ? (
          <div className="form-actions-secondary">
            <Button
              size="sm"
              variant="secondary"
              isPending={downloading}
              onPress={() => void startDownload()}
            >
              <Download size={14} />
              {status?.needs_download ?? true ? "下载模型" : "重新下载"}
            </Button>
          </div>
        ) : null}
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          保存
        </Button>
      </div>
    </div>
  );
}

function VadAdvancedFields({
  config,
  updateConfig,
}: {
  config: ReturnType<typeof useApp>["config"];
  updateConfig: ReturnType<typeof useApp>["updateConfig"];
}) {
  return (
    <div className="flex flex-col gap-3 pt-1">
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
            updateConfig("unfixed_token_num", Math.max(1, Math.min(32, n)));
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
            updateConfig("vad_aggression", Math.max(0, Math.min(3, n)));
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
            updateConfig("vad_max_segment_sec", Math.max(10, Math.min(180, n)));
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
    </div>
  );
}

function LlmProviderPanel() {
  const { config, updateConfig, saveConfig } = useApp();
  // Which provider's editor is open. null = collapsed list (no flat form).
  const [openId, setOpenId] = useState<LlmProvider | null>(null);

  const providers = listLlmProviders(config);

  const patchCreds = (
    provider: LlmProvider,
    patch: Partial<LlmCredential>,
  ) => {
    const nextCred = { ...resolveLlmCreds(config, provider), ...patch };
    updateConfig("llm_credentials", {
      ...config.llm_credentials,
      [provider]: nextCred,
    });
    // Mirror into flat fields the backend reads when editing the active provider.
    if (provider === config.llm_provider) {
      if (patch.api_base_url !== undefined) {
        updateConfig("llm_api_base_url", nextCred.api_base_url);
      }
      if (patch.api_key !== undefined) {
        updateConfig("llm_api_key", nextCred.api_key);
      }
      if (patch.model !== undefined) {
        updateConfig("llm_model", nextCred.model);
      }
    }
  };

  const activate = (provider: LlmProvider) => {
    const patch = activateLlmProviderPatch(config, provider);
    updateConfig("llm_provider", patch.llm_provider);
    updateConfig("llm_api_base_url", patch.llm_api_base_url);
    updateConfig("llm_api_key", patch.llm_api_key);
    updateConfig("llm_model", patch.llm_model);
    void saveConfig(
      {
        ...config,
        ...patch,
      },
      { silent: true },
    );
    toast.success(`已设为当前 · ${llmProviderLabel(config, provider)}`);
  };

  const resetBuiltin = (provider: LlmProvider) => {
    const rest = { ...config.llm_credentials };
    delete rest[provider];
    updateConfig("llm_credentials", rest);
    void saveConfig({ ...config, llm_credentials: rest }, { silent: true });
    toast.success("已重置该服务商");
  };

  const deleteCustom = (provider: LlmProvider) => {
    if (!window.confirm("删除该自定义服务商？")) return;
    const rest = { ...config.llm_credentials };
    delete rest[provider];
    const next = { ...config, llm_credentials: rest };
    // Fall back to OpenAI if the deleted provider was current.
    if (provider === config.llm_provider) {
      Object.assign(next, activateLlmProviderPatch(next, "openai"));
    }
    void saveConfig(next, { silent: true });
    updateConfig("llm_credentials", rest);
    if (provider === config.llm_provider) {
      updateConfig("llm_provider", next.llm_provider);
      updateConfig("llm_api_base_url", next.llm_api_base_url);
      updateConfig("llm_api_key", next.llm_api_key);
      updateConfig("llm_model", next.llm_model);
    }
    if (openId === provider) setOpenId(null);
    toast.success("已删除");
  };

  const addProvider = () => {
    const id = newCustomProviderId();
    updateConfig("llm_credentials", {
      ...config.llm_credentials,
      [id]: { api_base_url: "", api_key: "", model: "", label: "新服务商" },
    });
    setOpenId(id);
  };

  const save = () => {
    void saveConfig();
    toast.success("已保存");
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <SectionCard className="flex flex-col gap-4">
        <div className="settings-switchrow">
          <Switch
            isSelected={config.llm_enabled}
            onChange={(value) => updateConfig("llm_enabled", value)}
          >
            <Switch.Content className="w-full justify-between gap-2 p-3">
              <div className="min-w-0 pr-2">
                <div className="type-ui">启用纠错</div>
                <div className="mt-0.5 type-meta">
                  用所选服务商润色识别稿 · 关闭则出原始识别文字
                </div>
              </div>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </SectionCard>

      <SectionCard className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="type-section">服务商</h2>
          <span className="type-meta">点开编辑 · 设为当前</span>
        </div>

        <div className="set-rows">
          {providers.map((p) => {
            const isCur = p.id === config.llm_provider;
            const isOpen = openId === p.id;
            const local = p.id === "ollama";
            const stored = config.llm_credentials?.[p.id];
            const hasKey = Boolean(stored?.api_key?.trim());
            const rc = resolveLlmCreds(config, p.id);
            const badge = isCur
              ? "当前"
              : local
                ? "本地"
                : hasKey
                  ? "有 Key"
                  : "未配";
            return (
              <div key={p.id} className={cn("set-row-wrap", isOpen && "is-open")}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className={cn("set-row text-left", isOpen && "is-active")}
                  onClick={() => setOpenId(isOpen ? null : p.id)}
                >
                  <div className="set-row-body">
                    <div className="set-row-meta">
                      {p.label}
                      {isCur ? (
                        <span className="set-row-tag">· 当前</span>
                      ) : null}
                    </div>
                    <div className="set-row-sub">
                      {rc.api_base_url || "未设置地址"}
                      {rc.model ? ` · ${rc.model}` : ""}
                    </div>
                  </div>
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "type-micro rounded-md px-1.5 py-0.5",
                        isCur
                          ? "bg-accent-soft text-accent-soft-foreground"
                          : local || hasKey
                            ? "bg-success/10 text-success"
                            : "bg-default/60 text-muted",
                      )}
                    >
                      {badge}
                    </span>
                    <ChevronDown
                      size={15}
                      className={cn(
                        "shrink-0 text-muted transition-transform duration-200",
                        isOpen && "rotate-180",
                      )}
                    />
                  </span>
                </button>

                <SoftCollapse open={isOpen}>
                  <ProviderEditor
                    provider={p.id}
                    builtin={p.builtin}
                    isCurrent={isCur}
                    config={config}
                    onPatch={(patch) => patchCreds(p.id, patch)}
                    onActivate={() => activate(p.id)}
                    onSave={save}
                    onReset={() => resetBuiltin(p.id)}
                    onDelete={() => deleteCustom(p.id)}
                  />
                </SoftCollapse>
              </div>
            );
          })}
        </div>

        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onPress={addProvider}
        >
          <Plus size={14} />
          添加服务商
        </Button>
      </SectionCard>
    </div>
  );
}

function ProviderEditor({
  provider,
  builtin,
  isCurrent,
  config,
  onPatch,
  onActivate,
  onSave,
  onReset,
  onDelete,
}: {
  provider: LlmProvider;
  builtin: boolean;
  isCurrent: boolean;
  config: ReturnType<typeof useApp>["config"];
  onPatch: (patch: Partial<LlmCredential>) => void;
  onActivate: () => void;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const creds = resolveLlmCreds(config, provider);
  const preset = llmPreset(provider);

  return (
    <div className="flex flex-col gap-4 px-3 pb-4 pt-3">
      {!builtin ? (
        <TextField
          fullWidth
          variant="secondary"
          value={creds.label ?? ""}
          onChange={(value) => onPatch({ label: value })}
        >
          <Label>名称</Label>
          <Input placeholder="自定义服务商名称" />
        </TextField>
      ) : null}

      <TextField
        fullWidth
        variant="secondary"
        value={creds.api_base_url}
        onChange={(value) => onPatch({ api_base_url: value })}
      >
        <Label>API Base URL</Label>
        <Input placeholder="https://api.openai.com/v1" />
      </TextField>

      <TextField
        fullWidth
        variant="secondary"
        type="password"
        value={creds.api_key}
        onChange={(value) => onPatch({ api_key: value })}
      >
        <Label>API Key</Label>
        <Input placeholder="可留空（Ollama 等本地服务）" />
      </TextField>

      <TextField
        fullWidth
        variant="secondary"
        value={creds.model}
        onChange={(value) => onPatch({ model: value })}
      >
        <Label>模型</Label>
        <Input
          placeholder={preset.models[0] ?? "模型名称"}
          className="font-mono text-[13px]"
        />
      </TextField>
      {preset.models.length > 0 ? (
        <div className="-mt-1 flex flex-wrap gap-1.5">
          {preset.models.map((m) => (
            <button
              key={m}
              type="button"
              className="rounded-md border border-border bg-surface-secondary px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-foreground/20 hover:text-foreground"
              onClick={() => onPatch({ model: m })}
            >
              {m}
            </button>
          ))}
        </div>
      ) : null}

      <div className="form-actions">
        <div className="form-actions-secondary flex gap-2">
          {!isCurrent ? (
            <Button size="sm" variant="secondary" onPress={onActivate}>
              设为当前
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted hover:text-danger data-[hovered=true]:text-danger"
            onPress={builtin ? onReset : onDelete}
          >
            <Trash2 size={14} />
            {builtin ? "重置" : "删除"}
          </Button>
        </div>
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={onSave}
        >
          <Save size={16} />
          保存
        </Button>
      </div>
    </div>
  );
}

function GeneralPanel() {
  const { config, updateConfig, saveConfig } = useApp();

  return (
    <SectionCard className="max-w-2xl flex flex-col gap-6">
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

      <div className="flex flex-col gap-2.5">
        <div className="type-ui">录音源</div>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="录音源">
          {(
            [
              { id: "external" as const, title: "只录外部" },
              { id: "system" as const, title: "只录系统" },
              { id: "both" as const, title: "两者都录" },
            ] as const
          ).map((item) => {
            const active =
              (config.audio_capture_mode ?? "external") === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={cn(
                  "w-full rounded-[10px] border px-3.5 py-3 text-left text-sm font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-surface-secondary text-foreground"
                    : "border-border text-muted hover:border-foreground/15 hover:bg-surface-secondary/60",
                )}
                onClick={() => updateConfig("audio_capture_mode", item.id)}
              >
                {item.title}
              </button>
            );
          })}
        </div>
      </div>

      <Button fullWidth variant="primary" onPress={() => void saveConfig()}>
        <Save size={16} />
        保存
      </Button>
    </SectionCard>
  );
}

function HotkeysPanel() {
  const { config, updateConfig } = useApp();
  const [listening, setListening] = useState<
    null | "transcribe" | "translate" | "cancel" | "agent"
  >(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<{
        slot: string;
        binding: HotkeyBinding;
      }>("hotkey-captured", (event) => {
        const { slot, binding } = event.payload;
        if (slot === "transcribe") updateConfig("hotkey_transcribe", binding);
        if (slot === "translate") updateConfig("hotkey_translate", binding);
        if (slot === "cancel") updateConfig("hotkey_cancel", binding);
        if (slot === "agent") updateConfig("hotkey_agent", binding);
        setListening(null);
        setPreview(null);
        toast.success(`已设置：${binding.label}`);
      }),
      listen("hotkey-capture-cancelled", () => {
        setListening(null);
        setPreview(null);
      }),
      listen<{ label: string }>("hotkey-capture-preview", (event) => {
        setPreview(event.payload.label);
      }),
    ]).then((items) => {
      if (disposed) {
        items.forEach((u) => u());
        return;
      }
      unlisteners.push(...items);
    });
    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
      void invoke("cancel_hotkey_capture").catch(() => {});
    };
  }, [updateConfig]);

  const startCapture = async (
    slot: "transcribe" | "translate" | "cancel" | "agent",
  ) => {
    try {
      setPreview(null);
      await invoke("begin_hotkey_capture", { slot });
      setListening(slot);
    } catch (error) {
      toast.danger(`无法开始录制快捷键: ${error}`);
    }
  };

  const abortCapture = async () => {
    try {
      await invoke("cancel_hotkey_capture");
    } catch {
      /* ignore */
    }
    setListening(null);
    setPreview(null);
  };

  const rows: {
    slot: "transcribe" | "translate" | "cancel" | "agent";
    title: string;
    binding: HotkeyBinding;
  }[] = [
    {
      slot: "transcribe",
      title: "出稿",
      binding: config.hotkey_transcribe,
    },
    {
      slot: "translate",
      title: "翻译",
      binding: config.hotkey_translate,
    },
    {
      slot: "agent",
      title: "派活",
      binding: config.hotkey_agent ?? {
        key: "49",
        modifiers: ["fn"],
        label: "Fn+Space",
      },
    },
    {
      slot: "cancel",
      title: "取消",
      binding: config.hotkey_cancel,
    },
  ];

  return (
    <>
      <SectionCard className="max-w-2xl flex flex-col gap-4" title="全局快捷键">
        <div className="flex flex-col gap-3">
          {rows.map((row) => {
            const active = listening === row.slot;
            return (
              <div
                key={row.slot}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-default/30 px-3.5 py-3"
              >
                <div className="min-w-0 text-sm font-medium text-foreground">
                  {row.title}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {active ? (
                    <>
                      <span className="text-[12px] text-accent">
                        {preview ? `松键确认：${preview}` : "按下组合键…"}
                      </span>
                      <Button size="sm" variant="secondary" onPress={() => void abortCapture()}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="inline-flex h-auto min-h-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-foreground shadow-none transition hover:border-foreground/25 hover:bg-default data-[hovered=true]:border-foreground/25 data-[hovered=true]:bg-default"
                      aria-label={`修改快捷键：${row.title}`}
                      onPress={() => void startCapture(row.slot)}
                    >
                      {hotkeySegments(row.binding.label).map((part, i) => (
                        <span key={`${row.slot}-${part}-${i}`} className="inline-flex items-center gap-1">
                          {i > 0 ? <span className="text-muted">+</span> : null}
                          <Kbd>{part}</Kbd>
                        </span>
                      ))}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

  
    </>
  );
}

function PermissionsPanel() {
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const lastOpenAt = useRef<Record<string, number>>({});

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

  const openSettingsOnce = async (kind: PermKind) => {
    const now = Date.now();
    const prev = lastOpenAt.current[kind] ?? 0;
    // Avoid stacking System Settings activations from rapid clicks.
    if (now - prev < 4000) {
      setHint("系统设置已打开，请在对应开关中开启本应用。");
      return;
    }
    lastOpenAt.current[kind] = now;
    await invoke("open_permission_settings", { kind });
  };

  const authorize = async (kind: PermKind) => {
    if (busy) return;
    setBusy(kind);
    setHint(null);
    try {
      const result = await invoke<PermissionRequestResult>("request_permission", {
        kind,
      });
      setHint(result.message);
      // Only open Settings when the OS dialog cannot finish the grant
      // (e.g. mic/speech previously denied). Never stack on top of Apple prompts.
      if (result.open_settings) {
        await openSettingsOnce(kind);
      }
      window.setTimeout(() => void refresh(), 1200);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const isMac = (perms?.platform ?? "macos") === "macos";
  const exePath = perms?.executable_path;
  const firstUngranted = PERMS.find((item) => !(perms?.[item.kind] ?? false))
    ?.kind;

  if (!isMac) {
    return (
      <SectionCard title="系统权限" className="max-w-2xl">
        <p className="type-meta">当前平台无需 macOS 隐私权限。</p>
      </SectionCard>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <SectionCard title="系统权限">
        <div>
          {PERMS.map((item) => {
            const granted = perms?.[item.kind] ?? false;
            const Icon = item.icon;
            const isPrimaryCta = !granted && item.kind === firstUngranted;
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
                  <div className="type-ui">{item.title}</div>
                  <div className="mt-0.5 type-meta">{item.blurb}</div>
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
                      variant={isPrimaryCta ? "primary" : "secondary"}
                      className={isPrimaryCta ? "btn-press" : undefined}
                      isDisabled={busy !== null}
                      onPress={() => void authorize(item.kind)}
                    >
                      去授权
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {hint ? (
          <p className="mt-3 whitespace-pre-wrap type-meta">{hint}</p>
        ) : null}
      </SectionCard>

      <div className="rounded-2xl border border-border bg-surface px-3 py-1">
        <CollapseTrigger
          open={helpOpen}
          onToggle={() => setHelpOpen((v) => !v)}
        >
          说明
        </CollapseTrigger>
        <SoftCollapse open={helpOpen}>
          <div className="border-t border-border px-1 pb-3 pt-2">
            <ul className="flex flex-col gap-2 type-meta">
              <li>· 签名安装包权限随 Bundle ID 保留</li>
              <li>· 辅助功能 / 输入监视按可执行路径</li>
            </ul>
            {exePath ? (
              <p className="mt-3 break-all rounded-xl border border-border bg-default/40 px-3 py-2 font-mono type-micro !normal-case !tracking-normal text-foreground">
                {exePath}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onPress={() =>
                void openSettingsOnce("accessibility").then(() =>
                  window.setTimeout(() => void refresh(), 800),
                )
              }
            >
              <ExternalLink size={14} />
              打开系统设置
            </Button>
          </div>
        </SoftCollapse>
      </div>
    </div>
  );
}

function UpdatesPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  useEffect(() => {
    void invoke<AppInfo>("get_app_info")
      .then(setInfo)
      .catch(() => setInfo({ version: "0.1.0", name: "言落" }));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgress>("update-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    setInstallMessage(null);
    try {
      const result = await invoke<UpdateCheckResult>("check_for_update");
      setCheck(result);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Defer so the Updates tab paints before the network call starts.
    const id = window.setTimeout(() => {
      void checkUpdates();
    }, 50);
    return () => window.clearTimeout(id);
  }, [checkUpdates]);

  const downloadAndInstall = useCallback(async () => {
    const asset = check?.asset;
    if (!asset) return;
    setDownloading(true);
    setProgress({ downloaded: 0, total: asset.size || null, percent: 0 });
    setInstallMessage(null);
    try {
      const result = await invoke<DownloadInstallResult>(
        "download_and_install_update",
        {
          url: asset.browser_download_url,
          filename: asset.name,
        },
      );
      setInstallMessage(result.message);
      toast.success(result.message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setInstallMessage(msg);
      toast.danger(`下载失败: ${msg}`);
    } finally {
      setDownloading(false);
    }
  }, [check?.asset]);

  const current = check?.current_version ?? info?.version ?? "0.1.0";
  const updateAvailable = check?.update_available === true;
  const latest = check?.latest ?? null;
  const asset = check?.asset ?? null;

  const logEntries: ChangelogEntry[] =
    check && check.releases.length > 0
      ? check.releases.map((r) => ({
          version: r.tag_name.replace(/^v/i, ""),
          date: r.published_at ? r.published_at.slice(0, 10) : "",
          notes: (r.body || r.name || "无说明")
            .split("\n")
            .map((line) => line.replace(/^[-*#\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, 8),
        }))
      : CHANGELOG;

  const percent = progress?.percent ?? null;

  return (
    <>
      <SectionCard className="max-w-2xl flex flex-col gap-4" title="当前版本">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {info?.name ?? "言落"}{" "}
              <span className="text-muted">v{current}</span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {updateAvailable
                ? `发现新版本 ${latest?.tag_name}${asset ? ` · ${asset.name}` : ""}`
                : checking
                  ? "正在检查更新…"
                  : "已是最新，或尚未发布远程版本。"}
            </p>
            {asset && updateAvailable ? (
              <p className="mt-1 text-[11px] text-muted">
                安装包约 {formatBytes(asset.size)}
              </p>
            ) : null}
            {checkError ? (
              <p className="mt-1 text-[12px]" style={{ color: "var(--danger)" }}>
                检查失败：{checkError}（仍显示本地更新说明）
              </p>
            ) : null}
            {installMessage ? (
              <p className="mt-1 text-[12px] text-muted">{installMessage}</p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={checking || downloading}
            onPress={() => void checkUpdates()}
          >
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
            检查更新
          </Button>
        </div>

        {downloading ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] text-muted">
              <span>正在下载安装包…</span>
              <span>
                {percent != null
                  ? `${percent.toFixed(0)}%`
                  : progress
                    ? formatBytes(progress.downloaded)
                    : ""}
                {progress?.total
                  ? ` / ${formatBytes(progress.total)}`
                  : ""}
              </span>
            </div>
            <div className="update-progress-track">
              <div
                className="update-progress-bar"
                style={{
                  width:
                    percent != null
                      ? `${Math.min(100, Math.max(0, percent))}%`
                      : "30%",
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {updateAvailable && asset ? (
            <Button
              size="sm"
              variant="primary"
              isDisabled={downloading}
              onPress={() => void downloadAndInstall()}
            >
              <Download size={14} />
              {downloading ? "下载中…" : `下载并安装 ${latest?.tag_name}`}
            </Button>
          ) : null}
          {updateAvailable && latest && !asset ? (
            <Button
              size="sm"
              variant="primary"
              onPress={() => void open(latest.html_url)}
            >
              <ExternalLink size={14} />
              打开 Release 页下载
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            isDisabled={downloading}
            onPress={() =>
              void invoke("open_update_download_dir").catch((error) => {
                toast.danger(
                  `无法打开下载目录: ${error instanceof Error ? error.message : String(error)}`,
                );
              })
            }
          >
            <FolderOpen size={14} />
            下载目录
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => void open(APP_RELEASES_URL)}
          >
            <ExternalLink size={14} />
            Releases
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => void open(APP_REPO_URL)}
          >
            <ExternalLink size={14} />
            仓库
          </Button>
        </div>
      </SectionCard>

      <SectionCard className="max-w-2xl" title="更新说明">
        <div className="flex flex-col gap-5">
          {logEntries.map((entry) => (
            <article key={`${entry.version}-${entry.date}`} className="release-entry">
              <header className="mb-2 flex items-baseline gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  v{entry.version}
                </h3>
                {entry.date ? (
                  <time className="text-[11px] text-muted">{entry.date}</time>
                ) : null}
              </header>
              <ul className="flex flex-col gap-1.5">
                {entry.notes.map((note, i) => (
                  <li
                    key={`${entry.version}-${i}`}
                    className="text-[13px] leading-relaxed text-muted before:mr-2 before:content-['·']"
                  >
                    {note}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </SectionCard>
    </>
  );
}

type DetectedBins = {
  claude: string | null;
  codex: string | null;
  pi: string | null;
};

function detectedForKind(
  detected: DetectedBins,
  kind: AgentKind,
): string | null {
  if (kind === "codex") return detected.codex;
  if (kind === "pi") return detected.pi;
  return detected.claude;
}

function shortBin(path: string): string {
  if (!path) return "未设置";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

const BUILTIN_AGENTS: { kind: AgentKind; name: string; desc: string }[] = [
  { kind: "claude", name: "Claude", desc: "Anthropic CLI" },
  { kind: "codex", name: "Codex", desc: "OpenAI CLI" },
  { kind: "pi", name: "Pi", desc: "Pi CLI" },
];

function AgentPanel() {
  const { config, updateConfig, saveConfig, agentModels, refreshAgentModels } =
    useApp();
  const [detected, setDetected] = useState<DetectedBins>({
    claude: null,
    codex: null,
    pi: null,
  });
  const [detecting, setDetecting] = useState(false);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);

  const profiles = config.agent_profiles?.length
    ? config.agent_profiles
    : defaultConfig.agent_profiles;

  useEffect(() => {
    void refreshDetect();
    void refreshAgentModels(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDetect = async () => {
    setDetecting(true);
    try {
      setDetected(await invoke<DetectedBins>("detect_agent_bins"));
    } catch {
      /* ignore */
    } finally {
      setDetecting(false);
    }
  };

  const whichBin = async (id: string, kind: AgentKind) => {
    setDetecting(true);
    try {
      const bins = await invoke<DetectedBins>("detect_agent_bins");
      setDetected(bins);
      const hit = detectedForKind(bins, kind);
      if (hit) {
        patchProfile(id, { bin: hit });
      } else {
        toast.warning(`未找到 ${kind}`);
      }
    } catch (e) {
      toast.danger(`which 失败: ${e}`);
    } finally {
      setDetecting(false);
    }
  };

  const refreshModels = async () => {
    setModelsRefreshing(true);
    try {
      await refreshAgentModels(true);
      toast.success("模型列表已刷新");
    } catch (e) {
      toast.danger(`刷新失败: ${e}`);
    } finally {
      setModelsRefreshing(false);
    }
  };

  const persistProfiles = (next: AgentProfile[]) => {
    updateConfig("agent_profiles", next);
    void saveConfig({ ...config, agent_profiles: next }, { silent: true });
  };

  const patchProfile = (id: string, patch: Partial<AgentProfile>) => {
    persistProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const setDefaultAgent = (profile: AgentProfile) => {
    updateConfig("agent_profile_id", profile.id);
    updateConfig("agent_kind", profile.kind);
    void saveConfig(
      { ...config, agent_profile_id: profile.id, agent_kind: profile.kind },
      { silent: true },
    );
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="-mb-1 type-meta">
        言落内置支持 Claude · Codex · Pi 三种 CLI。填好路径与默认模型，选一个作为默认派活 Agent。
      </p>

      {BUILTIN_AGENTS.map((meta, idx) => {
        const p =
          profiles.find((x) => x.kind === meta.kind) ??
          (defaultConfig.agent_profiles.find(
            (x) => x.kind === meta.kind,
          ) as AgentProfile);
        const hit = detectedForKind(detected, meta.kind);
        const configured = Boolean((p.bin ?? "").trim() || hit);
        const isDefault = config.agent_profile_id === p.id;
        const models = agentModelsFor(meta.kind, agentModels);
        const modelKey = models.some((m) => m.id === (p.model ?? ""))
          ? p.model || "__default__"
          : p.model
            ? p.model
            : "__default__";
        return (
          <Reveal key={meta.kind} index={idx}>
          <SectionCard className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="type-section">
                  {meta.name}
                  <span className="ml-2 type-meta font-normal">{meta.desc}</span>
                </div>
                <div className="mt-0.5 type-meta">
                  {configured ? (
                    <span className="text-success-soft-foreground">
                      已检测到路径
                    </span>
                  ) : (
                    <span className="text-muted">未检测到路径</span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant={isDefault ? "primary" : "secondary"}
                isDisabled={isDefault}
                onPress={() => setDefaultAgent(p)}
              >
                {isDefault ? "默认" : "设为默认"}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-end gap-1">
                <Select
                  className="min-w-0 flex-1"
                  selectedKey={modelKey}
                  onSelectionChange={(key) => {
                    if (key == null) return;
                    const model =
                      String(key) === "__default__" ? "" : String(key);
                    patchProfile(p.id, { model });
                  }}
                >
                  <Label>默认模型</Label>
                  <Select.Trigger className="flex items-center justify-between">
                    <Select.Value>
                      {() => {
                        const cur = p.model ?? "";
                        const opt = models.find((m) => m.id === cur);
                        return (
                          <span className="truncate">
                            {opt?.label ?? (cur || "默认")}
                          </span>
                        );
                      }}
                    </Select.Value>
                    <ChevronDown size={12} className="shrink-0 opacity-50" />
                  </Select.Trigger>
                  <Select.Popover className="min-w-40">
                    <ListBox>
                      {models.map((m) => (
                        <ListBox.Item
                          key={m.id || "__default__"}
                          id={m.id || "__default__"}
                          textValue={m.label}
                        >
                          <span>{m.label}</span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                      {p.model && !models.some((m) => m.id === p.model) ? (
                        <ListBox.Item id={p.model} textValue={p.model}>
                          <span>{p.model}</span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ) : null}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <Button
                  isIconOnly
                  variant="secondary"
                  className="mb-0.5 h-8 w-8 min-h-8 min-w-8 shrink-0"
                  aria-label="刷新模型列表"
                  isDisabled={modelsRefreshing}
                  onPress={() => void refreshModels()}
                >
                  <RefreshCw
                    size={13}
                    className={modelsRefreshing ? "animate-spin" : ""}
                  />
                </Button>
              </div>

              <TextField
                value={p.bin ?? ""}
                onChange={(v) => patchProfile(p.id, { bin: v })}
              >
                <Label>路径</Label>
                <InputGroup>
                  <InputGroup.Prefix className="pl-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 min-h-7 gap-1 rounded-md px-2 text-[11px] font-medium"
                      isDisabled={detecting}
                      onPress={() => void whichBin(p.id, meta.kind)}
                    >
                      <RefreshCw
                        size={11}
                        className={detecting ? "animate-spin" : ""}
                      />
                      which
                    </Button>
                  </InputGroup.Prefix>
                  <InputGroup.Input
                    placeholder={hit ?? `which ${meta.kind}`}
                    className="p-2 font-mono text-[12px]"
                  />
                </InputGroup>
              </TextField>
            </div>
            {hit && (p.bin ?? "").trim() !== hit ? (
              <div className="type-meta truncate">
                which → {shortBin(hit)}
              </div>
            ) : null}
          </SectionCard>
          </Reveal>
        );
      })}


      {config.agent_trusted_dirs.length > 0 ? (
        <Reveal index={2}>
        <SectionCard className="flex flex-col gap-2" title="Codex 信任目录">
          {config.agent_trusted_dirs.map((dir) => (
            <div
              key={dir}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-default/25 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                {dir}
              </span>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                className="h-auto min-h-0 rounded-md p-1 text-muted shadow-none hover:bg-default/50 hover:text-danger data-[hovered=true]:bg-default/50 data-[hovered=true]:text-danger"
                aria-label={`移除信任目录 ${dir}`}
                onPress={() =>
                  updateConfig(
                    "agent_trusted_dirs",
                    config.agent_trusted_dirs.filter((d) => d !== dir),
                  )
                }
              >
                <Trash2 size={12} aria-hidden />
              </Button>
            </div>
          ))}
        </SectionCard>
        </Reveal>
      ) : null}

      <Reveal index={2}>
      <SectionCard>
        <Button fullWidth variant="primary" onPress={() => void saveConfig()}>
          <Save size={16} />
          保存
        </Button>
      </SectionCard>
      </Reveal>
    </div>
  );
}

