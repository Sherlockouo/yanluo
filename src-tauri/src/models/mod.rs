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

fn model_status_path(requested: Option<&str>, configured: &str, installed: PathBuf) -> PathBuf {
    match requested {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        Some(_) => installed,
        None if !configured.trim().is_empty() => PathBuf::from(configured.trim()),
        None => installed,
    }
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
    let root = crate::config::app_data_dir().join("models");
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
        .header("User-Agent", "Sayi")
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
    let mut last_emit: u64 = 0;
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
        // Throttle — every 256 KiB (or finish). Unthrottled emits starve the webview.
        if downloaded - last_emit >= 256 * 1024 || total == Some(downloaded) {
            last_emit = downloaded;
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
    }
    drop(out);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_model_status(
    model_id: Option<String>,
    path: Option<String>,
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
    let path = model_status_path(path.as_deref(), &configured, model_install_path(&model_id)?);
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

// —— Local cache detection (HuggingFace / ModelScope) ——

/// A Qwen model discovered in a local hub cache. Suggestion only — the FE lets
/// the user adopt it with one click or ignore it entirely.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct LocalModelHit {
    pub(crate) model_id: String,
    /// Directory that directly holds model.safetensors (snapshot or flat dir).
    pub(crate) path: String,
    /// "huggingface" | "modelscope"
    pub(crate) source: String,
}

const DETECT_MODEL_IDS: [&str; 3] = [
    "Qwen3-ASR-0.6B",
    "Qwen3-ASR-1.7B",
    "Qwen3-ForcedAligner-0.6B",
];

/// Hub-cache roots to scan, most authoritative first. Env overrides respected
/// (HF_HUB_CACHE / HF_HOME / MODELSCOPE_CACHE); duplicates collapse.
fn detect_cache_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut push = |p: PathBuf, source: &'static str| {
        if !p.as_os_str().is_empty() && !roots.iter().any(|(e, _)| e == &p) {
            roots.push((p, source));
        }
    };
    let env = |key: &str| std::env::var(key).ok().map(|v| v.trim().to_string());
    if let Some(v) = env("HF_HUB_CACHE") {
        push(PathBuf::from(v), "huggingface");
    }
    if let Some(v) = env("HF_HOME") {
        push(PathBuf::from(v).join("hub"), "huggingface");
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".cache/huggingface/hub"), "huggingface");
    }
    if let Some(v) = env("MODELSCOPE_CACHE") {
        // Both layouts exist across ModelScope versions: cache root holding
        // `hub/…` (older) and the hub dir itself holding `models/…` (newer).
        let base = PathBuf::from(&v);
        push(base.join("hub"), "modelscope");
        push(base, "modelscope");
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".cache/modelscope/hub"), "modelscope");
    }
    roots
}

/// ModelScope escapes `.` as `___` in some flat layouts (0.6B → 0___6B).
fn model_dirname_variants(model_id: &str) -> [String; 2] {
    [model_id.to_string(), model_id.replace('.', "___")]
}

/// Weight-bearing dir for a hub entry: freshest valid snapshot, or the entry
/// itself when files sit flat (ModelScope `models/Qwen/<name>` layout).
fn best_weight_dir(entry: &Path) -> Option<PathBuf> {
    let snapshots = entry.join("snapshots");
    if snapshots.is_dir() {
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        if let Ok(revs) = fs::read_dir(&snapshots) {
            for rev in revs.filter_map(|e| e.ok()).map(|e| e.path()) {
                if rev.is_dir() && has_model_weights(&rev) {
                    let mtime = fs::metadata(&rev)
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
                        best = Some((mtime, rev));
                    }
                }
            }
        }
        if let Some((_, p)) = best {
            return Some(p);
        }
    }
    if has_model_weights(entry) {
        return Some(entry.to_path_buf());
    }
    None
}

/// Scan standard HuggingFace / ModelScope caches for locally downloaded Qwen
/// models. Read-only; missing roots are skipped. Cheap (one read_dir per root).
#[tauri::command]
pub(crate) fn detect_local_qwen_models() -> Vec<LocalModelHit> {
    scan_local_qwen_models(&detect_cache_roots())
}

