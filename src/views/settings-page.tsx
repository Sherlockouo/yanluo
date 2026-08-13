import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
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
  NumberField,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { toast } from "@/lib/toast";
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
  Globe,
  Keyboard,
  Languages,
  Mic,
  Monitor,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Volume2,
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
import { useI18n, useT, tStatic } from "@/lib/i18n";
import { useApp } from "@/app-context";
import { requestStartTour } from "@/components/spotlight-tour";
import { playSfx, readSfxEnabled, setSfxEnabled, unlockSfx } from "@/lib/sfx";
import {
  activateLlmProviderPatch,
  agentModelsFor,
  defaultConfig,
  DEFAULT_LLM_TRANSLATE_PROMPT,
  hotkeySegments,
  listLlmProviders,
  llmPreset,
  llmProviderLabel,
  newCustomProviderId,
  asrLanguageOptions,
  addableLanguageCatalog,
  QWEN_ASR_MODELS,
  RECOMMENDED_REFINE_MODELS,
  resolveLlmCreds,
} from "@/lib/constants";
import { useFade } from "@/lib/motion";
import {
  type ModelDownloadProgress,
  type ModelStatus,
  progressLabel,
} from "@/lib/model-download";
import type {
  AgentKind,
  AgentProfile,
  AsrProvider,
  ExtraLanguage,
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
import { useTabScroll } from "@/hooks/use-tab-scroll";
import {
  isSettingsTab,
  patchSettingsUi,
  readSettingsUi,
  settingsScrollKey,
  type SettingsTab,
} from "@/lib/ui-session";

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
  if (raw && isSettingsTab(raw)) return { tab: raw };
  if (raw && raw in TAB_ALIASES) return TAB_ALIASES[raw];
  return { tab: "general" };
}

function effectiveSub(tab: SettingsTab, sub: string | undefined): string | undefined {
  if (tab === "polish") {
    return POLISH_SUBS.some((s) => s.id === sub) ? sub : "config";
  }
  if (tab === "system") {
    return SYSTEM_SUBS.some((s) => s.id === sub) ? sub : "hotkeys";
  }
  return undefined;
}

