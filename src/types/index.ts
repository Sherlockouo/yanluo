export type RecState = "idle" | "recording" | "processing" | "refining";

export type AsrProvider = "qwen" | "apple" | "elevenlabs";

export type AppConfig = {
  asr_model_dir: string;
  asr_provider: AsrProvider;
  elevenlabs_api_key: string;
  elevenlabs_model: string;
  language: string;
  llm_enabled: boolean;
  llm_api_base_url: string;
  llm_api_key: string;
  llm_model: string;
  vocabulary: string[];
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
  source?: string;
};

export type FloatingPayload = {
  visible: boolean;
  state: RecState;
  text: string;
  rms: number;
};

export type TranscriptionResult = {
  text: string;
  raw_text: string;
  language: string;
  duration_seconds: number;
  refined: boolean;
  error: string | null;
};

export type Page =
  | "overview"
  | "transcribe"
  | "asr"
  | "llm"
  | "vocabulary"
  | "history"
  | "settings";
