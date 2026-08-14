use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use crate::audio::*;

// ---------------------------------------------------------------------------
// App config, history, and persistence
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) struct HotkeyBinding {
    /// "fn" | "escape" | macOS virtual keycode as decimal string.
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) modifiers: Vec<String>,
    pub(crate) label: String,
}

pub(crate) fn default_hotkey_transcribe() -> HotkeyBinding {
    HotkeyBinding {
        key: "fn".into(),
        modifiers: Vec::new(),
        label: "Fn".into(),
    }
}

pub(crate) fn default_hotkey_translate() -> HotkeyBinding {
    HotkeyBinding {
        key: "fn".into(),
        modifiers: vec!["shift".into()],
        label: "⇧+Fn".into(),
    }
}

pub(crate) fn default_hotkey_cancel() -> HotkeyBinding {
    HotkeyBinding {
        key: "escape".into(),
        modifiers: Vec::new(),
        label: "Esc".into(),
    }
}

/// Fn held + Space (keycode 49). `"fn"` is a pseudo-modifier (not CGEventFlags).
pub(crate) fn default_hotkey_agent() -> HotkeyBinding {
    HotkeyBinding {
        key: "49".into(),
        modifiers: vec!["fn".into()],
        label: "Fn+Space".into(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct ExtraLanguage {
    pub(crate) id: String,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct AgentProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    /// `claude` | `codex` | `pi`
    pub(crate) kind: String,
    /// Optional CLI override (empty → agent_*_bin / which).
    #[serde(default)]
    pub(crate) bin: String,
    /// Underlying model for CLI (`claude --model` / `codex -m`). Empty → CLI default.
    #[serde(default)]
    pub(crate) model: String,
}

pub(crate) fn default_agent_profiles() -> Vec<AgentProfile> {
    vec![
        AgentProfile {
            id: "claude".into(),
            name: "Claude".into(),
            kind: "claude".into(),
            bin: String::new(),
            model: "sonnet".into(),
        },
        AgentProfile {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "codex".into(),
            bin: String::new(),
            model: String::new(),
        },
        AgentProfile {
            id: "pi".into(),
            name: "Pi".into(),
            kind: "pi".into(),
            bin: String::new(),
            model: String::new(),
        },
    ]
}

pub(crate) fn default_agent_profile_id() -> String {
    "claude".into()
}

pub(crate) fn default_agent_kind() -> String {
    "claude".into()
}

pub(crate) fn format_hotkey_label(key: &str, modifiers: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if modifiers.iter().any(|m| m == "fn") {
        parts.push("Fn".into());
    }
    if modifiers.iter().any(|m| m == "control") {
        parts.push("⌃".into());
    }
    if modifiers.iter().any(|m| m == "option") {
        parts.push("⌥".into());
    }
    if modifiers.iter().any(|m| m == "shift") {
        parts.push("⇧".into());
    }
    if modifiers.iter().any(|m| m == "command") {
        parts.push("⌘".into());
    }
    let key_label = match key {
        "fn" => "Fn".into(),
        "escape" => "Esc".into(),
        "…" | "..." => "…".into(),
        "49" => "Space".into(),
        "36" => "Return".into(),
        "48" => "Tab".into(),
        "51" => "Delete".into(),
        "123" => "←".into(),
        "124" => "→".into(),
        "125" => "↓".into(),
        "126" => "↑".into(),
        other => {
            if let Ok(code) = other.parse::<i64>() {
                keycode_letter(code).unwrap_or_else(|| format!("Key{code}"))
            } else {
                other.to_string()
            }
        }
    };
    if key == "…" || key == "..." {
        if parts.is_empty() {
            return "…".into();
        }
        parts.push("…".into());
        return parts.join("+");
    }
    parts.push(key_label);
    parts.join("+")
}

pub(crate) fn keycode_letter(code: i64) -> Option<String> {
    // US ANSI letter/digit keycodes → display glyph.
    let ch = match code {
        0 => 'A',
        1 => 'S',
        2 => 'D',
        3 => 'F',
        4 => 'H',
        5 => 'G',
        6 => 'Z',
        7 => 'X',
        8 => 'C',
        9 => 'V',
        11 => 'B',
        12 => 'Q',
        13 => 'W',
        14 => 'E',
        15 => 'R',
        16 => 'Y',
        17 => 'T',
        18 => '1',
        19 => '2',
        20 => '3',
        21 => '4',
        22 => '6',
        23 => '5',
        24 => '=',
        25 => '9',
        26 => '7',
        27 => '-',
        28 => '8',
        29 => '0',
        31 => 'O',
        32 => 'U',
        34 => 'I',
        35 => 'P',
        37 => 'L',
        38 => 'J',
        40 => 'K',
        45 => 'N',
        46 => 'M',
        _ => return None,
    };
    Some(ch.to_string())
}

pub(crate) fn binding_from_event(key: &str, modifiers: Vec<String>) -> HotkeyBinding {
    let label = format_hotkey_label(key, &modifiers);
    HotkeyBinding {
        key: key.into(),
        modifiers,
        label,
    }
}

pub(crate) fn binding_matches(binding: &HotkeyBinding, key: &str, modifiers: &[String]) -> bool {
    if binding.key != key {
        return false;
    }
    let mut a = binding.modifiers.clone();
    let mut b = modifiers.to_vec();
    a.sort();
    b.sort();
    a == b
}

pub(crate) fn binding_is_fn(binding: &HotkeyBinding) -> bool {
    binding.key == "fn"
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct AppConfig {
    pub(crate) asr_model_dir: String,
    /// Qwen3-ForcedAligner model directory (word/char timestamps).
    #[serde(default)]
    pub(crate) align_model_dir: String,
    /// Enable ForcedAligner. Effective only when `align_model_dir` is non-empty.
    #[serde(default = "default_align_enabled")]
    pub(crate) align_enabled: bool,
    /// Catalog id e.g. `Qwen3-ASR-0.6B`.
    #[serde(default = "default_asr_model_id")]
    pub(crate) asr_model_id: String,
    pub(crate) asr_provider: AsrProvider,
    pub(crate) elevenlabs_api_key: String,
    pub(crate) elevenlabs_model: String,
    pub(crate) language: String,
    /// Shift+Fn translate target language (BCP-47 / app language id).
    #[serde(default = "default_translate_target_language")]
    pub(crate) translate_target_language: String,
    /// User-added languages (beyond built-in zh/en/ja/ko).
    #[serde(default)]
    pub(crate) extra_languages: Vec<ExtraLanguage>,
    /// Qwen streaming chunk size in seconds (`chunk_size_sec`).
    #[serde(default = "default_chunk_size_sec")]
    pub(crate) chunk_size_sec: f64,
    /// Qwen streaming unfixed token count (`unfixed_token_num` / rollback_tokens).
    #[serde(default = "default_unfixed_token_num")]
    pub(crate) unfixed_token_num: usize,
    /// Warm the mic on Fn key-down (discard buffer unless the release commits
    /// a transcribe/translate/agent session). Trading a brief mic-indicator
    /// flash during cancelled chords for ~30-80ms faster capture start.
    #[serde(default = "default_speculative_mic")]
    pub(crate) speculative_mic: bool,
    /// VAD backend: `webrtc` (default) or `energy`.
    #[serde(default = "default_vad_backend")]
    pub(crate) vad_backend: String,
    /// WebRTC aggressiveness 0..=3 (Quality..VeryAggressive). Default 2.
    #[serde(default = "default_vad_aggression")]
    pub(crate) vad_aggression: u8,
    /// Energy VAD RMS threshold (linear PCM); used when backend is `energy`.
    #[serde(default = "default_vad_energy_threshold")]
    pub(crate) vad_energy_threshold: f32,
    /// Silence duration (ms) before a commit candidate.
    #[serde(default = "default_vad_min_silence_ms")]
    pub(crate) vad_min_silence_ms: u64,
    /// Extra silence hold (ms) after candidate before commit.
    #[serde(default = "default_vad_commit_hold_ms")]
    pub(crate) vad_commit_hold_ms: u64,
    /// Minimum segment length (ms).
    #[serde(default = "default_vad_min_segment_ms")]
    pub(crate) vad_min_segment_ms: u64,
    /// Hard-cap segment length (seconds) — RoPE / KV guard.
    #[serde(default = "default_vad_max_segment_sec")]
    pub(crate) vad_max_segment_sec: f64,
    /// Overlap into next segment after a cut (ms).
    #[serde(default = "default_vad_overlap_ms")]
    pub(crate) vad_overlap_ms: u64,
    /// VAD speed preset: "default" or "fast" (shorter silence/hold for rapid dictation).
    #[serde(default = "default_vad_speed_preset")]
    pub(crate) vad_speed_preset: String,
    /// Max tokens of committed text injected as cross-segment context (0 = off).
    #[serde(default = "default_cross_segment_prefix_tokens")]
    pub(crate) cross_segment_prefix_tokens: usize,
    #[serde(default = "default_hotkey_transcribe")]
    pub(crate) hotkey_transcribe: HotkeyBinding,
    #[serde(default = "default_hotkey_translate")]
    pub(crate) hotkey_translate: HotkeyBinding,
    #[serde(default = "default_hotkey_cancel")]
    pub(crate) hotkey_cancel: HotkeyBinding,
    /// Summon agent HUD (default Fn+Space).
    #[serde(default = "default_hotkey_agent")]
    pub(crate) hotkey_agent: HotkeyBinding,
    /// Last agent kind: `claude` | `codex` (mirrors selected profile.kind).
    #[serde(default = "default_agent_kind")]
    pub(crate) agent_kind: String,
    /// Selected agent profile id (settings-managed list).
    #[serde(default = "default_agent_profile_id")]
    pub(crate) agent_profile_id: String,
    /// User-managed agent presets (HUD picker).
    #[serde(default = "default_agent_profiles")]
    pub(crate) agent_profiles: Vec<AgentProfile>,
    /// Working directory for agent CLI runs.
    #[serde(default)]
    pub(crate) agent_cwd: String,
    /// Recent / custom agent working directories (HUD picker). Cap enforced on write.
    #[serde(default)]
    pub(crate) agent_cwd_history: Vec<String>,
    /// Absolute path to `claude` CLI (empty = `which claude`). Fallback if profile.bin empty.
    #[serde(default)]
    pub(crate) agent_claude_bin: String,
    /// Absolute path to `codex` CLI (empty = `which codex`). Fallback if profile.bin empty.
    #[serde(default)]
    pub(crate) agent_codex_bin: String,
    /// Absolute path to `pi` CLI (empty = `which pi`). Fallback if profile.bin empty.
    #[serde(default)]
    pub(crate) agent_pi_bin: String,
    /// CWD paths user granted for Codex outside a git repo (`--skip-git-repo-check`).
    #[serde(default)]
    pub(crate) agent_trusted_dirs: Vec<String>,
    /// Recording source: external mic / system playback / both.
    #[serde(default)]
    pub(crate) audio_capture_mode: AudioCaptureMode,
    pub(crate) llm_enabled: bool,
    #[serde(default = "default_llm_provider")]
    pub(crate) llm_provider: String,
    pub(crate) llm_api_base_url: String,
    pub(crate) llm_api_key: String,
    pub(crate) llm_model: String,
    /// Per-provider credentials (provider id -> creds). The frontend resolves the
    /// active provider into the flat `llm_api_*` fields; the backend only reads flat.
    /// Persisted here so Rust-side saves don't drop it.
    #[serde(default)]
    pub(crate) llm_credentials: std::collections::HashMap<String, LlmCredential>,
    /// Empty = built-in refine prompt.
    #[serde(default)]
    pub(crate) llm_refine_prompt: String,
    /// Empty = built-in translate prompt (`{target}` placeholder).
    #[serde(default)]
    pub(crate) llm_translate_prompt: String,
    pub(crate) vocabulary: Vec<String>,
}

pub(crate) fn default_translate_target_language() -> String {
    "en-US".into()
}

pub(crate) fn default_chunk_size_sec() -> f64 {
    // Steady-state partial cadence. First hypothesis timing is handled separately
    // (0.5s bootstrap + early ramp in the mlx worker); partial decode is
    // incremental (Δ-mel/encoder + rollback re-encode + ≤32 tokens), so 0.6s
    // reads as "live" while leaving the rollback window room to settle —
    // shorter cadences make hypotheses flicker instead of stream.
    0.6
}

pub(crate) fn default_unfixed_token_num() -> usize {
    5
}

pub(crate) fn default_speculative_mic() -> bool {
    true
}

pub(crate) fn default_vad_backend() -> String {
    "webrtc".into()
}

pub(crate) fn default_vad_aggression() -> u8 {
    2
}

pub(crate) fn default_vad_energy_threshold() -> f32 {
    // Enter threshold; exit = 40% via SegmentConfig::from_app_ms (hysteresis).
    0.010
}

pub(crate) fn default_vad_min_silence_ms() -> u64 {
    // 650ms + 250ms hold ≈ 0.9s of quiet before a segment commits — prompt
    // enough that finished sentences settle visibly, without cutting at
    // mid-sentence thinking pauses (those rarely reach 0.9s).
    650
}

pub(crate) fn default_vad_commit_hold_ms() -> u64 {
    250
}

pub(crate) fn default_vad_min_segment_ms() -> u64 {
    // Counts *speech* samples only. 1.2s: a short spoken sentence + a natural
    // pause now commits (HUD text settles) instead of waiting for 2.5s of
    // accumulated speech. Cross-segment context prefix absorbs the boundary.
    1200
}

pub(crate) fn default_vad_max_segment_sec() -> f64 {
    90.0
}

pub(crate) fn default_vad_overlap_ms() -> u64 {
    500
}

pub(crate) fn default_vad_speed_preset() -> String {
    "default".into()
}

pub(crate) fn default_cross_segment_prefix_tokens() -> usize {
    64
}

pub(crate) fn default_asr_model_id() -> String {
    "Qwen3-ASR-0.6B".into()
}

pub(crate) fn default_llm_provider() -> String {
    "openai".into()
}

pub(crate) fn default_align_enabled() -> bool {
    true
}

/// Per-provider LLM credentials. Only persisted; requests read the flat `llm_api_*`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct LlmCredential {
    #[serde(default)]
    pub(crate) api_base_url: String,
    #[serde(default)]
    pub(crate) api_key: String,
    #[serde(default)]
    pub(crate) model: String,
    /// Display name for user-added custom providers. Empty for built-in presets.
    #[serde(default)]
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AsrProvider {
    Qwen,
    Apple,
    Elevenlabs,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            asr_model_dir: String::new(),
            align_model_dir: default_align_model_dir(),
            align_enabled: default_align_enabled(),
            asr_model_id: default_asr_model_id(),
            asr_provider: default_asr_provider(),
            elevenlabs_api_key: String::new(),
            elevenlabs_model: "scribe_v2".into(),
            language: read_user_default_language().unwrap_or_else(|| "auto".into()),
            translate_target_language: default_translate_target_language(),
            extra_languages: Vec::new(),
            chunk_size_sec: default_chunk_size_sec(),
            unfixed_token_num: default_unfixed_token_num(),
            speculative_mic: default_speculative_mic(),
            vad_backend: default_vad_backend(),
            vad_aggression: default_vad_aggression(),
            vad_energy_threshold: default_vad_energy_threshold(),
            vad_min_silence_ms: default_vad_min_silence_ms(),
            vad_commit_hold_ms: default_vad_commit_hold_ms(),
            vad_min_segment_ms: default_vad_min_segment_ms(),
            vad_max_segment_sec: default_vad_max_segment_sec(),
            vad_overlap_ms: default_vad_overlap_ms(),
            vad_speed_preset: default_vad_speed_preset(),
            cross_segment_prefix_tokens: default_cross_segment_prefix_tokens(),
            hotkey_transcribe: default_hotkey_transcribe(),
            hotkey_translate: default_hotkey_translate(),
            hotkey_cancel: default_hotkey_cancel(),
            hotkey_agent: default_hotkey_agent(),
            agent_kind: default_agent_kind(),
            agent_profile_id: default_agent_profile_id(),
            agent_profiles: default_agent_profiles(),
            agent_cwd: String::new(),
            agent_cwd_history: Vec::new(),
            agent_claude_bin: String::new(),
            agent_codex_bin: String::new(),
            agent_pi_bin: String::new(),
            agent_trusted_dirs: Vec::new(),
            audio_capture_mode: AudioCaptureMode::External,
            llm_enabled: false,
            llm_provider: default_llm_provider(),
            llm_api_base_url: "https://api.openai.com/v1".into(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".into(),
            llm_credentials: std::collections::HashMap::new(),
            llm_refine_prompt: String::new(),
            llm_translate_prompt: String::new(),
            vocabulary: Vec::new(),
        }
    }
}

pub(crate) fn agent_jobs_path() -> PathBuf {
    app_data_dir().join("agent-jobs.json")
}

pub(crate) fn default_asr_provider() -> AsrProvider {
    #[cfg(target_os = "macos")]
    {
        AsrProvider::Apple
    }
    #[cfg(not(target_os = "macos"))]
    {
        AsrProvider::Qwen
    }
}

impl AsrProvider {
    pub(crate) fn label(&self) -> &'static str {
        match self {
            AsrProvider::Qwen => "qwen",
            AsrProvider::Apple => "apple",
            AsrProvider::Elevenlabs => "elevenlabs",
        }
    }
}
pub(crate) fn default_align_model_dir() -> String {
    let hf = dirs::home_dir().map(|h| {
        h.join(".cache/huggingface/hub/models--Qwen--Qwen3-ForcedAligner-0.6B/snapshots")
    });
    if let Some(snapshots) = hf {
        if let Ok(entries) = fs::read_dir(&snapshots) {
            let mut dirs: Vec<_> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir() && p.join("config.json").exists())
                .collect();
            dirs.sort();
            if let Some(last) = dirs.pop() {
                return last.to_string_lossy().to_string();
            }
        }
    }
    String::new()
}

const APP_DATA_DIR_NAME: &str = "Yanluo";
const LEGACY_APP_DATA_DIR_NAME: &str = "ASR Workshop";
const DEFAULTS_DOMAIN: &str = "com.sherlockouo.yanluo";
const LEGACY_DEFAULTS_DOMAIN: &str = "com.template.asr-workshop";

pub(crate) fn app_data_dir() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical = base.join(APP_DATA_DIR_NAME);
    if canonical.exists() {
        return canonical;
    }
    let legacy = base.join(LEGACY_APP_DATA_DIR_NAME);
    if legacy.exists() {
        match fs::rename(&legacy, &canonical) {
            Ok(()) => {
                crate::elog::elog!(
                    "[config] migrated data dir {:?} → {:?}",
                    legacy, canonical
                );
                return canonical;
            }
            Err(e) => {
                crate::elog::elog!(
                    "[config] migrate data dir failed ({e}); using legacy {:?}",
                    legacy
                );
                return legacy;
            }
        }
    }
    canonical
}