function resolveInitialSettings(
  tabParam: string | null,
  subParam: string | null,
): { tab: SettingsTab; sub?: string; fromStorage: boolean } {
  if (tabParam) {
    const resolved = resolveTabParam(tabParam);
    const sub = subParam ?? resolved.sub;
    return { tab: resolved.tab, sub, fromStorage: false };
  }
  const stored = readSettingsUi();
  if (stored && isSettingsTab(stored.tab)) {
    return { tab: stored.tab, sub: stored.sub, fromStorage: true };
  }
  return { tab: "general", fromStorage: false };
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
  needs_relaunch?: boolean;
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
  qwen_local_available?: boolean;
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

const TABS: { id: SettingsTab; labelKey: string; icon: typeof Shield }[] = [
  { id: "general", labelKey: "settings.tab.general", icon: SlidersHorizontal },
  { id: "asr", labelKey: "settings.tab.asr", icon: Mic },
  { id: "polish", labelKey: "settings.tab.polish", icon: Wand2 },
  { id: "agent", labelKey: "settings.tab.agent", icon: Bot },
  { id: "system", labelKey: "settings.tab.system", icon: Cpu },
  { id: "updates", labelKey: "settings.tab.updates", icon: Download },
];

const POLISH_SUBS: { id: PolishSub; labelKey: string }[] = [
  { id: "config", labelKey: "settings.sub.config" },
  { id: "refine", labelKey: "settings.sub.refine" },
  { id: "vocab", labelKey: "settings.sub.vocab" },
];

const SYSTEM_SUBS: { id: SystemSub; labelKey: string }[] = [
  { id: "hotkeys", labelKey: "settings.sub.hotkeys" },
  { id: "permissions", labelKey: "settings.sub.permissions" },
];

/** One muted 13px description line under the serif section head (v3.1). */
const TAB_DESC_KEYS: Record<SettingsTab, string> = {
  general: "settings.tabDesc.general",
  asr: "settings.tabDesc.asr",
  polish: "settings.tabDesc.polish",
  agent: "settings.tabDesc.agent",
  system: "settings.tabDesc.system",
  updates: "settings.tabDesc.updates",
};

/**
 * Quiet 文字开关 (v3.1) — 「·」-separated options, no box; active option gets
 * 600 weight + 2px accent underline. Same language as .tswitch on 出稿.
 */
function QSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="qswitch" role="radiogroup" aria-label={ariaLabel}>
      {options.map((item, i) => {
        const active = value === item.id;
        return (
          <Fragment key={item.id}>
            {i > 0 ? (
              <span className="sep" aria-hidden>
                ·
              </span>
            ) : null}
            <button
              type="button"
              role="radio"
              aria-checked={active}
              className={cn("o", active && "on")}
              onClick={() => onChange(item.id)}
            >
              {item.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

const PERMS: {
  kind: PermKind;
  titleKey: string;
  blurbKey: string;
  icon: typeof Shield;
}[] = [
  {
    kind: "accessibility",
    titleKey: "settings.perm.accessibility",
    blurbKey: "settings.perm.accessibilityBlurb",
    icon: Shield,
  },
  {
    kind: "input_monitoring",
    titleKey: "settings.perm.inputMonitoring",
    blurbKey: "settings.perm.inputMonitoringBlurb",
    icon: Keyboard,
  },
  {
    kind: "microphone",
    titleKey: "settings.perm.microphone",
    blurbKey: "settings.perm.microphoneBlurb",
    icon: Mic,
  },
  {
    kind: "speech_recognition",
    titleKey: "settings.perm.speechRecognition",
    blurbKey: "settings.perm.speechRecognitionBlurb",
    icon: Ear,
  },
  {
    kind: "screen_recording",
    titleKey: "settings.perm.screenRecording",
    blurbKey: "settings.perm.screenRecordingBlurb",
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
  items: { id: T; labelKey: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  const t = useT();
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
            {t(item.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const seeded = useRef(
    resolveInitialSettings(searchParams.get("tab"), searchParams.get("sub")),
  );
  const [tab, setTab] = useState<SettingsTab>(seeded.current.tab);
  const [sub, setSub] = useState<string | undefined>(seeded.current.sub);
  /** Pointer-down paint before React commit — left nav feels instant. */
  const [navPaint, setNavPaint] = useState<SettingsTab | null>(null);
  const scroll = useTabScroll(readSettingsUi()?.scroll ?? {});
  const tabRef = useRef(tab);
  const subRef = useRef(sub);
  tabRef.current = tab;
  subRef.current = sub;
  const urlFromClick = useRef(false);
  const urlHydrated = useRef(false);

  const scrollKeyFor = (t: SettingsTab, s: string | undefined) =>
    settingsScrollKey(t, effectiveSub(t, s));

  const persistNav = (t: SettingsTab, s: string | undefined) => {
    patchSettingsUi({
      tab: t,
      sub: effectiveSub(t, s),
    });
  };

  const applyNav = (
    nextTab: SettingsTab,
    nextSub: string | undefined,
    opts?: { skipScroll?: boolean },
  ) => {
    const fromKey = scrollKeyFor(tabRef.current, subRef.current);
    const toKey = scrollKeyFor(nextTab, nextSub);
    if (!opts?.skipScroll) {
      const y = scroll.save(fromKey);
      patchSettingsUi({
        tab: nextTab,
        sub: effectiveSub(nextTab, nextSub),
        scrollPatch: { [fromKey]: y },
      });
    } else {
      persistNav(nextTab, nextSub);
    }
    setTab(nextTab);
    setSub(nextSub);
    if (!opts?.skipScroll && fromKey !== toKey) {
      requestAnimationFrame(() => scroll.restore(toKey));
    }
  };

  // Alias → canonical URL once (before storage seed URL write).
  useEffect(() => {
    const raw = searchParams.get("tab");
    if (raw && !isSettingsTab(raw) && raw in TAB_ALIASES) {
      const next = TAB_ALIASES[raw];
      const params: Record<string, string> = { tab: next.tab };
      if (next.sub) params.sub = next.sub;
      setSearchParams(params, { replace: true });
      return;
    }
    // Bare `/settings`: push stored tab/sub into URL.
    if (!raw && seeded.current.fromStorage) {
      const t = seeded.current.tab;
      const s = effectiveSub(t, seeded.current.sub);
      if (t === "general") return;
      const params: Record<string, string> = { tab: t };
      if (s) params.sub = s;
      setSearchParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    scroll.restore(scrollKeyFor(tab, sub));
    persistNav(tab, sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      const key = scrollKeyFor(tabRef.current, subRef.current);
      const y = scroll.save(key);
      patchSettingsUi({
        tab: tabRef.current,
        sub: effectiveSub(tabRef.current, subRef.current),
        scrollPatch: { [key]: y },
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (urlFromClick.current) {
      urlFromClick.current = false;
      return;
    }
    const raw = searchParams.get("tab");
    if (!urlHydrated.current) {
      urlHydrated.current = true;
      if (!raw && seeded.current.fromStorage) return;
    }
    const resolvedNext = resolveTabParam(raw);
    const nextSub = searchParams.get("sub") ?? resolvedNext.sub;
    if (
      resolvedNext.tab !== tabRef.current ||
      nextSub !== subRef.current
    ) {
      applyNav(resolvedNext.tab, nextSub);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const selectTab = (id: SettingsTab) => {
    // Same primary tab with no sub already open — no-op.
    if (id === tab && sub == null) {
      setNavPaint(null);
      return;
    }
    setNavPaint(id);
    applyNav(id, undefined);
    urlFromClick.current = true;
    if (id === "general") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: id }, { replace: true });
    }
  };

  const selectSub = (nextSub: string) => {
    if (nextSub === sub) return;
    applyNav(tab, nextSub);
    urlFromClick.current = true;
    setSearchParams({ tab, sub: nextSub }, { replace: true });
  };

  // Clear optimistic paint once URL/state caught up.
  useEffect(() => {
    if (navPaint != null && navPaint === tab) setNavPaint(null);
  }, [tab, navPaint]);

  const fade = useFade();
  const t = useT();

  const paintedTab = navPaint ?? tab;
  const activeTabDef = TABS.find((item) => item.id === paintedTab);
  const activeLabel = activeTabDef ? t(activeTabDef.labelKey) : t("settings.title");

  return (
    <PageShell className="max-w-none! set-page pt-8 -mb-15 gap-7! h-full min-h-0">
      <PageHeader title={t("settings.title")} />

      {/* macOS System-Settings-style two-pane: left source list, right detail. */}
      <div className="set">
        <nav className="setnav" aria-label={t("settings.navAria")}>
          {TABS.map((item) => {
            const active = paintedTab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "true" : undefined}
                data-tour={
                  item.id === "asr"
                    ? "settings-asr"
                    : item.id === "system"
                      ? "settings-hotkeys"
                      : undefined
                }
                className={cn("setnav-item", active && "setnav-item-active")}
                onPointerDown={() => setNavPaint(item.id)}
                onClick={() => selectTab(item.id)}
              >
                <Icon size={14} className="setnav-icon" aria-hidden />
                <span className="relative z-10">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="setbody">
          <motion.div
            key={tab}
            initial={fade.initial}
            animate={fade.animate}
            transition={fade.transition}
            style={{ willChange: "opacity" }}
            className="flex flex-col gap-4"
          >
            <div>
              <h2 className="set-sechead">{activeLabel}</h2>
              <p className="set-secdesc">{t(TAB_DESC_KEYS[tab])}</p>
            </div>
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
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="set-group-t">{t("settings.polish.groupTitle")}</div>
        <div className="mt-2">
          <SubTabs
            items={POLISH_SUBS}
            active={sub}
            onSelect={onSelectSub}
          />
        </div>
      </div>
      <motion.div
        key={sub}
        initial={fade.initial}
        animate={fade.animate}
        transition={fade.transition}
        style={{ willChange: "opacity" }}
      >
        {sub === "config" ? <LlmProviderPanel /> : null}
        {sub === "refine" ? (
          <div className="learn-embed">
            <LlmPage embedded />
          </div>
        ) : null}
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
    <div className="flex flex-col gap-4">
      <SubTabs
        items={SYSTEM_SUBS}
        active={sub}
        onSelect={onSelectSub}
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

function AsrProviderPanel() {
  const { config, updateConfig, saveConfig, chooseModelDir, loadModel, modelLoaded, modelLoading } =
    useApp();
  const t = useT();
  const [appleAvailable, setAppleAvailable] = useState(true);
  const [qwenLocal, setQwenLocal] = useState(false);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadAligner, setDownloadAligner] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Dirty detection: snapshot config on mount and after save
  const configSnapshotRef = useRef(JSON.stringify(config));
  const isDirty = JSON.stringify(config) !== configSnapshotRef.current;

  useEffect(() => {
    void invoke<AppInfo>("get_app_info")
      .then((info) => {
        const ok = info.apple_speech_available ?? info.platform === "macos";
        setAppleAvailable(ok);
        setQwenLocal(info.qwen_local_available ?? false);
        if (!ok && config.asr_provider === "apple") {
          updateConfig("asr_provider", "qwen");
        }
      })
      .catch(() => {
        setAppleAvailable(false);
        setQwenLocal(false);
      });
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
      toast.success(t("settings.asr.modelDownloadedLoading"));
      await refreshStatus();
      await loadModel(path);
    } catch (error) {
      toast.danger(
        t("settings.asr.downloadFailed", {
          msg: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setDownloading(false);
    }
  };

  const alignReady = Boolean(config.align_model_dir?.trim());

  const isQwen = config.asr_provider === "qwen";
  const needsDownload = isQwen && (status?.needs_download ?? !status?.installed);

  return (
    <div className="flex flex-col gap-4">
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
          <Label>{t("settings.asr.engine")}</Label>
          <Select.Trigger className="set-select-box">
            <Select.Value />
            <ChevronDown size={14} className="shrink-0 text-muted opacity-70" />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="gap-3 p-3">
              {appleAvailable ? (
                <ListBox.Item id="apple" textValue="Apple Speech">
                  Apple Speech
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ) : null}
              <ListBox.Item
                id="qwen"
                textValue={t("settings.asr.qwenLocal")}
                isDisabled={!qwenLocal}
              >
                {t("settings.asr.qwenLocal")}
                {!qwenLocal ? t("settings.asr.qwenNotBuilt") : ""}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>

        {config.asr_provider === "apple" ? (
          <p className="type-meta">{t("settings.asr.appleBlurb")}</p>
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
              <Label>{t("settings.asr.model")}</Label>
              <Select.Trigger className="set-select-box">
                <Select.Value />
                <ChevronDown size={14} className="shrink-0 text-muted opacity-70" />
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
            {status?.installed && !status.needs_download ? (
              <p className="-mt-2 truncate type-meta">
                <span className="badge-soft" data-tone="success">
                  {t("settings.asr.installed")}
                </span>{" "}
                {status.path}
              </p>
            ) : null}

            {needsDownload ? (
              <div className="flex flex-col gap-3 rounded-xl bg-default/40 p-4">
                <div>
                  <div className="type-ui">{t("settings.asr.needDownloadTitle")}</div>
                  <div className="mt-0.5 type-meta">
                    {t("settings.asr.needDownloadBlurb")}
                  </div>
                </div>
                {downloading && progress ? (
                  <div className="flex flex-col gap-2">
                    <div className="type-meta">{progressLabel(progress)}</div>
                    <div className="update-progress-track">
                      <div
                        className="update-progress-bar"
                        style={
                          {
                            "--progress":
                              progress.percent != null
                                ? Math.min(100, Math.max(0, progress.percent)) /
                                  100
                                : 0.3,
                          } as CSSProperties
                        }
                      />
                    </div>
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
                  {downloading
                    ? t("settings.asr.downloading")
                    : t("settings.asr.startDownload")}
                </Button>
              </div>
            ) : null}

            <div className="settings-switchrow">
              <Switch
                isSelected={alignReady && config.align_enabled}
                isDisabled={!alignReady}
                onChange={(value) => updateConfig("align_enabled", value)}
              >
                <Switch.Content className="w-full justify-between gap-2 p-3">
                  <div className="min-w-0 pr-2">
                    <div className="type-ui">{t("settings.asr.align")}</div>
                    <div className="mt-0.5 type-meta">
                      {alignReady
                        ? t("settings.asr.alignReady")
                        : t("settings.asr.alignNotReady")}
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
            {t("settings.asr.advancedTitle")}
          </CollapseTrigger>
          {!advancedOpen ? (
            <p className="-mt-1 type-meta">{t("settings.asr.advancedBlurb")}</p>
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
                        "--progress":
                          progress.percent != null
                            ? Math.min(100, Math.max(0, progress.percent)) / 100
                            : 0.3,
                      } as CSSProperties}
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
                <Label>{t("settings.asr.modelDir")}</Label>
                <InputGroup className="w-full">
                  <InputGroup.Input className="min-w-0 font-mono text-[13px]" />
                  <InputGroup.Suffix className="pr-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => void chooseModelDir()}
                    >
                      <FolderOpen size={16} />
                      {t("settings.asr.browse")}
                    </Button>
                  </InputGroup.Suffix>
                </InputGroup>
              </TextField>

              <Checkbox
                isSelected={downloadAligner}
                onChange={setDownloadAligner}
              >
                <Checkbox.Content className="flex items-center gap-2 type-meta">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {t("settings.asr.downloadAligner")}
                </Checkbox.Content>
              </Checkbox>

              <TextField
                fullWidth
                variant="secondary"
                value={config.align_model_dir ?? ""}
                onChange={(value) => updateConfig("align_model_dir", value)}
              >
                <Label>{t("settings.asr.alignModelDir")}</Label>
                <Input className="min-w-0 font-mono text-[13px]" />
              </TextField>

              <VadAdvancedFields config={config} updateConfig={updateConfig} />
            </div>
          </SoftCollapse>
        </SectionCard>
        </Reveal>
      ) : null}

      <div className="form-actions">
        {isQwen && !needsDownload ? (
          <div className="form-actions-secondary flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              isPending={downloading}
              onPress={() => void startDownload()}
            >
              <Download size={14} />
              {t("settings.asr.redownload")}
            </Button>
            <Button
              size="sm"
              variant={modelLoaded ? "secondary" : "primary"}
              isPending={modelLoading}
              isDisabled={!config.asr_model_dir?.trim()}
              onPress={() => void loadModel()}
            >
              {modelLoaded ? t("settings.asr.reload") : t("settings.asr.loadModel")}
            </Button>
          </div>
        ) : null}
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant={isQwen && !needsDownload && !modelLoaded ? "secondary" : "primary"}
          isDisabled={!isDirty}
          onPress={() => {
            void saveConfig(config, { silent: true }).then(() => {
              configSnapshotRef.current = JSON.stringify(config);
              toast.success(t("common.saved"));
            });
          }}
        >
          <Save size={16} />
          {t("common.save")}
        </Button>
      </div>
      {isQwen && !needsDownload && !modelLoaded ? (
        <p className="type-meta text-warning">{t("settings.asr.notLoadedWarning")}</p>
      ) : null}
    </div>
  );
}


/**
 * Controlled number field that allows empty / intermediate typing.
 * Commits + clamps on blur only — never snaps mid-keystroke.
 */
function ConfigNumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [local, setLocal] = useState<number>(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const clamp = (n: number) => {
    let next = n;
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    return next;
  };

  return (
    <NumberField
      fullWidth
      variant="secondary"
      value={local}
      minValue={min}
      maxValue={max}
      step={step}
      onFocusChange={(focused) => {
        focusedRef.current = focused;
        if (!focused) {
          if (!Number.isFinite(local)) {
            setLocal(value);
            return;
          }
          const next = clamp(local);
          setLocal(next);
          if (next !== value) onCommit(next);
        }
      }}
      onChange={(n) => {
        setLocal(n);
        // Commit only in-range finite values (stepper + finished typing).
        // Out-of-range / empty wait for blur clamp — avoids snap while editing.
        if (
          Number.isFinite(n) &&
          (min == null || n >= min) &&
          (max == null || n <= max)
        ) {
          onCommit(n);
        }
      }}
    >
      <Label>{label}</Label>
      <NumberField.Group
        className="w-full"
        style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
      >
        <NumberField.Input className="w-full min-w-0 font-mono text-[13px]" />
      </NumberField.Group>
    </NumberField>
  );
}

/** 场景 id — maps to a 灵敏度 value; "custom" = current value doesn't match any preset. */
type VadScene = "dictate" | "meeting" | "interview" | "custom";

const VAD_SCENE_AGGRESSION: Record<Exclude<VadScene, "custom">, number> = {
  dictate: 1,
  meeting: 2,
  interview: 3,
};

function vadSceneFor(aggression: number): VadScene {
  if (aggression <= 1) return "dictate";
  if (aggression === 2) return "meeting";
  if (aggression >= 3) return "interview";
  return "custom";
}

function VadAdvancedFields({
  config,
  updateConfig,
}: {
  config: ReturnType<typeof useApp>["config"];
  updateConfig: ReturnType<typeof useApp>["updateConfig"];
}) {
  const aggression = config.vad_aggression ?? 2;
  const scene = vadSceneFor(aggression);
  const t = useT();

  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex flex-col gap-1.5">
        <span className="type-meta">{t("settings.vad.scene")}</span>
        <QSwitch
          ariaLabel={t("settings.vad.scenePresetAria")}
          value={scene}
          onChange={(id) => {
            if (id === "custom") return;
            updateConfig("vad_aggression", VAD_SCENE_AGGRESSION[id]);
          }}
          options={[
            { id: "dictate" as const, label: t("settings.vad.sceneDictate") },
            { id: "meeting" as const, label: t("settings.vad.sceneMeeting") },
            { id: "interview" as const, label: t("settings.vad.sceneInterview") },
          ]}
        />
        {aggression >= 3 ? (
          <p className="type-meta">{t("settings.vad.tooChoppyHint")}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ConfigNumberField
          label={t("settings.vad.chunkSizeSec")}
          value={config.chunk_size_sec ?? 1.5}
          min={0.2}
          max={5}
          step={0.1}
          onCommit={(n) => updateConfig("chunk_size_sec", n)}
        />
        <ConfigNumberField
          label={t("settings.vad.unfixedTokens")}
          value={config.unfixed_token_num ?? 5}
          min={1}
          max={32}
          step={1}
          onCommit={(n) => updateConfig("unfixed_token_num", Math.round(n))}
        />
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
          <Label>{t("settings.vad.backend")}</Label>
          <Select.Trigger className="set-select-box">
            <Select.Value />
            <ChevronDown size={14} className="shrink-0 text-muted opacity-70" />
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
        <ConfigNumberField
          label={t("settings.vad.aggression")}
          value={config.vad_aggression ?? 2}
          min={0}
          max={3}
          step={1}
          onCommit={(n) => updateConfig("vad_aggression", Math.round(n))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ConfigNumberField
          label={t("settings.vad.minSilenceMs")}
          value={config.vad_min_silence_ms ?? 900}
          min={400}
          step={50}
          onCommit={(n) => updateConfig("vad_min_silence_ms", Math.round(n))}
        />
        <ConfigNumberField
          label={t("settings.vad.commitHoldMs")}
          value={config.vad_commit_hold_ms ?? 500}
          min={200}
          step={50}
          onCommit={(n) => updateConfig("vad_commit_hold_ms", Math.round(n))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ConfigNumberField
          label={t("settings.vad.minSegmentMs")}
          value={config.vad_min_segment_ms ?? 2500}
          min={1000}
          step={100}
          onCommit={(n) => updateConfig("vad_min_segment_ms", Math.round(n))}
        />
        <ConfigNumberField
          label={t("settings.vad.maxSegmentSec")}
          value={config.vad_max_segment_sec ?? 90}
          min={10}
          max={180}
          step={1}
          onCommit={(n) => updateConfig("vad_max_segment_sec", n)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ConfigNumberField
          label={t("settings.vad.overlapMs")}
          value={config.vad_overlap_ms ?? 500}
          min={200}
          step={50}
          onCommit={(n) => updateConfig("vad_overlap_ms", Math.round(n))}
        />
        <ConfigNumberField
          label={t("settings.vad.crossSegmentPrefix")}
          value={config.cross_segment_prefix_tokens ?? 64}
          min={0}
          max={256}
          step={1}
          onCommit={(n) =>
            updateConfig("cross_segment_prefix_tokens", Math.round(n))
          }
        />
      </div>

      {config.vad_backend === "energy" ? (
        <ConfigNumberField
          label={t("settings.vad.energyThreshold")}
          value={config.vad_energy_threshold ?? 0.01}
          min={0.001}
          max={0.05}
          step={0.001}
          onCommit={(n) => updateConfig("vad_energy_threshold", n)}
        />
      ) : null}
    </div>
  );
}


function LlmProviderPanel() {
  const { config, updateConfig, saveConfig } = useApp();
  const t = useT();
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
    toast.success(
      t("settings.llm.setCurrentToast", {
        label: llmProviderLabel(config, provider),
      }),
    );
  };

  const resetBuiltin = (provider: LlmProvider) => {
    const rest = { ...config.llm_credentials };
    delete rest[provider];
    updateConfig("llm_credentials", rest);
    void saveConfig({ ...config, llm_credentials: rest }, { silent: true });
    toast.success(t("settings.llm.resetToast"));
  };

  const deleteCustom = (provider: LlmProvider) => {
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
    toast.success(t("common.deleted"));
  };

  const addProvider = () => {
    const id = newCustomProviderId();
    updateConfig("llm_credentials", {
      ...config.llm_credentials,
      [id]: {
        api_base_url: "",
        api_key: "",
        model: "",
        label: t("settings.llm.newProviderName"),
      },
    });
    setOpenId(id);
  };

  const save = () => {
    void saveConfig();
    toast.success(t("common.saved"));
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="set-lines">
        <div className="set-row-line">
          <div className="set-row-line-lab">
            <span className="set-row-line-lab-title">
              <Wand2 size={14} className="set-row-ico" aria-hidden />
              {t("settings.llm.enableRefine")}
            </span>
            <small>{t("settings.llm.enableRefineBlurb")}</small>
          </div>
          <div className="set-row-line-ctl">
            <Switch
              aria-label={t("settings.llm.enableRefine")}
              isSelected={config.llm_enabled}
              onChange={(value) => updateConfig("llm_enabled", value)}
            >
              <Switch.Content className="gap-2">
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </div>
      </div>

      <div>
        <div className="set-prov-list">
          {providers.map((p) => {
            const isCur = p.id === config.llm_provider;
            const isOpen = openId === p.id;
            const local = p.id === "ollama";
            const stored = config.llm_credentials?.[p.id];
            const hasKey = Boolean(stored?.api_key?.trim());
            const rc = resolveLlmCreds(config, p.id);
            const badge = isCur
              ? t("settings.llm.badgeCurrent")
              : local
                ? t("settings.llm.badgeLocal")
                : hasKey
                  ? t("settings.llm.badgeHasKey")
                  : t("settings.llm.badgeUnset");
            const toggle = () => setOpenId(isOpen ? null : p.id);
            return (
              <div key={p.id} className={cn("set-prov-wrap", isOpen && "is-open")}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  className={cn("set-prov-line", isCur && "current")}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <div className="set-prov-grow">
                    <div className="set-prov-namerow">
                      <span className="set-prov-name">{p.label}</span>
                      <span
                        className="badge-soft"
                        data-tone={
                          isCur ? "accent" : local || hasKey ? "success" : "neutral"
                        }
                      >
                        {badge}
                      </span>
                    </div>
                    <div className="set-prov-meta">
                      {rc.model ? `${rc.model} · ` : ""}
                      {rc.api_base_url || t("settings.llm.noBaseUrl")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="set-prov-act"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle();
                    }}
                  >
                    <span>{isOpen ? t("common.collapse") : t("common.edit")}</span>
                    <ChevronDown
                      size={12}
                      style={{
                        transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                        transition: "transform 150ms ease",
                      }}
                    />
                  </button>
                  {!isCur ? (
                    <button
                      type="button"
                      className="set-prov-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        activate(p.id);
                      }}
                    >
                      {t("settings.llm.setCurrent")}
                    </button>
                  ) : null}
                </div>

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

          <div
            role="button"
            tabIndex={0}
            className="set-prov-line"
            onClick={addProvider}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                addProvider();
              }
            }}
          >
            <div className="set-prov-grow">
              <span className="set-prov-name text-muted">
                {t("settings.llm.customProviderEllipsis")}
              </span>
            </div>
            <span className="set-prov-ghost">{t("settings.llm.addProvider")}</span>
          </div>
        </div>
      </div>

      <TranslatePromptSection />
    </div>
  );
}

/** 翻译 Prompt — 从出稿-翻译 tab 收敛至此 (v3.1: 使用处只留选择, 编辑在设置). */
function TranslatePromptSection() {
  const { config, updateConfig, saveConfig } = useApp();
  const t = useT();
  const translateValue =
    config.llm_translate_prompt || DEFAULT_LLM_TRANSLATE_PROMPT;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="set-group-t">{t("settings.translatePrompt.title")}</div>
        <p className="mt-1 type-meta">
          {t("settings.translatePrompt.blurb", { placeholder: "{target}" })}
        </p>
      </div>
      <TextField
        fullWidth
        variant="secondary"
        value={translateValue}
        onChange={(value) => updateConfig("llm_translate_prompt", value)}
      >
        <Label className="sr-only">{t("settings.translatePrompt.title")}</Label>
        <TextArea
          rows={8}
          className="min-h-[10rem] font-mono type-meta !text-[12px]"
          placeholder={t("settings.translatePrompt.placeholder", {
            placeholder: "{target}",
          })}
        />
      </TextField>
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onPress={() => updateConfig("llm_translate_prompt", "")}
        >
          <RotateCcw size={14} />
          {t("common.restoreDefault")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="btn-press"
          onPress={() => {
            void saveConfig();
            toast.success(t("common.saved"));
          }}
        >
          <Save size={14} />
          {t("common.save")}
        </Button>
      </div>
    </section>
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
  const t = useT();
  // Two-step inline confirm for delete: first press arms (确认删除？), second executes.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
      }
    },
    [],
  );

  const pressDestructive = () => {
    if (builtin) {
      onReset();
      return;
    }
    if (confirmingDelete) {
      if (confirmTimer.current != null) {
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
      setConfirmingDelete(false);
      onDelete();
      return;
    }
    setConfirmingDelete(true);
    confirmTimer.current = window.setTimeout(() => {
      setConfirmingDelete(false);
      confirmTimer.current = null;
    }, 3000);
  };

  return (
    <div className="flex flex-col gap-4 px-3 pb-4 pt-3">
      {!builtin ? (
        <TextField
          fullWidth
          variant="secondary"
          value={creds.label ?? ""}
          onChange={(value) => onPatch({ label: value })}
        >
          <Label>{t("settings.llm.name")}</Label>
          <Input placeholder={t("settings.llm.namePlaceholder")} />
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
        <Input placeholder={t("settings.llm.apiKeyPlaceholder")} />
      </TextField>

      <TextField
        fullWidth
        variant="secondary"
        value={creds.model}
        onChange={(value) => onPatch({ model: value })}
      >
        <Label>{t("settings.llm.model")}</Label>
        <Input
          placeholder={preset.models[0] ?? t("settings.llm.modelPlaceholder")}
          className="font-mono text-[13px]"
        />
      </TextField>
      {preset.models.length > 0 ? (
        <div className="-mt-1 flex flex-wrap gap-1.5">
          {preset.models.map((m) => (
            <button
              key={m}
              type="button"
              className="rounded-md bg-surface-secondary px-2 py-1 font-mono text-[11px] text-muted transition-[color,background-color,transform] duration-100 ease-out hover:text-foreground active:scale-[0.96] motion-reduce:active:transform-none"
              onClick={() => onPatch({ model: m })}
            >
              {m}
            </button>
          ))}
        </div>
      ) : null}

      <div className="-mt-1 flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="type-meta">{t("settings.llm.recommended")}</span>
          {RECOMMENDED_REFINE_MODELS.map((rec) => (
            <button
              key={rec.model}
              type="button"
              className="rounded-md bg-surface-secondary px-2 py-1 font-mono text-[11px] text-muted transition-[color,background-color,transform] duration-100 ease-out hover:text-foreground active:scale-[0.96] motion-reduce:active:transform-none"
              onClick={() => onPatch({ model: rec.model })}
            >
              {rec.scope} {rec.model}
            </button>
          ))}
        </div>
        <p className="type-meta">{t("settings.llm.fewShotHint")}</p>
      </div>

      <div className="form-actions">
        <div className="form-actions-secondary flex gap-2">
          {!isCurrent ? (
            <Button size="sm" variant="secondary" onPress={onActivate}>
              {t("settings.llm.setCurrent")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className={
              confirmingDelete
                ? "text-danger"
                : "text-muted hover:text-danger data-[hovered=true]:text-danger"
            }
            onPress={pressDestructive}
          >
            <Trash2 size={14} />
            {builtin
              ? t("common.reset")
              : confirmingDelete
                ? t("common.confirmDelete")
                : t("common.delete")}
          </Button>
        </div>
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={onSave}
        >
          <Save size={16} />
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function GeneralPanel() {
  const { config, updateConfig, theme, setTheme, saveConfig } = useApp();
  const { locale, setLocale, t } = useI18n();
  const langOptions = asrLanguageOptions(config.extra_languages);
  const addable = addableLanguageCatalog(config.extra_languages);
  const [pendingAdd, setPendingAdd] = useState<string>(addable[0]?.[0] ?? "");
  const [sfxOn, setSfxOn] = useState(() => readSfxEnabled());

  useEffect(() => {
    if (!addable.some(([id]) => id === pendingAdd)) {
      setPendingAdd(addable[0]?.[0] ?? "");
    }
  }, [addable, pendingAdd]);

  useEffect(() => {
    const onSfx = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean }>).detail;
      if (detail && typeof detail.enabled === "boolean") setSfxOn(detail.enabled);
    };
    window.addEventListener("yanluo:sfx-enabled", onSfx);
    return () => window.removeEventListener("yanluo:sfx-enabled", onSfx);
  }, []);
  const addLanguage = (id: string) => {
    const row = addable.find(([v]) => v === id);
    if (!row) return;
    const next: ExtraLanguage[] = [
      ...(config.extra_languages ?? []),
      { id: row[0], label: row[1] },
    ];
    updateConfig("extra_languages", next);
    // Prefer newly added as recognition language when still on auto? No — just list.
  };

  const removeLanguage = (id: string) => {
    const next = (config.extra_languages ?? []).filter((e) => e.id !== id);
    updateConfig("extra_languages", next);
    if (config.language === id) updateConfig("language", "auto");
    if (config.translate_target_language === id) {
      updateConfig("translate_target_language", "en-US");
    }
  };

  const switchTheme = (mode: "dark" | "light") => {
    const skipOverlay =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (skipOverlay) {
      setTheme(mode);
      return;
    }
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "99999",
      background: "var(--background)",
      pointerEvents: "none",
      opacity: "1",
      transition: "opacity 120ms ease-out",
    });
    document.body.appendChild(overlay);
    setTheme(mode);
    // Force a reflow so transition triggers
    void overlay.offsetHeight;
    overlay.style.opacity = "0";
    overlay.addEventListener("transitionend", () => overlay.remove(), {
      once: true,
    });
    // Fallback removal in case transitionend doesn't fire
    setTimeout(() => overlay.remove(), 200);
  };

  return (
    <div className="set-lines">
      {/* 语言 / Language — interface locale, applies immediately (not persisted in config) */}
      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Languages size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.uiLanguage")}
          </span>
          <small>{t("settings.general.uiLanguageBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <Select
            aria-label={t("settings.general.uiLanguage")}
            selectedKey={locale}
            onSelectionChange={(key) => {
              if (key !== "en" && key !== "zh") return;
              setLocale(key);
            }}
          >
            <Select.Trigger className="qsel">
              <Select.Value />
              <ChevronDown size={12} className="qsel-chev shrink-0" />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="en" textValue="English">
                  English
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="zh" textValue="中文">
                  中文
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

      {/* 识别语言 — quiet mono ▾ 触发器, 无盒 */}
      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Globe size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.asrLanguage")}
          </span>
          <small>{t("settings.general.asrLanguageBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <Select
            aria-label={t("settings.general.asrLanguage")}
            selectedKey={config.language}
            onSelectionChange={(key) => {
              if (key == null) return;
              updateConfig("language", String(key));
            }}
          >
            <Select.Trigger className="qsel">
              <Select.Value />
              <ChevronDown size={12} className="qsel-chev shrink-0" />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {langOptions.map(([value, label]) => (
                  <ListBox.Item key={value} id={value} textValue={label}>
                    {label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Plus size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.addLanguage")}
          </span>
          <small>{t("settings.general.addLanguageBlurb")}</small>
        </div>
        <div className="set-row-line-ctl flex flex-col items-end gap-2">
          {(config.extra_languages?.length ?? 0) > 0 ? (
            <div className="flex max-w-md flex-wrap justify-end gap-1.5">
              {config.extra_languages.map((e) => (
                <span
                  key={e.id}
                  className="inline-flex items-center gap-1 rounded-md bg-default/40 px-2 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {e.label}
                  <button
                    type="button"
                    className="text-muted transition-colors hover:text-danger"
                    aria-label={t("settings.general.removeLanguageAria", {
                      label: e.label,
                    })}
                    onClick={() => removeLanguage(e.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {addable.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select
                aria-label={t("settings.general.pendingLanguageAria")}
                selectedKey={pendingAdd || undefined}
                onSelectionChange={(key) => {
                  if (key == null) return;
                  setPendingAdd(String(key));
                }}
              >
                <Select.Trigger className="qsel">
                  <Select.Value />
                  <ChevronDown size={12} className="qsel-chev shrink-0" />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {addable.map(([value, label]) => (
                      <ListBox.Item key={value} id={value} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 min-h-7 px-2.5 text-[12px]"
                isDisabled={!pendingAdd}
                onPress={() => pendingAdd && addLanguage(pendingAdd)}
              >
                {t("common.add")}
              </Button>
            </div>
          ) : (
            <span className="type-meta">{t("settings.general.allLanguagesAdded")}</span>
          )}
        </div>
      </div>

      {/* 录音源 — quiet 文字开关, 无盒 */}
      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Mic size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.audioSource")}
          </span>
          <small>{t("settings.general.audioSourceBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <QSwitch
            ariaLabel={t("settings.general.audioSource")}
            value={config.audio_capture_mode ?? "external"}
            onChange={(mode) => updateConfig("audio_capture_mode", mode)}
            options={[
              { id: "external" as const, label: t("settings.general.audioExternal") },
              { id: "system" as const, label: t("settings.general.audioSystem") },
              { id: "both" as const, label: t("settings.general.audioBoth") },
            ]}
          />
        </div>
      </div>

      {/* 外观 — quiet 文字开关 (即时生效, 不写 config) */}
      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Palette size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.appearance")}
          </span>
          <small>{t("settings.general.appearanceBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <QSwitch
            ariaLabel={t("settings.general.appearance")}
            value={theme}
            onChange={(mode) => switchTheme(mode)}
            options={[
              { id: "dark" as const, label: t("settings.general.themeDark") },
              { id: "light" as const, label: t("settings.general.themeLight") },
            ]}
          />
        </div>
      </div>

      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Volume2 size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.sfx")}
          </span>
          <small>{t("settings.general.sfxBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <QSwitch
            ariaLabel={t("settings.general.sfx")}
            value={sfxOn ? "on" : "off"}
            onChange={(mode) => {
              const on = mode === "on";
              setSfxEnabled(on);
              setSfxOn(on);
              if (on) {
                unlockSfx();
                playSfx("uiTap");
              }
            }}
            options={[
              { id: "on" as const, label: t("settings.general.sfxOn") },
              { id: "off" as const, label: t("settings.general.sfxOff") },
            ]}
          />
        </div>
      </div>

      <div className="set-row-line">
        <div className="set-row-line-lab">
          <span className="set-row-line-lab-title">
            <Sparkles size={14} className="set-row-ico" aria-hidden />
            {t("settings.general.tour")}
          </span>
          <small>{t("settings.general.tourBlurb")}</small>
        </div>
        <div className="set-row-line-ctl">
          <Button size="sm" variant="secondary" onPress={() => requestStartTour()}>
            {t("settings.general.tourButton")}
          </Button>
        </div>
      </div>

      <div className="form-actions">
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={() => {
            void saveConfig(config, { silent: true }).then(() =>
              toast.success(t("common.saved")),
            );
          }}
        >
          <Save size={16} />
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

type HotkeySlot = "transcribe" | "translate" | "cancel" | "agent";

const HOTKEY_SLOT_KEYS: Record<HotkeySlot, string> = {
  transcribe: "settings.hotkeys.slotTranscribe",
  translate: "settings.hotkeys.slotTranslate",
  cancel: "settings.hotkeys.slotCancel",
  agent: "settings.hotkeys.slotAgent",
};

function HotkeysPanel() {
  const { config, updateConfig, saveConfig } = useApp();
  const t = useT();
  const [listening, setListening] = useState<null | HotkeySlot>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    slot: HotkeySlot;
    conflictSlot: HotkeySlot;
    binding: HotkeyBinding;
  } | null>(null);

  /** Find a conflicting slot that already uses the same binding label. */
  const findConflict = (
    targetSlot: HotkeySlot,
    binding: HotkeyBinding,
  ): HotkeySlot | null => {
    const slots: { slot: HotkeySlot; binding: HotkeyBinding }[] = [
      { slot: "transcribe", binding: config.hotkey_transcribe },
      { slot: "translate", binding: config.hotkey_translate },
      { slot: "cancel", binding: config.hotkey_cancel },
      {
        slot: "agent",
        binding: config.hotkey_agent ?? {
          key: "49",
          modifiers: ["fn"],
          label: "Fn+Space",
        },
      },
    ];
    for (const s of slots) {
      if (s.slot === targetSlot) continue;
      if (s.binding.label === binding.label) return s.slot;
    }
    return null;
  };

  const applyBinding = (slot: HotkeySlot, binding: HotkeyBinding, clearSlot?: HotkeySlot) => {
    const patch: Partial<typeof config> = {};
    if (slot === "transcribe") {
      updateConfig("hotkey_transcribe", binding);
      (patch as Record<string, unknown>).hotkey_transcribe = binding;
    }
    if (slot === "translate") {
      updateConfig("hotkey_translate", binding);
      (patch as Record<string, unknown>).hotkey_translate = binding;
    }
    if (slot === "cancel") {
      updateConfig("hotkey_cancel", binding);
      (patch as Record<string, unknown>).hotkey_cancel = binding;
    }
    if (slot === "agent") {
      updateConfig("hotkey_agent", binding);
      (patch as Record<string, unknown>).hotkey_agent = binding;
    }
    // Clear the conflicting slot if user chose override
    if (clearSlot) {
      const emptyBinding: HotkeyBinding = {
        key: "",
        modifiers: [],
        label: tStatic("settings.hotkeys.notSet"),
      };
      if (clearSlot === "transcribe") {
        updateConfig("hotkey_transcribe", emptyBinding);
        (patch as Record<string, unknown>).hotkey_transcribe = emptyBinding;
      }
      if (clearSlot === "translate") {
        updateConfig("hotkey_translate", emptyBinding);
        (patch as Record<string, unknown>).hotkey_translate = emptyBinding;
      }
      if (clearSlot === "cancel") {
        updateConfig("hotkey_cancel", emptyBinding);
        (patch as Record<string, unknown>).hotkey_cancel = emptyBinding;
      }
      if (clearSlot === "agent") {
        updateConfig("hotkey_agent", emptyBinding);
        (patch as Record<string, unknown>).hotkey_agent = emptyBinding;
      }
    }
    void saveConfig({ ...config, ...patch }, { silent: true }).then(() =>
      toast.success(t("settings.hotkeys.boundToast", { label: binding.label })),
    );
  };

  const applyBindingRef = useRef(applyBinding);
  applyBindingRef.current = applyBinding;
  const findConflictRef = useRef(findConflict);
  findConflictRef.current = findConflict;

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<{
        slot: string;
        binding: HotkeyBinding;
      }>("hotkey-captured", (event) => {
        const { slot, binding } = event.payload;
        const typedSlot = slot as HotkeySlot;
        setListening(null);
        setPreview(null);

        // Check for conflict
        const conflictSlot = findConflictRef.current(typedSlot, binding);
        if (conflictSlot) {
          setConflict({ slot: typedSlot, conflictSlot, binding });
          return;
        }

        applyBindingRef.current(typedSlot, binding);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCapture = async (
    slot: "transcribe" | "translate" | "cancel" | "agent",
  ) => {
    try {
      setPreview(null);
      await invoke("begin_hotkey_capture", { slot });
      setListening(slot);
    } catch (error) {
      toast.danger(
        t("settings.hotkeys.captureStartFailed", { msg: String(error) }),
      );
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
    slot: HotkeySlot;
    title: string;
    binding: HotkeyBinding;
  }[] = [
    {
      slot: "transcribe",
      title: t(HOTKEY_SLOT_KEYS.transcribe),
      binding: config.hotkey_transcribe,
    },
    {
      slot: "translate",
      title: t(HOTKEY_SLOT_KEYS.translate),
      binding: config.hotkey_translate,
    },
    {
      slot: "agent",
      title: t(HOTKEY_SLOT_KEYS.agent),
      binding: config.hotkey_agent ?? {
        key: "49",
        modifiers: ["fn"],
        label: "Fn+Space",
      },
    },
    {
      slot: "cancel",
      title: t(HOTKEY_SLOT_KEYS.cancel),
      binding: config.hotkey_cancel,
    },
  ];

  return (
    <SectionCard className="flex flex-col gap-4">
      <div>
        {rows.map((row) => {
          const active = listening === row.slot;
          const isConflicting = conflict?.conflictSlot === row.slot;
          return (
            <div
              key={row.slot}
              className={cn(
                "set-linerow flex-wrap",
                isConflicting && "rounded-lg ring-2 ring-warning/40 bg-warning/5",
              )}
            >
              <div className="min-w-0 type-ui">
                {row.title}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {active ? (
                  <>
                    <span className="type-meta text-accent-soft-foreground!">
                      {preview
                        ? t("settings.hotkeys.releaseToConfirm", { label: preview })
                        : t("settings.hotkeys.pressCombo")}
                    </span>
                    <Button size="sm" variant="secondary" onPress={() => void abortCapture()}>
                      {t("common.cancel")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="inline-flex h-auto min-h-0 items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-foreground shadow-none transition hover:bg-default data-[hovered=true]:bg-default"
                    aria-label={t("settings.hotkeys.changeAria", { title: row.title })}
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

      {conflict ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 flex flex-col gap-2">
          <div className="type-ui text-warning">
            <CircleAlert size={14} className="inline -mt-0.5 mr-1" />
            {t("settings.hotkeys.conflictTitle")}
          </div>
          <p className="type-meta">
            {t("settings.hotkeys.conflictBody", {
              label: conflict.binding.label,
              slot: t(HOTKEY_SLOT_KEYS[conflict.conflictSlot]),
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                applyBinding(conflict.slot, conflict.binding, conflict.conflictSlot);
                setConflict(null);
              }}
            >
              {t("settings.hotkeys.conflictOverride", {
                slot: t(HOTKEY_SLOT_KEYS[conflict.conflictSlot]),
              })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setConflict(null)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl bg-default/40 p-3">
        <div className="type-ui mb-1">{t("settings.hotkeys.fnNoteTitle")}</div>
        <p className="type-meta">{t("settings.hotkeys.fnNoteBody")}</p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onPress={() => {
            void invoke("open_permission_settings", { kind: "keyboard" }).catch(
              () => {
                void invoke("open_path_in_system", {
                  path: "/System/Library/PreferencePanes/Keyboard.prefPane",
                }).catch(() => {});
              },
            );
          }}
        >
          {t("settings.hotkeys.openKeyboardSettings")}
        </Button>
      </div>

      <div className="form-actions">
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={() => {
            void saveConfig(config, { silent: true }).then(() =>
              toast.success(t("common.saved")),
            );
          }}
        >
          <Save size={16} />
          {t("common.save")}
        </Button>
      </div>
    </SectionCard>
  );
}

function PermissionsPanel() {
  const t = useT();
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [needsRelaunch, setNeedsRelaunch] = useState(false);
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
      setHint(t("settings.perm.settingsAlreadyOpen"));
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
      setNeedsRelaunch(Boolean(result.needs_relaunch));
      // Open the matching Privacy pane when grant cannot finish in-dialog
      // (denied mic/speech, or AX/IM/Screen still off after the OS request).
      if (result.open_settings) {
        await openSettingsOnce(kind);
      }
      window.setTimeout(() => void refresh(), 1200);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
      setNeedsRelaunch(false);
    } finally {
      setBusy(null);
    }
  };

  const relaunch = () => {
    void invoke("relaunch_app").catch((error) => {
      setHint(error instanceof Error ? error.message : String(error));
    });
  };

  const isMac = (perms?.platform ?? "macos") === "macos";
  const exePath = perms?.executable_path;
  const firstUngranted = PERMS.find((item) => !(perms?.[item.kind] ?? false))
    ?.kind;

  if (!isMac) {
    return (
      <SectionCard>
        <p className="type-meta">{t("settings.perm.notMac")}</p>
      </SectionCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <div>
          {PERMS.map((item) => {
            const granted = perms?.[item.kind] ?? false;
            const Icon = item.icon;
            const isPrimaryCta = !granted && item.kind === firstUngranted;
            return (
              <div key={item.kind} className="perm-row">
                <div
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
                    granted
                      ? "bg-foreground/[0.06] text-foreground"
                      : "bg-default/40 text-muted",
                  )}
                >
                  <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="type-ui">{t(item.titleKey)}</div>
                  <div className="mt-0.5 type-meta">{t(item.blurbKey)}</div>
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
                    {granted
                      ? t("settings.perm.granted")
                      : t("settings.perm.notGranted")}
                  </span>
                  {!granted ? (
                    <Button
                      size="sm"
                      variant={isPrimaryCta ? "primary" : "secondary"}
                      className={isPrimaryCta ? "btn-press" : undefined}
                      isDisabled={busy !== null}
                      onPress={() => void authorize(item.kind)}
                    >
                      {t("settings.perm.authorize")}
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
        {needsRelaunch ? (
          <Button
            size="sm"
            variant="primary"
            className="btn-press mt-3"
            onPress={relaunch}
          >
            {t("settings.perm.relaunch")}
          </Button>
        ) : null}
      </SectionCard>

      <div className="rounded-2xl bg-surface px-3 py-1">
        <CollapseTrigger
          open={helpOpen}
          onToggle={() => setHelpOpen((v) => !v)}
        >
          {t("settings.perm.helpTitle")}
        </CollapseTrigger>
        <SoftCollapse open={helpOpen}>
          <div className="px-1 pb-3 pt-2">
            <ul className="flex flex-col gap-2 type-meta">
              <li>{t("settings.perm.helpLine1")}</li>
              <li>{t("settings.perm.helpLine2")}</li>
              <li>{t("settings.perm.helpLine3")}</li>
              <li>{t("settings.perm.helpLine4")}</li>
            </ul>
            {exePath ? (
              <p className="mt-3 break-all rounded-xl bg-default/40 px-3 py-2 font-mono type-micro !normal-case !tracking-normal text-foreground">
                {exePath}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onPress={() =>
                  void openSettingsOnce(firstUngranted ?? "accessibility").then(
                    () => window.setTimeout(() => void refresh(), 800),
                  )
                }
              >
                <ExternalLink size={14} />
                {t("settings.perm.openSystemSettings")}
              </Button>
              <Button size="sm" variant="secondary" onPress={relaunch}>
                {t("settings.perm.relaunch")}
              </Button>
            </div>
          </div>
        </SoftCollapse>
      </div>
    </div>
  );
}

function UpdatesPanel() {
  const t = useT();
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
      .catch(() => setInfo({ version: "0.1.0", name: tStatic("common.appName") }));
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
      toast.danger(t("settings.updates.downloadFailed", { msg }));
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
          notes: (r.body || r.name || t("settings.updates.noNotes"))
            .split("\n")
            .map((line) => line.replace(/^[-*#\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, 8),
        }))
      : CHANGELOG;

  const percent = progress?.percent ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard className="flex flex-col gap-4" title={t("settings.updates.currentVersion")}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="type-ui">
              {info?.name ?? t("common.appName")}{" "}
              <span className="text-muted">v{current}</span>
            </div>
            <p className="mt-1 type-meta">
              {updateAvailable
                ? t("settings.updates.newVersionFound", {
                    tag: latest?.tag_name ?? "",
                  }) + (asset ? ` · ${asset.name}` : "")
                : checking
                  ? t("settings.updates.checking")
                  : t("settings.updates.upToDate")}
            </p>
            {asset && updateAvailable ? (
              <p className="mt-1 type-meta">
                {t("settings.updates.packageSize", {
                  size: formatBytes(asset.size),
                })}
              </p>
            ) : null}
            {checkError ? (
              <p className="mt-1 text-[12px] text-danger">
                {t("settings.updates.checkFailed", { msg: checkError })}
              </p>
            ) : null}
            {installMessage ? (
              <p className="mt-1 type-meta">{installMessage}</p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={checking || downloading}
            onPress={() => void checkUpdates()}
          >
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
            {t("settings.updates.checkButton")}
          </Button>
        </div>

        {downloading ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between type-meta">
              <span>{t("settings.updates.downloadingPackage")}</span>
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
                  "--progress":
                    percent != null
                      ? Math.min(100, Math.max(0, percent)) / 100
                      : 0.3,
                } as CSSProperties}
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
              {downloading
                ? t("settings.updates.downloading")
                : t("settings.updates.downloadAndInstall", {
                    tag: latest?.tag_name ?? "",
                  })}
            </Button>
          ) : null}
          {updateAvailable && latest && !asset ? (
            <Button
              size="sm"
              variant="primary"
              onPress={() => void open(latest.html_url)}
            >
              <ExternalLink size={14} />
              {t("settings.updates.openReleasePage")}
            </Button>
          ) : null}
        </div>

        {/* link-grade actions — quiet mono links, not a row of equal buttons */}
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="dlink muted"
            onClick={() =>
              void invoke("open_update_download_dir").catch((error) => {
                toast.danger(
                  t("settings.updates.openDownloadDirFailed", {
                    msg: error instanceof Error ? error.message : String(error),
                  }),
                );
              })
            }
          >
            {t("settings.updates.downloadDir")}
          </button>
          <button
            type="button"
            className="dlink muted"
            onClick={() => void open(APP_RELEASES_URL)}
          >
            Releases
          </button>
          <button
            type="button"
            className="dlink muted"
            onClick={() => void open(APP_REPO_URL)}
          >
            {t("settings.updates.repo")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("settings.updates.releaseNotes")}>
        <div className="flex flex-col gap-5">
          {logEntries.map((entry) => (
            <article key={`${entry.version}-${entry.date}`} className="release-entry">
              <header className="mb-2 flex items-baseline gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  v{entry.version}
                </h3>
                {entry.date ? (
                  <time className="type-mono-meta">{entry.date}</time>
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
    </div>
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
  if (!path) return tStatic("settings.agent.notSet");
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
  const t = useT();
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
        toast.warning(t("settings.agent.binNotFound", { kind }));
      }
    } catch (e) {
      toast.danger(t("settings.agent.whichFailed", { msg: String(e) }));
    } finally {
      setDetecting(false);
    }
  };

  const refreshModels = async () => {
    setModelsRefreshing(true);
    try {
      await refreshAgentModels(true);
      toast.success(t("settings.agent.modelsRefreshed"));
    } catch (e) {
      toast.danger(t("settings.agent.refreshFailed", { msg: String(e) }));
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
    <div className="flex flex-col gap-4">
      <p className="-mb-1 type-meta">{t("settings.agent.intro")}</p>

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
                <div className="type-section">{meta.name}</div>
                <div className="mt-0.5 type-meta">
                  {meta.desc}
                  {" · "}
                  {configured ? (
                    <span className="text-success-soft-foreground">
                      {t("settings.agent.pathDetected")}
                    </span>
                  ) : (
                    <span>{t("settings.agent.pathNotDetected")}</span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant={isDefault ? "primary" : "secondary"}
                isDisabled={isDefault}
                onPress={() => setDefaultAgent(p)}
              >
                {isDefault
                  ? t("settings.agent.isDefault")
                  : t("settings.agent.setDefault")}
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
                  <Label>{t("settings.agent.defaultModel")}</Label>
                  <Select.Trigger className="flex items-center justify-between">
                    <Select.Value>
                      {() => {
                        const cur = p.model ?? "";
                        const opt = models.find((m) => m.id === cur);
                        return (
                          <span className="truncate">
                            {opt?.label ?? (cur || t("settings.agent.defaultOption"))}
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
                  aria-label={t("settings.agent.refreshModelsAria")}
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
                <Label>{t("settings.agent.binPath")}</Label>
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
        <SectionCard
          className="flex flex-col gap-2"
          title={t("settings.agent.trustedDirs")}
        >
          <div>
            {config.agent_trusted_dirs.map((dir) => (
              <div
                key={dir}
                className="set-linerow"
              >
                <span className="min-w-0 flex-1 truncate type-mono-meta text-foreground!">
                  {dir}
                </span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="h-auto min-h-0 rounded-md p-1 text-muted shadow-none hover:bg-default/50 hover:text-danger data-[hovered=true]:bg-default/50 data-[hovered=true]:text-danger"
                  aria-label={t("settings.agent.removeTrustedDirAria", { dir })}
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
          </div>
        </SectionCard>
        </Reveal>
      ) : null}

      <Reveal index={3}>
      <div className="form-actions">
        <Button
          className="form-actions-primary btn-press"
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          {t("common.save")}
        </Button>
      </div>
      </Reveal>
    </div>
  );
}

