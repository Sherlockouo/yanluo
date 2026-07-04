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
    LoadModel {
        path: PathBuf,
    },
    StartStreaming {
        chunk_sec: f64,
        rollback_tokens: usize,
    },
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

            WorkerCommand::StartStreaming {
                chunk_sec,
                rollback_tokens,
            } => {
                let inf = match inference.as_mut() {
                    Some(inf) => inf,
                    None => {
                        eprintln!("[mlx-worker] StartStreaming but no model loaded");
                        continue;
                    }
                };

                let chunk_samples = (chunk_sec * 16000.0) as usize;

                eprintln!(
                    "[mlx-worker] streaming: chunk={}s ({} samples), rollback={}",
                    chunk_sec, chunk_samples, rollback_tokens
                );

                let mut stream_state = match inf.init_streaming(None, rollback_tokens) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[mlx-worker] init_streaming failed: {}", e);
                        let _ = app.emit("partial-error", &format!("init_streaming: {e}"));
                        continue;
                    }
                };

                eprintln!(
                    "[mlx-worker] streaming loop started (rollback={})",
                    rollback_tokens
                );
                let mut partial_count = 0usize;
                let mut last_transcribed_samples = 0usize;

                // --- Self-paced streaming loop ---
                // After each transcription, wait for at least chunk_sec of new
                // audio before the next round.
                loop {
                    if !recording.load(Ordering::Acquire) {
                        break;
                    }

                    std::thread::sleep(Duration::from_millis(50));

                    let samples = match AsrEngine::get_audio_snapshot(&app) {
                        Some(s) => s,
                        None => break, // recorder gone
                    };

                    // Wait until enough new audio has accumulated.
                    let new_samples = samples.len().saturating_sub(last_transcribed_samples);
                    if samples.len() < chunk_samples || new_samples < chunk_samples {
                        continue;
                    }

                    partial_count += 1;
                    let duration = samples.len() as f64 / 16000.0;
                    eprintln!(
                        "[mlx-worker] partial #{}: {:.1}s audio (+{:.1}s new)",
                        partial_count,
                        duration,
                        new_samples as f64 / 16000.0
                    );

                    match inf.streaming_transcribe_partial(&samples, &mut stream_state) {
                        Ok(r) => {
                            last_transcribed_samples = samples.len();

                            if recording.load(Ordering::Acquire) {
                                eprintln!(
                                    "[mlx-worker] partial #{} done: lang={} text_len={}",
                                    partial_count,
                                    r.language,
                                    r.text.len()
                                );
                                // Only emit if there's new text — avoids
                                // flicker when a partial step produces no
                                // new complete chunk.
                                if !r.text.is_empty() {
                                    let _ =
                                        app.emit("partial-result", &PartialResult { text: r.text });
                                }
                            }
                        }
                        Err(e) => {
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

                // Final transcription: process everything including tail frames.
                let result = match inf.streaming_transcribe(&samples, &mut stream_state) {
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
fn start_recording(
    chunk_sec: Option<f64>,
    rollback_tokens: Option<usize>,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
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

    // Defaults: 1s chunk, rollback=3.
    let chunk_sec = chunk_sec.unwrap_or(0.5);
    let rollback_tokens = rollback_tokens.unwrap_or(1);

    // Tell the worker to enter the streaming loop.
    engine.send_worker(WorkerCommand::StartStreaming {
        chunk_sec,
        rollback_tokens,
    })?;
    eprintln!(
        "[asr] recording started, chunk={}s rollback={}",
        chunk_sec, rollback_tokens
    );

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