/// Default agent working directory: `{app_data_dir}/agent` (created on demand).
pub(crate) fn default_agent_workdir() -> PathBuf {
    app_data_dir().join("agent")
}

pub(crate) fn ensure_default_agent_workdir() -> Result<PathBuf, String> {
    let dir = default_agent_workdir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建 agent 工作目录失败: {e}"))?;
    Ok(dir)
}

/// Empty `agent_cwd` → ensure `{app}/agent` and write back.
pub(crate) fn resolve_agent_cwd(config: &mut AppConfig) -> Result<String, String> {
    let trimmed = config.agent_cwd.trim().to_string();
    if !trimmed.is_empty() && Path::new(&trimmed).is_dir() {
        push_agent_cwd_history(config, &trimmed);
        return Ok(trimmed);
    }
    let dir = ensure_default_agent_workdir()?;
    let s = dir.to_string_lossy().into_owned();
    config.agent_cwd = s.clone();
    push_agent_cwd_history(config, &s);
    Ok(s)
}

const AGENT_CWD_HISTORY_CAP: usize = 12;

/// Dedupe + move `cwd` to front; always keep default agent workdir in list.
pub(crate) fn push_agent_cwd_history(config: &mut AppConfig, cwd: &str) {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return;
    }
    config.agent_cwd_history.retain(|p| p != cwd);
    config.agent_cwd_history.insert(0, cwd.to_string());
    if let Ok(default) = ensure_default_agent_workdir() {
        let d = default.to_string_lossy().into_owned();
        if !config.agent_cwd_history.iter().any(|p| p == &d) {
            config.agent_cwd_history.push(d);
        }
    }
    if config.agent_cwd_history.len() > AGENT_CWD_HISTORY_CAP {
        config.agent_cwd_history.truncate(AGENT_CWD_HISTORY_CAP);
    }
}

