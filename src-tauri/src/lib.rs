//! ASR Workshop backend — Tauri commands for model management, recording, and transcription.
//!
//! Architecture: a dedicated MLX worker thread owns the inference engine.
//! All MLX operations (model loading, transcription) happen on that thread.
//! Tauri commands send requests to the worker via an mpsc channel and
//! results come back via Tauri events.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

mod audio_recorder;
use audio_recorder::AudioRecorder;

// ---------------------------------------------------------------------------
// Send-safe wrapper for cpal::Stream (which is !Send on macOS).
// ---------------------------------------------------------------------------

struct SendWrapper<T>(pub T);
unsafe impl<T> Send for SendWrapper<T> {}
unsafe impl<T> Sync for SendWrapper<T> {}

impl<T> SendWrapper<T> {
    fn new(t: T) -> Self {
        Self(t)
    }
    fn into_inner(self) -> T {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Worker commands (producer → consumer)
// ---------------------------------------------------------------------------

enum WorkerCommand {
    LoadModel { path: PathBuf },
    Transcribe { samples: Vec<f32>, is_final: bool },
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AsrEngine {
    model_dir: Mutex<String>,
    recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
    recording: Arc<AtomicBool>,
    model_loaded: Arc<AtomicBool>,
    /// Channel to the MLX worker thread.
    worker_tx: Mutex<Sender<WorkerCommand>>,
}

impl AsrEngine {
    fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<WorkerCommand>();

        // Spawn the dedicated MLX worker thread — lives for the entire app.
        let model_loaded = Arc::new(AtomicBool::new(false));
        let model_loaded_clone = model_loaded.clone();
        let app_for_worker = app.clone();
        std::thread::Builder::new()
            .name("mlx-worker".into())
            .spawn(move || {
                mlx_worker(rx, app_for_worker, model_loaded_clone);
            })
            .expect("failed to spawn MLX worker thread");

        Self {
            model_dir: Mutex::new(String::new()),
            recorder: Mutex::new(None),
            recording: Arc::new(AtomicBool::new(false)),
            model_loaded,
            worker_tx: Mutex::new(tx),
        }
    }

    fn send_worker(&self, cmd: WorkerCommand) -> Result<(), String> {
        self.worker_tx
            .lock()
            .map_err(|e| e.to_string())?
            .send(cmd)
            .map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// MLX worker thread — owns the inference engine, all MLX ops happen here.
// ---------------------------------------------------------------------------

fn mlx_worker(rx: Receiver<WorkerCommand>, app: AppHandle, model_loaded: Arc<AtomicBool>) {
    // Initialize MLX on THIS thread. All subsequent MLX operations must
    // run on this thread — MLX streams are thread-local.
    qwen3_asr_rs::backend::mlx::stream::init_mlx(true);
    eprintln!("[mlx-worker] MLX initialized, waiting for commands...");

    let mut inference: Option<qwen3_asr_rs::inference::AsrInference> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::LoadModel { path } => {
                eprintln!("[mlx-worker] Loading model from {:?}", path);
                match qwen3_asr_rs::inference::AsrInference::load(
                    &path,
                    qwen3_asr_rs::tensor::Device::Gpu(0),
                ) {
                    Ok(inf) => {
                        eprintln!("[mlx-worker] Model loaded successfully");
                        inference = Some(inf);
                        model_loaded.store(true, Ordering::Release);
                        let _ = app.emit("model-loaded", &path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        eprintln!("[mlx-worker] Model load failed: {}", e);
                        model_loaded.store(false, Ordering::Release);
                        let _ = app.emit("model-error", &format!("Failed to load model: {}", e));
                    }
                }
            }
            WorkerCommand::Transcribe { samples, is_final } => {
                let sample_count = samples.len();
                let duration = sample_count as f64 / 16000.0;
                let kind = if is_final { "final" } else { "partial" };

                // Quick audio level check (RMS) to verify mic is capturing.
                let rms = if sample_count > 0 {
                    let sum: f32 = samples.iter().map(|s| s * s).sum();
                    (sum / sample_count as f32).sqrt()
                } else {
                    0.0
                };
                eprintln!(
                    "[mlx-worker] {} transcribe: {:.1}s audio ({} samples, RMS={:.4})",
                    kind, duration, sample_count, rms
                );

                let inf = match inference.as_ref() {
                    Some(inf) => inf,
                    None => {
                        eprintln!("[mlx-worker] No model loaded, skipping");
                        if is_final {
                            let _ = app.emit(
                                "transcription-result",
                                &TranscriptionResult {
                                    text: String::new(),
                                    language: String::new(),
                                    duration_seconds: duration,
                                    error: Some("Model not loaded".into()),
                                },
                            );
                        }
                        continue;
                    }
                };

                // Transcribe samples directly — no temp file I/O.
                match inf.transcribe_samples(&samples, None) {
                    Ok(r) => {
                        eprintln!(
                            "[mlx-worker] {} done: lang={} text_len={}",
                            kind,
                            r.language,
                            r.text.len()
                        );
                        if is_final {
                            let _ = app.emit(
                                "transcription-result",
                                &TranscriptionResult {
                                    text: r.text,
                                    language: r.language,
                                    duration_seconds: r.duration_seconds,
                                    error: None,
                                },
                            );
                        } else {
                            let _ = app.emit("partial-result", &PartialResult { text: r.text });
                        }
                    }
                    Err(e) => {
                        eprintln!("[mlx-worker] {} transcription failed: {}", kind, e);
                        if is_final {
                            let _ = app.emit(
                                "transcription-result",
                                &TranscriptionResult {
                                    text: String::new(),
                                    language: String::new(),
                                    duration_seconds: duration,
                                    error: Some(format!("{e}")),
                                },
                            );
                        }
                        // For partials, emit an error event so the frontend can show it
                        let _ = app.emit("partial-error", &format!("{e}"));
                    }
                }
            }
        }
    }

    eprintln!("[mlx-worker] channel closed, exiting");
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_model_dir(path: String, engine: State<'_, AsrEngine>) -> Result<(), String> {
    *engine.inner().model_dir.lock().map_err(|e| e.to_string())? = path;
    Ok(())
}

#[tauri::command]
fn get_model_dir(engine: State<'_, AsrEngine>) -> Result<String, String> {
    engine
        .inner()
        .model_dir
        .lock()
        .map(|d| d.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_model(engine: State<'_, AsrEngine>) -> Result<(), String> {
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
    if !path.join("model.safetensors").exists() {
        return Err(format!("model.safetensors not found in {}", dir));
    }
    // Async: worker thread loads the model, emits "model-loaded" / "model-error".
    engine.send_worker(WorkerCommand::LoadModel { path })
}

/// Minimum audio length (in samples) before we attempt a partial transcription.
const MIN_PARTIAL_SAMPLES: usize = 16_000; // 1 second @ 16kHz

/// Interval between partial transcription attempts.
const PARTIAL_INTERVAL: Duration = Duration::from_secs(2);

#[tauri::command]
fn start_recording(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    // Reject if already recording.
    {
        let guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Already recording".into());
        }
    }
    if !engine.inner().model_loaded.load(Ordering::Acquire) {
        return Err("Model not loaded".into());
    }

    let rec = AudioRecorder::start().map_err(|e| e.to_string())?;
    {
        let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        *guard = Some(SendWrapper::new(rec));
    }
    engine.inner().recording.store(true, Ordering::Release);
    eprintln!("[asr] recording started, timer thread spawning");

    // Spawn timer thread that sends partial transcription requests to the worker.
    let app_handle = app.clone();
    let recording = engine.inner().recording.clone();
    let worker_tx = engine
        .inner()
        .worker_tx
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    std::thread::Builder::new()
        .name("partial-timer".into())
        .spawn(move || {
            // Wait before the first partial so we have enough audio.
            std::thread::sleep(PARTIAL_INTERVAL);

            while recording.load(Ordering::Acquire) {
                // Snapshot the current audio buffer.
                let samples = {
                    let state = app_handle.state::<AsrEngine>();
                    let rec_guard = state.inner().recorder.lock().unwrap();
                    match rec_guard.as_ref() {
                        Some(r) => r.0.get_samples(),
                        None => break, // recorder taken — stop.
                    }
                };

                eprintln!(
                    "[partial-timer] snapshot: {} samples ({:.1}s)",
                    samples.len(),
                    samples.len() as f64 / 16000.0
                );

                if samples.len() >= MIN_PARTIAL_SAMPLES {
                    let _ = worker_tx.send(WorkerCommand::Transcribe {
                        samples,
                        is_final: false,
                    });
                }

                std::thread::sleep(PARTIAL_INTERVAL);
            }
            eprintln!("[partial-timer] exited");
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn stop_recording(engine: State<'_, AsrEngine>) -> Result<(), String> {
    // Signal the timer thread to stop.
    engine.inner().recording.store(false, Ordering::Release);

    let recorder = {
        let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("Not recording")?
    };

    let recorder = recorder.into_inner();
    let samples = recorder.stop().map_err(|e| e.to_string())?;
    eprintln!(
        "[asr] recording stopped, {} samples ({:.1}s) → worker",
        samples.len(),
        samples.len() as f64 / 16000.0
    );

    // Send final transcription to the worker thread.
    // Result arrives via "transcription-result" event.
    engine.send_worker(WorkerCommand::Transcribe {
        samples,
        is_final: true,
    })
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct PartialResult {
    text: String,
}

#[derive(Clone, Serialize)]
struct TranscriptionResult {
    text: String,
    language: String,
    duration_seconds: f64,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AsrEngine::new(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_model_dir,
            get_model_dir,
            load_model,
            start_recording,
            stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
