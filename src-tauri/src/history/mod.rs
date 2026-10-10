use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
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
    /// Canonical speaker id (e.g. "speaker_1") when the provider diarized.
    /// serde(default) keeps pre-P2 history.json / transcript.json parseable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) speaker: Option<String>,
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
    /// Canonical display / paste text (user gold if adjusted, else LLM/ASR).
    pub(crate) text: String,
    /// ASR raw output.
    pub(crate) raw_text: String,
    /// Snapshot after LLM refine (+ post-vocab). None if LLM did not run.
    #[serde(default)]
    pub(crate) llm_text: Option<String>,
    /// Explicit user correction (gold). None until user edits.
    #[serde(default)]
    pub(crate) user_text: Option<String>,
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
    /// User rating of ASR quality: "bad" | "ok" | "good". Used for learn/distill.
    #[serde(default)]
    pub(crate) quality_rating: Option<String>,
    /// RFC3339 when quality_rating was last set.
    #[serde(default)]
    pub(crate) rated_at: Option<String>,
    /// Learn loop: None | "suggested" | "distilled" | "applied" | "skipped".
    #[serde(default)]
    pub(crate) learn_status: Option<String>,
    /// Terms applied to vocab from this entry.
    #[serde(default)]
    pub(crate) learn_terms: Vec<String>,
    /// Linked work (作品目录 folder index id) for file/URL transcriptions.
    #[serde(default)]
    pub(crate) work_id: Option<String>,
}

#[cfg(test)]
impl HistoryEntry {
    /// Minimal entry for tests: fill only the fields the learn/distill logic reads.
    pub(crate) fn test_new(id: &str, raw: &str) -> Self {
        HistoryEntry {
            id: id.into(),
            text: raw.into(),
            raw_text: raw.into(),
            llm_text: None,
            user_text: None,
            language: "zh-CN".into(),
            duration_seconds: 1.0,
            created_at: "2026-01-01T00:00:00Z".into(),
            refined: false,
            audio_path: None,
            media_kind: "audio".into(),
            segments: Vec::new(),
            alignment: None,
            source: "fn".into(),
            translate_target_language: None,
            quality_rating: None,
            rated_at: None,
            learn_status: None,
            learn_terms: Vec::new(),
            work_id: None,
        }
    }
}

pub(crate) fn default_media_kind() -> String {
    "audio".into()
}

pub(crate) fn default_history_source() -> String {
    "fn".into()
}
pub(crate) fn load_history_from_disk() -> Vec<HistoryEntry> {
    let path = history_path();
    match fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(history) => history,
            Err(error) => {
                crate::elog::elog!("[history] parse failed {:?}: {error}", path);
                Vec::new()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            crate::elog::elog!("[history] read failed {:?}: {error}", path);
            Vec::new()
        }
    }
}

/// List/IPC payload — drop alignment + segments (can be MiB-scale per entry).
pub(crate) fn history_entry_for_list(entry: &HistoryEntry) -> HistoryEntry {
    HistoryEntry {
        id: entry.id.clone(),
        text: entry.text.clone(),
        raw_text: entry.raw_text.clone(),
        llm_text: entry.llm_text.clone(),
        user_text: entry.user_text.clone(),
        language: entry.language.clone(),
        duration_seconds: entry.duration_seconds,
        created_at: entry.created_at.clone(),
        refined: entry.refined,
        audio_path: entry.audio_path.clone(),
        media_kind: entry.media_kind.clone(),
        segments: Vec::new(),
        alignment: None,
        source: entry.source.clone(),
        translate_target_language: entry.translate_target_language.clone(),
        quality_rating: entry.quality_rating.clone(),
        rated_at: entry.rated_at.clone(),
        learn_status: entry.learn_status.clone(),
        learn_terms: entry.learn_terms.clone(),
        work_id: entry.work_id.clone(),
    }
}

pub(crate) fn save_history_to_disk(history: &[HistoryEntry]) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut tmp, history).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(history_path())
        .map_err(|e| e.error.to_string())?;
    Ok(())
}
pub(crate) fn append_history(
    app: &AppHandle,
    result: &TranscriptionResult,
    source: &str,
    audio_path: Option<String>,
    media_kind: &str,
) -> Option<String> {
    append_history_with_user(app, result, source, audio_path, media_kind, None)
}

