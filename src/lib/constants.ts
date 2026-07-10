import type { AppConfig, AsrProvider, Page, RecState } from "../types";

export const defaultConfig: AppConfig = {
  asr_model_dir: "/Users/xbcoder/project/Qwen3-ASR/models",
  align_model_dir: "",
  asr_provider: "apple",
  elevenlabs_api_key: "",
  elevenlabs_model: "scribe_v2",
  // auto = Qwen language detect (best for CN-EN mix). Forced zh-CN caused pure-Chinese bias.
  language: "auto",
  llm_enabled: false,
  llm_api_base_url: "https://api.openai.com/v1",
  llm_api_key: "",
  llm_model: "gpt-4o-mini",
  vocabulary: [],
};

export const LANGUAGES: [string, string][] = [
  ["auto", "自动检测（中英混合）"],
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en-US", "English"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
];

export const NAV: { id: Page; label: string }[] = [
  { id: "overview", label: "主页" },
  { id: "transcribe", label: "转写" },
  { id: "asr", label: "ASR" },
  { id: "llm", label: "LLM" },
  { id: "vocabulary", label: "词库" },
  { id: "history", label: "历史" },
  { id: "settings", label: "设置" },
];

/** Soft cap for local history.json (disk is cheap; UI virtualizes). */
export const HISTORY_MAX_ENTRIES = 5000;

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

/** Dialog filters for file transcription (audio + common video containers). */
export const TRANSCRIBE_FILE_FILTERS = [
  {
    name: "Audio & Video",
    extensions: [
      // audio
      "wav",
      "mp3",
      "m4a",
      "m4b",
      "m4r",
      "aac",
      "flac",
      "aiff",
      "aif",
      "aifc",
      "caf",
      "ogg",
      "oga",
      "opus",
      "wma",
      "amr",
      "ac3",
      "eac3",
      "au",
      "snd",
      // video (extract audio track)
      "mp4",
      "m4v",
      "mov",
      "mkv",
      "webm",
      "avi",
      "mpeg",
      "mpg",
      "3gp",
      "3g2",
    ],
  },
  {
    name: "Audio",
    extensions: [
      "wav",
      "mp3",
      "m4a",
      "m4b",
      "aac",
      "flac",
      "aiff",
      "aif",
      "caf",
      "ogg",
      "opus",
      "wma",
      "amr",
    ],
  },
  {
    name: "Video",
    extensions: ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "3gp"],
  },
] as const;

export const TRANSCRIBE_FORMAT_HINT =
  "音频：WAV / MP3 / M4A / FLAC / OGG / Opus… · 视频：MP4 / MOV / MKV / WebM…";