pub(crate) fn recordings_dir() -> PathBuf {
    app_data_dir().join("recordings")
}

pub(crate) fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

pub(crate) fn history_path() -> PathBuf {
    app_data_dir().join("history.json")
}

pub(crate) fn load_config_from_disk() -> AppConfig {
    let mut config = fs::read_to_string(config_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default();
    normalize_config_for_platform(&mut config);
    ensure_agent_profiles(&mut config);
    let before = config.agent_cwd.clone();
    if resolve_agent_cwd(&mut config).is_ok() && config.agent_cwd != before {
        let _ = save_config_to_disk(&config);
    }
    config
}

/// Ensure at least default Claude/Codex profiles; sync kind from selected profile.
pub(crate) fn ensure_agent_profiles(config: &mut AppConfig) {
    if config.agent_profiles.is_empty() {
        config.agent_profiles = default_agent_profiles();
    }
    // Deduplicate ids.
    let mut seen = std::collections::HashSet::new();
    config.agent_profiles.retain(|p| {
        let id = p.id.trim().to_string();
        if id.is_empty() || !seen.insert(id) {
            return false;
        }
        true
    });
    if config.agent_profiles.is_empty() {
        config.agent_profiles = default_agent_profiles();
    }
    if !config
        .agent_profiles
        .iter()
        .any(|p| p.id == config.agent_profile_id)
    {
        config.agent_profile_id = config.agent_profiles[0].id.clone();
    }
    if let Some(p) = config
        .agent_profiles
        .iter()
        .find(|p| p.id == config.agent_profile_id)
    {
        let kind = match p.kind.as_str() {
            "codex" => "codex",
            "pi" => "pi",
            _ => "claude",
        };
        config.agent_kind = kind.into();
    }
}

pub(crate) fn normalize_config_for_platform(config: &mut AppConfig) {
    #[cfg(not(target_os = "macos"))]
    {
        if matches!(config.asr_provider, AsrProvider::Apple | AsrProvider::Elevenlabs) {
            config.asr_provider = AsrProvider::Qwen;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if matches!(config.asr_provider, AsrProvider::Elevenlabs) {
            config.asr_provider = AsrProvider::Apple;
        }
    }
    let _ = config;
}

pub(crate) fn save_config_to_disk(config: &AppConfig) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(), data).map_err(|e| e.to_string())?;
    write_user_default_language(&config.language);
    Ok(())
}

pub(crate) fn read_user_default_language() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for domain in [DEFAULTS_DOMAIN, LEGACY_DEFAULTS_DOMAIN] {
            let output = Command::new("defaults")
                .args(["read", domain, "language"])
                .output()
                .ok()?;
            if !output.status.success() {
                continue;
            }
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(crate) fn write_user_default_language(language: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("defaults")
            .args(["write", DEFAULTS_DOMAIN, "language", language])
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = language;
    }
}
