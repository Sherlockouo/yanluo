//! ASR Workshop backend — Tauri commands for model management, recording, and transcription.

use serde::Serialize;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tempfile::NamedTempFile;

mod audio_recorder;
use audio_recorder::AudioRecorder;

// ---------------------------------------------------------------------------
// Send-safe wrapper for MLX-backed types that hold raw C pointers.
// MLX C library internally manages thread safety; the raw pointers are
// safe to pass between threads as long as we serialize access via Mutex.
// ---------------------------------------------------------------------------

/// Wrapper that asserts Send + Sync. The wrapped value must only be
/// accessed under external synchronization (e.g. behind a Mutex).
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
// App state
// ---------------------------------------------------------------------------

pub struct AsrEngine {
    inference: Mutex<Option<SendWrapper<qwen3_asr_rs::inference::AsrInference>>>,
    model_dir: Mutex<String>,
    // cpal::Stream is !Send on macOS (CoreAudio holds *mut () + dyn FnMut callbacks).
    // We only ever access it behind this Mutex and never actually send the
    // stream across threads at runtime, so the SendWrapper assertion is safe.
    recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
}

impl AsrEngine {
    fn new() -> Self {
        Self {
            inference: Mutex::new(None),
            model_dir: Mutex::new(String::new()),
            recorder: Mutex::new(None),
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
fn load_model(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let dir = engine
        .inner()
        .model_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if dir.is_empty() {
        return Err("Model directory not configured".into());
    }
    let path = Path::new(&dir);
    if !path.join("model.safetensors").exists() {
        return Err(format!("model.safetensors not found in {}", dir));
    }

    let mut guard = engine.inner().inference.lock().map_err(|e| e.to_string())?;
    match qwen3_asr_rs::inference::AsrInference::load(path, qwen3_asr_rs::tensor::Device::Cpu) {
        Ok(inf) => {
            *guard = Some(SendWrapper::new(inf));
            let _ = app.emit("model-loaded", &dir);
            Ok(())
        }
        Err(e) => Err(format!("Failed to load model: {}", e)),
    }
}

#[tauri::command]
fn start_recording(engine: State<'_, AsrEngine>) -> Result<(), String> {
    let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Already recording".into());
    }
    let rec = AudioRecorder::start().map_err(|e| e.to_string())?;
    *guard = Some(SendWrapper::new(rec));
    Ok(())
}

#[tauri::command]
fn stop_recording(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let recorder = {
        let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("Not recording")?
    };

    // Unwrap the SendWrapper to get the real AudioRecorder.
    let recorder = recorder.into_inner();
    let samples = recorder.stop().map_err(|e| e.to_string())?;
    let duration_seconds = samples.len() as f64 / 16000.0;

    let wav_path = save_wav(&samples, "asr_recording")?;

    let mut inference_guard = engine.inner().inference.lock().map_err(|e| e.to_string())?;

    let result = match inference_guard.as_ref() {
        Some(inf) => match inf.0.transcribe(wav_path.to_str().unwrap(), None) {
            Ok(r) => TranscriptionResult {
                text: r.text,
                language: r.language,
                duration_seconds: r.duration_seconds,
                error: None,
            },
            Err(e) => TranscriptionResult {
                text: String::new(),
                language: String::new(),
                duration_seconds,
                error: Some(format!("{e}")),
            },
        },
        None => TranscriptionResult {
            text: String::new(),
            language: String::new(),
            duration_seconds,
            error: Some("Model not loaded".into()),
        },
    };

    drop(inference_guard);
    let _ = app.emit("transcription-result", &result);
    let _ = std::fs::remove_file(&wav_path);

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TranscriptionResult {
    text: String,
    language: String,
    duration_seconds: f64,
    error: Option<String>,
}

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
        .manage(AsrEngine::new())
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
