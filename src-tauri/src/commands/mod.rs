use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::*;
use crate::state::*;
use crate::config::*;
use crate::history::*;
use crate::hotkey::*;
use crate::hud::*;
use crate::paste::*;
use crate::transcription::*;
use crate::permissions;

#[tauri::command]
pub(crate) fn get_permission_status() -> permissions::PermissionStatus {
    permissions::get_permission_status()
}

#[tauri::command]
pub(crate) fn open_permission_settings(kind: String) -> Result<(), String> {
    permissions::open_permission_settings(&kind)
}

#[tauri::command]
pub(crate) fn request_permission(
    kind: String,
) -> Result<permissions::PermissionRequestResult, String> {
    permissions::request_permission(&kind)
}

#[derive(Clone, Serialize)]
pub(crate) struct AppInfo {
    pub(crate) version: String,
    pub(crate) name: String,
    pub(crate) platform: String,
    pub(crate) executable_path: String,
    pub(crate) apple_speech_available: bool,
}

#[tauri::command]
pub(crate) fn get_app_info() -> AppInfo {
    let perms = permissions::get_permission_status();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        name: "ASR Workshop".to_string(),
        platform: perms.platform,
        executable_path: perms.executable_path,
        apple_speech_available: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub(crate) fn get_platform() -> String {
    permissions::get_permission_status().platform
}
// ---------------------------------------------------------------------------

pub(crate) use crate::models::has_model_weights;

#[tauri::command]
pub(crate) fn set_model_dir(path: String, engine: State<'_, AsrEngine>) -> Result<(), String> {
    *engine.inner().model_dir.lock().map_err(|e| e.to_string())? = path;
    if let Ok(mut config) = engine.inner().config.lock() {
        config.asr_model_dir = engine
            .inner()
            .model_dir
            .lock()
            .map(|dir| dir.clone())
            .unwrap_or_default();
        let _ = save_config_to_disk(&config);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_model_dir(engine: State<'_, AsrEngine>) -> Result<String, String> {
    engine
        .inner()
        .model_dir
        .lock()
        .map(|d| d.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_app_config(engine: State<'_, AsrEngine>) -> Result<AppConfig, String> {
    engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_app_config(
    app: AppHandle,
    config: AppConfig,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
    let mut config = config;
    normalize_config_for_platform(&mut config);
    ensure_agent_profiles(&mut config);
    let previous_target = engine
        .inner()
        .config
        .lock()
        .map(|c| c.translate_target_language.clone())
        .unwrap_or_default();
    {
        let mut current = engine.inner().config.lock().map_err(|e| e.to_string())?;
        *current = config.clone();
    }
    {
        let mut model_dir = engine.inner().model_dir.lock().map_err(|e| e.to_string())?;
        *model_dir = config.asr_model_dir.clone();
    }
    save_config_to_disk(&config)?;
    let _ = app.emit("config-updated", &config);
    if previous_target != config.translate_target_language {
        retarget_translate_stream(&app);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn begin_hotkey_capture(
    slot: String,
    capture: State<'_, Arc<Mutex<HotkeyCaptureSlot>>>,
) -> Result<(), String> {
    let next = HotkeyCaptureSlot::from_str(&slot);
    if matches!(next, HotkeyCaptureSlot::None) {
        return Err("unknown hotkey slot".into());
    }
    let mut guard = capture.lock().map_err(|e| e.to_string())?;
    *guard = next;
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_hotkey_capture(
    app: AppHandle,
    capture: State<'_, Arc<Mutex<HotkeyCaptureSlot>>>,
) -> Result<(), String> {
    let mut guard = capture.lock().map_err(|e| e.to_string())?;
    *guard = HotkeyCaptureSlot::None;
    let _ = app.emit("hotkey-capture-cancelled", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn get_history(engine: State<'_, AsrEngine>) -> Result<Vec<HistoryEntry>, String> {
    engine
        .inner()
        .history
        .lock()
        .map(|history| history.iter().map(history_entry_for_list).collect())
        .map_err(|e| e.to_string())
}

/// Full entry including alignment — only for detail viewers.
#[tauri::command]
pub(crate) fn get_history_entry(
    id: String,
    engine: State<'_, AsrEngine>,
) -> Result<Option<HistoryEntry>, String> {
    engine
        .inner()
        .history
        .lock()
        .map(|history| history.iter().find(|e| e.id == id).cloned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn clear_history(engine: State<'_, AsrEngine>) -> Result<(), String> {
    {
        let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
        history.clear();
    }
    save_history_to_disk(&[])
}

#[tauri::command]
pub(crate) fn delete_history_entry(id: String, engine: State<'_, AsrEngine>) -> Result<bool, String> {
    let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
    delete_history_entry_by_id(&mut history, &id)
}

/// Rate ASR quality on a history entry: "bad" | "ok" | "good" (empty clears).
#[tauri::command]
pub(crate) fn rate_history_entry(
    id: String,
    rating: String,
    engine: State<'_, AsrEngine>,
) -> Result<bool, String> {
    let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
    rate_history_entry_by_id(&mut history, &id, &rating)
}

/// Save user gold correction for learn/few-shot.
#[tauri::command]
pub(crate) fn set_history_user_text(
    id: String,
    user_text: String,
    engine: State<'_, AsrEngine>,
) -> Result<bool, String> {
    let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
    set_history_user_text_by_id(&mut history, &id, &user_text)
}

/// Mark learn_status: "suggested" | "distilled" | "applied" | "skipped" (empty clears).
#[tauri::command]
pub(crate) fn mark_history_learn_status(
    id: String,
    status: String,
    engine: State<'_, AsrEngine>,
) -> Result<bool, String> {
    let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
    mark_history_learn_status_by_id(&mut history, &id, &status)
}

/// Mark learn_status on many history entries.
#[tauri::command]
pub(crate) fn mark_history_learn_status_batch(
    ids: Vec<String>,
    status: String,
    engine: State<'_, AsrEngine>,
) -> Result<usize, String> {
    let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
    mark_history_learn_status_many(&mut history, &ids, &status)
}

/// Merge terms into vocabulary and mark entries learn_status=applied.
#[tauri::command]
pub(crate) fn apply_learned_terms(
    app: AppHandle,
    ids: Vec<String>,
    terms: Vec<String>,
    engine: State<'_, AsrEngine>,
) -> Result<Vec<String>, String> {
    let vocabulary = {
        let mut config = engine.inner().config.lock().map_err(|e| e.to_string())?;
        let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
        apply_learned_terms_to_state(&mut config, &mut history, &ids, &terms)?
    };
    let config = engine
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .map_err(|e| e.to_string())?;
    let _ = app.emit("config-updated", &config);
    Ok(vocabulary)
}

fn eligible_for_distill(e: &HistoryEntry) -> bool {
    if (e.source.as_str() == "translate") {
        return false;
    }
    let asr = e.raw_text.trim();
    if asr.is_empty() {
        return false;
    }
    let gold = learn_gold_text(e).trim();
    if gold.is_empty() || gold == asr {
        // Need a correction signal: user adjust and/or llm diff + bad rating
        return false;
    }
    // Prefer user-adjusted; otherwise require bad rating + refined.
    let has_user = e
        .user_text
        .as_deref()
        .map(|t| !t.trim().is_empty() && t.trim() != asr)
        .unwrap_or(false);
    if !has_user {
        if !e.refined || e.quality_rating.as_deref() != Some("bad") {
            return false;
        }
    }
    match e.learn_status.as_deref() {
        Some("applied") | Some("skipped") => false,
        _ => true,
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DistillLearnResult {
    pub(crate) terms: Vec<String>,
    pub(crate) source_ids: Vec<String>,
}

/// AI distill vocabulary from history entries rated `bad` (not yet applied/distilled).
#[tauri::command]
pub(crate) async fn distill_learn_from_ratings(
    engine: State<'_, AsrEngine>,
) -> Result<DistillLearnResult, String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .map_err(|e| e.to_string())?;
    let history = engine
        .inner()
        .history
        .lock()
        .map(|h| h.clone())
        .map_err(|e| e.to_string())?;

    let eligible: Vec<&HistoryEntry> = history.iter().filter(|e| eligible_for_distill(e)).collect();
    let source_ids: Vec<String> = eligible.iter().map(|e| e.id.clone()).collect();
    let cases: Vec<LearnCase> = eligible
        .iter()
        .map(|e| LearnCase {
            asr: e.raw_text.clone(),
            llm: e.llm_text.clone().unwrap_or_default(),
            user: e.user_text.clone().unwrap_or_default(),
        })
        .collect();

    let terms = tauri::async_runtime::spawn_blocking(move || {
        distill_learn_from_cases(&config, &cases)
    })
    .await
    .map_err(|e| format!("学习提炼任务失败: {e}"))??;

    Ok(DistillLearnResult { terms, source_ids })
}

/// Keep the newest `keep` entries; drop the rest. `keep=0` clears all.
#[tauri::command]
pub(crate) fn prune_history(keep: usize, engine: State<'_, AsrEngine>) -> Result<usize, String> {
    let remaining = {
        let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
        if keep == 0 {
            history.clear();
        } else {
            history.truncate(keep);
        }
        let n = history.len();
        save_history_to_disk(&history)?;
        n
    };
    Ok(remaining)
}

/// Drop entries older than `days` (by created_at). Returns remaining count.
#[tauri::command]
pub(crate) fn prune_history_older_than(days: u64, engine: State<'_, AsrEngine>) -> Result<usize, String> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let remaining = {
        let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
        history.retain(|entry| {
            chrono::DateTime::parse_from_rfc3339(&entry.created_at)
                .map(|dt| dt.with_timezone(&chrono::Utc) >= cutoff)
                .unwrap_or(true)
        });
        let n = history.len();
        save_history_to_disk(&history)?;
        n
    };
    Ok(remaining)
}

#[tauri::command]
pub(crate) async fn test_llm_refinement(
    text: String,
    engine: State<'_, AsrEngine>,
) -> Result<String, String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    eprintln!(
        "[llm] test_llm_refinement: enabled={} url={} model={} key={}",
        config.llm_enabled,
        if config.llm_api_base_url.trim().is_empty() {
            "(empty)"
        } else {
            config.llm_api_base_url.trim()
        },
        if config.llm_model.trim().is_empty() {
            "(empty)"
        } else {
            config.llm_model.trim()
        },
        if config.llm_api_key.trim().is_empty() {
            "(empty)"
        } else {
            "(set)"
        }
    );
    // reqwest::blocking must not run on the Tokio/async command thread — freezes UI.
    tauri::async_runtime::spawn_blocking(move || refine_transcript(&config, &text))
        .await
        .map_err(|e| format!("LLM 测试任务失败: {e}"))?
}

#[tauri::command]
pub(crate) fn load_model(engine: State<'_, AsrEngine>) -> Result<(), String> {
    let dir = engine
        .inner()
        .model_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if dir.is_empty() {
        return Err("Model directory not configured".into());
    }
    let path = PathBuf::from(&dir);
    if !has_model_weights(&path) {
        return Err(format!(
            "Model weights not found in {} (expected model.safetensors or model.safetensors.index.json)",
            dir
        ));
    }
    engine.send_worker(WorkerCommand::LoadModel { path })
}

/// Minimum audio length (in samples) before we attempt a partial transcription.
#[cfg(feature = "qwen-local")]
pub(crate) const MIN_PARTIAL_SAMPLES: usize = 16_000; // 1 second @ 16kHz

#[tauri::command]
pub(crate) fn start_recording(
    chunk_sec: Option<f64>,
    rollback_tokens: Option<usize>,
    language: Option<String>,
    mode: Option<String>,
    app: AppHandle,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    // Reject if already recording.
    {
        let guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Already recording".into());
        }
    }
    if matches!(config.asr_provider, AsrProvider::Qwen)
        && !engine.inner().model_loaded.load(Ordering::Acquire)
    {
        return Err("Model not loaded".into());
    }

    let session = match mode.as_deref() {
        Some("transcribe") => "transcribe",
        Some("translate") => "translate",
        Some("agent") => "agent",
        _ => "fn",
    };
    AsrEngine::set_session_mode(&app, session);
    reset_translate_stream(&app);
    let _ = AsrEngine::bump_finalize_gen(&app);
    AsrEngine::set_pending_hud_confirm(&app, None);

    // Show HUD *before* ScreenCaptureKit start — that path can take seconds and
    // used to leave the UI frozen with no capsule until capture finished/failed.
    // Agent also uses the same floating HUD (with extras).
    let show_hud = session == "fn" || session == "translate" || session == "agent";
    emit_floating_status(&app, show_hud, "recording", "", 0.0);

    let rec = match AudioRecorder::start(config.audio_capture_mode) {
        Ok(rec) => rec,
        Err(e) => {
            emit_floating_status(&app, false, "idle", "", 0.0);
            return Err(e.to_string());
        }
    };
    if let Some(warning) = rec.fallback_warning.clone() {
        let _ = app.emit("audio-capture-warning", warning);
    }
    {
        let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        *guard = Some(SendWrapper::new(rec));
    }
    engine
        .inner()
        .cancel_requested
        .store(false, Ordering::Release);
    engine.inner().recording.store(true, Ordering::Release);

    spawn_audio_level_pump(app.clone(), engine.inner().recording.clone());

    // Segmented streaming quality floors (S1.1). Tiny chunk/rollback from
    // older config.json causes unstable hypotheses and feels like "worse ASR".
    let raw_chunk = chunk_sec.unwrap_or(config.chunk_size_sec.max(0.2));
    let chunk_sec = if raw_chunk < 1.0 {
        eprintln!(
            "[asr] chunk_sec={raw_chunk:.2} too small for segmented streaming; clamping to 1.0s"
        );
        1.0
    } else {
        raw_chunk
    };
    let raw_rollback = rollback_tokens.unwrap_or(config.unfixed_token_num.max(1));
    let rollback_tokens = if raw_rollback < 3 {
        eprintln!(
            "[asr] rollback_tokens={raw_rollback} too small; clamping to 3 (prefer 5)"
        );
        3
    } else {
        raw_rollback
    };
    let language = language.or_else(|| {
        engine
            .inner()
            .config
            .lock()
            .ok()
            .map(|config| config.language.clone())
    });

    // Tell the local streaming worker to enter the loop only for Qwen.
    if matches!(config.asr_provider, AsrProvider::Qwen) {
        engine.send_worker(WorkerCommand::StartStreaming {
            chunk_sec,
            rollback_tokens,
            language,
        })?;
    }
    eprintln!(
        "[asr] recording started, provider={} mode={} chunk={}s rollback={}",
        config.asr_provider.label(),
        session,
        chunk_sec,
        rollback_tokens
    );

    Ok(())
}

/// Abort in-progress recording or mid-pipeline finalize (paste/history follow-ups).
/// Already-pasted text (if any) is kept; late transcription-result is suppressed.
/// `reason` is logged for diagnosing accidental cancels (`agent-esc` / `escape-key` / `hud-cancel`).
#[tauri::command]
pub(crate) fn cancel_recording(
    app: AppHandle,
    engine: State<'_, AsrEngine>,
    reason: Option<String>,
) -> Result<(), String> {
    cancel_recording_with_reason(&app, engine.inner(), reason.as_deref().unwrap_or("unspecified"));
    Ok(())
}

/// Shared cancel path for IPC + hotkey tap (must not depend on floating webview).
pub(crate) fn cancel_recording_with_reason(app: &AppHandle, engine: &AsrEngine, reason: &str) {
    let was_recording = engine.recording.load(Ordering::Acquire);
    let has_recorder = engine
        .recorder
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    let hud_busy = floating_status_slot(app)
        .lock()
        .map(|s| {
            s.visible
                && matches!(
                    s.state.as_str(),
                    "recording" | "processing" | "refining"
                )
        })
        .unwrap_or(false);
    let session = AsrEngine::session_mode(app);

    let _ = AsrEngine::bump_finalize_gen(app);
    engine.cancel_requested.store(true, Ordering::Release);
    engine.recording.store(false, Ordering::Release);
    reset_translate_stream(app);
    AsrEngine::set_pending_hud_confirm(app, None);

    if !was_recording && !has_recorder && !hud_busy {
        emit_floating_status(app, false, "idle", "", 0.0);
        let _ = app.emit("recording-cancelled", ());
        eprintln!(
            "[asr] cancelled noop reason={reason} session={session} (recording=false recorder=false hud_busy=false)"
        );
        return;
    }

    let config = engine
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    if !matches!(config.asr_provider, AsrProvider::Qwen) {
        let _ = AsrEngine::take_recorder_and_stop(app);
    }

    emit_floating_status(app, false, "idle", "", 0.0);
    let _ = app.emit("recording-cancelled", ());
    eprintln!(
        "[asr] cancelled reason={reason} session={session} (recording={} recorder={} hud_busy={})",
        was_recording, has_recorder, hud_busy
    );
}

#[derive(Clone, Serialize)]
pub(crate) struct LearnFromHudPayload {
    pub(crate) entry_id: String,
    pub(crate) before: String,
    pub(crate) after: String,
}

/// Confirm Fn/⇧Fn HUD edit: paste → history → optional learn → hide.
#[tauri::command]
pub(crate) fn confirm_floating_transcript(
    app: AppHandle,
    text: String,
) -> Result<(), String> {
    let pending = AsrEngine::take_pending_hud_confirm(&app)
        .ok_or_else(|| "没有待确认的识别结果".to_string())?;
    if AsrEngine::finalize_aborted(&app, pending.gen) {
        emit_floating_status(&app, false, "idle", "", 0.0);
        return Err("会话已取消".into());
    }

    let confirmed = text.trim().to_string();
    if confirmed.is_empty() {
        // Put pending back so user can retry / Esc cancel.
        AsrEngine::set_pending_hud_confirm(&app, Some(pending));
        return Err("确认文本不能为空".into());
    }

    let asr_text = pending.asr_text.clone();
    let mode = pending.mode.clone();
    let edited = confirmed != asr_text.trim();
    let learn = mode == "fn" && edited;

    let mut result = pending.result;
    // Keep ASR baseline in raw_text for learn harvest.
    if result.raw_text.trim().is_empty() || mode == "fn" {
        result.raw_text = asr_text.clone();
    }
    result.text = confirmed.clone();

    match inject_text_via_paste_on_main(&app, &confirmed) {
        Ok(()) => {
            eprintln!(
                "[paste] confirmed {} chars (edited={edited} mode={mode})",
                confirmed.chars().count()
            );
        }
        Err(e) => {
            eprintln!("[paste] injection failed: {e}");
            let _ = app.emit(
                "partial-error",
                format!("已写入剪切板，但粘贴失败（请检查辅助功能权限）: {e}"),
            );
        }
    }

    let user_for_history = if learn {
        Some(confirmed.as_str())
    } else {
        None
    };
    let entry_id = append_history_with_user(
        &app,
        &result,
        &mode,
        None,
        &pending.media_kind,
        user_for_history,
    );

    if learn {
        if let Some(id) = entry_id.clone() {
            let payload = LearnFromHudPayload {
                entry_id: id,
                before: asr_text.clone(),
                after: confirmed.clone(),
            };
            let _ = app.emit("learn-from-hud", &payload);
        }
    }

    emit_floating_status(&app, false, "idle", "", 0.0);
    let _ = app.emit("transcription-result", &result);
    Ok(())
}

/// Discard Fn/⇧Fn HUD edit without paste or history.
#[tauri::command]
pub(crate) fn cancel_floating_transcript(app: AppHandle) -> Result<(), String> {
    let _ = AsrEngine::take_pending_hud_confirm(&app);
    let _ = AsrEngine::bump_finalize_gen(&app);
    emit_floating_status(&app, false, "idle", "", 0.0);
    let _ = app.emit("recording-cancelled", ());
    eprintln!("[asr] hud confirm cancelled");
    Ok(())
}

#[tauri::command]
pub(crate) fn stop_recording(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    let session = AsrEngine::session_mode(&app);
    let show_hud = session == "fn" || session == "translate" || session == "agent";
    let finalize_gen = AsrEngine::finalize_gen(&app);

    // Signal the worker's streaming loop to stop.
    // The worker will then do the final transcription automatically.
    engine
        .inner()
        .cancel_requested
        .store(false, Ordering::Release);
    engine.inner().recording.store(false, Ordering::Release);

    // Fn release = accept current. No refining HUD — paste committed / stream preview.
    let hud_text = if session == "translate" {
        peek_translate_out(&app)
    } else {
        String::new()
    };
    emit_floating_status(&app, show_hud, "processing", &hud_text, 0.0);
    if session == "agent" {
        let _ = app.emit("agent-voice-status", "processing");
        let _ = app.emit_to("floating", "agent-voice-status", "processing");
    }

    if matches!(config.asr_provider, AsrProvider::Qwen) {
        eprintln!("[asr] stop signaled, worker will finish current partial then paste");
        return Ok(());
    }

    let samples = AsrEngine::take_recorder_and_stop(&app)
        .ok_or_else(|| "Recorder not found".to_string())?;
    std::thread::spawn(move || {
        if AsrEngine::finalize_aborted(&app, finalize_gen) {
            eprintln!("[asr] stop aborted before provider ASR");
            return;
        }
        let mut result = match config.asr_provider {
            AsrProvider::Elevenlabs => transcribe_with_elevenlabs(&config, &samples)
                .unwrap_or_else(|error| TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: samples.len() as f64 / 16_000.0,
                        refined: false,
                        error: Some(error),
                        segments: Vec::new(),
                        alignment: None,
                    }),
            AsrProvider::Apple => transcribe_with_apple_speech(&config, &samples).unwrap_or_else(
                |error| TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: samples.len() as f64 / 16_000.0,
                        refined: false,
                        error: Some(error),
                        segments: Vec::new(),
                        alignment: None,
                    },
            ),
            AsrProvider::Qwen => unreachable!(),
        };
        if AsrEngine::finalize_aborted(&app, finalize_gen) {
            eprintln!("[asr] stop aborted after provider ASR — suppress result");
            emit_floating_status(&app, false, "idle", "", 0.0);
            return;
        }
        if result.error.is_none() {
            match finalize_successful_result(&app, &mut result, Some(&samples), None, "audio") {
                None => {
                    // Aborted mid-pipeline; recording-cancelled already (or) HUD idle.
                    return;
                }
                Some(false) => {
                    if AsrEngine::session_mode(&app) != "agent" {
                        emit_floating_status(&app, false, "idle", "", 0.0);
                    }
                }
                Some(true) => {}
            }
        } else {
            emit_floating_status(&app, false, "idle", "", 0.0);
            if AsrEngine::session_mode(&app) == "agent" {
                let _ = app.emit("agent-transcription-result", &result);
                let _ = app.emit_to("floating", "agent-transcription-result", &result);
            }
        }
        if AsrEngine::finalize_aborted(&app, finalize_gen) {
            return;
        }
        if AsrEngine::session_mode(&app) != "agent"
            && !AsrEngine::has_pending_hud_confirm(&app)
        {
            let _ = app.emit("transcription-result", &result);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn transcribe_file(
    path: String,
    media_kind: Option<String>,
    app: AppHandle,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    if engine.inner().recording.load(Ordering::Acquire) {
        return Err("正在录音中，请先结束录音".into());
    }

    AsrEngine::set_session_mode(&app, "transcribe");
    emit_floating_status(&app, false, "processing", "", 0.0);

    if matches!(config.asr_provider, AsrProvider::Qwen) {
        if !engine.inner().model_loaded.load(Ordering::Acquire) {
            return Err("Model not loaded".into());
        }
        engine.send_worker(WorkerCommand::TranscribeFile {
            path: src,
            media_kind,
        })?;
        return Ok(());
    }

    std::thread::spawn(move || {
        let (saved, media_kind) = match persist_media_for_playback(&src, media_kind.as_deref()) {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some(e),
                        segments: Vec::new(),
                        alignment: None,
                    },
                );
                emit_floating_status(&app, false, "idle", "", 0.0);
                return;
            }
        };
        let samples = match load_audio_samples_16k(&saved) {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some(e),
                        segments: Vec::new(),
                        alignment: None,
                    },
                );
                emit_floating_status(&app, false, "idle", "", 0.0);
                return;
            }
        };
        let mut result = match config.asr_provider {
            AsrProvider::Elevenlabs => transcribe_with_elevenlabs(&config, &samples)
                .unwrap_or_else(|error| TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: samples.len() as f64 / 16_000.0,
                        refined: false,
                        error: Some(error),
                        segments: Vec::new(),
                        alignment: None,
                    }),
            AsrProvider::Apple => transcribe_with_apple_speech(&config, &samples).unwrap_or_else(
                |error| TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        llm_text: None,
                        language: config.language.clone(),
                        duration_seconds: samples.len() as f64 / 16_000.0,
                        refined: false,
                        error: Some(error),
                        segments: Vec::new(),
                        alignment: None,
                    },
            ),
            AsrProvider::Qwen => unreachable!(),
        };
        if result.error.is_none() {
            let _ = finalize_successful_result(
                &app,
                &mut result,
                None,
                Some(saved.to_string_lossy().to_string()),
                &media_kind,
            );
        }
        emit_floating_status(&app, false, "idle", "", 0.0);
        let _ = app.emit("transcription-result", &result);
    });
    Ok(())
}

// ---------------------------------------------------------------------------
