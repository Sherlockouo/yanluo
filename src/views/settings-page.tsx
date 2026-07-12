import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  Kbd,
  Label,
  ListBox,
  Select,
  toast,
} from "@heroui/react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Ear,
  ExternalLink,
  FolderOpen,
  Keyboard,
  Mic,
  Monitor,
  Moon,
  RefreshCw,
  Save,
  Shield,
  Sun,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { cn } from "@/lib/cn";
import { useApp, type ThemeMode } from "@/app-context";
import { hotkeySegments, LANGUAGES, TRANSLATE_LANGUAGES } from "@/lib/constants";
import type { HotkeyBinding } from "@/types";
import {
  APP_RELEASES_URL,
  APP_REPO_URL,
  CHANGELOG,
  type ChangelogEntry,
} from "@/lib/changelog";

type SettingsTab = "general" | "hotkeys" | "permissions" | "updates";

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

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "常规" },
  { id: "hotkeys", label: "快捷键" },
  { id: "permissions", label: "权限" },
  { id: "updates", label: "更新" },
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

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as SettingsTab | null) ?? "general";
  const [tab, setTab] = useState<SettingsTab>(
    TABS.some((t) => t.id === initialTab) ? initialTab : "general",
  );

  useEffect(() => {
    const next = searchParams.get("tab") as SettingsTab | null;
    if (next && TABS.some((t) => t.id === next) && next !== tab) {
      setTab(next);
    }
  }, [searchParams, tab]);

  const selectTab = (id: SettingsTab) => {
    setTab(id);
    if (id === "general") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: id }, { replace: true });
    }
  };

  return (
    <PageShell>
      <PageHeader title="设置" />

      <div className="settings-tabs max-w-2xl" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={cn(
              "settings-tab",
              tab === item.id && "settings-tab-active",
            )}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "general" ? <GeneralPanel /> : null}
      {tab === "hotkeys" ? <HotkeysPanel /> : null}
      {tab === "permissions" ? <PermissionsPanel /> : null}
      {tab === "updates" ? <UpdatesPanel /> : null}
    </PageShell>
  );
}

function GeneralPanel() {
  const { config, updateConfig, saveConfig } = useApp();


  return (
    <>

      <SectionCard className="max-w-2xl flex flex-col gap-5" title="全局语言">
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
        <p className="text-[12px] leading-relaxed text-muted">
          主要说中文时选「简体中文」更稳；「自动」会按系统语言偏置，并推迟锁定英文，减轻开头被听成英文。
        </p>
        <Button
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          保存语言
        </Button>
      </SectionCard>

      <SectionCard className="max-w-2xl flex flex-col gap-5" title="录音源">
        <div className="grid gap-2">
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
                className={cn(
                  "flex items-center rounded-xl border px-3.5 py-3 text-left text-sm font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-default text-foreground"
                    : "border-border bg-transparent text-muted hover:bg-default/50",
                )}
                onClick={() => updateConfig("audio_capture_mode", item.id)}
              >
                {item.title}
              </button>
            );
          })}
        </div>
        <Button
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          保存录音源
        </Button>
      </SectionCard>
    </>
  );
}

function HotkeysPanel() {
  const { config, updateConfig, saveConfig } = useApp();
  const [listening, setListening] = useState<
    null | "transcribe" | "translate" | "cancel"
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

  const startCapture = async (slot: "transcribe" | "translate" | "cancel") => {
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
    slot: "transcribe" | "translate" | "cancel";
    title: string;
    binding: HotkeyBinding;
  }[] = [
    {
      slot: "transcribe",
      title: "转录",
      binding: config.hotkey_transcribe,
    },
    {
      slot: "translate",
      title: "翻译",
      binding: config.hotkey_translate,
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
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-foreground transition hover:border-foreground/25 hover:bg-default"
                      onClick={() => void startCapture(row.slot)}
                      title="修改快捷键"
                    >
                      {hotkeySegments(row.binding.label).map((part, i) => (
                        <span key={`${row.slot}-${part}-${i}`} className="inline-flex items-center gap-1">
                          {i > 0 ? <span className="text-muted">+</span> : null}
                          <Kbd>{part}</Kbd>
                        </span>
                      ))}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard className="max-w-2xl flex flex-col gap-5" title="翻译目标语言">
        <Select
          className="w-full"
          selectedKey={config.translate_target_language}
          onSelectionChange={(key) => {
            if (key == null) return;
            const next = {
              ...config,
              translate_target_language: String(key),
            };
            updateConfig("translate_target_language", String(key));
            void saveConfig(next, { silent: true });
          }}
        >
          <Label>目标语言</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {TRANSLATE_LANGUAGES.map(([value, label]) => (
                <ListBox.Item key={value} id={value} textValue={`${label} ${value}`}>
                  <span>{label}</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Button
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          保存
        </Button>
      </SectionCard>
    </>
  );
}

function PermissionsPanel() {
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);
  const [hint, setHint] = useState<string | null>(null);
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

  if (!isMac) {
    return (
      <SectionCard title="系统权限" className="max-w-2xl">
        <p className="text-[13px] text-muted">当前平台无需 macOS 隐私权限。</p>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        title="系统权限"
        description="点「去授权」即可。系统弹窗能完成的不会再强开设置。"
        className="max-w-2xl"
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
                  <div className="mt-0.5 text-[12px] text-muted">{item.blurb}</div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
                      variant="primary"
                      isDisabled={busy !== null}
                      onPress={() => void authorize(item.kind)}
                    >
                      去授权
                    </Button>
                  ) : null}
                  {!granted ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={busy !== null}
                      onPress={() =>
                        void openSettingsOnce(item.kind).then(() =>
                          window.setTimeout(() => void refresh(), 800),
                        )
                      }
                    >
                      <ExternalLink size={14} />
                      系统设置
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard className="max-w-2xl" title="说明">
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted">
          <li>
            · 正式签名安装包：麦克风 / 语音识别 / 屏幕录制通常随 Bundle ID
            保留，重装不必再点允许。
          </li>
          <li>
            · 辅助功能、输入监视由 macOS 按应用路径管理，重装或换路径后需重新打开开关（系统限制，应用无法代记）。
          </li>
          <li>
            · <code className="text-foreground">tauri dev</code>{" "}
            列表名多为{" "}
            <code className="text-foreground">asr-workshop</code>
            ；麦克风等需在打包 .app 中请求。
          </li>
        </ul>
        {exePath ? (
          <p className="mt-3 break-all rounded-xl border border-border bg-default/40 px-3 py-2 font-mono text-[11px] text-foreground">
            {exePath}
          </p>
        ) : null}
        {hint ? (
          <p className="mt-3 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
            {hint}
          </p>
        ) : null}
      </SectionCard>
    </>
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
      .catch(() => setInfo({ version: "0.1.0", name: "ASR Workshop" }));
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
              {info?.name ?? "ASR Workshop"}{" "}
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
                检查失败：{checkError}（仍显示本地 Release Log）
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

      <SectionCard className="max-w-2xl" title="Release Log">
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