fn scan_local_qwen_models(roots: &[(PathBuf, &'static str)]) -> Vec<LocalModelHit> {
    let mut hits: Vec<LocalModelHit> = Vec::new();
    for (root, source) in roots {
        for model_id in DETECT_MODEL_IDS {
            if hits.iter().any(|h| h.model_id == model_id) {
                continue;
            }
            let variants = model_dirname_variants(model_id);
            let mut candidates: Vec<PathBuf> = Vec::new();
            for name in &variants {
                candidates.push(root.join(format!("models--Qwen--{name}")));
                candidates.push(root.join("models/Qwen").join(name));
                candidates.push(root.join("Qwen").join(name));
            }
            for entry in candidates {
                if let Some(path) = best_weight_dir(&entry) {
                    hits.push(LocalModelHit {
                        model_id: model_id.to_string(),
                        path: path.to_string_lossy().to_string(),
                        source: source.to_string(),
                    });
                    break;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_model_path_overrides_stale_saved_config() {
        let installed = PathBuf::from("/models/default");
        assert_eq!(
            model_status_path(Some("/models/typed"), "/models/stale", installed.clone()),
            PathBuf::from("/models/typed")
        );
        assert_eq!(
            model_status_path(Some(""), "/models/stale", installed.clone()),
            installed
        );
    }

    /// Unique temp dir (no tempfile dev-dependency).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sayi-detect-{tag}-{}",
            std::process::id() as u64 + std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create scratch");
        dir
    }

    fn touch_weights(dir: &Path) {
        fs::create_dir_all(dir).expect("mkdir");
        fs::write(dir.join("model.safetensors"), b"weights").expect("write");
    }

    #[test]
    fn scan_finds_hf_snapshot_layout() {
        let root = scratch("hf");
        let snap = root.join("models--Qwen--Qwen3-ASR-1.7B/snapshots/abc123");
        touch_weights(&snap);
        // Distractor: a second model that must not leak into results.
        let other = root.join("models--Org--Other/snapshots/x");
        touch_weights(&other);

        let hits = scan_local_qwen_models(&[(root.clone(), "huggingface")]);
        assert_eq!(hits.len(), 1, "only the known Qwen id is reported: {hits:?}");
        assert_eq!(hits[0].model_id, "Qwen3-ASR-1.7B");
        assert_eq!(hits[0].source, "huggingface");
        assert_eq!(hits[0].path, snap.to_string_lossy());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_finds_modelscope_flat_layouts_plain_and_escaped() {
        let root = scratch("ms");
        // Current modelscope: models/<org>/<name> (files flat, no snapshots/).
        touch_weights(&root.join("models/Qwen/Qwen3-ASR-0.6B"));
        // Escaped-dot variant some versions write (0.6B → 0___6B).
        touch_weights(&root.join("models/Qwen/Qwen3-ForcedAligner-0___6B"));

        let hits = scan_local_qwen_models(&[(root.clone(), "modelscope")]);
        assert_eq!(hits.len(), 2, "{hits:?}");
        let ids: Vec<&str> = hits.iter().map(|h| h.model_id.as_str()).collect();
        assert!(ids.contains(&"Qwen3-ASR-0.6B"));
        assert!(ids.contains(&"Qwen3-ForcedAligner-0.6B"));
        assert!(hits.iter().all(|h| h.source == "modelscope"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_prefers_first_root_and_skips_incomplete_entries() {
        let ms_root = scratch("ms-priority");
        // Incomplete ModelScope dir (no weights) must not match…
        fs::create_dir_all(ms_root.join("models/Qwen/Qwen3-ASR-1.7B")).expect("mkdir");
        // …while the HF root holds the real one; ASR-0.6B exists in BOTH roots,
        // and the first (huggingface) root must win.
        let hf_root = scratch("hf-priority");
        touch_weights(&hf_root.join("models--Qwen--Qwen3-ASR-0.6B/snapshots/r1"));
        touch_weights(&ms_root.join("models/Qwen/Qwen3-ASR-0.6B"));

        let hits = scan_local_qwen_models(&[
            (hf_root.clone(), "huggingface"),
            (ms_root.clone(), "modelscope"),
        ]);
        let asr06 = hits
            .iter()
            .find(|h| h.model_id == "Qwen3-ASR-0.6B")
            .expect("0.6B found");
        assert_eq!(asr06.source, "huggingface");
        assert!(asr06.path.starts_with(hf_root.to_string_lossy().as_ref()));
        assert!(!hits.iter().any(|h| h.model_id == "Qwen3-ASR-1.7B"));

        fs::remove_dir_all(&hf_root).ok();
        fs::remove_dir_all(&ms_root).ok();
    }
}

/// Download Qwen ASR weights + tokenizer off the IPC thread.
/// Blocking HTTP on a sync command freezes the webview; mirror update/download.
#[tauri::command]
pub(crate) async fn download_qwen_asr_model(
    app: AppHandle,
    model_id: String,
    download_aligner: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_qwen_asr_model_blocking(&app, model_id, download_aligner)
    })
    .await
    .map_err(|e| format!("下载任务失败: {e}"))?
}

fn download_qwen_asr_model_blocking(
    app: &AppHandle,
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
        crate::elog::elog!("[model-dl] {} → {}", url, dest.display());
        download_file(app, model_id, &url, &dest, name, i + 1, file_count)?;
    }

    if !has_model_weights(&dest_dir) {
        return Err("下载完成但未找到 model.safetensors".into());
    }
    if !dest_dir.join("tokenizer.json").exists() {
        return Err("下载完成但缺少 tokenizer.json".into());
    }

    if download_aligner.unwrap_or(false) {
        let _ = download_aligner_best_effort(app);
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
