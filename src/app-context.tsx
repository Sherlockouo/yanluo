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

export type ThemeMode = "dark" | "light";

type AppContextValue = {
  config: AppConfig;
  history: HistoryEntry[];
  state: RecState;
  modelLoaded: boolean;
  modelLoading: boolean;
  newTerm: string;
  theme: ThemeMode;
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
  pruneHistory: (keep: number) => Promise<void>;
  pruneHistoryOlderThan: (days: number) => Promise<void>;
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
    void loadHistory();

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
        if (result.error) {
          toast.danger(result.error);
          return;
        }
        if (sessionModeRef.current === "transcribe") {
          toast.success(
            result.refined ? "转写完成（已优化）" : "转写完成，已保存音频与文本",
          );
        } else if (sessionModeRef.current === "translate") {
          toast.success(result.refined ? "已翻译并粘贴" : "已粘贴");
        } else {
          toast.success(result.refined ? "已优化并粘贴" : "已写入剪切板并粘贴");
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
        if (stateRef.current === "recording") {
          const translating = sessionModeRef.current === "translate";
          const shouldRefine =
            translating ||
            Boolean(
              current.llm_enabled &&
                current.llm_api_base_url?.trim() &&
                current.llm_model?.trim(),
            );
          const next: RecState = shouldRefine ? "refining" : "processing";
          setState(next);
          stateRef.current = next;
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
            rollbackTokens: current.unfixed_token_num ?? 2,
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
        try {
          await invoke("cancel_recording");
          setState("idle");
          stateRef.current = "idle";
          toast.info("已取消录音");
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
      pruneHistory,
      pruneHistoryOlderThan,
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
      pruneHistory,
      pruneHistoryOlderThan,
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
