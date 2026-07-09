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
  saveConfig: (next?: AppConfig) => Promise<void>;
  loadHistory: () => Promise<void>;
  chooseModelDir: () => Promise<void>;
  loadModel: () => Promise<void>;
  testLlm: () => Promise<void>;
  addTerm: () => void;
  saveVocabulary: (vocabulary: string[]) => Promise<void>;
  clearHistory: () => Promise<void>;
  markSession: (mode: "fn" | "transcribe") => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.setAttribute("data-theme", theme);
  localStorage.setItem("asr-theme", theme);
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
  const sessionModeRef = useRef<"fn" | "transcribe">("fn");

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
      language: next.language || "zh-CN",
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
          language: event.payload.language || "zh-CN",
        });
        toast.info("菜单设置已更新");
      }),
      listen<string>("open-settings", () => {
        navigate("/llm");
      }),
      listen("fn-key-down", async () => {
        const current = configRef.current;
        if (stateRef.current !== "idle") return;
        if (current.asr_provider === "qwen" && !modelLoadedRef.current) {
          toast.warning("请先加载 ASR 模型，或切到 Apple/ElevenLabs");
          return;
        }
        setState("recording");
        stateRef.current = "recording";
        sessionModeRef.current = "fn";
        try {
          await invoke("save_app_config", { config: current });
          await invoke("start_recording", {
            chunkSec: 0.5,
            rollbackTokens: 1,
            language: current.language,
            mode: "fn",
          });
        } catch (error) {
          setState("idle");
          stateRef.current = "idle";
          toast.danger(`启动录音失败: ${error}`);
        }
      }),
      listen("fn-key-up", async () => {
        if (stateRef.current !== "recording") return;
        const current = configRef.current;
        const shouldRefine = Boolean(
          current.llm_enabled &&
            current.llm_api_base_url &&
            current.llm_api_key &&
            current.llm_model,
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
      }),
      listen<string>("fn-listener-error", (event) => {
        toast.danger(event.payload);
      }),
      listen<string>("partial-error", (event) => {
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
    async (next = config) => {
      await invoke("save_app_config", { config: next });
      setConfig(next);
      toast.success("设置已保存");
    },
    [config],
  );

  const testLlm = useCallback(async () => {
    try {
      const refined = await invoke<string>("test_llm_refinement", {
        text: "我在写配森脚本读取杰森文件。",
      });
      toast.success(`LLM OK: ${refined}`);
    } catch (error) {
      toast.danger(`LLM 测试失败: ${error}`);
    }
  }, []);

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

  const markSession = useCallback((mode: "fn" | "transcribe") => {
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
