import type { AppConfig, AsrProvider, Page, RecState } from "../types";

export const defaultConfig: AppConfig = {
  asr_model_dir: "/Users/xbcoder/project/Qwen3-ASR/models",
  asr_provider: "apple",
  elevenlabs_api_key: "",
  elevenlabs_model: "scribe_v2",
  language: "zh-CN",
  llm_enabled: false,
  llm_api_base_url: "https://api.openai.com/v1",
  llm_api_key: "",
  llm_model: "gpt-4o-mini",
  vocabulary: [],
};

export const LANGUAGES: [string, string][] = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en-US", "English"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
];

export const NAV: { id: Page; label: string; hint: string }[] = [
  { id: "overview", label: "主页", hint: "录音与状态" },
  { id: "transcribe", label: "转写", hint: "上传音频" },
  { id: "asr", label: "ASR", hint: "识别引擎" },
  { id: "llm", label: "LLM", hint: "纠错优化" },
  { id: "vocabulary", label: "词库", hint: "专有名词" },
  { id: "history", label: "历史", hint: "识别记录" },
  { id: "settings", label: "设置", hint: "凭证与权限" },
];

export const CAPSULE_TAIL_CHARS = 34;

export function providerLabel(provider: AsrProvider) {
  if (provider === "apple") return "Apple Speech";
  if (provider === "elevenlabs") return "ElevenLabs";
  return "Qwen Local";
}

export function stateLabel(state: RecState) {
  if (state === "recording") return "录音中";
  if (state === "processing") return "转写中";
  if (state === "refining") return "纠错中";
  return "就绪";
}

export function lastChars(text: string, count: number) {
  return Array.from(text).slice(-count).join("");
}
