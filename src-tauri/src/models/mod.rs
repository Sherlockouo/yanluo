//! First-run Qwen ASR model download into Application Support.

use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::config::{save_config_to_disk, AppConfig};
use crate::state::AsrEngine;
use tauri::Manager;

pub(crate) fn has_model_weights(path: &Path) -> bool {
    path.join("model.safetensors").exists() || path.join("model.safetensors.index.json").exists()
}

#[derive(Clone, Serialize)]
pub(crate) struct ModelStatus {
    pub(crate) model_id: String,
    pub(crate) path: String,
    pub(crate) installed: bool,
    pub(crate) needs_download: bool,
    pub(crate) has_tokenizer: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct DownloadProgress {
    pub(crate) model_id: String,
    pub(crate) file: String,
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
    pub(crate) file_index: usize,
    pub(crate) file_count: usize,
    pub(crate) percent: Option<f64>,
}

fn models_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "无法定位 Application Support".to_string())?;
    let root = base.join("ASR Workshop").join("models");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

pub(crate) fn model_install_path(model_id: &str) -> Result<PathBuf, String> {
    Ok(models_root()?.join(model_id))
}

fn hf_resolve(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{file}")
}

struct FileSpec {
    repo: &'static str,
    file: &'static str,
    /// Optional rename on disk (defaults to `file` basename).
    save_as: Option<&'static str>,
}

fn file_list_for(model_id: &str) -> Result<Vec<FileSpec>, String> {
    match model_id {
        "Qwen3-ASR-0.6B" => Ok(vec![
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "generation_config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "preprocessor_config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "vocab.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "merges.txt",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B",
                file: "model.safetensors",
                save_as: None,
            },
            // Official ASR repo lacks tokenizer.json; HF Transformers export has it.
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B-hf",
                file: "tokenizer.json",
                save_as: None,
            },
        ]),
        "Qwen3-ASR-1.7B" => Ok(vec![
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "generation_config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "preprocessor_config.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "vocab.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "merges.txt",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "model.safetensors.index.json",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "model-00001-of-00002.safetensors",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-1.7B",
                file: "model-00002-of-00002.safetensors",
                save_as: None,
            },
            FileSpec {
                repo: "Qwen/Qwen3-ASR-0.6B-hf",
                file: "tokenizer.json",
                save_as: None,
            },
        ]),
        other => Err(format!("不支持的模型 id: {other}")),
    }
}

fn download_file(
    app: &AppHandle,
    model_id: &str,
    url: &str,
    dest: &Path,
    file_label: &str,
    file_index: usize,
    file_count: usize,
) -> Result<(), String> {
    if dest.exists() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let _ = app.emit(
            "model-download-progress",
            DownloadProgress {
                model_id: model_id.to_string(),
                file: file_label.to_string(),
                downloaded: dest.metadata().map(|m| m.len()).unwrap_or(0),
                total: dest.metadata().map(|m| m.len()).ok(),
                file_index,
                file_count,
                percent: Some(100.0),
            },
        );
        return Ok(());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(url)
        .header("User-Agent", "ASR-Workshop")
        .send()
        .map_err(|e| format!("下载失败 {file_label}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "下载失败 {file_label}: HTTP {}",
            response.status()
        ));
    }

    let total = response.content_length();
    let tmp = dest.with_extension("partial");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 1024 * 64];
    loop {
        let n = {
            use std::io::Read;
            response.read(&mut buf).map_err(|e| e.to_string())?
        };
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        let percent = total.map(|t| {
            if t == 0 {
                0.0
            } else {
                (downloaded as f64 / t as f64) * 100.0
            }
        });
        let _ = app.emit(
            "model-download-progress",
            DownloadProgress {
                model_id: model_id.to_string(),
                file: file_label.to_string(),
                downloaded,
                total,
                file_index,
                file_count,
                percent,
            },
        );
    }
    drop(out);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_model_status(
    model_id: Option<String>,
    engine: tauri::State<'_, AsrEngine>,
) -> Result<ModelStatus, String> {
    let cfg_id = engine
        .inner()
        .config
        .lock()
        .map(|c| c.asr_model_id.clone())
        .unwrap_or_else(|_| "Qwen3-ASR-0.6B".into());
    let model_id = model_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(cfg_id);
    let configured = engine
        .inner()
        .config
        .lock()
        .map(|c| c.asr_model_dir.clone())
        .unwrap_or_default();
    let path = if !configured.trim().is_empty() && has_model_weights(Path::new(&configured)) {
        PathBuf::from(configured.trim())
    } else {
        model_install_path(&model_id)?
    };
    let installed = has_model_weights(&path);
    let has_tokenizer = path.join("tokenizer.json").exists();
    Ok(ModelStatus {
        model_id,
        path: path.to_string_lossy().to_string(),
        installed,
        needs_download: !installed || !has_tokenizer,
        has_tokenizer,
    })
}

