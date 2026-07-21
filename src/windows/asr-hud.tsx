import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import { Button, TextArea, TextField } from "@heroui/react";
import {
  AtSign,
  ChevronUp,
  FileText,
  FolderOpen,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import type {
  AgentKind,
  AgentPathInfo,
  AppConfig,
  AudioLevelPayload,
  FloatingPayload,
  TranscriptionResult,
} from "@/types";
import { defaultConfig } from "@/lib/constants";
import { useSmoothedRms } from "@/hooks/useAudioBars";
import { AudioBars } from "@/components/ui/audio-bars";
import { cn } from "@/lib/cn";
import { duration, easeOut, springBounce, springUI } from "@/lib/motion";

const CAPSULE_W = 420;
const CAPSULE_H = 56;
const AGENT_W = 520;
/** Pills row above + capsule row (attachments inline — no extra strip). */
const AGENT_BASE_H = 88;

type Attachment = AgentPathInfo & { at: boolean };

function applyHudTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.setAttribute("data-theme", theme);
  void invoke("set_floating_theme", { theme }).catch(() => {});
}

function shortName(name: string, max = 12): string {
  if (name.length <= max) return name;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const base = name.slice(0, Math.max(4, max - ext.length - 1));
  return `${base}…${ext}`;
}

function cwdLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const base = trimmed.split("/").filter(Boolean).pop() || trimmed;
  return shortName(base, 14);
}

async function loadPathInfo(path: string, at: boolean): Promise<Attachment> {
  const info = await invoke<AgentPathInfo>("get_path_info", { path });
  return { ...info, at: at || info.kind === "dir" };
}

/**
 * Floating HUD: ASR capsule + agent extras (rail / edit / dispatch).
 */
