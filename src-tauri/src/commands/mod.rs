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
        .map(|history| history.clone())
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
pub(crate) fn test_llm_refinement(text: String, engine: State<'_, AsrEngine>) -> Result<String, String> {
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
    refine_transcript(&config, &text)
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
        _ => "fn",
    };
    AsrEngine::set_session_mode(&app, session);
    reset_translate_stream(&app);

    // Show HUD *before* ScreenCaptureKit start — that path can take seconds and
    // used to leave the UI frozen with no capsule until capture finished/failed.
    let show_hud = session == "fn" || session == "translate";
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

/// Abort an in-progress Fn recording without transcription / paste / history.
#[tauri::command]
pub(crate) fn cancel_recording(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let was_recording = engine.inner().recording.load(Ordering::Acquire);
    let has_recorder = engine
        .inner()
        .recorder
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if !was_recording && !has_recorder {
        emit_floating_status(&app, false, "idle", "", 0.0);
        return Ok(());
    }

    engine
        .inner()
        .cancel_requested
        .store(true, Ordering::Release);
    engine.inner().recording.store(false, Ordering::Release);
    reset_translate_stream(&app);

    // For Apple/ElevenLabs the recorder is owned here; drop samples.
    // For Qwen the mlx worker owns the stop path and will see cancel_requested.
    let config = engine
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    if !matches!(config.asr_provider, AsrProvider::Qwen) {
        let _ = AsrEngine::take_recorder_and_stop(&app);
    }

    emit_floating_status(&app, false, "idle", "", 0.0);
    let _ = app.emit("recording-cancelled", ());
    eprintln!("[asr] recording cancelled");
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
    let show_hud = session == "fn" || session == "translate";

    // Signal the worker's streaming loop to stop.
    // The worker will then do the final transcription automatically.
    engine
        .inner()
        .cancel_requested
        .store(false, Ordering::Release);
    engine.inner().recording.store(false, Ordering::Release);

    // Final round: keep streamed translation on HUD and show loading (refining).
    let hud_text = if session == "translate" {
        peek_translate_out(&app)
    } else {
        String::new()
    };
    let hud_state = if session == "translate"
        || (session == "fn"
            && config.llm_enabled
            && !config.llm_api_base_url.trim().is_empty()
            && !config.llm_model.trim().is_empty())
    {
        "refining"
    } else {
        "processing"
    };
    emit_floating_status(&app, show_hud, hud_state, &hud_text, 0.0);

    if matches!(config.asr_provider, AsrProvider::Qwen) {
        eprintln!("[asr] stop signaled, worker will finish current partial then do final");
        return Ok(());
    }

    let samples = AsrEngine::take_recorder_and_stop(&app)
        .ok_or_else(|| "Recorder not found".to_string())?;
    std::thread::spawn(move || {
        let mut result = match config.asr_provider {
            AsrProvider::Elevenlabs => transcribe_with_elevenlabs(&config, &samples)
                .unwrap_or_else(|error| TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
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
            let hud_done =
                finalize_successful_result(&app, &mut result, Some(&samples), None, "audio");
            if !hud_done {
                emit_floating_status(&app, false, "idle", "", 0.0);
            }
        } else {
            emit_floating_status(&app, false, "idle", "", 0.0);
        }
        let _ = app.emit("transcription-result", &result);
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn transcribe_file(path: String, app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
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
        engine.send_worker(WorkerCommand::TranscribeFile { path: src })?;
        return Ok(());
    }

    std::thread::spawn(move || {
        let (saved, media_kind) = match persist_media_for_playback(&src) {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
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
