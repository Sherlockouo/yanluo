import { useCallback, useEffect, useState } from "react";
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
  APP_REPO,
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

type GhRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
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
  description: string;
  icon: typeof Shield;
}[] = [
  {
    kind: "accessibility",
    title: "辅助功能",
    description: "Fn 全局监听与粘贴到前台应用需要此权限。",
    icon: Shield,
  },
  {
    kind: "input_monitoring",
    title: "输入监视",
    description: "监听 Fn / Shift+Fn 与 Esc 取消。",
    icon: Keyboard,
  },
  {
    kind: "microphone",
    title: "麦克风",
    description: "录音转写需要麦克风访问。",
    icon: Mic,
  },
  {
    kind: "speech_recognition",
    title: "语音识别",
    description: "使用 Apple Speech 时需要此权限。",
    icon: Ear,
  },
  {
    kind: "screen_recording",
    title: "屏幕录制",
    description: "「只录系统 / 两者都录」时采集系统播放声音（不保存画面）。",
    icon: Monitor,
  },
];

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <PageShell>
      <PageHeader title="设置" subtitle="常规、快捷键、权限与版本更新。" />

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
            onClick={() => setTab(item.id)}
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
  const { config, updateConfig, saveConfig, theme, setTheme } = useApp();

  const setThemeMode = (next: ThemeMode) => {
    setTheme(next);
  };

  return (
    <>
      <SectionCard
        className="max-w-2xl flex flex-col gap-5"
        title="外观"
        description="主题对主窗口与浮动胶囊同时生效。"
      >
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { id: "dark", label: "深色", icon: Moon },
              { id: "light", label: "浅色", icon: Sun },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = theme === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-default text-foreground"
                    : "border-border bg-transparent text-muted hover:bg-default/50",
                )}
                onClick={() => setThemeMode(item.id)}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        className="max-w-2xl flex flex-col gap-5"
        title="全局语言"
        description="影响 Fn 录音、文件转写与系统菜单语言选项。"
      >
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
        <Button
          fullWidth
          variant="primary"
          onPress={() => void saveConfig()}
        >
          <Save size={16} />
          保存语言
        </Button>
      </SectionCard>

      <SectionCard
        className="max-w-2xl flex flex-col gap-5"
        title="录音源"
        description="Fn / 快捷键录音采集哪里的声音。「只录系统 / 两者都录」走数字通路抓取播放内容，不是会议室那种回声消除；需要屏幕录制权限。"
      >
        <div className="grid gap-2">
          {(
            [
              {
                id: "external" as const,
                title: "只录外部",
                hint: "麦克风输入（默认，debug 最稳）",
              },
              {
                id: "system" as const,
                title: "只录系统",
                hint: "扬声器正在播放的声音（ScreenCaptureKit，需屏幕录制）",
              },
              {
                id: "both" as const,
                title: "两者都录",
                hint: "麦克风 + 系统播放混合；系统音失败时自动退回只录外部",
              },
            ] as const
          ).map((item) => {
            const active =
              (config.audio_capture_mode ?? "external") === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex flex-col items-start rounded-xl border px-3.5 py-3 text-left transition-colors",
                  active
                    ? "border-foreground/20 bg-default text-foreground"
                    : "border-border bg-transparent text-muted hover:bg-default/50",
                )}
                onClick={() => updateConfig("audio_capture_mode", item.id)}
              >
                <span className="text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className="mt-0.5 text-[12px] text-muted">{item.hint}</span>
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
    description: string;
    binding: HotkeyBinding;
  }[] = [
    {
      slot: "transcribe",
      title: "转录",
      description: "识别后粘贴原文（可走 LLM 纠错）",
      binding: config.hotkey_transcribe,
    },
    {
      slot: "translate",
      title: "翻译",
      description: "识别后翻译为目标语言并粘贴（需配置 LLM）",
      binding: config.hotkey_translate,
    },
    {
      slot: "cancel",
      title: "取消",
      description: "丢弃当前录音，不粘贴",
      binding: config.hotkey_cancel,
    },
  ];

  return (
    <>
      <SectionCard
        className="max-w-2xl flex flex-col gap-4"
        title="全局快捷键"
        description="支持多键组合（⇧+Fn、⌃+Space 等）。Fn 组合在松开 Fn 时启动（可先按 Fn 再按 ⇧）；普通键在按下时启动。Esc 取消录制。"
      >
        <div className="flex flex-col gap-3">
          {rows.map((row) => {
            const active = listening === row.slot;
            return (
              <div
                key={row.slot}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-default/30 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {row.title}
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {row.description}
                  </p>
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
                      title="点击修改快捷键"
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
        {listening ? (
          <p className="text-[12px] text-muted">
            正在录制「{rows.find((r) => r.slot === listening)?.title}」。可先按
            ⇧/⌃/⌥/⌘，再按 Fn 或字母键；任意顺序按住 Fn 再加修饰键，松开 Fn 即可。
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        className="max-w-2xl flex flex-col gap-5"
        title="翻译目标语言"
        description="翻译快捷键会将识别结果翻译到此语言。"
      >
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
                <ListBox.Item key={value} id={value} textValue={label}>
                  {label}
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

  const requestThenOpen = async (kind: PermKind) => {
    setBusy(kind);
    setHint(null);
    try {
      // Request first so this binary appears in the Privacy list, then open the pane.
      const message = await invoke<string>("request_permission", { kind });
      setHint(message);
      await invoke("open_permission_settings", { kind });
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
      <SectionCard
        title="系统权限"
        description="当前平台无需 macOS 隐私权限。"
        className="max-w-2xl"
      >
        <p className="text-[13px] leading-relaxed text-muted">
          辅助功能 / 输入监视 / Apple Speech 仅在 macOS 使用。Linux / Windows
          请直接配置麦克风与云端凭证。
        </p>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        title="系统权限"
        description="先点「请求权限」让本进程出现在列表里，再打开系统设置打开开关。"
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
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                    {item.description}
                  </p>
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
                      isDisabled={busy === item.kind}
                      onPress={() => void requestThenOpen(item.kind)}
                    >
                      请求权限
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy === item.kind}
                    onPress={() =>
                      void invoke("open_permission_settings", {
                        kind: item.kind,
                      }).then(() =>
                        window.setTimeout(() => void refresh(), 800),
                      )
                    }
                  >
                    <ExternalLink size={14} />
                    系统设置
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        className="max-w-2xl"
        title="调试：列表里找不到本应用？"
        description="打开系统设置不会自动登记进程；必须先「请求权限」或实际录音一次。"
      >
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted">
          <li>
            · 必须先点「请求权限」——只打开系统设置不会把本应用登记进列表。
          </li>
          <li>
            · <code className="text-foreground">tauri dev</code>{" "}
            时列表名通常是{" "}
            <code className="text-foreground">asr-workshop</code>
            ，不是「ASR Workshop」。
          </li>
          <li>
            · 麦克风 / 语音识别必须在打包后的 .app 里请求——
            <code className="text-foreground">tauri dev</code>{" "}
            裸二进制没有 Info.plist，系统会直接闪退（TCC）。
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
  const [remote, setRemote] = useState<GhRelease[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [latest, setLatest] = useState<GhRelease | null>(null);

  useEffect(() => {
    void invoke<AppInfo>("get_app_info")
      .then(setInfo)
      .catch(() => setInfo({ version: "0.1.0", name: "ASR Workshop" }));
  }, []);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${APP_REPO}/releases?per_page=12`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!res.ok) {
        throw new Error(`GitHub API ${res.status}`);
      }
      const data = (await res.json()) as GhRelease[];
      const published = data.filter((r) => !r.draft);
      setRemote(published);
      setLatest(published.find((r) => !r.prerelease) ?? published[0] ?? null);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkUpdates();
  }, [checkUpdates]);

  const current = info?.version ?? "0.1.0";
  const updateAvailable =
    latest != null && compareSemver(latest.tag_name, current) > 0;

  const logEntries: ChangelogEntry[] =
    remote.length > 0
      ? remote.map((r) => ({
          version: r.tag_name.replace(/^v/i, ""),
          date: r.published_at
            ? r.published_at.slice(0, 10)
            : "",
          notes: (r.body || r.name || "无说明")
            .split("\n")
            .map((line) => line.replace(/^[-*#\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, 8),
        }))
      : CHANGELOG;

  return (
    <>
      <SectionCard
        className="max-w-2xl flex flex-col gap-4"
        title="当前版本"
        description="检查 GitHub Releases 获取更新与发版说明。"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {info?.name ?? "ASR Workshop"}{" "}
              <span className="text-muted">v{current}</span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {updateAvailable
                ? `发现新版本 ${latest?.tag_name}`
                : checking
                  ? "正在检查更新…"
                  : "已是最新，或尚未发布远程版本。"}
            </p>
            {checkError ? (
              <p className="mt-1 text-[12px]" style={{ color: "var(--danger)" }}>
                检查失败：{checkError}（仍显示本地 Release Log）
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={checking}
            onPress={() => void checkUpdates()}
          >
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
            检查更新
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {updateAvailable && latest ? (
            <Button
              size="sm"
              variant="primary"
              onPress={() => void open(latest.html_url)}
            >
              <Download size={14} />
              下载 {latest.tag_name}
            </Button>
          ) : null}
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

      <SectionCard
        className="max-w-2xl"
        title="Release Log"
        description="最近发版说明。"
      >
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
