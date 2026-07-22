use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use crate::audio::*;
use crate::config::*;
use crate::history::*;
use crate::transcription::*;

fn panic_payload_str(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".into()
    }
}

// ---------------------------------------------------------------------------
// Send-safe wrapper for cpal::Stream (which is !Send on macOS).
// ---------------------------------------------------------------------------

pub(crate) struct SendWrapper<T>(pub T);
unsafe impl<T> Send for SendWrapper<T> {}
unsafe impl<T> Sync for SendWrapper<T> {}

impl<T> SendWrapper<T> {
    pub(crate) fn new(t: T) -> Self {
        Self(t)
    }
    pub(crate) fn into_inner(self) -> T {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Worker commands
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(crate) enum WorkerCommand {
    LoadModel {
        path: PathBuf,
    },
    StartStreaming {
        chunk_sec: f64,
        rollback_tokens: usize,
        language: Option<String>,
    },
    TranscribeFile {
        path: PathBuf,
        media_kind: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Fn/⇧Fn: ASR done, HUD editing — paste deferred until confirm.
#[derive(Clone)]
pub(crate) struct PendingHudConfirm {
    pub(crate) mode: String,
    /// Text shown when editing started (post-vocab / LLM refine / translate accept).
    /// Used to detect user edits; true ASR lives in `result.raw_text`.
    pub(crate) asr_text: String,
    pub(crate) result: TranscriptionResult,
    pub(crate) gen: u64,
    pub(crate) media_kind: String,
}

/// After confirm/accept paste: clipboard snapshot to restore on "撤销" — see
/// `undo_last_paste`. We deliberately do NOT synthesize ⌘Z: the focused app
/// (or focus itself) may have changed since paste, and blind undo could hit
/// an unrelated edit in an unrelated app. Clipboard-restore is always safe.
#[derive(Clone)]
pub(crate) struct PendingPasteUndo {
    /// Clipboard content immediately before this paste overwrote it.
    pub(crate) previous_clipboard: Option<String>,
    /// Captured `finalize_gen` at paste time — a delayed auto-hide checks this
    /// so a newer recording/paste doesn't get yanked away underneath it.
    pub(crate) gen: u64,
}

pub struct AsrEngine {
    pub(crate) model_dir: Mutex<String>,
    pub(crate) recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
    /// true while recording is active. Worker loop reads this.
    pub(crate) recording: Arc<AtomicBool>,
    /// Set by cancel_recording; mlx worker skips final transcription when true.
    pub(crate) cancel_requested: Arc<AtomicBool>,
    /// Bumped on start/cancel. Finalize captures gen; stale gen = aborted mid-pipeline.
    pub(crate) finalize_gen: Arc<AtomicU64>,
    pub(crate) model_loaded: Arc<AtomicBool>,
    /// Channel to the MLX worker thread.
    pub(crate) worker_tx: Mutex<Sender<WorkerCommand>>,
    pub(crate) config: Mutex<AppConfig>,
    pub(crate) history: Mutex<Vec<HistoryEntry>>,
    /// "fn" | "translate" (HUD + paste) or "transcribe" (save audio, no paste).
    pub(crate) session_mode: Mutex<String>,
    /// Live translate accumulation (strategy C). Translate mode only.
    pub(crate) translate_stream: Mutex<TranslateStreamState>,
    /// Fn/translate confirm-then-paste slot.
    pub(crate) pending_hud_confirm: Mutex<Option<PendingHudConfirm>>,
    /// Clipboard-restore undo slot, set right after a successful confirm/accept
    /// paste; cleared by `undo_last_paste` or the delayed auto-hide.
    pub(crate) pending_paste_undo: Mutex<Option<PendingPasteUndo>>,
    /// HUD meter — updated from capture callbacks, read by pump (no recorder lock).
    pub(crate) live_meter: Arc<LiveMeter>,
}

impl AsrEngine {
    pub(crate) fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<WorkerCommand>();

        let model_loaded = Arc::new(AtomicBool::new(false));
        let recording = Arc::new(AtomicBool::new(false));
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let finalize_gen = Arc::new(AtomicU64::new(0));
        // Pass flag Arcs into the worker — do NOT app.state::<AsrEngine>() at
        // worker start. That races manage(): MLX init can finish before
        // AsrEngine::new returns → panic "state() called before manage()".
        let model_loaded_w = model_loaded.clone();
        let recording_w = recording.clone();
        let cancel_w = cancel_requested.clone();
        let app_for_worker = app.clone();
        std::thread::Builder::new()
            .name("mlx-worker".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mlx_worker(
                        rx,
                        app_for_worker.clone(),
                        model_loaded_w,
                        recording_w,
                        cancel_w,
                    );
                }));
                if let Err(payload) = result {
                    let msg = panic_payload_str(&payload);
                    eprintln!("[mlx-worker] PANIC: {msg}");
                    let _ = app_for_worker.emit("mlx-worker-dead", &msg);
                }
            })
            .expect("failed to spawn MLX worker thread");

        let config = load_config_from_disk();
        let history = load_history_from_disk();