export function AsrHud() {
  const [payload, setPayload] = useState<FloatingPayload>({
    visible: false,
    state: "idle",
    text: "",
    rms: 0,
    bands: [],
  });
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [cwd, setCwd] = useState("");
  const [cwdHistory, setCwdHistory] = useState<string[]>([]);
  const [editText, setEditText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<"" | "agent" | "cwd">("");
  const [profiles, setProfiles] = useState(defaultConfig.agent_profiles);
  const [profileId, setProfileId] = useState(defaultConfig.agent_profile_id);
  const [fnLabel, setFnLabel] = useState(defaultConfig.hotkey_transcribe.label);

  const payloadRef = useRef(payload);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef(attachments);
  const agentRef = useRef(agent);
  const cwdRef = useRef(cwd);
  const pickerModeRef = useRef(pickerMode);
  const dispatchingRef = useRef(false);
  const attachDialogRef = useRef(false);
  const attachDialogGenRef = useRef(0);

  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  useEffect(() => {
    pickerModeRef.current = pickerMode;
  }, [pickerMode]);

  const isAgent = payload.intention === "agent";
  const editing = payload.state === "editing";
  const agentEditing = isAgent && editing;
  const confirmEditing = !isAgent && editing;
  const editTextRef = useRef(editText);
  const confirmingRef = useRef(false);
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** Ephemeral agent/HUD UI — must clear when HUD closes or new voice starts. */
  const resetAgentSessionUi = useCallback(() => {
    attachDialogGenRef.current += 1;
    attachDialogRef.current = false;
    setEditText("");
    setAttachments([]);
    setPickerMode("");
    setError(null);
    setBusy(false);
    confirmingRef.current = false;
    dispatchingRef.current = false;
  }, []);

  const agentLabel =
    profiles.find((p) => p.id === profileId)?.name ??
    (agent === "claude" ? "Claude" : "Codex");

  const resize = useCallback((agentMode: boolean) => {
    if (!agentMode) {
      void invoke("resize_floating_hud", {
        width: CAPSULE_W,
        height: CAPSULE_H,
      }).catch(() => {});
      return;
    }
    void invoke("resize_floating_hud", {
      width: AGENT_W,
      height: AGENT_BASE_H,
    }).catch(() => {});
    void getCurrentWindow()
      .setSize(new LogicalSize(AGENT_W, AGENT_BASE_H))
      .catch(() => {});
  }, []);

  useEffect(() => {
    resize(isAgent);
  }, [isAgent, resize]);

  useEffect(() => {
    if (!editing) return;
    setEditText(payload.text || "");
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
    void getCurrentWindow().setFocus().catch(() => {});
  }, [editing, payload.text]);

  const confirmTranscript = useCallback(async () => {
    if (confirmingRef.current) return;
    const text = editTextRef.current.trim();
    if (!text) {
      setError("无内容");
      return;
    }
    confirmingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoke("confirm_floating_transcript", { text });
      setEditText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      confirmingRef.current = false;
    }
  }, []);

  const cancelTranscript = useCallback(async () => {
    try {
      await invoke("cancel_floating_transcript");
    } catch {
      /* ignore */
    }
    setEditText("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!isAgent) setPickerMode("");
  }, [isAgent]);

  const startVoice = useCallback(async () => {
    setError(null);
    resetAgentSessionUi();
    setPayload((prev) => ({
      ...prev,
      text: "",
      committed: "",
      active: "",
      bands: [],
      rms: 0,
    }));
    try {
      const cfg = await invoke<AppConfig>("get_app_config").catch(
        () => defaultConfig,
      );
      if (
        cfg.agent_kind === "claude" ||
        cfg.agent_kind === "codex" ||
        cfg.agent_kind === "pi"
      ) {
        setAgent(cfg.agent_kind);
      }
      setCwd(cfg.agent_cwd || "");
      setCwdHistory(cfg.agent_cwd_history ?? []);
      setProfiles(
        cfg.agent_profiles?.length
          ? cfg.agent_profiles
          : defaultConfig.agent_profiles,
      );
      setProfileId(cfg.agent_profile_id || "claude");
      await invoke("start_recording", {
        chunkSec: cfg.chunk_size_sec ?? 1.5,
        rollbackTokens: cfg.unfixed_token_num ?? 5,
        language: cfg.language === "auto" ? null : cfg.language,
        mode: "agent",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [resetAgentSessionUi]);

  const stopVoice = useCallback(async () => {
    try {
      await invoke("stop_recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const cancelVoice = useCallback(async () => {
    try {
      await invoke("cancel_recording", { reason: "hud-cancel" });
    } catch {
      /* ignore */
    }
    resetAgentSessionUi();
  }, [resetAgentSessionUi]);

  const dispatch = useCallback(async (text: string) => {
    if (dispatchingRef.current) return;
    const voice = text.trim();
    const attachPaths = attachmentsRef.current.map((a) => a.path);
    if (!voice && attachPaths.length === 0) {
      setError("无内容");
      return;
    }
    const workDir = cwdRef.current.trim();
    dispatchingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoke("dispatch_agent", {
        agent: agentRef.current,
        prompt: voice || "（见附件）",
        cwd: workDir,
        attachments: attachPaths,
      });
      setEditText("");
      setAttachments([]);
      setPickerMode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      dispatchingRef.current = false;
    }
  }, []);

  const mergeAttachments = useCallback(async (paths: string[], at: boolean) => {
    const next: Attachment[] = [];
    for (const p of paths) {
      try {
        next.push(await loadPathInfo(p, at));
      } catch {
        /* skip */
      }
    }
    if (!next.length) return;
    setAttachments((prev) => {
      const merged = [...prev];
      for (const a of next) {
        if (!merged.some((x) => x.path === a.path)) merged.push(a);
      }
      return merged;
    });
    // Don't auto-open — user clicks chip → system default app.
  }, []);

  const pasteClipboard = useCallback(async () => {
    try {
      const paths = await invoke<string[]>("read_clipboard_attachments");
      if (!paths.length) {
        setError("剪贴板无文件/图片");
        return;
      }
      setError(null);
      await mergeAttachments(paths, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [mergeAttachments]);

  useEffect(() => {
    document.documentElement.setAttribute("data-floating", "1");
    const syncTheme = () => {
      applyHudTheme(
        localStorage.getItem("asr-theme") === "light" ? "light" : "dark",
      );
    };
    syncTheme();
    const onStorage = (event: StorageEvent) => {
      if (event.key === "asr-theme") syncTheme();
    };
    window.addEventListener("storage", onStorage);

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const add = (p: Promise<UnlistenFn>) => {
      void p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });
    };

    void invoke<FloatingPayload>("get_floating_status")
      .then((status) => {
        if (!disposed) {
          setPayload(status);
          if (
            status.agent === "claude" ||
            status.agent === "codex" ||
            status.agent === "pi"
          ) {
            setAgent(status.agent);
          }
          if (status.cwd) setCwd(status.cwd);
        }
      })
      .catch(() => {});

    void invoke<AppConfig>("get_app_config")
      .then((cfg) => {
        if (disposed) return;
        if (
          cfg.agent_kind === "claude" ||
          cfg.agent_kind === "codex" ||
          cfg.agent_kind === "pi"
        ) {
          setAgent(cfg.agent_kind);
        }
        if (cfg.agent_cwd) setCwd(cfg.agent_cwd);
        setCwdHistory(cfg.agent_cwd_history ?? []);
        setProfiles(
          cfg.agent_profiles?.length
            ? cfg.agent_profiles
            : defaultConfig.agent_profiles,
        );
        setProfileId(cfg.agent_profile_id || "claude");
        setFnLabel(
          cfg.hotkey_transcribe?.label ?? defaultConfig.hotkey_transcribe.label,
        );
      })
      .catch(() => {});

    add(
      listen<FloatingPayload>("floating-status", (event) => {
        setPayload((prev) => {
          const next = event.payload;
          // Same live session only — new recording/idle must wipe prior ASR.
          const sameSession =
            (prev.state === "recording" || prev.state === "processing") &&
            (next.state === "recording" || next.state === "processing") &&
            prev.intention === next.intention;
          const keepLive = sameSession && !next.text?.trim();
          if (
            next.state === "recording" &&
            !next.text?.trim() &&
            !sameSession
          ) {
            return {
              ...next,
              rms: next.rms > 0 ? next.rms : 0,
              bands: Array.isArray(next.bands) ? next.bands : [],
              committed: "",
              active: "",
              text: "",
            };
          }
          const keepMeter = sameSession;
          return {
            ...next,
            rms: next.rms > 0 ? next.rms : keepMeter ? prev.rms : next.rms,
            bands:
              Array.isArray(next.bands) && next.bands.length > 0
                ? next.bands
                : keepMeter
                  ? prev.bands
                  : next.bands ?? [],
            committed:
              next.committed != null && next.committed !== ""
                ? next.committed
                : keepLive
                  ? prev.committed
                  : (next.committed ?? ""),
            active:
              next.active != null && next.active !== ""
                ? next.active
                : keepLive
                  ? prev.active
                  : (next.active ?? ""),
            text: keepLive && prev.text?.trim() ? prev.text : next.text,
          };
        });
        if (
          event.payload.agent === "claude" ||
          event.payload.agent === "codex"
        ) {
          setAgent(event.payload.agent);
        }
        if (event.payload.cwd != null) setCwd(event.payload.cwd || "");
        if (!event.payload.visible || event.payload.state === "idle") {
          resetAgentSessionUi();
          void invoke("set_agent_picker", { mode: "", itemCount: 1 }).catch(
            () => {},
          );
        } else if (
          event.payload.visible &&
          event.payload.intention === "agent"
        ) {
          void invoke("restore_floating_interaction").catch(() => {});
        }
      }),
    );
    add(
      listen<AudioLevelPayload | number>("audio-level", (event) => {
        const raw = event.payload;
        if (typeof raw === "number") {
          if (!Number.isFinite(raw)) return;
          setPayload((prev) => ({
            ...prev,
            rms: Math.max(0, Math.min(1, raw)),
          }));
          return;
        }
        const rms = Number(raw?.rms);
        if (!Number.isFinite(rms)) return;
        const bands = Array.isArray(raw.bands)
          ? raw.bands.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
          : [];
        setPayload((prev) => ({
          ...prev,
          rms: Math.max(0, Math.min(1, rms)),
          bands,
        }));
      }),
    );
    add(
      listen<{
        text: string;
        committed?: string;
        active?: string;
      }>("partial-result", (event) =>
        setPayload((prev) => ({
          ...prev,
          visible: true,
          state: prev.state === "idle" ? "recording" : prev.state,
          text: event.payload.text,
          committed: event.payload.committed ?? "",
          active: event.payload.active ?? "",
          switching:
            event.payload.text.trim() === "" ? prev.switching : false,
        })),
      ),
    );
    add(
      listen("agent-voice-start", () => {
        void startVoice();
      }),
    );
    add(
      listen("agent-voice-stop", () => {
        void stopVoice();
      }),
    );
    add(
      listen("agent-voice-cancel", () => {
        // Rust already cancelled; clear local agent UI only.
        resetAgentSessionUi();
      }),
    );
    add(
      listen<string>("agent-picker", (event) => {
        const m = event.payload;
        setPickerMode(m === "agent" || m === "cwd" ? m : "");
      }),
    );
    add(
      listen("agent-focus-edit", () => {
        editRef.current?.focus();
      }),
    );
    add(
      listen<TranscriptionResult>("agent-transcription-result", (event) => {
        if (event.payload.error) {
          setError(event.payload.error);
          return;
        }
        setEditText(event.payload.text || "");
      }),
    );
    add(
      listen<{ text?: string; asr_text?: string }>("hud-edit-ready", (event) => {
        const t = event.payload?.text ?? event.payload?.asr_text ?? "";
        setEditText(t);
        setError(null);
        requestAnimationFrame(() => {
          editRef.current?.focus();
          editRef.current?.select();
        });
      }),
    );
    add(
      listen("hud-confirm-request", () => {
        void confirmTranscript();
      }),
    );
    add(
      listen("hud-accept-preview-request", () => {
        const p = payloadRef.current;
        const text =
          p.text?.trim() ||
          [p.committed, p.active]
            .map((s) => (s ?? "").trim())
            .filter(Boolean)
            .join(" ") ||
          "";
        void invoke("accept_floating_preview", {
          text: text || null,
        }).catch((e) => {
          console.error("[hud] accept preview failed", e);
        });
      }),
    );
    add(
      listen("hud-cancel-request", () => {
        void cancelTranscript();
      }),
    );
    add(
      listen<"light" | "dark">("theme-changed", (event) => {
        applyHudTheme(event.payload);
      }),
    );
    add(
      listen<AppConfig>("config-updated", (event) => {
        const cfg = event.payload;
        if (
          cfg.agent_kind === "claude" ||
          cfg.agent_kind === "codex" ||
          cfg.agent_kind === "pi"
        ) {
          setAgent(cfg.agent_kind);
        }
        if (cfg.agent_cwd != null) setCwd(cfg.agent_cwd || "");
        setCwdHistory(cfg.agent_cwd_history ?? []);
        setProfiles(
          cfg.agent_profiles?.length
            ? cfg.agent_profiles
            : defaultConfig.agent_profiles,
        );
        setProfileId(cfg.agent_profile_id || "claude");
        setFnLabel(
          cfg.hotkey_transcribe?.label ?? defaultConfig.hotkey_transcribe.label,
        );
      }),
    );

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlisteners.forEach((u) => u());
    };
  }, [startVoice, stopVoice, cancelVoice, confirmTranscript, cancelTranscript, resetAgentSessionUi]);

  const addAttach = async (asDir: boolean) => {
    if (attachDialogRef.current) return;
    attachDialogRef.current = true;
    const gen = attachDialogGenRef.current;
    // Defer past HeroUI/RAC press end — sync openDialog swallows pointerup and
    // leaves the HUD dead after ESC-cancel / reopen.
    await new Promise<void>((r) => {
      window.setTimeout(r, 0);
    });
    if (gen !== attachDialogGenRef.current) {
      attachDialogRef.current = false;
      return;
    }
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog(
        asDir
          ? {
              directory: true,
              multiple: false,
              defaultPath: cwd || undefined,
            }
          : {
              multiple: true,
              defaultPath: cwd || undefined,
            },
      );
    } catch {
      selected = null;
    } finally {
      if (gen === attachDialogGenRef.current) {
        attachDialogRef.current = false;
      }
      await invoke("restore_floating_interaction").catch(() => {});
      requestAnimationFrame(() => {
        editRef.current?.focus();
      });
    }
    if (gen !== attachDialogGenRef.current) return;
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (!paths.length) return;
    await mergeAttachments(paths, asDir);
  };

  const openAttach = useCallback((a: Attachment) => {
    void invoke("open_path_in_system", { path: a.path }).catch((e) => {
      console.error("[hud] open attach failed", e);
    });
  }, []);

  const toggleMenu = useCallback(
    (mode: "agent" | "cwd") => {
      if (pickerMode === mode) {
        void invoke("set_agent_picker", { mode: "", itemCount: 1 }).catch(
          () => {},
        );
        setPickerMode("");
      } else {
        const itemCount =
          mode === "agent"
            ? Math.max(profiles.length, 2)
            : 1 + cwdHistory.length;
        void invoke("set_agent_picker", { mode, itemCount }).catch(() => {});
        setPickerMode(mode);
      }
    },
    [pickerMode, profiles.length, cwdHistory.length],
  );

  const onEditKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (pickerModeRef.current) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (confirmEditing) {
        void confirmTranscript();
      } else {
        void dispatch(editText);
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirmEditing) {
        void cancelTranscript();
      } else {
        void invoke("hide_agent_hud").catch(() => {});
      }
    }
  };

  // Global keys while agent HUD visible (picker toggles + paste).
  useEffect(() => {
    if (!isAgent) return;
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key === ".") {
        event.preventDefault();
        toggleMenu("agent");
        return;
      }
      if (meta && event.key === "/") {
        event.preventDefault();
        toggleMenu("cwd");
        return;
      }
      if (meta && (event.key === "v" || event.key === "V")) {
        event.preventDefault();
        void pasteClipboard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAgent, pasteClipboard, toggleMenu]);

  const show =
    payload.visible &&
    payload.state !== "idle" &&
    (payload.state === "recording" ||
      payload.state === "processing" ||
      payload.state === "refining" ||
      payload.state === "editing");

  return (
    <div
      className="hud-root"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const t = event.target as HTMLElement;
        if (t.closest("input,textarea,button,a,[data-no-drag]")) return;
        void getCurrentWindow().startDragging().catch(() => {});
      }}
    >
      <AnimatePresence initial={false}>
        {show ? (
          <motion.div
            className={cn(
              "flex h-full w-full items-center justify-center",
              isAgent && "px-0",
            )}
            initial={{ opacity: 0, scale: 0.35 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={springBounce}
          >
          {isAgent ? (
            <AgentCapsule
              payload={payload}
              agentLabel={agentLabel}
              cwd={cwd}
              pickerMode={pickerMode}
              editText={editText}
              editing={agentEditing}
              busy={busy}
              error={error}
              editRef={editRef}
              attachments={attachments}
              onToggleAgent={() => toggleMenu("agent")}
              onToggleCwd={() => toggleMenu("cwd")}
              onStop={() => void stopVoice()}
              onEditChange={setEditText}
              onEditKey={onEditKey}
              onSend={() => void dispatch(editText)}
              onAddFile={() => void addAttach(false)}
              onAddDir={() => void addAttach(true)}
              onSelectAttach={openAttach}
              onRemoveAttach={(path) => {
                setAttachments((prev) => prev.filter((x) => x.path !== path));
              }}
            />
          ) : (
            <FloatingCapsule
              payload={payload}
              editText={editText}
              editing={confirmEditing}
              busy={busy}
              error={error}
              editRef={editRef}
              fnLabel={fnLabel}
              onEditChange={setEditText}
              onEditKey={onEditKey}
            />
          )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function AgentCapsule({
  payload,
  agentLabel,
  cwd,
  pickerMode,
  editText,
  editing,
  busy,
  error,
  editRef,
  attachments,
  onToggleAgent,
  onToggleCwd,
  onStop,
  onEditChange,
  onEditKey,
  onSend,
  onAddFile,
  onAddDir,
  onSelectAttach,
  onRemoveAttach,
}: {
  payload: FloatingPayload;
  agentLabel: string;
  cwd: string;
  pickerMode: "" | "agent" | "cwd";
  editText: string;
  editing: boolean;
  busy: boolean;
  error: string | null;
  editRef: RefObject<HTMLTextAreaElement | null>;
  attachments: Attachment[];
  onToggleAgent: () => void;
  onToggleCwd: () => void;
  onStop: () => void;
  onEditChange: (v: string) => void;
  onEditKey: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onAddFile: () => void;
  onAddDir: () => void;
  onSelectAttach: (a: Attachment) => void;
  onRemoveAttach: (path: string) => void;
}) {
  const recording = payload.state === "recording";
  const processing = payload.state === "processing";
  const smoothed = useSmoothedRms(payload.rms, recording);

  const committed = (payload.committed ?? "").trim();
  const active = (payload.active ?? "").trim();
  const live =
    committed || active
      ? `${committed}${committed && active ? " " : ""}${active}`
      : payload.text;

  const hint =
    error ??
    (busy
      ? "派发中…"
      : recording
        ? "说完再按 Fn+Space"
        : processing
          ? "识别中…"
          : "编辑后 Enter 派发");

  return (
    <div className="hud-agent" data-no-drag>
      <div className="hud-agent-rail">
        <div className="hud-agent-pills">
          <Button
            variant="ghost"
            className={cn(
              "hud-agent-pill h-auto min-h-0 gap-1 px-1.5 py-0.5 text-[11px] font-semibold shadow-none",
              "data-[hovered=true]:bg-transparent",
              pickerMode === "agent" && "is-open",
            )}
            aria-haspopup="listbox"
            aria-expanded={pickerMode === "agent"}
            aria-label="选择 Agent · ⌘."
            onPress={onToggleAgent}
          >
            <span>{agentLabel}</span>
            <ChevronUp size={10} strokeWidth={2.4} className="opacity-70" />
          </Button>
          <Button
            variant="ghost"
            className={cn(
              "hud-agent-pill h-auto min-h-0 gap-1 px-1.5 py-0.5 text-[11px] font-semibold shadow-none",
              "data-[hovered=true]:bg-transparent",
              pickerMode === "cwd" && "is-open",
            )}
            aria-haspopup="listbox"
            aria-expanded={pickerMode === "cwd"}
            aria-label={cwd ? `${cwd} · ⌘/` : "工作目录 · ⌘/"}
            onPress={onToggleCwd}
          >
            <FolderOpen size={11} strokeWidth={2.2} className="shrink-0 opacity-75" />
            <span className="truncate">{cwd ? cwdLabel(cwd) : "工作目录"}</span>
            <ChevronUp size={10} strokeWidth={2.4} className="opacity-70" />
          </Button>
        </div>
      </div>

      <div className="hud-agent-main">
        {processing ? (
          <span className="hud-spinner" aria-label="处理中" />
        ) : recording ? (
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springUI, delay: 0.12 }}
          >
            <AudioBars rms={smoothed} bands={payload.bands} active />
          </motion.div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="hud-agent-inline-attach">
            {attachments.map((a) => (
              <div
                key={a.path}
                className="hud-agent-chip hud-agent-attach-chip inline-flex max-w-28 items-center gap-1"
              >
                <Button
                  variant="ghost"
                  className="h-auto min-h-0 min-w-0 flex-1 justify-start gap-1 rounded-none bg-transparent px-0 py-0 shadow-none data-[hovered=true]:bg-transparent"
                  aria-label={
                    a.at || a.kind === "dir"
                      ? `@${shortName(a.name, 8)}`
                      : shortName(a.name, 8)
                  }
                  onPress={() => onSelectAttach(a)}
                >
                  {a.kind === "image" ? (
                    <img
                      src={convertFileSrc(a.path)}
                      alt=""
                      className="hud-agent-thumb"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : a.at || a.kind === "dir" ? (
                    <FolderOpen size={12} />
                  ) : (
                    <FileText size={12} />
                  )}
                  <span className="truncate">
                    {a.at || a.kind === "dir"
                      ? `@${shortName(a.name, 8)}`
                      : shortName(a.name, 8)}
                  </span>
                </Button>
                <Button
                  isIconOnly
                  variant="ghost"
                  aria-label="移除"
                  className="hud-agent-chip-x h-auto min-h-0 w-auto min-w-0 p-0 shadow-none"
                  onPress={() => onRemoveAttach(a.path)}
                >
                  <X size={10} />
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {editing ? (
          <TextField
            aria-label={hint}
            value={editText}
            onChange={onEditChange}
            isDisabled={busy}
            className="min-w-0 flex-1"
          >
            <TextArea
              ref={editRef}
              rows={1}
              placeholder={hint}
              className="hud-agent-input"
              onKeyDown={onEditKey}
            />
          </TextField>
        ) : (
          <div className="hud-text-viewport min-w-0 flex-1">
            <span className="hud-text-scroll">
              {live.trim() || (
                <span className="hud-agent-hint">{hint}</span>
              )}
            </span>
          </div>
        )}

        <div className="hud-agent-tools">
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            className="hud-agent-icon-btn"
            aria-label="@ 目录"
            onPress={onAddDir}
          >
            <AtSign size={15} strokeWidth={2.25} />
          </Button>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            className="hud-agent-icon-btn"
            aria-label="附件 · ⌘V 粘贴"
            onPress={onAddFile}
          >
            <Paperclip size={15} strokeWidth={2.25} />
          </Button>
          {recording ? (
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              className="hud-agent-icon-btn is-danger"
              aria-label="停止"
              onPress={onStop}
            >
              <Square size={12} fill="currentColor" />
            </Button>
          ) : null}
          {editing ? (
            <Button
              isIconOnly
              className="hud-agent-send"
              aria-label="派发 Enter"
              isDisabled={busy}
              onPress={onSend}
            >
              <Send size={14} strokeWidth={2.4} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FloatingCapsule({
  payload,
  editText,
  editing,
  busy,
  error,
  editRef,
  fnLabel,
  onEditChange,
  onEditKey,
}: {
  payload: FloatingPayload;
  editText: string;
  editing: boolean;
  busy: boolean;
  error: string | null;
  editRef: RefObject<HTMLTextAreaElement | null>;
  fnLabel?: string;
  onEditChange: (v: string) => void;
  onEditKey: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const refining = payload.state === "refining";
  const processing = payload.state === "processing";
  const recording = payload.state === "recording";
  const switching = Boolean(payload.switching);
  const translating = payload.intention === "translate";
  const smoothed = useSmoothedRms(payload.rms, recording);
  const lastTextRef = useRef("");
  const textViewportRef = useRef<HTMLDivElement>(null);
  const sizedRef = useRef(false);

  if (payload.text.trim()) {
    lastTextRef.current = payload.text;
  } else if (recording || switching) {
    lastTextRef.current = "";
  }

  const committed = (payload.committed ?? "").trim();
  const active = (payload.active ?? "").trim();
  const hasSplit = Boolean(committed || active);

  const sourceText =
    payload.text.trim() ||
    (refining || processing ? lastTextRef.current : "");
  const displayText = switching ? "" : sourceText;

  const justRefined = processing && !switching && Boolean(displayText.trim());
  const loading =
    !editing && (refining || switching || (processing && !justRefined));

  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (sizedRef.current) return;
    sizedRef.current = true;
    const win = getCurrentWindow();
    void win.setSize(new LogicalSize(CAPSULE_W, CAPSULE_H)).catch(() => {});
    void invoke("recenter_floating_hud", { width: CAPSULE_W }).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    if (editing) return;
    const el = textViewportRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setOverflowing(el.scrollWidth > el.clientWidth + 1);
  }, [displayText, committed, active, loading, switching, editing]);

  const hint = error ?? (busy ? "确认中…" : "");

  return (
    <div
      className={cn(
        "hud-capsule",
        loading && "hud-capsule-refining",
        switching && "hud-capsule-switching",
        justRefined && "hud-capsule-refined",
      )}
      style={{ width: "100%", height: CAPSULE_H }}
    >
      <div className="hud-inner">
        {loading ? (
          <span
            className="hud-spinner"
            aria-label={
              switching ? "切换目标语言" : translating ? "翻译中" : "处理中"
            }
          />
        ) : busy ? (
          <span className="hud-spinner" aria-label="确认中" />
        ) : recording ? (
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springUI, delay: 0.12 }}
          >
            <AudioBars
              rms={smoothed}
              bands={payload.bands}
              active
              className="hud-brand-bars"
            />
          </motion.div>
        ) : (
          <div className="hud-brand-bars" aria-hidden>
            <div className="hud-brand-bar" />
            <div className="hud-brand-bar" />
            <div className="hud-brand-bar" />
            <div className="hud-brand-bar" />
            <div className="hud-brand-bar" />
          </div>
        )}
        <span className="hud-colon" aria-hidden>
          :
        </span>
        {editing ? (
          <TextField
            aria-label={hint || "确认或修改后按 Fn / Enter"}
            value={editText}
            onChange={onEditChange}
            isDisabled={busy}
            className="min-w-0 flex-1"
          >
            <TextArea
              ref={editRef}
              rows={1}
              placeholder={hint || "确认或修改后按 Fn / Enter"}
              className="hud-agent-input flex"
              data-no-drag
              onKeyDown={onEditKey}
            />
          </TextField>
        ) : (
          <div
            ref={textViewportRef}
            className={cn(
              "hud-text-viewport",
              overflowing && "hud-text-overflow",
              loading && "hud-text-refining",
              switching && "hud-text-switching",
              justRefined && "hud-text-refined",
            )}
          >
            <motion.span
              key={switching ? "switching" : "content"}
              className="hud-text-scroll"
              initial={{ opacity: 0.7 }}
              animate={{ opacity: 1 }}
              transition={{ duration: duration.fast, ease: easeOut }}
            >
              {switching ? (
                "切换中"
              ) : hasSplit && recording && !loading ? (
                <>
                  {committed ? (
                    <span className="hud-text-committed">{committed}</span>
                  ) : null}
                  {committed && active ? " " : null}
                  {active ? (
                    <span className="hud-text-active">{active}</span>
                  ) : null}
                </>
              ) : (
                displayText ||
                (loading ? (translating ? "翻译中" : "处理中") : "")
              )}
              {(loading || switching) && (displayText || switching) ? (
                <span className="hud-loading-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </motion.span>
          </div>
        )}
        {editing && fnLabel ? (
          <span className="hud-fn-badge">{fnLabel}</span>
        ) : null}
      </div>
    </div>
  );
}
