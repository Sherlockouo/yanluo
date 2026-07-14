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
  AppConfig,
  FloatingPayload,
  HistoryEntry,
  RecState,
  TranscriptionResult,
} from "@/types";
import { defaultConfig } from "@/lib/constants";
import {
  harvestFromTriples,
} from "@/lib/learn-cases";
import type { LearnCandidate } from "@/lib/learn-from-refine";
import {
  mergePendingLearn,
  type PendingLearn,
} from "@/lib/pending-learn";

export type ThemeMode = "dark" | "light";

type AppContextValue = {
  config: AppConfig;
  history: HistoryEntry[];
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
  chooseModelDir: () => Promise<void>;
  loadModel: () => Promise<void>;
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
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
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
    setConfig({
      ...defaultConfig,
      ...next,
      language: next.language || "auto",
      hotkey_transcribe: next.hotkey_transcribe ?? defaultConfig.hotkey_transcribe,
      hotkey_translate: next.hotkey_translate ?? defaultConfig.hotkey_translate,
      hotkey_cancel: next.hotkey_cancel ?? defaultConfig.hotkey_cancel,
      audio_capture_mode: next.audio_capture_mode ?? defaultConfig.audio_capture_mode,
    });
  }, []);

  const loadHistory = useCallback(async () => {
    const entries = await invoke<HistoryEntry[]>("get_history").catch(() => []);
    setHistory(entries);
  }, []);

  useEffect(() => {
    void loadConfig();
    // History can be multi‑MiB on disk (alignment). Defer past first paint.
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(
        () => {
          void loadHistory();
        },
        { timeout: 1200 },
      );
    } else {
      timeoutId = window.setTimeout(() => {
        void loadHistory();
      }, 0);
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
          toast.danger(result.error);
          return;
        }
        const mode = sessionModeRef.current;
        if (mode === "translate") {
          toast.success(result.refined ? "已翻译并粘贴" : "已粘贴");
        } else if (mode === "transcribe") {
          toast.success(
            result.refined ? "转写完成（已优化）" : "转写完成，已保存音频与文本",
          );
        } else {
          toast.success("已写入剪切板并粘贴");
        }
        sessionModeRef.current = "fn";
        void loadHistory();
      }),
      listen<string>("model-loaded", () => {
        setModelLoaded(true);
        setModelLoading(false);
        toast.success("ASR 模型已加载");
      }),
      listen<string>("model-error", (event) => {
        setModelLoaded(false);
        setModelLoading(false);
        toast.danger(event.payload);
      }),
      listen<string>("mlx-worker-dead", (event) => {
        setModelLoaded(false);
        setModelLoading(false);
        setState("idle");
        stateRef.current = "idle";
        toast.danger(
          `ASR 引擎崩溃：${event.payload || "unknown"}。请重启应用。`,
        );
      }),
      listen<AppConfig>("config-updated", (event) => {
        setConfig({
          ...defaultConfig,
          ...event.payload,
          language: event.payload.language || "auto",
          hotkey_transcribe:
            event.payload.hotkey_transcribe ?? defaultConfig.hotkey_transcribe,
          hotkey_translate:
            event.payload.hotkey_translate ?? defaultConfig.hotkey_translate,
          hotkey_cancel:
            event.payload.hotkey_cancel ?? defaultConfig.hotkey_cancel,
          audio_capture_mode:
            event.payload.audio_capture_mode ?? defaultConfig.audio_capture_mode,
        });
      }),
      listen<string>("open-settings", (event) => {
        const page = event.payload;
        if (page === "llm") navigate("/llm");
        else if (page === "updates") navigate("/settings?tab=updates");
        else navigate("/settings");
      }),
      listen<{ shift?: boolean; intention?: string }>("fn-key-down", async (event) => {
        const current = configRef.current;
        const intention =
          event.payload?.intention === "translate" || event.payload?.shift
            ? "translate"
            : "transcribe";
        const shift = intention === "translate";
        // Toggle: hotkey press starts when idle, stops when recording.
        // Stop = accept current (no refine / full re-translate).
        if (stateRef.current === "recording") {
          setState("processing");
          stateRef.current = "processing";
          try {
            await invoke("stop_recording");
          } catch (error) {
            setState("idle");
            stateRef.current = "idle";
            toast.danger(`停止录音失败: ${error}`);
          }
          return;
        }
        if (stateRef.current !== "idle") return;
        if (current.asr_provider === "qwen" && !modelLoadedRef.current) {
          toast.warning("请先加载 ASR 模型，或切到 Apple/ElevenLabs");
          return;
        }
        if (shift) {
          if (
            !current.llm_api_base_url?.trim() ||
            !current.llm_model?.trim()
          ) {
            toast.warning("翻译需要先在「LLM」页配置 Base URL 与 Model（Key 可留空）");
            return;
          }
        }
        const mode = shift ? "translate" : "fn";
        setState("recording");
        stateRef.current = "recording";
        sessionModeRef.current = mode;
        try {
          await invoke("save_app_config", { config: current });
          await invoke("start_recording", {
            chunkSec: current.chunk_size_sec ?? 1.0,
            rollbackTokens: current.unfixed_token_num ?? 5,
            language: current.language === "auto" ? null : current.language,
            mode,
          });
        } catch (error) {
          setState("idle");
          stateRef.current = "idle";
          toast.danger(`启动录音失败: ${error}`);
        }
      }),
      listen("escape-key-down", async () => {
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
          await invoke("cancel_recording");
          setState("idle");
          stateRef.current = "idle";
          toast.info(midPipeline ? "已中止后续处理" : "已取消录音");
        } catch (error) {
          toast.danger(`取消失败: ${error}`);
        }
      }),
      listen("recording-cancelled", () => {
        setState("idle");
        stateRef.current = "idle";
      }),
      listen<string>("fn-listener-error", (event) => {
        toast.danger(event.payload);
      }),
      listen<string>("partial-error", (event) => {
        toast.warning(event.payload);
      }),
      listen<string>("audio-capture-warning", (event) => {
        toast.warning(event.payload);
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
      if (timeoutId != null) window.clearTimeout(timeoutId);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [loadConfig, loadHistory, navigate]);

  const saveConfig = useCallback(
    async (next = config, opts?: { silent?: boolean }) => {
      await invoke("save_app_config", { config: next });
      setConfig(next);
      if (!opts?.silent) toast.success("设置已保存");
    },
    [config],
  );

  const testLlm = useCallback(async () => {
    try {
      // Persist form values first — test hits Rust engine config, not React state.
      await invoke("save_app_config", { config });
      const sample = "我在写配森脚本读取杰森文件。";
      const refined = await invoke<string>("test_llm_refinement", {
        text: sample,
      });
      if (refined === sample) {
        toast.warning(`LLM 已响应，但未改写：${refined}`);
      } else {
        toast.success(`LLM OK：${sample} → ${refined}`);
      }
    } catch (error) {
      toast.danger(`LLM 测试失败: ${error}`);
    }
  }, [config]);

  const chooseModelDir = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 ASR 模型目录",
    });
    if (typeof selected !== "string") return;
    const next = { ...config, asr_model_dir: selected };
    setConfig(next);
    await invoke("set_model_dir", { path: selected });
  }, [config]);

  const loadModel = useCallback(async () => {
    setModelLoading(true);
    try {
      await invoke("set_model_dir", { path: config.asr_model_dir });
      await invoke("load_model");
    } catch (error) {
      setModelLoading(false);
      toast.danger(`加载失败: ${error}`);
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
      state,
      modelLoaded,
      modelLoading,
      newTerm,
      theme,
      pendingLearn,
      updateConfig,
      saveConfig,
      loadHistory,
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