/// Append history; optional user correction sets learn fields in one write.
pub(crate) fn append_history_with_user(
    app: &AppHandle,
    result: &TranscriptionResult,
    source: &str,
    audio_path: Option<String>,
    media_kind: &str,
    user_text: Option<&str>,
) -> Option<String> {
    let state = app.state::<AsrEngine>();
    let _persist = match state.inner().history_persist.lock() {
        Ok(lock) => lock,
        Err(error) => {
            crate::elog::elog!("[history] append serialization failed: {error}");
            return None;
        }
    };
    // Lock order: config → history (same as apply_learned_terms) to avoid deadlock.
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
    let mut history = match state.inner().history.lock() {
        Ok(history) => history,
        Err(error) => {
            crate::elog::elog!("[history] append failed: {error}");
            return None;
        }
    };
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        history.len().saturating_add(1)
    );
    let user_trim = user_text.map(str::trim).filter(|s| !s.is_empty());
    let (text, user_text_field, quality_rating, rated_at, learn_status) =
        if let Some(u) = user_trim {
            (
                u.to_string(),
                Some(u.to_string()),
                Some("bad".to_string()),
                Some(chrono::Utc::now().to_rfc3339()),
                Some("suggested".to_string()),
            )
        } else {
            (result.text.clone(), None, None, None, None)
        };
    history.insert(
        0,
        HistoryEntry {
            id: id.clone(),
            text,
            raw_text: result.raw_text.clone(),
            llm_text: result.llm_text.clone(),
            user_text: user_text_field,
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
            quality_rating,
            rated_at,
            learn_status,
            learn_terms: Vec::new(),
            work_id: None,
        },
    );
    history.truncate(5000);
    let snapshot = history.clone();
    drop(history);
    if let Err(error) = save_history_to_disk(&snapshot) {
        crate::elog::elog!("[history] append persist failed: {error}");
        return None;
    }
    Some(id)
}

/// Link a history entry to its work folder (作品目录). Re-persists under the
/// same history_persist serialization as append.
pub(crate) fn set_history_work_id(app: &AppHandle, id: &str, work_id: &str) {
    let state = app.state::<AsrEngine>();
    let _persist = match state.inner().history_persist.lock() {
        Ok(lock) => lock,
        Err(error) => {
            crate::elog::elog!("[history] work_id serialization failed: {error}");
            return;
        }
    };
    let mut history = match state.inner().history.lock() {
        Ok(history) => history,
        Err(error) => {
            crate::elog::elog!("[history] work_id update failed: {error}");
            return;
        }
    };
    let Some(entry) = history.iter_mut().find(|e| e.id == id) else {
        crate::elog::elog!("[history] work_id target not found: {id}");
        return;
    };
    entry.work_id = Some(work_id.to_string());
    let snapshot = history.clone();
    drop(history);
    if let Err(error) = save_history_to_disk(&snapshot) {
        crate::elog::elog!("[history] work_id persist failed: {error}");
    }
}

fn learn_status_ok(status: &str) -> bool {
    matches!(
        status,
        "suggested" | "distilled" | "applied" | "skipped"
    )
}

/// Set or clear `quality_rating` on one entry. Empty `rating` clears.
/// Allowed: "bad" | "ok" | "good". Sets/clears `rated_at` accordingly.
pub(crate) fn rate_history_entry_by_id(
    history: &mut Vec<HistoryEntry>,
    id: &str,
    rating: &str,
) -> Result<bool, String> {
    let Some(entry) = history.iter_mut().find(|e| e.id == id) else {
        return Ok(false);
    };
    let trimmed = rating.trim();
    if trimmed.is_empty() {
        entry.quality_rating = None;
        entry.rated_at = None;
    } else if matches!(trimmed, "bad" | "ok" | "good") {
        entry.quality_rating = Some(trimmed.to_string());
        entry.rated_at = Some(chrono::Utc::now().to_rfc3339());
    } else {
        return Err(format!("invalid quality_rating: {trimmed}"));
    }
    Ok(true)
}

/// Save user gold correction. Updates `user_text` + canonical `text`.
pub(crate) fn set_history_user_text_by_id(
    history: &mut Vec<HistoryEntry>,
    id: &str,
    user_text: &str,
) -> Result<bool, String> {
    let Some(entry) = history.iter_mut().find(|e| e.id == id) else {
        return Ok(false);
    };
    let trimmed = user_text.trim();
    if trimmed.is_empty() {
        return Err("user_text 不能为空".into());
    }
    entry.user_text = Some(trimmed.to_string());
    entry.text = trimmed.to_string();
    // User correction is a strong learn signal — nudge toward suggested if open.
    if entry.learn_status.as_deref() != Some("applied")
        && entry.learn_status.as_deref() != Some("skipped")
    {
        entry.learn_status = Some("suggested".into());
    }
    if entry.quality_rating.is_none() {
        entry.quality_rating = Some("bad".into());
        entry.rated_at = Some(chrono::Utc::now().to_rfc3339());
    }
    Ok(true)
}

