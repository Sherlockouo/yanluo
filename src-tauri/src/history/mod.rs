use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};
use crate::state::*;
use crate::config::*;
use crate::transcription::*;

/// Word/char span for transcript highlighting (ForcedAligner / ElevenLabs words).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TranscriptSegment {
    pub(crate) text: String,
    pub(crate) start: f64,
    pub(crate) end: f64,
}

/// ElevenLabs `CharacterAlignmentResponseModel` shape for transcript-viewer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CharacterAlignment {
    pub(crate) characters: Vec<String>,
    pub(crate) character_start_times_seconds: Vec<f64>,
    pub(crate) character_end_times_seconds: Vec<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct HistoryEntry {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) raw_text: String,
    pub(crate) language: String,
    pub(crate) duration_seconds: f64,
    pub(crate) created_at: String,
    pub(crate) refined: bool,
    #[serde(default)]
    pub(crate) audio_path: Option<String>,
    /// "audio" | "video" — drives `<audio>` vs `<video>` playback.
    #[serde(default = "default_media_kind")]
    pub(crate) media_kind: String,
    /// Word/char timing spans for highlight.
    #[serde(default)]
    pub(crate) segments: Vec<TranscriptSegment>,
    /// ElevenLabs CharacterAlignmentResponseModel-compatible payload.
    #[serde(default)]
    pub(crate) alignment: Option<CharacterAlignment>,
    /// "fn" | "translate" | "transcribe"
    #[serde(default = "default_history_source")]
    pub(crate) source: String,
    /// Translate target language id (e.g. en-US). Only set for translate sessions.
    #[serde(default)]
    pub(crate) translate_target_language: Option<String>,
}

pub(crate) fn default_media_kind() -> String {
    "audio".into()
}

pub(crate) fn default_history_source() -> String {
    "fn".into()
}
pub(crate) fn load_history_from_disk() -> Vec<HistoryEntry> {
    fs::read_to_string(history_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub(crate) fn save_history_to_disk(history: &[HistoryEntry]) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    fs::write(history_path(), data).map_err(|e| e.to_string())
}
pub(crate) fn append_history(
    app: &AppHandle,
    result: &TranscriptionResult,
    source: &str,
    audio_path: Option<String>,
    media_kind: &str,
) {
    let state = app.state::<AsrEngine>();
    let mut history = match state.inner().history.lock() {
        Ok(history) => history,
        Err(_) => return,
    };
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        history.len().saturating_add(1)
    );
    let translate_target_language = if source == "translate" {
        state
            .inner()
            .config
            .lock()
            .ok()
            .map(|c| c.translate_target_language.clone())
            .filter(|s| !s.trim().is_empty())
    } else {
        None
    };
    history.insert(
        0,
        HistoryEntry {
            id,
            text: result.text.clone(),
            raw_text: result.raw_text.clone(),
            language: result.language.clone(),
            duration_seconds: result.duration_seconds,
            created_at: chrono::Utc::now().to_rfc3339(),
            refined: result.refined,
            audio_path,
            media_kind: media_kind.to_string(),
            segments: result.segments.clone(),
            alignment: result.alignment.clone(),
            source: source.to_string(),
            translate_target_language,
        },
    );
    history.truncate(5000);
    let _ = save_history_to_disk(&history);
}

/// Remove one history entry by id. Deletes associated media under recordings/.
/// Returns true if an entry was removed.
pub(crate) fn delete_history_entry_by_id(
    history: &mut Vec<HistoryEntry>,
    id: &str,
) -> Result<bool, String> {
    let Some(idx) = history.iter().position(|e| e.id == id) else {
        return Ok(false);
    };
    let entry = history.remove(idx);
    if let Some(path) = entry.audio_path.as_deref() {
        remove_recording_if_owned(path);
    }
    save_history_to_disk(history)?;
    Ok(true)
}

fn remove_recording_if_owned(path: &str) {
    let path = Path::new(path);
    if path.starts_with(recordings_dir()) {
        let _ = fs::remove_file(path);
    }
}
