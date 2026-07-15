export type RecState =
  | "idle"
  | "recording"
  | "processing"
  | "refining"
  | "editing";

export type AsrProvider = "qwen" | "apple" | "elevenlabs";

export type LlmProvider =
  | "openai"
  | "deepseek"
  | "dashscope"
  | "ollama"
  | "custom";

/** Recording source for Fn / live capture. */
export type AudioCaptureMode = "external" | "system" | "both";

/** Global hotkey: key is "fn" | "escape" | macOS virtual keycode string. */
export type HotkeyBinding = {
  key: string;
  modifiers: string[];
  label: string;
};

export type AgentKind = "claude" | "codex" | "pi";

/** User-managed agent preset (settings + HUD picker). */
export type AgentProfile = {
  id: string;
  name: string;
  kind: AgentKind;
  /** Optional CLI override; empty → global bin / which. */
  bin?: string;
  /** Underlying CLI model (`claude --model` / `codex -m`). Empty → CLI default. */
  model?: string;
};

export type AgentJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type AgentJobEvent = {
  seq: number;
  ts: string;
  /** user | assistant | tool | tool_result | status | error | system */
  kind: string;
  title: string;
  text: string;
};

export type AgentJob = {
  id: string;
  agent: AgentKind;
  prompt: string;
  cwd: string;
  attachments?: string[];
  status: AgentJobStatus;
  progress: string;
  result: string;
  error: string;
  started_at: string;
  finished_at?: string | null;
  /** Claude/Codex conversation id for multi-turn resume. */
  session_id?: string | null;
  /** Full stream timeline (persisted). */
  events?: AgentJobEvent[];
  /** Attachments for the current / next turn only. */
  turn_attachments?: string[];
};

export type AgentPathInfo = {
  path: string;
  name: string;
  kind:
    | "file"
    | "dir"
    | "text"
    | "image"
    | "pdf"
    | "html"
    | "video"
    | "audio"
    | string;
  size: number;
  ext: string;
  preview: string;
  previewable: boolean;
};

/** Per-provider LLM credentials, keyed by LlmProvider id. */
export type LlmCredential = {
  api_base_url: string;
  api_key: string;
  model: string;
};

export type AppConfig = {
  asr_model_dir: string;
  align_model_dir?: string;
  /** Enable ForcedAligner. Effective only when align_model_dir is set. */
  align_enabled: boolean;
  /** Catalog id e.g. Qwen3-ASR-0.6B */
  asr_model_id: string;
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
  /** VAD backend: webrtc | energy | silero */
  vad_backend: "webrtc" | "energy" | string;
  /** WebRTC aggressiveness 0..=3 */
  vad_aggression: number;
  /** Energy VAD enter RMS (used when backend is energy). */
  vad_energy_threshold: number;
  vad_min_silence_ms: number;
  vad_commit_hold_ms: number;
  vad_min_segment_ms: number;
  vad_max_segment_sec: number;
  vad_overlap_ms: number;
  /** Cross-segment committed text prefix tokens (0 = off). */
  cross_segment_prefix_tokens: number;
  hotkey_transcribe: HotkeyBinding;
  hotkey_translate: HotkeyBinding;
  hotkey_cancel: HotkeyBinding;
  /** Summon agent HUD (default Fn+Space). */
  hotkey_agent: HotkeyBinding;
  /** Last agent: claude | codex | pi (mirrors selected profile.kind). */
  agent_kind: AgentKind;
  /** Selected agent profile id. */
  agent_profile_id: string;
  /** Settings-managed agent presets. */
  agent_profiles: AgentProfile[];
  /** Working directory for agent CLI. */
  agent_cwd: string;
  /** Recent / custom agent working directories (HUD picker). */
  agent_cwd_history: string[];
  /** Absolute path to claude CLI (empty = which claude). Fallback if profile.bin empty. */
  agent_claude_bin: string;
  /** Absolute path to codex CLI (empty = which codex). Fallback if profile.bin empty. */
  agent_codex_bin: string;
  /** Absolute path to pi CLI (empty = which pi). Fallback if profile.bin empty. */
  agent_pi_bin: string;
  /** Codex dirs allowed outside git (`--skip-git-repo-check`). */
  agent_trusted_dirs: string[];
  /** 录音源：外部麦 / 系统播放 / 两者。 */
  audio_capture_mode: AudioCaptureMode;
  llm_enabled: boolean;
  llm_provider: LlmProvider;
  llm_api_base_url: string;
  llm_api_key: string;
  llm_model: string;
  /** Per-provider credentials; the active provider mirrors into the flat llm_* fields. */
  llm_credentials: Partial<Record<LlmProvider, LlmCredential>>;
  /** Empty = built-in default; `{glossary}` appended by backend for vocab. */
  llm_refine_prompt: string;
  /** Empty = built-in default; `{target}` replaced with language name. */
  llm_translate_prompt: string;
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
  /** ASR raw. */
  raw_text: string;
  /** After LLM refine; null if LLM skipped. */
  llm_text?: string | null;
  /** User gold correction; null until edited. */
  user_text?: string | null;
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
  /** ASR quality feedback: bad | ok | good. For AI learn/distill. */
  quality_rating?: "bad" | "ok" | "good" | null;
  /** RFC3339 when quality_rating was set. */
  rated_at?: string | null;
  /** Learn loop: suggested | distilled | applied | skipped. */
  learn_status?: "suggested" | "distilled" | "applied" | "skipped" | null;
  /** Terms applied to vocab from this entry. */
  learn_terms?: string[];
};

export type FloatingPayload = {
  visible: boolean;
  state: RecState;
  text: string;
  /** Committed segments (stable). Optional for older events. */
  committed?: string;
  /** In-flight segment hypothesis. Optional for older events. */
  active?: string;
  rms: number;
  /** Optional log-spaced speech spectrum for HUD bars. */
  bands?: number[];
  /** Fn session intention: transcribe | translate | agent */
  intention?: "transcribe" | "translate" | "agent";
  /** Translate target language id (e.g. en-US). */
  target_language?: string | null;
  /** Clearing + re-translating after a live target switch. */
  switching?: boolean;
  /** Agent kind when intention=agent */
  agent?: AgentKind | null;
  /** Agent working directory */
  cwd?: string | null;
};

export type AudioLevelPayload = {
  rms: number;
  bands: number[];
};

export type TranscriptionResult = {
  text: string;
  raw_text: string;
  /** After LLM refine when applicable. */
  llm_text?: string | null;
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
  | "agent"
  | "settings";