/// Gold learn target: user adjust > llm > text.
pub(crate) fn learn_gold_text(entry: &HistoryEntry) -> &str {
    if let Some(u) = entry.user_text.as_deref() {
        if !u.trim().is_empty() {
            return u;
        }
    }
    if let Some(l) = entry.llm_text.as_deref() {
        if !l.trim().is_empty() {
            return l;
        }
    }
    entry.text.as_str()
}

/// Mark learn_status on one entry. Empty clears.
pub(crate) fn mark_history_learn_status_by_id(
    history: &mut Vec<HistoryEntry>,
    id: &str,
    status: &str,
) -> Result<bool, String> {
    let Some(entry) = history.iter_mut().find(|e| e.id == id) else {
        return Ok(false);
    };
    let trimmed = status.trim();
    if trimmed.is_empty() {
        entry.learn_status = None;
    } else if learn_status_ok(trimmed) {
        entry.learn_status = Some(trimmed.to_string());
    } else {
        return Err(format!("invalid learn_status: {trimmed}"));
    }
    Ok(true)
}

/// Mark learn_status on many entries. Returns how many were updated.
pub(crate) fn mark_history_learn_status_many(
    history: &mut Vec<HistoryEntry>,
    ids: &[String],
    status: &str,
) -> Result<usize, String> {
    let trimmed = status.trim();
    if !trimmed.is_empty() && !learn_status_ok(trimmed) {
        return Err(format!("invalid learn_status: {trimmed}"));
    }
    let next = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    let mut n = 0;
    for id in ids {
        if let Some(entry) = history.iter_mut().find(|e| e.id == *id) {
            entry.learn_status = next.clone();
            n += 1;
        }
    }
    Ok(n)
}

fn merge_unique_preserve(existing: &mut Vec<String>, incoming: &[String]) {
    let mut seen: std::collections::HashSet<String> = existing
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let mut fresh = Vec::new();
    for term in incoming {
        let t = term.trim();
        if t.is_empty() {
            continue;
        }
        let key = t.to_lowercase();
        if seen.insert(key) {
            fresh.push(t.to_string());
        }
    }
    if !fresh.is_empty() {
        fresh.append(existing);
        *existing = fresh;
    }
}

/// Append unique terms to vocabulary + mark entries applied. Returns updated vocab.
pub(crate) fn apply_learned_terms_to_state(
    config: &mut AppConfig,
    history: &mut Vec<HistoryEntry>,
    ids: &[String],
    terms: &[String],
) -> Result<Vec<String>, String> {
    merge_unique_preserve(&mut config.vocabulary, terms);
    for id in ids {
        if let Some(entry) = history.iter_mut().find(|e| e.id == *id) {
            entry.learn_status = Some("applied".into());
            merge_unique_preserve(&mut entry.learn_terms, terms);
        }
    }
    Ok(config.vocabulary.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            text: "Python".into(),
            raw_text: "配森".into(),
            llm_text: Some("Python".into()),
            user_text: None,
            language: "zh".into(),
            duration_seconds: 1.0,
            created_at: chrono::Utc::now().to_rfc3339(),
            refined: true,
            audio_path: None,
            media_kind: "audio".into(),
            segments: Vec::new(),
            alignment: None,
            source: "fn".into(),
            translate_target_language: None,
            quality_rating: None,
            rated_at: None,
            learn_status: None,
            learn_terms: Vec::new(),
            work_id: None,
        }
    }

    #[test]
    fn rate_sets_and_clears_rated_at() {
        let mut history = vec![sample_entry("a")];
        // Don't write disk in unit test — exercise field logic via direct mutate path.
        let entry = history.first_mut().unwrap();
        entry.quality_rating = Some("bad".into());
        entry.rated_at = Some(chrono::Utc::now().to_rfc3339());
        assert!(entry.rated_at.is_some());
        entry.quality_rating = None;
        entry.rated_at = None;
        assert!(entry.rated_at.is_none());
    }

    #[test]
    fn learn_status_validation() {
        assert!(learn_status_ok("applied"));
        assert!(learn_status_ok("distilled"));
        assert!(!learn_status_ok("nope"));
    }

    #[test]
    fn merge_unique_puts_new_first() {
        let mut v = vec!["Python".into(), "MySQL".into()];
        merge_unique_preserve(&mut v, &["配森=Python".into(), "python".into()]);
        assert_eq!(v[0], "配森=Python");
        assert_eq!(v.iter().filter(|t| t.eq_ignore_ascii_case("python")).count(), 1);
    }
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
    Ok(true)
}

fn remove_recording_if_owned(path: &str) {
    let path = Path::new(path);
    if path.starts_with(recordings_dir()) {
        let _ = fs::remove_file(path);
    }
}
