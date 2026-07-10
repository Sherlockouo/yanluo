import type { AppConfig, AsrProvider, HotkeyBinding, Page, RecState } from "../types";

export const defaultHotkeyTranscribe: HotkeyBinding = {
  key: "fn",
  modifiers: [],
  label: "Fn",
};

export const defaultHotkeyTranslate: HotkeyBinding = {
  key: "fn",
  modifiers: ["shift"],
  label: "⇧+Fn",
};

export const defaultHotkeyCancel: HotkeyBinding = {
  key: "escape",
  modifiers: [],
  label: "Esc",
};

export const defaultConfig: AppConfig = {
  asr_model_dir: "",
  align_model_dir: "",
  // Apple Speech is macOS-only; non-macOS remaps to elevenlabs at runtime.
  asr_provider: "apple",
  elevenlabs_api_key: "",
  elevenlabs_model: "scribe_v2",
  // auto = Qwen language detect (best for CN-EN mix). Forced zh-CN caused pure-Chinese bias.
  language: "auto",
  translate_target_language: "en-US",
  chunk_size_sec: 1.0,
  unfixed_token_num: 2,
  hotkey_transcribe: defaultHotkeyTranscribe,
  hotkey_translate: defaultHotkeyTranslate,
  hotkey_cancel: defaultHotkeyCancel,
  audio_capture_mode: "external",
  llm_enabled: false,
  llm_api_base_url: "https://api.openai.com/v1",
  llm_api_key: "",
  llm_model: "gpt-4o-mini",
  vocabulary: [],
};

/** Split "⇧+Fn" / "⌃+Space" into Kbd segments. */
export function hotkeySegments(label: string): string[] {
  return label
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const LANGUAGES: [string, string][] = [
  ["auto", "自动检测（中英混合）"],
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en-US", "English"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
];

/** Translate target — no auto. */
export const TRANSLATE_LANGUAGES: [string, string][] = LANGUAGES.filter(
  ([value]) => value !== "auto",
);

/** Human label for a stored translate target (e.g. en-US → English). */
export function translateTargetLabel(code?: string | null): string {
  if (!code?.trim()) return "";
  return (
    TRANSLATE_LANGUAGES.find(([v]) => v === code)?.[1] ??
    LANGUAGES.find(([v]) => v === code)?.[1] ??
    code
  );
}

/** Compact HUD badge for translate target. */
export function hudTargetShort(code?: string | null): string {
  if (!code?.trim()) return "";
  switch (code) {
    case "zh-CN":
      return "简中";
    case "zh-TW":
      return "繁中";
    case "en-US":
    case "en":
      return "EN";
    case "ja-JP":
    case "ja":
      return "JA";
    case "ko-KR":
    case "ko":
      return "KO";
    default:
      return translateTargetLabel(code) || code;
  }
}

export const NAV: { id: Page; label: string }[] = [
  { id: "overview", label: "主页" },
  { id: "transcribe", label: "转写" },
  { id: "translate", label: "翻译" },
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
  if (state === "refining") return "处理中";
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
  "支持拖拽或点击选择 · 音频 WAV / MP3 / M4A / FLAC… · 视频 MP4 / MOV / MKV…";