        Self {
            model_dir: Mutex::new(config.asr_model_dir.clone()),
            recorder: Mutex::new(None),
            recording,
            cancel_requested,
            finalize_gen,
            model_loaded,
            worker_tx: Mutex::new(tx),
            config: Mutex::new(config),
            history: Mutex::new(history),
            session_mode: Mutex::new("fn".into()),
            translate_stream: Mutex::new(TranslateStreamState::default()),
            pending_hud_confirm: Mutex::new(None),
            pending_paste_undo: Mutex::new(None),
            live_meter: Arc::new(LiveMeter::default()),
        }
    }

    pub(crate) fn session_mode(app: &AppHandle) -> String {
        app.state::<AsrEngine>()
            .inner()
            .session_mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_else(|_| "fn".into())
    }

    pub(crate) fn set_session_mode(app: &AppHandle, mode: &str) {
        if let Ok(mut slot) = app.state::<AsrEngine>().inner().session_mode.lock() {
            *slot = mode.to_string();
        }
    }

    /// Capture finalize generation for this stop→paste pipeline.
    pub(crate) fn finalize_gen(app: &AppHandle) -> u64 {
        app.state::<AsrEngine>()
            .inner()
            .finalize_gen
            .load(Ordering::Acquire)
    }

    /// Invalidate in-flight finalize / LLM follow-ups (Esc abort).
    pub(crate) fn bump_finalize_gen(app: &AppHandle) -> u64 {
        app.state::<AsrEngine>()
            .inner()
            .finalize_gen
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
    }

    pub(crate) fn finalize_aborted(app: &AppHandle, gen: u64) -> bool {
        Self::finalize_gen(app) != gen
    }

    pub(crate) fn set_pending_hud_confirm(app: &AppHandle, pending: Option<PendingHudConfirm>) {
        if let Ok(mut slot) = app.state::<AsrEngine>().inner().pending_hud_confirm.lock() {
            *slot = pending;
        }
    }

    pub(crate) fn take_pending_hud_confirm(app: &AppHandle) -> Option<PendingHudConfirm> {
        app.state::<AsrEngine>()
            .inner()
            .pending_hud_confirm
            .lock()
            .ok()?
            .take()
    }

    pub(crate) fn has_pending_hud_confirm(app: &AppHandle) -> bool {
        app.state::<AsrEngine>()
            .inner()
            .pending_hud_confirm
            .lock()
            .map(|s| s.is_some())
            .unwrap_or(false)
    }

    pub(crate) fn set_pending_paste_undo(app: &AppHandle, pending: Option<PendingPasteUndo>) {
        if let Ok(mut slot) = app.state::<AsrEngine>().inner().pending_paste_undo.lock() {
            *slot = pending;
        }
    }

    pub(crate) fn take_pending_paste_undo(app: &AppHandle) -> Option<PendingPasteUndo> {
        app.state::<AsrEngine>()
            .inner()
            .pending_paste_undo
            .lock()
            .ok()?
            .take()
    }

    pub(crate) fn send_worker(&self, cmd: WorkerCommand) -> Result<(), String> {
        self.worker_tx
            .lock()
            .map_err(|e| e.to_string())?
            .send(cmd)
            .map_err(|_| {
                "MLX worker 已退出（可能已崩溃）。请重启应用后再试。".to_string()
            })
    }

    /// Grab a snapshot of all accumulated audio samples (16kHz mono f32).
    pub(crate) fn get_audio_snapshot(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.as_ref().map(|r| r.0.get_samples())
    }

    /// Hot-path: samples from absolute `from` to end (avoids full-buffer clone).
    pub(crate) fn get_audio_from(app: &AppHandle, from: usize) -> Option<(usize, Vec<f32>)> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().ok()?;
        Some(rec_guard.as_ref()?.0.get_samples_from(from))
    }

    /// Drain recorder samples before `keep_from` for cold archive.
    pub(crate) fn drain_audio_before(app: &AppHandle, keep_from: usize) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().ok()?;
        Some(rec_guard.as_ref()?.0.drain_before(keep_from))
    }

    /// Live meter level from the active recorder (avoids cloning the full buffer).
    pub(crate) fn get_audio_rms(app: &AppHandle) -> Option<f32> {
        let (rms, _) = app.state::<AsrEngine>().inner().live_meter.refresh_for_pump();
        Some(rms)
    }

    /// RMS + bands for HUD. Envelope is lock-free; spectrum uses try_lock on PCM
    /// so VAD commit never freezes the meter at silence.
    pub(crate) fn get_audio_level(app: &AppHandle, _band_count: usize) -> Option<(f32, Vec<f32>)> {
        if !app
            .state::<AsrEngine>()
            .inner()
            .recording
            .load(Ordering::Acquire)
        {
            return None;
        }
        Some(app.state::<AsrEngine>().inner().live_meter.refresh_for_pump())
    }

    /// Take ownership of the recorder, stop it, and return all samples.
    pub(crate) fn take_recorder_and_stop(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let mut rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.take().map(|wrapper| {
            let rec = wrapper.into_inner();
            rec.stop().unwrap_or_default()
        })
    }
}
