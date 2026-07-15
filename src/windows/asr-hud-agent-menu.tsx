import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import type { AgentKind, AgentProfile, AppConfig } from "@/types";
import { defaultConfig } from "@/lib/constants";
import { cn } from "@/lib/cn";

function applyHudTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.setAttribute("data-theme", theme);
  void invoke("set_floating_theme", { theme }).catch(() => {});
}

function cwdLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const base = trimmed.split("/").filter(Boolean).pop() || trimmed;
  if (base.length <= 16) return base;
  return `${base.slice(0, 12)}…`;
}

function normalizeProfiles(list: AgentProfile[] | undefined): AgentProfile[] {
  if (list?.length) return list;
  return defaultConfig.agent_profiles;
}

/**
 * Outside-HUD picker window. Solid CSS panel (no vibrancy).
 * Mode via agent-picker event + get_agent_picker — never set_focus from Rust.
 */
export function AsrHudAgentMenu() {
  const [mode, setMode] = useState<"" | "agent" | "cwd">("");
  const [profiles, setProfiles] = useState<AgentProfile[]>(
    defaultConfig.agent_profiles,
  );
  const [profileId, setProfileId] = useState(defaultConfig.agent_profile_id);
  const [cwd, setCwd] = useState("");
  const [cwdHistory, setCwdHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(0);

  const applyCfg = useCallback((cfg: AppConfig) => {
    setProfiles(normalizeProfiles(cfg.agent_profiles));
    setProfileId(cfg.agent_profile_id || "claude");
    setCwd(cfg.agent_cwd || "");
    setCwdHistory(cfg.agent_cwd_history ?? []);
  }, []);

  const loadCfg = useCallback(() => {
    void invoke<AppConfig>("get_app_config")
      .then(applyCfg)
      .catch(() => {});
  }, [applyCfg]);

  const applyMode = useCallback(
    (raw: string) => {
      if (raw === "agent" || raw === "cwd") {
        setMode(raw);
        setHi(0);
        loadCfg();
      } else {
        setMode("");
      }
    },
    [loadCfg],
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-floating", "1");
    document.documentElement.setAttribute("data-floating-agent-menu", "1");
    const syncTheme = () => {
      applyHudTheme(
        localStorage.getItem("asr-theme") === "light" ? "light" : "dark",
      );
    };
    syncTheme();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "asr-theme") syncTheme();
    };
    window.addEventListener("storage", onStorage);

    let disposed = false;
    const uns: UnlistenFn[] = [];
    const add = (p: Promise<UnlistenFn>) => {
      void p.then((u) => {
        if (disposed) u();
        else uns.push(u);
      });
    };

    loadCfg();
    void invoke<string>("get_agent_picker")
      .then(applyMode)
      .catch(() => {});

    add(
      listen<string>("agent-picker", (event) => {
        applyMode(event.payload);
      }),
    );
    add(
      listen<AppConfig>("config-updated", (event) => {
        applyCfg(event.payload);
      }),
    );
    add(
      listen<"light" | "dark">("theme-changed", (event) => {
        applyHudTheme(event.payload);
      }),
    );

    // Poll briefly after mount — catches raise-before-listen race.
    const t0 = window.setTimeout(() => {
      void invoke<string>("get_agent_picker").then(applyMode).catch(() => {});
    }, 80);
    const t1 = window.setTimeout(() => {
      void invoke<string>("get_agent_picker").then(applyMode).catch(() => {});
    }, 200);

    return () => {
      disposed = true;
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.removeEventListener("storage", onStorage);
      uns.forEach((u) => u());
    };
  }, [applyCfg, applyMode, loadCfg]);

  const cwdOptions = (() => {
    const list = [...cwdHistory];
    if (cwd && !list.includes(cwd)) list.unshift(cwd);
    return list;
  })();

  const agentItems = normalizeProfiles(profiles);
  const itemCount =
    mode === "agent"
      ? Math.max(agentItems.length, 1)
      : mode === "cwd"
        ? Math.max(1 + cwdOptions.length, 1)
        : 0;

  // Resize only — never re-open via set_agent_picker (focus/loop bugs).
  useEffect(() => {
    if (!mode || itemCount < 1) return;
    void invoke("resize_floating_agent_menu", {
      itemCount,
    }).catch(() => {});
  }, [mode, itemCount]);

  const close = useCallback(() => {
    setMode("");
    void invoke("set_agent_picker", { mode: "", itemCount: 1 }).catch(() => {});
  }, []);

  const pickProfile = useCallback(
    (p: AgentProfile) => {
      const kind = (
        p.kind === "codex" || p.kind === "pi" || p.kind === "claude"
          ? p.kind
          : "claude"
      ) as AgentKind;
      void invoke("set_agent_defaults", {
        agent: kind,
        cwd: null,
        profileId: p.id,
      }).catch(() => {});
      close();
    },
    [close],
  );

  const pickCwd = useCallback(
    (path: string) => {
      void invoke("set_agent_defaults", { agent: null, cwd: path }).catch(
        () => {},
      );
      close();
    },
    [close],
  );

  const addCwd = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: cwd || undefined,
    }).catch(() => null);
    const path = typeof selected === "string" ? selected : null;
    if (!path) return;
    pickCwd(path);
  }, [cwd, pickCwd]);

  const pickIndex = useCallback(
    (idx: number) => {
      if (mode === "agent") {
        const p = agentItems[idx];
        if (p) pickProfile(p);
      } else if (mode === "cwd") {
        if (idx === 0) void addCwd();
        else {
          const path = cwdOptions[idx - 1];
          if (path) pickCwd(path);
        }
      }
    },
    [mode, agentItems, cwdOptions, pickProfile, pickCwd, addCwd],
  );

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Math.max(itemCount, 1);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((i) => (i + 1) % n);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((i) => (i - 1 + n) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        pickIndex(hi);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, itemCount, hi, pickIndex, close]);

  if (!mode) {
    return <div className="hud-agent-menu-root is-empty" />;
  }

  return (
    <div className="hud-agent-menu-root" data-no-drag>
      <div className="hud-agent-menu-ext" role="listbox">
        {mode === "agent"
          ? agentItems.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={hi === i || p.id === profileId}
                className={cn(
                  "hud-agent-menu-item",
                  (hi === i || p.id === profileId) && "is-active",
                )}
                onMouseEnter={() => setHi(i)}
                onClick={() => pickProfile(p)}
              >
                {p.name || p.id}
              </button>
            ))
          : null}
        {mode === "cwd" ? (
          <>
            <button
              type="button"
              role="option"
              aria-selected={hi === 0}
              className={cn("hud-agent-menu-item", hi === 0 && "is-active")}
              onMouseEnter={() => setHi(0)}
              onClick={() => void addCwd()}
            >
              <Plus size={12} strokeWidth={2.4} />
              <span>添加目录</span>
            </button>
            {cwdOptions.map((path, i) => (
              <button
                key={path}
                type="button"
                role="option"
                title={path}
                aria-selected={hi === i + 1}
                className={cn(
                  "hud-agent-menu-item",
                  hi === i + 1 && "is-active",
                )}
                onMouseEnter={() => setHi(i + 1)}
                onClick={() => pickCwd(path)}
              >
                <span className="truncate">{cwdLabel(path)}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
