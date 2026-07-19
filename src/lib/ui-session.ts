/** Session memory for tab selection + per-tab scroll (.app-content). */

export type DraftMode = "file" | "live" | "translate" | "history";

export type SettingsTab =
  | "general"
  | "asr"
  | "polish"
  | "agent"
  | "system"
  | "updates";

export type DraftUiSession = {
  mode: DraftMode;
  scroll: Partial<Record<DraftMode, number>>;
};

export type SettingsUiSession = {
  tab: SettingsTab;
  sub?: string;
  scroll: Record<string, number>;
};

const DRAFT_KEY = "yanluo:draft-ui";
const SETTINGS_KEY = "yanluo:settings-ui";

const DRAFT_MODES: DraftMode[] = ["file", "live", "translate", "history"];
const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "asr",
  "polish",
  "agent",
  "system",
  "updates",
];

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

export function isDraftMode(v: string | null | undefined): v is DraftMode {
  return !!v && DRAFT_MODES.includes(v as DraftMode);
}

export function isSettingsTab(v: string | null | undefined): v is SettingsTab {
  return !!v && SETTINGS_TABS.includes(v as SettingsTab);
}

/** Scroll storage key: `tab` or `tab:sub`. */
export function settingsScrollKey(tab: string, sub?: string | null): string {
  return sub ? `${tab}:${sub}` : tab;
}

export function readDraftUi(): DraftUiSession | null {
  const raw = readJson<Partial<DraftUiSession>>(DRAFT_KEY);
  if (!raw || !isDraftMode(raw.mode)) return null;
  return {
    mode: raw.mode,
    scroll:
      raw.scroll && typeof raw.scroll === "object" ? { ...raw.scroll } : {},
  };
}

export function writeDraftUi(next: DraftUiSession): void {
  writeJson(DRAFT_KEY, next);
}

export function patchDraftUi(
  patch: Partial<DraftUiSession> & {
    scrollPatch?: Partial<Record<DraftMode, number>>;
  },
): DraftUiSession {
  const prev = readDraftUi() ?? { mode: "file" as DraftMode, scroll: {} };
  const next: DraftUiSession = {
    mode: patch.mode ?? prev.mode,
    scroll: {
      ...prev.scroll,
      ...(patch.scroll ?? {}),
      ...(patch.scrollPatch ?? {}),
    },
  };
  writeDraftUi(next);
  return next;
}

export function readSettingsUi(): SettingsUiSession | null {
  const raw = readJson<Partial<SettingsUiSession>>(SETTINGS_KEY);
  if (!raw || !isSettingsTab(raw.tab)) return null;
  return {
    tab: raw.tab,
    sub: typeof raw.sub === "string" ? raw.sub : undefined,
    scroll:
      raw.scroll && typeof raw.scroll === "object" ? { ...raw.scroll } : {},
  };
}

export function writeSettingsUi(next: SettingsUiSession): void {
  writeJson(SETTINGS_KEY, next);
}

export function patchSettingsUi(
  patch: Partial<SettingsUiSession> & {
    scrollPatch?: Record<string, number>;
  },
): SettingsUiSession {
  const prev = readSettingsUi() ?? {
    tab: "general" as SettingsTab,
    scroll: {},
  };
  const next: SettingsUiSession = {
    tab: patch.tab ?? prev.tab,
    sub: "sub" in patch ? patch.sub : prev.sub,
    scroll: {
      ...prev.scroll,
      ...(patch.scroll ?? {}),
      ...(patch.scrollPatch ?? {}),
    },
  };
  writeSettingsUi(next);
  return next;
}

/** Layout stage scroller — sole page scroll container. */
export function getAppContentScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(".app-content");
}

export function readScrollTop(): number {
  return getAppContentScroller()?.scrollTop ?? 0;
}

export function writeScrollTop(y: number): void {
  const el = getAppContentScroller();
  if (!el) return;
  el.scrollTop = Math.max(0, y);
}

/** Apply scroll after paint so remounted panel height is ready (no smooth). */
export function restoreScrollTop(y: number | undefined): void {
  if (y == null || !Number.isFinite(y)) {
    writeScrollTop(0);
    return;
  }
  const apply = () => writeScrollTop(y);
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}
