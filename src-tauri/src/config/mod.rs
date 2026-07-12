use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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

pub(crate) fn format_hotkey_label(key: &str, modifiers: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
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
    pub(crate) asr_provider: AsrProvider,
    pub(crate) elevenlabs_api_key: String,
    pub(crate) elevenlabs_model: String,
    pub(crate) language: String,
    /// Shift+Fn translate target language (BCP-47 / app language id).
    #[serde(default = "default_translate_target_language")]
    pub(crate) translate_target_language: String,
    /// Qwen streaming chunk size in seconds (`chunk_size_sec`).
    #[serde(default = "default_chunk_size_sec")]
    pub(crate) chunk_size_sec: f64,
    /// Qwen streaming unfixed token count (`unfixed_token_num` / rollback_tokens).
    #[serde(default = "default_unfixed_token_num")]
    pub(crate) unfixed_token_num: usize,
    /// Energy VAD RMS threshold (linear PCM).
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
    /// Max tokens of committed text injected as cross-segment context (0 = off).
    #[serde(default = "default_cross_segment_prefix_tokens")]
    pub(crate) cross_segment_prefix_tokens: usize,
    #[serde(default = "default_hotkey_transcribe")]
    pub(crate) hotkey_transcribe: HotkeyBinding,
    #[serde(default = "default_hotkey_translate")]
    pub(crate) hotkey_translate: HotkeyBinding,
    #[serde(default = "default_hotkey_cancel")]
    pub(crate) hotkey_cancel: HotkeyBinding,
    /// Recording source: external mic / system playback / both.
    #[serde(default)]
    pub(crate) audio_capture_mode: AudioCaptureMode,
    pub(crate) llm_enabled: bool,
    pub(crate) llm_api_base_url: String,
    pub(crate) llm_api_key: String,
    pub(crate) llm_model: String,
    pub(crate) vocabulary: Vec<String>,
}

pub(crate) fn default_translate_target_language() -> String {
    "en-US".into()
}

pub(crate) fn default_chunk_size_sec() -> f64 {
    // 1.5s: first hypothesis has enough audio; 1.0s felt weak on sentence starts.
    1.5
}

pub(crate) fn default_unfixed_token_num() -> usize {
    5
}

pub(crate) fn default_vad_energy_threshold() -> f32 {
    // Enter threshold; exit = 40% via SegmentConfig::from_app_ms (hysteresis).
    0.010
}

pub(crate) fn default_vad_min_silence_ms() -> u64 {
    900
}

pub(crate) fn default_vad_commit_hold_ms() -> u64 {
    500
}

pub(crate) fn default_vad_min_segment_ms() -> u64 {
    2500
}

pub(crate) fn default_vad_max_segment_sec() -> f64 {
    90.0
}

pub(crate) fn default_vad_overlap_ms() -> u64 {
    500
}

pub(crate) fn default_cross_segment_prefix_tokens() -> usize {
    64
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
            asr_provider: default_asr_provider(),
            elevenlabs_api_key: String::new(),
            elevenlabs_model: "scribe_v2".into(),
            language: read_user_default_language().unwrap_or_else(|| "auto".into()),
            translate_target_language: default_translate_target_language(),
            chunk_size_sec: default_chunk_size_sec(),
            unfixed_token_num: default_unfixed_token_num(),
            vad_energy_threshold: default_vad_energy_threshold(),
            vad_min_silence_ms: default_vad_min_silence_ms(),
            vad_commit_hold_ms: default_vad_commit_hold_ms(),
            vad_min_segment_ms: default_vad_min_segment_ms(),
            vad_max_segment_sec: default_vad_max_segment_sec(),
            vad_overlap_ms: default_vad_overlap_ms(),
            cross_segment_prefix_tokens: default_cross_segment_prefix_tokens(),
            hotkey_transcribe: default_hotkey_transcribe(),
            hotkey_translate: default_hotkey_translate(),
            hotkey_cancel: default_hotkey_cancel(),
            audio_capture_mode: AudioCaptureMode::External,
            llm_enabled: false,
            llm_api_base_url: "https://api.openai.com/v1".into(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".into(),
            vocabulary: Vec::new(),
        }
    }
}

pub(crate) fn default_asr_provider() -> AsrProvider {
    #[cfg(target_os = "macos")]
    {
        AsrProvider::Apple
    }
    #[cfg(not(target_os = "macos"))]
    {
        AsrProvider::Elevenlabs
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

pub(crate) fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("ASR Workshop")
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
    config
}

pub(crate) fn normalize_config_for_platform(config: &mut AppConfig) {
    #[cfg(not(target_os = "macos"))]
    {
        if matches!(config.asr_provider, AsrProvider::Apple) {
            config.asr_provider = AsrProvider::Elevenlabs;
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
        let output = Command::new("defaults")
            .args(["read", "com.template.asr-workshop", "language"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
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
            .args(["write", "com.template.asr-workshop", "language", language])
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = language;
    }
}
