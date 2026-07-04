//! ASR Workshop backend — Tauri commands for model management, recording, and transcription.
//!
//! Architecture: a dedicated MLX worker thread owns the inference engine.
//! All MLX operations (model loading, transcription) happen on that thread.
//! Tauri commands send requests to the worker via an mpsc channel and
//! results come back via Tauri events.

use serde::Serialize;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::NamedTempFile;

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
        std::thread::spawn(move || {
            mlx_worker(rx, app_for_worker, model_loaded_clone);
        });

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

    let mut inference: Option<qwen3_asr_rs::inference::AsrInference> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::LoadModel { path } => {
                match qwen3_asr_rs::inference::AsrInference::load(
                    &path,
                    qwen3_asr_rs::tensor::Device::Gpu(0),
                ) {
                    Ok(inf) => {
                        inference = Some(inf);
                        model_loaded.store(true, Ordering::Release);
                        let _ = app.emit("model-loaded", &path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        model_loaded.store(false, Ordering::Release);
                        let _ = app.emit("model-error", &format!("Failed to load model: {}", e));
                    }
                }
            }
            WorkerCommand::Transcribe { samples, is_final } => {
                let inf = match inference.as_ref() {
                    Some(inf) => inf,
                    None => {
                        if is_final {
                            let _ = app.emit(
                                "transcription-result",
                                &TranscriptionResult {
                                    text: String::new(),
                                    language: String::new(),
                                    duration_seconds: samples.len() as f64 / 16000.0,
                                    error: Some("Model not loaded".into()),
                                },
                            );
                        }
                        continue;
                    }
                };

                let duration_seconds = samples.len() as f64 / 16000.0;
                let prefix = if is_final { "asr_recording" } else { "partial" };

                let wav_path = match save_wav(&samples, prefix) {
                    Ok(p) => p,
                    Err(e) => {
                        if is_final {
                            let _ = app.emit(
                                "transcription-result",
                                &TranscriptionResult {
                                    text: String::new(),
                                    language: String::new(),
                                    duration_seconds,
                                    error: Some(e),
                                },
                            );
                        }
                        continue;
                    }
                };

                let result = inf.transcribe(wav_path.to_str().unwrap(), None);
                let _ = std::fs::remove_file(&wav_path);

                match result {
                    Ok(r) => {
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
                    Err(e) if is_final => {
                        let _ = app.emit(
                            "transcription-result",
                            &TranscriptionResult {
                                text: String::new(),
                                language: String::new(),
                                duration_seconds,
                                error: Some(format!("{e}")),
                            },
                        );
                    }
                    Err(_) => { /* swallow partial transcription errors */ }
                }
            }
        }
    }
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

    // Spawn timer thread that sends partial transcription requests to the worker.
    let app_handle = app.clone();
    let recording = engine.inner().recording.clone();
    let worker_tx = engine
        .inner()
        .worker_tx
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    std::thread::spawn(move || {
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

            if samples.len() >= MIN_PARTIAL_SAMPLES {
                let _ = worker_tx.send(WorkerCommand::Transcribe {
                    samples,
                    is_final: false,
                });
            }

            std::thread::sleep(PARTIAL_INTERVAL);
        }
    });

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
// Helpers
// ---------------------------------------------------------------------------

fn save_wav(samples: &[f32], prefix: &str) -> Result<PathBuf, String> {
    // tempfile 3.27: NamedTempFile::keep() returns (File, PathBuf) — file first.
    let temp = NamedTempFile::with_prefix(prefix).map_err(|e| e.to_string())?;
    let (file, path) = temp.keep().map_err(|e| e.to_string())?;

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::new(BufWriter::new(file), spec).map_err(|e| e.to_string())?;

    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let sample = (clamped * 32767.0) as i16;
        writer.write_sample(sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(path)
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
