export type RecState = "idle" | "recording" | "processing" | "refining";

export type AsrProvider = "qwen" | "apple" | "elevenlabs";

/** Recording source for Fn / live capture. */
export type AudioCaptureMode = "external" | "system" | "both";

/** Global hotkey: key is "fn" | "escape" | macOS virtual keycode string. */
export type HotkeyBinding = {
  key: string;
  modifiers: string[];
  label: string;
};

export type AppConfig = {
  asr_model_dir: string;
  align_model_dir?: string;
  asr_provider: AsrProvider;
  elevenlabs_api_key: string;
  elevenlabs_model: string;
  language: string;
  /** Shift+Fn 翻译目标语言（不含 auto）。 */
  translate_target_language: string;
  /** Qwen 流式分块秒数（chunk_size_sec）。 */
  chunk_size_sec: number;
  /** Qwen 流式未固定 token 数（unfixed_token_num）。 */
  unfixed_token_num: number;
  hotkey_transcribe: HotkeyBinding;
  hotkey_translate: HotkeyBinding;
  hotkey_cancel: HotkeyBinding;
  /** 录音源：外部麦 / 系统播放 / 两者。 */
  audio_capture_mode: AudioCaptureMode;
  llm_enabled: boolean;
  llm_api_base_url: string;
  llm_api_key: string;
  llm_model: string;
  vocabulary: string[];
};

/** Word/char timing span from ForcedAligner or ElevenLabs words. */
export type TranscriptSegment = {
  text: string;
  start: number;
  end: number;
};

/** ElevenLabs CharacterAlignmentResponseModel shape. */
export type CharacterAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

export type HistoryEntry = {
  id: string;
  text: string;
  raw_text: string;
  language: string;
  duration_seconds: number;
  created_at: string;
  refined: boolean;
  audio_path?: string | null;
  /** "audio" | "video" */
  media_kind?: string;
  segments?: TranscriptSegment[];
  alignment?: CharacterAlignment | null;
  source?: string;
  /** Translate target language id (e.g. en-US). Set for translate sessions. */
  translate_target_language?: string | null;
};

export type FloatingPayload = {
  visible: boolean;
  state: RecState;
  text: string;
  rms: number;
  /** Optional log-spaced speech spectrum for HUD bars. */
  bands?: number[];
  /** Fn session intention: transcribe | translate */
  intention?: "transcribe" | "translate";
  /** Translate target language id (e.g. en-US). */
  target_language?: string | null;
  /** Clearing + re-translating after a live target switch. */
  switching?: boolean;
};

export type AudioLevelPayload = {
  rms: number;
  bands: number[];
};

export type TranscriptionResult = {
  text: string;
  raw_text: string;
  language: string;
  duration_seconds: number;
  refined: boolean;
  error: string | null;
  segments?: TranscriptSegment[];
  alignment?: CharacterAlignment | null;
};

export type Page =
  | "overview"
  | "transcribe"
  | "translate"
  | "asr"
  | "llm"
  | "vocabulary"
  | "history"
  | "settings";
