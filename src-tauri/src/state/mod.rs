use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use crate::audio::*;
use crate::config::*;
use crate::history::*;
use crate::transcription::*;

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
    },
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AsrEngine {
    pub(crate) model_dir: Mutex<String>,
    pub(crate) recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
    /// true while recording is active. Worker loop reads this.
    pub(crate) recording: Arc<AtomicBool>,
    /// Set by cancel_recording; mlx worker skips final transcription when true.
    pub(crate) cancel_requested: Arc<AtomicBool>,
    pub(crate) model_loaded: Arc<AtomicBool>,
    /// Channel to the MLX worker thread.
    pub(crate) worker_tx: Mutex<Sender<WorkerCommand>>,
    pub(crate) config: Mutex<AppConfig>,
    pub(crate) history: Mutex<Vec<HistoryEntry>>,
    /// "fn" | "translate" (HUD + paste) or "transcribe" (save audio, no paste).
    pub(crate) session_mode: Mutex<String>,
    /// Live translate accumulation (strategy C). Translate mode only.
    pub(crate) translate_stream: Mutex<TranslateStreamState>,
}

impl AsrEngine {
    pub(crate) fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<WorkerCommand>();

        let model_loaded = Arc::new(AtomicBool::new(false));
        let model_loaded_clone = model_loaded.clone();
        let app_for_worker = app.clone();
        std::thread::Builder::new()
            .name("mlx-worker".into())
            .spawn(move || {
                mlx_worker(rx, app_for_worker, model_loaded_clone);
            })
            .expect("failed to spawn MLX worker thread");

        let config = load_config_from_disk();
        let history = load_history_from_disk();

        Self {
            model_dir: Mutex::new(config.asr_model_dir.clone()),
            recorder: Mutex::new(None),
            recording: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            model_loaded,
            worker_tx: Mutex::new(tx),
            config: Mutex::new(config),
            history: Mutex::new(history),
            session_mode: Mutex::new("fn".into()),
            translate_stream: Mutex::new(TranslateStreamState::default()),
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

    pub(crate) fn send_worker(&self, cmd: WorkerCommand) -> Result<(), String> {
        self.worker_tx
            .lock()
            .map_err(|e| e.to_string())?
            .send(cmd)
            .map_err(|e| e.to_string())
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
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().ok()?;
        Some(rec_guard.as_ref()?.0.recent_rms(640)) // ~40ms @ 16kHz
    }

    /// RMS + log-spaced speech bands for the HUD spectrum.
    pub(crate) fn get_audio_level(app: &AppHandle, band_count: usize) -> Option<(f32, Vec<f32>)> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().ok()?;
        Some(rec_guard.as_ref()?.0.recent_bands(band_count, 1_024))
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
