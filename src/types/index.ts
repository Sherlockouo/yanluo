export type RecState = "idle" | "recording" | "processing" | "refining";

export type AsrProvider = "qwen" | "apple" | "elevenlabs";

export type AppConfig = {
  asr_model_dir: string;
  align_model_dir?: string;
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
  segments?: TranscriptSegment[];
  alignment?: CharacterAlignment | null;
};

export type Page =
  | "overview"
  | "transcribe"
  | "asr"
  | "llm"
  | "vocabulary"
  | "history"
  | "settings";
