//! ASR Workshop backend — Tauri commands for model management, recording, and transcription.
//!
//! Architecture: a dedicated MLX worker thread owns the inference engine.
//! All MLX operations (model loading, transcription) happen on that thread.
//!
//! Streaming: the worker thread runs a self-paced loop — after each partial
//! transcription completes, it immediately grabs the latest accumulated audio
//! and starts the next round. No timer, no queue, no stale partials.

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
// Worker commands
// ---------------------------------------------------------------------------

enum WorkerCommand {
    LoadModel { path: PathBuf },
    StartStreaming,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AsrEngine {
    model_dir: Mutex<String>,
    recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
    /// true while recording is active. Worker loop reads this.
    recording: Arc<AtomicBool>,
    model_loaded: Arc<AtomicBool>,
    /// Channel to the MLX worker thread.
    worker_tx: Mutex<Sender<WorkerCommand>>,
}

impl AsrEngine {
    fn new(app: AppHandle) -> Self {
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

    /// Grab a snapshot of all accumulated audio samples (16kHz mono f32).
    fn get_audio_snapshot(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.as_ref().map(|r| r.0.get_samples())
    }

    /// Take ownership of the recorder, stop it, and return all samples.
    fn take_recorder_and_stop(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let mut rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.take().map(|wrapper| {
            let rec = wrapper.into_inner();
            rec.stop().unwrap_or_default()
        })
    }
}

// ---------------------------------------------------------------------------
// MLX worker thread — owns the inference engine, all MLX ops happen here.
// ---------------------------------------------------------------------------

fn mlx_worker(rx: Receiver<WorkerCommand>, app: AppHandle, model_loaded: Arc<AtomicBool>) {
    qwen3_asr_rs::backend::mlx::stream::init_mlx(true);
    eprintln!("[mlx-worker] MLX initialized, waiting for commands...");

    let mut inference: Option<qwen3_asr_rs::inference::AsrInference> = None;
    let recording = app.state::<AsrEngine>().inner().recording.clone();

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

            WorkerCommand::StartStreaming => {
                let inf = match inference.as_ref() {
                    Some(inf) => inf,
                    None => {
                        eprintln!("[mlx-worker] StartStreaming but no model loaded");
                        continue;
                    }
                };

                eprintln!("[mlx-worker] streaming loop started");
                let mut partial_count = 0usize;

                // --- Self-paced streaming loop ---
                // After each transcription, immediately grab the latest audio
                // and start the next round. No timer, no queue.
                loop {
                    if !recording.load(Ordering::Acquire) {
                        break;
                    }

                    // Sleep briefly before first transcription to accumulate audio.
                    // Also prevents busy-looping when audio is too short.
                    std::thread::sleep(Duration::from_millis(300));

                    let samples = match AsrEngine::get_audio_snapshot(&app) {
                        Some(s) => s,
                        None => break, // recorder gone
                    };

                    if samples.len() < MIN_PARTIAL_SAMPLES {
                        continue; // not enough audio yet
                    }

                    partial_count += 1;
                    let duration = samples.len() as f64 / 16000.0;
                    eprintln!(
                        "[mlx-worker] partial #{}: {:.1}s audio",
                        partial_count, duration
                    );

                    match inf.transcribe_samples(&samples, None) {
                        Ok(r) => {
                            // Flush MLX computation graph to free memory.
                            qwen3_asr_rs::backend::mlx::stream::synchronize();

                            if recording.load(Ordering::Acquire) {
                                eprintln!(
                                    "[mlx-worker] partial #{} done: lang={} text_len={}",
                                    partial_count,
                                    r.language,
                                    r.text.len()
                                );
                                let _ = app.emit("partial-result", &PartialResult { text: r.text });
                            }
                        }
                        Err(e) => {
                            qwen3_asr_rs::backend::mlx::stream::synchronize();
                            eprintln!("[mlx-worker] partial #{} failed: {}", partial_count, e);
                            let _ = app.emit("partial-error", &format!("{e}"));
                        }
                    }
                }

                eprintln!("[mlx-worker] streaming loop ended, doing final transcription");

                // --- Final transcription ---
                // Take the recorder, stop it, get all samples.
                let samples = match AsrEngine::take_recorder_and_stop(&app) {
                    Some(s) => s,
                    None => {
                        eprintln!("[mlx-worker] recorder already gone, skipping final");
                        let _ = app.emit(
                            "transcription-result",
                            &TranscriptionResult {
                                text: String::new(),
                                language: String::new(),
                                duration_seconds: 0.0,
                                error: Some("Recorder not found".into()),
                            },
                        );
                        continue;
                    }
                };

                let duration = samples.len() as f64 / 16000.0;
                eprintln!("[mlx-worker] final: {:.1}s audio", duration);

                let result = match inf.transcribe_samples(&samples, None) {
                    Ok(r) => TranscriptionResult {
                        text: r.text,
                        language: r.language,
                        duration_seconds: r.duration_seconds,
                        error: None,
                    },
                    Err(e) => TranscriptionResult {
                        text: String::new(),
                        language: String::new(),
                        duration_seconds: duration,
                        error: Some(format!("{e}")),
                    },
                };

                // Flush MLX graph.
                qwen3_asr_rs::backend::mlx::stream::synchronize();

                eprintln!(
                    "[mlx-worker] final done: lang={} text_len={} error={:?}",
                    result.language,
                    result.text.len(),
                    result.error
                );
                let _ = app.emit("transcription-result", &result);
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
    engine.send_worker(WorkerCommand::LoadModel { path })
}

/// Minimum audio length (in samples) before we attempt a partial transcription.
const MIN_PARTIAL_SAMPLES: usize = 16_000; // 1 second @ 16kHz

#[tauri::command]
fn start_recording(engine: State<'_, AsrEngine>) -> Result<(), String> {
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

    // Tell the worker to enter the streaming loop.
    engine.send_worker(WorkerCommand::StartStreaming)?;
    eprintln!("[asr] recording started, worker streaming loop initiated");

    Ok(())
}

#[tauri::command]
fn stop_recording(engine: State<'_, AsrEngine>) -> Result<(), String> {
    // Signal the worker's streaming loop to stop.
    // The worker will then do the final transcription automatically.
    engine.inner().recording.store(false, Ordering::Release);
    eprintln!("[asr] stop signaled, worker will finish current partial then do final");
    Ok(())
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