#[tauri::command]
pub(crate) fn download_qwen_asr_model(
    app: AppHandle,
    model_id: String,
    download_aligner: Option<bool>,
) -> Result<String, String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("model_id 为空".into());
    }
    let files = file_list_for(model_id)?;
    let dest_dir = model_install_path(model_id)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let file_count = files.len();
    for (i, spec) in files.iter().enumerate() {
        let name = spec.save_as.unwrap_or(spec.file);
        let dest = dest_dir.join(name);
        let url = hf_resolve(spec.repo, spec.file);
        eprintln!("[model-dl] {} → {}", url, dest.display());
        download_file(&app, model_id, &url, &dest, name, i + 1, file_count)?;
    }

    if !has_model_weights(&dest_dir) {
        return Err("下载完成但未找到 model.safetensors".into());
    }
    if !dest_dir.join("tokenizer.json").exists() {
        return Err("下载完成但缺少 tokenizer.json".into());
    }

    if download_aligner.unwrap_or(false) {
        let _ = download_aligner_best_effort(&app);
    }

    let path_str = dest_dir.to_string_lossy().to_string();
    if let Some(engine) = app.try_state::<AsrEngine>() {
        if let Ok(mut dir) = engine.inner().model_dir.lock() {
            *dir = path_str.clone();
        }
        if let Ok(mut cfg) = engine.inner().config.lock() {
            cfg.asr_model_dir = path_str.clone();
            cfg.asr_model_id = model_id.to_string();
            cfg.asr_provider = crate::config::AsrProvider::Qwen;
            let _ = save_config_to_disk(&cfg);
            let _ = app.emit("config-updated", cfg.clone());
        }
    }

    let _ = app.emit(
        "model-download-progress",
        DownloadProgress {
            model_id: model_id.to_string(),
            file: "(done)".into(),
            downloaded: 0,
            total: None,
            file_index: file_count,
            file_count,
            percent: Some(100.0),
        },
    );

    Ok(path_str)
}

fn download_aligner_best_effort(app: &AppHandle) -> Result<(), String> {
    let align_id = "Qwen3-ForcedAligner-0.6B";
    let dest_dir = model_install_path(align_id)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let specs = [
        ("config.json", "Qwen/Qwen3-ForcedAligner-0.6B"),
        ("model.safetensors", "Qwen/Qwen3-ForcedAligner-0.6B"),
        ("vocab.json", "Qwen/Qwen3-ForcedAligner-0.6B"),
        ("merges.txt", "Qwen/Qwen3-ForcedAligner-0.6B"),
        ("tokenizer.json", "Qwen/Qwen3-ASR-0.6B-hf"),
    ];
    let n = specs.len();
    for (i, (file, repo)) in specs.iter().enumerate() {
        let dest = dest_dir.join(file);
        let url = hf_resolve(repo, file);
        download_file(app, align_id, &url, &dest, file, i + 1, n)?;
    }
    if let Some(engine) = app.try_state::<AsrEngine>() {
        if let Ok(mut cfg) = engine.inner().config.lock() {
            cfg.align_model_dir = dest_dir.to_string_lossy().to_string();
            let _ = save_config_to_disk(&cfg);
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn apply_downloaded_path_to_config(cfg: &mut AppConfig, path: &str, model_id: &str) {
    cfg.asr_model_dir = path.to_string();
    cfg.asr_model_id = model_id.to_string();
}
