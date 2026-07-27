import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "@heroui/react";
import { useNavigate } from "react-router-dom";
import type {
  AgentJob,
  AppConfig,
  FloatingPayload,
  HistoryEntry,
  RecState,
  TranscriptionResult,
} from "@/types";
import { defaultConfig, seedLlmCredentials } from "@/lib/constants";
import type { AgentModelsCache } from "@/lib/constants";
import {
  harvestFromTriples,
} from "@/lib/learn-cases";
import {
  type LearnCandidate,
} from "@/lib/learn-from-refine";
import {
  mergePendingLearn,
  type PendingLearn,
} from "@/lib/pending-learn";
import { useT } from "@/lib/i18n";
import { lookupRustMsg } from "@/lib/i18n/rust-msg";

export type ThemeMode = "dark" | "light";

type AppContextValue = {
  config: AppConfig;
  history: HistoryEntry[];
  agentJobs: AgentJob[];
  agentModels: AgentModelsCache | null;
  refreshAgentModels: (force?: boolean) => Promise<void>;
  state: RecState;
  modelLoaded: boolean;
  modelLoading: boolean;
  newTerm: string;
  theme: ThemeMode;
  pendingLearn: PendingLearn | null;
  setNewTerm: (value: string) => void;
  setTheme: (theme: ThemeMode | ((prev: ThemeMode) => ThemeMode)) => void;
  updateConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
  saveConfig: (next?: AppConfig, opts?: { silent?: boolean }) => Promise<void>;
  loadHistory: () => Promise<void>;
  cancelAgentJob: (id: string) => Promise<void>;
  continueAgentJob: (id: string, prompt: string, attachments?: string[]) => Promise<AgentJob>;
  deleteAgentJob: (id: string) => Promise<boolean>;
  clearAgentJobs: (finishedOnly?: boolean) => Promise<number>;
  chooseModelDir: () => Promise<void>;
  /** Pass `path` right after download — avoids stale empty `asr_model_dir` wiping Rust. */
  loadModel: (path?: string) => Promise<void>;
  testLlm: () => Promise<void>;
  addTerm: () => void;
  saveVocabulary: (vocabulary: string[]) => Promise<void>;
  clearHistory: () => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  rateHistory: (id: string, rating: "" | "bad" | "ok" | "good") => Promise<void>;
  setHistoryUserText: (id: string, userText: string) => Promise<void>;
  pruneHistory: (keep: number) => Promise<void>;
  pruneHistoryOlderThan: (days: number) => Promise<void>;
  distillLearnFromRatings: () => Promise<{ terms: string[]; source_ids: string[] }>;
  markHistoryLearnStatus: (
    ids: string[],
    status: "" | "suggested" | "distilled" | "applied" | "skipped",
  ) => Promise<void>;
  applyLearnedTerms: (ids: string[], terms: string[]) => Promise<string[]>;
  offerLearnFromEntries: (
    entries: HistoryEntry[],
    terms?: LearnCandidate[],
  ) => Promise<number>;
  abortPendingLearn: () => Promise<void>;
  clearPendingLearn: () => void;
  removePendingLearnTerm: (term: string) => Promise<void>;
  markSession: (mode: "fn" | "translate" | "transcribe") => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.setAttribute("data-theme", theme);
  localStorage.setItem("asr-theme", theme);
  // Floating HUD is a separate webview — broadcast + native vibrancy sync.
  void import("@tauri-apps/api/event").then(({ emit }) =>
    emit("theme-changed", theme),
  );
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke("set_floating_theme", { theme }).catch(() => {}),
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const t = useT();
  // Long-lived Tauri listeners read the ref — always current locale, no re-subscribe.
  const tRef = useRef(t);
  tRef.current = t;
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [agentJobs, setAgentJobs] = useState<AgentJob[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelsCache | null>(null);
  const [state, setState] = useState<RecState>("idle");
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [newTerm, setNewTerm] = useState("");
  const [pendingLearn, setPendingLearn] = useState<PendingLearn | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("asr-theme");
    return saved === "light" ? "light" : "dark";
  });
  const configRef = useRef(config);
  const modelLoadedRef = useRef(modelLoaded);
  const stateRef = useRef(state);
  const sessionModeRef = useRef<"fn" | "translate" | "transcribe">("fn");

  useEffect(() => {
    configRef.current = config;
    modelLoadedRef.current = modelLoaded;
    stateRef.current = state;
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // After reload: rebuild pending chips from suggested bad cases.
  useEffect(() => {
    if (pendingLearn?.terms.length) return;
    const suggested = history.filter(
      (e) =>
        e.learn_status === "suggested" &&
        (e.source ?? "fn") !== "translate" &&
        (e.quality_rating === "bad" || Boolean(e.user_text?.trim())),
    );
    if (!suggested.length) return;
    const cands = harvestFromTriples(suggested, config.vocabulary);
    if (!cands.length) return;
    setPendingLearn({
      terms: cands,
      sourceIds: suggested.map((e) => e.id),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length]);

  const loadConfig = useCallback(async () => {
    const next = await invoke<AppConfig>("get_app_config").catch(
      () => defaultConfig,
    );
    const merged: AppConfig = {
      ...defaultConfig,
      ...next,
      language: next.language || "auto",
      align_enabled: next.align_enabled ?? defaultConfig.align_enabled,
      hotkey_transcribe: next.hotkey_transcribe ?? defaultConfig.hotkey_transcribe,
      hotkey_translate: next.hotkey_translate ?? defaultConfig.hotkey_translate,
      hotkey_cancel: next.hotkey_cancel ?? defaultConfig.hotkey_cancel,
      hotkey_agent: next.hotkey_agent ?? defaultConfig.hotkey_agent,
      agent_kind: next.agent_kind ?? defaultConfig.agent_kind,
      agent_profile_id:
        next.agent_profile_id ?? defaultConfig.agent_profile_id,
      agent_profiles:
        next.agent_profiles?.length
          ? next.agent_profiles
          : defaultConfig.agent_profiles,
      agent_cwd: next.agent_cwd ?? defaultConfig.agent_cwd,
      agent_cwd_history:
        next.agent_cwd_history ?? defaultConfig.agent_cwd_history,
      agent_claude_bin: next.agent_claude_bin ?? defaultConfig.agent_claude_bin,
      agent_codex_bin: next.agent_codex_bin ?? defaultConfig.agent_codex_bin,
      agent_pi_bin: next.agent_pi_bin ?? defaultConfig.agent_pi_bin,
      agent_trusted_dirs:
        next.agent_trusted_dirs ?? defaultConfig.agent_trusted_dirs,
      audio_capture_mode: next.audio_capture_mode ?? defaultConfig.audio_capture_mode,
      extra_languages: next.extra_languages ?? defaultConfig.extra_languages,
    };
    merged.llm_credentials = seedLlmCredentials(merged);
    setConfig(merged);
  }, []);

  const loadHistory = useCallback(async () => {
    const entries = await invoke<HistoryEntry[]>("get_history").catch(() => []);
    setHistory(entries);
  }, []);

  const loadAgentJobs = useCallback(async () => {
    const jobs = await invoke<AgentJob[]>("list_agent_jobs").catch(() => []);
    setAgentJobs(jobs);
  }, []);

  const loadAgentModels = useCallback(async () => {
    const cache = await invoke<AgentModelsCache>("get_agent_models").catch(
      () => null,
    );
    if (cache) setAgentModels(cache);
  }, []);

  const refreshAgentModels = useCallback(async (force = false) => {
    const cache = await invoke<AgentModelsCache>("refresh_agent_models", {
      force,
    }).catch(() => null);
    if (cache) setAgentModels(cache);
  }, []);

  const cancelAgentJob = useCallback(async (id: string) => {
    await invoke("cancel_agent_job", { id });
  }, []);

  const continueAgentJob = useCallback(
    async (id: string, prompt: string, attachments?: string[]) => {
      const job = await invoke<AgentJob>("continue_agent_job", {
        jobId: id,
        prompt,
        attachments: attachments ?? null,
      });
      setAgentJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id);
        if (i < 0) return [job, ...prev];
        const next = prev.slice();
        next[i] = job;
        return next;
      });
      return job;
    },
    [],
  );

  const deleteAgentJob = useCallback(async (id: string) => {
    const ok = await invoke<boolean>("delete_agent_job", { id });
    if (ok) {
      setAgentJobs((prev) => prev.filter((j) => j.id !== id));
    }
    return ok;
  }, []);

  const clearAgentJobs = useCallback(async (finishedOnly = true) => {
    const n = await invoke<number>("clear_agent_jobs", { finishedOnly });
    if (finishedOnly) {
      setAgentJobs((prev) =>
        prev.filter((j) => j.status === "queued" || j.status === "running"),
      );
    } else {
      setAgentJobs([]);
    }
    return n;
  }, []);

  useEffect(() => {
    void loadConfig();
    // History / agent jobs can be multi‑MiB on disk. Defer past first paint,
    // and split into two idle batches so the setState re-renders don't pile
    // into the first-click window.
    let idleId: number | null = null;
    let idleId2: number | null = null;
    let timeoutId: number | null = null;
    let timeoutId2: number | null = null;
    const deferredHistory = () => {
      void loadHistory();
    };
    const deferredAgent = () => {
      void loadAgentJobs();
      void loadAgentModels();
      void refreshAgentModels(false);
    };
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(deferredHistory, { timeout: 1200 });
      idleId2 = window.requestIdleCallback(deferredAgent, { timeout: 2700 });
    } else {
      timeoutId = window.setTimeout(deferredHistory, 0);
      timeoutId2 = window.setTimeout(deferredAgent, 1500);
    }

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    // Auto-load Qwen when provider is qwen and model_dir is set.
    void (async () => {
      try {
        const cfg = await invoke<AppConfig>("get_app_config");
        if (disposed) return;
        if (
          cfg.asr_provider === "qwen" &&
          cfg.asr_model_dir?.trim() &&
          !modelLoadedRef.current
        ) {
          setModelLoading(true);
          await invoke("set_model_dir", { path: cfg.asr_model_dir });
          await invoke("load_model");
        }
      } catch {
        // ignore — user can load manually on ASR page
        if (!disposed) setModelLoading(false);
      }
    })();

    Promise.all([
      listen<FloatingPayload>("floating-status", (event) => {
        setState(event.payload.state);
      }),
      listen<TranscriptionResult>("transcription-result", (event) => {
        const result = event.payload;
        setState("idle");
        stateRef.current = "idle";
        if (result.error) {
          toast.danger(lookupRustMsg(result.error, tRef.current));
          return;
        }
        const mode = sessionModeRef.current;
        if (mode === "translate") {
          toast.success(
            result.refined
              ? tRef.current("toast.translatedPasted")
              : tRef.current("toast.pasted"),
          );
        } else if (mode === "transcribe") {
          toast.success(
            result.refined
              ? tRef.current("toast.transcribeDoneRefined")
              : tRef.current("toast.transcribeDone"),
          );
        } else {
          toast.success(tRef.current("toast.clipboardPasted"));
        }
        sessionModeRef.current = "fn";
        void loadHistory();
      }),
      listen<string>("model-loaded", () => {
        setModelLoaded(true);
        setModelLoading(false);
        toast.success(tRef.current("toast.modelLoaded"));
      }),
      listen<string>("model-error", (event) => {
        setModelLoaded(false);
        setModelLoading(false);
        toast.danger(lookupRustMsg(event.payload, tRef.current));
      }),
      listen<string>("mlx-worker-dead", (event) => {
        setModelLoaded(false);
        setModelLoading(false);
        setState("idle");
        stateRef.current = "idle";
        toast.danger(
          tRef.current("toast.engineCrash", {
            reason: event.payload || "unknown",
          }),
        );
      }),
      listen<AppConfig>("config-updated", (event) => {
        const merged: AppConfig = {
          ...defaultConfig,
          ...event.payload,
          language: event.payload.language || "auto",
          align_enabled:
            event.payload.align_enabled ?? defaultConfig.align_enabled,
          hotkey_transcribe:
            event.payload.hotkey_transcribe ?? defaultConfig.hotkey_transcribe,
          hotkey_translate:
            event.payload.hotkey_translate ?? defaultConfig.hotkey_translate,
          hotkey_cancel:
            event.payload.hotkey_cancel ?? defaultConfig.hotkey_cancel,
          hotkey_agent:
            event.payload.hotkey_agent ?? defaultConfig.hotkey_agent,
          agent_kind: event.payload.agent_kind ?? defaultConfig.agent_kind,
          agent_profile_id:
            event.payload.agent_profile_id ?? defaultConfig.agent_profile_id,
          agent_profiles:
            event.payload.agent_profiles?.length
              ? event.payload.agent_profiles
              : defaultConfig.agent_profiles,
          agent_cwd: event.payload.agent_cwd ?? defaultConfig.agent_cwd,
          agent_cwd_history:
            event.payload.agent_cwd_history ?? defaultConfig.agent_cwd_history,
          agent_claude_bin:
            event.payload.agent_claude_bin ?? defaultConfig.agent_claude_bin,
          agent_codex_bin:
            event.payload.agent_codex_bin ?? defaultConfig.agent_codex_bin,
          agent_pi_bin:
            event.payload.agent_pi_bin ?? defaultConfig.agent_pi_bin,
          agent_trusted_dirs:
            event.payload.agent_trusted_dirs ?? defaultConfig.agent_trusted_dirs,
          audio_capture_mode:
            event.payload.audio_capture_mode ?? defaultConfig.audio_capture_mode,
          extra_languages:
            event.payload.extra_languages ?? defaultConfig.extra_languages,
        };
        merged.llm_credentials = seedLlmCredentials(merged);
        setConfig(merged);
      }),
      listen<AgentJob>("agent-job-updated", (event) => {
        setAgentJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === event.payload.id);
          if (idx === -1) return [event.payload, ...prev].slice(0, 40);
          const next = prev.slice();
          next[idx] = event.payload;
          return next;
        });
      }),
      listen<{ id: string }>("agent-job-deleted", (event) => {
        setAgentJobs((prev) => prev.filter((j) => j.id !== event.payload.id));
      }),
      listen("agent-jobs-reload", () => {
        void loadAgentJobs();
      }),
      listen<AgentModelsCache>("agent-models-updated", (event) => {
        setAgentModels(event.payload);
      }),
      listen<string>("open-settings", (event) => {
        const page = event.payload;
        if (page === "llm") navigate("/settings?tab=llm");
        else if (page === "updates") navigate("/settings?tab=updates");
        else if (page === "agent") navigate("/dispatch");
        else navigate("/settings");
      }),
      listen<string>("open-agent-job", (event) => {
        const id = event.payload;
        if (id) navigate(`/dispatch/${id}`);
      }),
      listen<{ shift?: boolean; intention?: string }>("fn-key-down", async (event) => {
        // Confirm-wait: Fn is handled in floating via hud-confirm-request (hotkey tap).
        if (stateRef.current === "editing") return;

        // Mid-pipeline spinner: Fn = accept HUD text now + abort in-flight LLM/ASR.
        if (
          stateRef.current === "refining" ||
          stateRef.current === "processing"
        ) {
          try {
            await invoke("accept_floating_preview");
            setState("idle");
            stateRef.current = "idle";
          } catch (error) {
            toast.danger(
              tRef.current("toast.skipFailed", {
                error: lookupRustMsg(String(error), tRef.current),
              }),
            );
          }
          return;
        }

        const current = configRef.current;
        const intention =
          event.payload?.intention === "translate" || event.payload?.shift
            ? "translate"
            : "transcribe";
        const shift = intention === "translate";
        // Toggle: hotkey press starts when idle, stops when recording.
        if (stateRef.current === "recording") {
          setState("processing");
          stateRef.current = "processing";
          try {
            await invoke("stop_recording");
          } catch (error) {
            setState("idle");
            stateRef.current = "idle";
            toast.danger(
              tRef.current("toast.stopRecFailed", {
                error: lookupRustMsg(String(error), tRef.current),
              }),
            );
          }
          return;
        }
        if (stateRef.current !== "idle") return;
        if (
          (current.asr_provider as string) === "elevenlabs"
        ) {
          toast.warning(tRef.current("toast.elevenlabsRemoved"));
          return;
        }
        if (current.asr_provider === "qwen" && !modelLoadedRef.current) {
          toast.warning(tRef.current("toast.loadQwenFirst"));
          return;
        }
        if (shift) {
          if (
            !current.llm_api_base_url?.trim() ||
            !current.llm_model?.trim()
          ) {
            toast.warning(tRef.current("toast.translateNeedsLlm"));
            return;
          }
        }
        const mode = shift ? "translate" : "fn";
        setState("recording");
        stateRef.current = "recording";
        sessionModeRef.current = mode;
        try {
          await invoke("start_recording", {
            chunkSec: current.chunk_size_sec ?? 1.0,
            rollbackTokens: current.unfixed_token_num ?? 5,
            language: current.language === "auto" ? null : current.language,
            mode,
          });
        } catch (error) {
          setState("idle");
          stateRef.current = "idle";
          toast.danger(
            tRef.current("toast.startRecFailed", {
              error: lookupRustMsg(String(error), tRef.current),
            }),
          );
        }
      }),
      listen("escape-key-down", async () => {
        if (stateRef.current === "editing") {
          try {
            await invoke("cancel_floating_transcript");
            setState("idle");
            stateRef.current = "idle";
            toast.info(tRef.current("toast.cancelled"));
          } catch (error) {
            toast.danger(
              tRef.current("toast.cancelFailed", {
                error: lookupRustMsg(String(error), tRef.current),
              }),
            );
          }
          return;
        }
        if (
          stateRef.current !== "recording" &&
          stateRef.current !== "processing" &&
          stateRef.current !== "refining"
        ) {
          return;
        }
        const midPipeline =
          stateRef.current === "processing" || stateRef.current === "refining";
        try {
          await invoke("cancel_recording", { reason: "escape-key" });
          setState("idle");
          stateRef.current = "idle";
          toast.info(
            midPipeline
              ? tRef.current("toast.abortedPipeline")
              : tRef.current("toast.cancelledRecording"),
          );
        } catch (error) {
          toast.danger(
            tRef.current("toast.cancelFailed", {
              error: lookupRustMsg(String(error), tRef.current),
            }),
          );
        }
      }),
      listen("recording-cancelled", () => {
        setState("idle");
        stateRef.current = "idle";
      }),
      listen<string>("fn-listener-error", (event) => {
        toast.danger(lookupRustMsg(event.payload, tRef.current));
      }),
      listen<string>("partial-error", (event) => {
        toast.warning(lookupRustMsg(event.payload, tRef.current));
      }),
      listen<string>("audio-capture-warning", (event) => {
        toast.warning(lookupRustMsg(event.payload, tRef.current));
      }),
    ]).then((items) => {
      if (disposed) {
        items.forEach((unlisten) => unlisten());
        return;
      }
      unlisteners.push(...items);
    });

    return () => {
      disposed = true;
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (idleId2 != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId2);
      }
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (timeoutId2 != null) window.clearTimeout(timeoutId2);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [loadConfig, loadHistory, loadAgentJobs, loadAgentModels, refreshAgentModels, navigate]);

  // Debounce config persistence refs
  const configSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configInitializedRef = useRef(false);
  const justSavedRef = useRef(false);
  const latestConfigRef = useRef(config);

  const saveConfig = useCallback(
    async (next = config, opts?: { silent?: boolean }) => {
      await invoke("save_app_config", { config: next });
      setConfig(next);
      justSavedRef.current = true;
      if (!opts?.silent) toast.success(tRef.current("toast.configSaved"));
    },
    [config],
  );

  // Debounce config persistence: write to disk ~1s after last config change.
  useEffect(() => {
    latestConfigRef.current = config;
    if (!configInitializedRef.current) {
      configInitializedRef.current = true;
      return;
    }
    if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
    configSaveTimerRef.current = setTimeout(() => {
      if (justSavedRef.current) {
        justSavedRef.current = false;
        return;
      }
      invoke("save_app_config", { config }).catch((e: unknown) =>
        console.warn("[config] debounced save failed:", e)
      );
    }, 1000);
    return () => {
      if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
    };
  }, [config]);

  // Flush pending debounced save on unmount
  useEffect(() => {
    return () => {
      if (configSaveTimerRef.current) {
        clearTimeout(configSaveTimerRef.current);
        invoke("save_app_config", { config: latestConfigRef.current }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const testLlm = useCallback(async () => {
    try {
      // Persist form values first — test hits Rust engine config, not React state.
      await invoke("save_app_config", { config });
      const sample = "我在写配森脚本读取杰森文件。";
      const refined = await invoke<string>("test_llm_refinement", {
        text: sample,
      });
      if (refined === sample) {
        toast.warning(tRef.current("toast.llmNoChange", { text: refined }));
      } else {
        toast.success(
          tRef.current("toast.llmOk", { before: sample, after: refined }),
        );
      }
    } catch (error) {
      toast.danger(
        tRef.current("toast.llmTestFailed", {
          error: lookupRustMsg(String(error), tRef.current),
        }),
      );
    }
  }, [config]);

  const chooseModelDir = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: tRef.current("toast.chooseModelDirTitle"),
    });
    if (typeof selected !== "string") return;
    const next = { ...config, asr_model_dir: selected };
    setConfig(next);
    await invoke("set_model_dir", { path: selected });
  }, [config]);

  const loadModel = useCallback(async (path?: string) => {
    const dir = (path ?? config.asr_model_dir)?.trim() ?? "";
    if (!dir) {
      toast.danger(tRef.current("toast.noModelDir"));
      return;
    }
    setModelLoading(true);
    try {
      await invoke("set_model_dir", { path: dir });
      await invoke("load_model");
    } catch (error) {
      setModelLoading(false);
      toast.danger(
        tRef.current("toast.loadFailed", {
          error: lookupRustMsg(String(error), tRef.current),
        }),
      );
    }
  }, [config.asr_model_dir]);

  const updateConfig = useCallback(
    <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const saveVocabulary = useCallback(
    async (vocabulary: string[]) => {
      const next = { ...config, vocabulary };
      setConfig(next);
      await saveConfig(next);
    },
    [config, saveConfig],
  );

  const addTerm = useCallback(() => {
    const term = newTerm.trim();
    if (!term || config.vocabulary.includes(term)) return;
    const vocabulary = [term, ...config.vocabulary];
    setNewTerm("");
    void saveVocabulary(vocabulary);
  }, [config.vocabulary, newTerm, saveVocabulary]);

  const clearHistory = useCallback(async () => {
    await invoke("clear_history");
    await loadHistory();
  }, [loadHistory]);

  const deleteHistory = useCallback(
    async (id: string) => {
      await invoke("delete_history_entry", { id });
      await loadHistory();
    },
    [loadHistory],
  );

  const rateHistory = useCallback(
    async (id: string, rating: "" | "bad" | "ok" | "good") => {
      await invoke("rate_history_entry", { id, rating });
      const ratedAt = rating === "" ? null : new Date().toISOString();
      setHistory((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                quality_rating: rating === "" ? null : rating,
                rated_at: ratedAt,
              }
            : e,
        ),
      );
    },
    [],
  );

  const setHistoryUserText = useCallback(async (id: string, userText: string) => {
    await invoke("set_history_user_text", { id, userText });
    setHistory((prev) =>
      prev.map((e) =>
        e.id === id
          ? {
              ...e,
              user_text: userText.trim(),
              text: userText.trim(),
              learn_status:
                e.learn_status === "applied" || e.learn_status === "skipped"
                  ? e.learn_status
                  : "suggested",
              quality_rating: e.quality_rating ?? "bad",
              rated_at: e.rated_at ?? new Date().toISOString(),
            }
          : e,
      ),
    );
  }, []);

  const distillLearnFromRatings = useCallback(async () => {
    return invoke<{ terms: string[]; source_ids: string[] }>(
      "distill_learn_from_ratings",
    );
  }, []);

  const markHistoryLearnStatus = useCallback(
    async (
      ids: string[],
      status: "" | "suggested" | "distilled" | "applied" | "skipped",
    ) => {
      if (ids.length === 0) return;
      if (ids.length === 1) {
        await invoke("mark_history_learn_status", { id: ids[0], status });
      } else {
        await invoke("mark_history_learn_status_batch", { ids, status });
      }
      setHistory((prev) =>
        prev.map((e) =>
          ids.includes(e.id)
            ? {
                ...e,
                learn_status: status === "" ? null : status,
              }
            : e,
        ),
      );
    },
    [],
  );

  const applyLearnedTerms = useCallback(
    async (ids: string[], terms: string[]) => {
      const vocabulary = await invoke<string[]>("apply_learned_terms", {
        ids,
        terms,
      });
      setConfig((prev) => ({ ...prev, vocabulary }));
      setHistory((prev) =>
        prev.map((e) =>
          ids.includes(e.id)
            ? {
                ...e,
                learn_status: "applied",
                learn_terms: Array.from(
                  new Set([...(e.learn_terms ?? []), ...terms]),
                ),
              }
            : e,
        ),
      );
      setPendingLearn(null);
      return vocabulary;
    },
    [],
  );

  const pendingLearnRef = useRef(pendingLearn);
  pendingLearnRef.current = pendingLearn;

  const offerLearnFromEntries = useCallback(
    async (entries: HistoryEntry[], terms?: LearnCandidate[]) => {
      if (!entries.length) return 0;
      const cands =
        terms ??
        harvestFromTriples(entries, configRef.current.vocabulary);
      if (!cands.length) return 0;
      const sourceIds = entries.map((e) => e.id);
      setPendingLearn((prev) => mergePendingLearn(prev, cands, sourceIds));
      try {
        await markHistoryLearnStatus(sourceIds, "suggested");
      } catch {
        /* non-fatal */
      }
      return cands.length;
    },
    [markHistoryLearnStatus],
  );

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ entry_id: string; before: string; after: string; learned_pairs?: Array<{ wrong: string; right: string }> }>(
      "learn-from-hud",
      (event) => {
        void loadHistory();
        const pairs = event.payload.learned_pairs;
        if (pairs && pairs.length > 0) {
          const msg =
            pairs.length === 1
              ? tRef.current("toast.learned", {
                  wrong: pairs[0].wrong,
                  right: pairs[0].right,
                })
              : tRef.current("toast.learnedMulti", {
                  first: `${pairs[0].wrong} → ${pairs[0].right}`,
                  n: pairs.length,
                });
          toast.success(msg);
        } else {
          toast.success(tRef.current("toast.learnedCase"));
        }
      },
    ).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [loadHistory]);

  const abortPendingLearn = useCallback(async () => {
    const ids = pendingLearnRef.current?.sourceIds ?? [];
    setPendingLearn(null);
    if (!ids.length) return;
    try {
      await markHistoryLearnStatus(ids, "");
    } catch {
      /* non-fatal */
    }
  }, [markHistoryLearnStatus]);

  const clearPendingLearn = useCallback(() => {
    void abortPendingLearn();
  }, [abortPendingLearn]);

  const removePendingLearnTerm = useCallback(
    async (term: string) => {
      const prev = pendingLearnRef.current;
      if (!prev) return;
      const terms = prev.terms.filter(
        (c) => c.term.toLocaleLowerCase() !== term.toLocaleLowerCase(),
      );
      if (!terms.length) {
        await abortPendingLearn();
        return;
      }
      setPendingLearn({ ...prev, terms });
    },
    [abortPendingLearn],
  );

  const pruneHistory = useCallback(
    async (keep: number) => {
      await invoke("prune_history", { keep });
      await loadHistory();
    },
    [loadHistory],
  );

  const pruneHistoryOlderThan = useCallback(
    async (days: number) => {
      await invoke("prune_history_older_than", { days });
      await loadHistory();
    },
    [loadHistory],
  );

  const markSession = useCallback((mode: "fn" | "translate" | "transcribe") => {
    sessionModeRef.current = mode;
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      config,
      history,
      agentJobs,
      agentModels,
      refreshAgentModels,
      state,
      modelLoaded,
      modelLoading,
      newTerm,
      theme,
      pendingLearn,
      setNewTerm,
      setTheme,
      updateConfig,
      saveConfig,
      loadHistory,
      cancelAgentJob,
      continueAgentJob,
      deleteAgentJob,
      clearAgentJobs,
      chooseModelDir,
      loadModel,
      testLlm,
      addTerm,
      saveVocabulary,
      clearHistory,
      deleteHistory,
      rateHistory,
      setHistoryUserText,
      pruneHistory,
      pruneHistoryOlderThan,
      distillLearnFromRatings,
      markHistoryLearnStatus,
      applyLearnedTerms,
      offerLearnFromEntries,
      abortPendingLearn,
      clearPendingLearn,
      removePendingLearnTerm,
      markSession,
    }),
    [
      config,
      history,
      agentJobs,
      agentModels,
      refreshAgentModels,
      state,
      modelLoaded,
      modelLoading,
      newTerm,
      theme,
      pendingLearn,
      updateConfig,
      saveConfig,
      loadHistory,
      cancelAgentJob,
      continueAgentJob,
      deleteAgentJob,
      clearAgentJobs,
      chooseModelDir,
      loadModel,
      testLlm,
      addTerm,
      saveVocabulary,
      clearHistory,
      deleteHistory,
      rateHistory,
      setHistoryUserText,
      pruneHistory,
      pruneHistoryOlderThan,
      distillLearnFromRatings,
      markHistoryLearnStatus,
      applyLearnedTerms,
      offerLearnFromEntries,
      abortPendingLearn,
      clearPendingLearn,
      removePendingLearnTerm,
      markSession,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
