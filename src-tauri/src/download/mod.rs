//! Download media from YouTube / Bilibili / Douyin / etc. via yt-dlp.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::audio::{ffmpeg_bin, ffmpeg_location_dir};
use crate::config::app_data_dir;

static DOWNLOAD_BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);
static ACTIVE_PID: Mutex<Option<u32>> = Mutex::new(None);

#[derive(Clone, Serialize)]
pub(crate) struct YtdlpStatus {
    pub(crate) available: bool,
    pub(crate) path: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) ffmpeg_available: bool,
    pub(crate) hint: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct UrlDownloadProgress {
    pub(crate) phase: String,
    pub(crate) percent: Option<f64>,
    pub(crate) message: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct UrlDownloadResult {
    pub(crate) path: String,
    pub(crate) media_kind: String,
    pub(crate) title: Option<String>,
    pub(crate) job_dir: String,
}

fn downloads_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir().join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn look_for_ytdlp() -> Option<(String, Vec<String>)> {
    const BINS: &[&str] = &[
        "yt-dlp",
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
    ];
    for bin in BINS {
        if Command::new(bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some((bin.to_string(), Vec::new()));
        }
    }
    for py in ["python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"] {
        if Command::new(py)
            .args(["-m", "yt_dlp", "--version"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some((py.to_string(), vec!["-m".into(), "yt_dlp".into()]));
        }
    }
    None
}

fn ytdlp_version(program: &str, base: &[String]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(base).arg("--version");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[tauri::command]
pub(crate) fn get_ytdlp_status() -> YtdlpStatus {
    let ff_dir = ffmpeg_location_dir();
    let ffmpeg_available = ff_dir.is_some() && ffmpeg_bin().is_some();
    match look_for_ytdlp() {
        Some((path, base)) => {
            let version = ytdlp_version(&path, &base);
            let display = if base.is_empty() {
                path.clone()
            } else {
                format!("{path} -m yt_dlp")
            };
            YtdlpStatus {
                available: true,
                path: Some(display),
                version,
                ffmpeg_available,
                hint: if ffmpeg_available {
                    String::new()
                } else {
                    "建议安装 ffmpeg（brew install ffmpeg），并确保同目录有 ffprobe。".into()
                },
            }
        }
        None => YtdlpStatus {
            available: false,
            path: None,
            version: None,
            ffmpeg_available,
            hint: "未找到 yt-dlp。请执行: brew install yt-dlp（或 pip install -U yt-dlp）".into(),
        },
    }
}

fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let before = &line[..idx];
    let num = before
        .rsplit(|c: char| c.is_whitespace() || c == '[')
        .next()?;
    num.trim().parse::<f64>().ok()
}

fn emit_progress(app: &AppHandle, phase: &str, percent: Option<f64>, message: impl Into<String>) {
    let _ = app.emit(
        "url-download-progress",
        UrlDownloadProgress {
            phase: phase.into(),
            percent,
            message: message.into(),
        },
    );
}

fn is_http_url(url: &str) -> bool {
    let u = url.trim();
    if u.len() > 2048 {
        return false;
    }
    (u.starts_with("https://") || u.starts_with("http://"))
        && !u.contains('\n')
        && !u.contains('\r')
        && !u.contains('\0')
}

fn path_under_job(job: &Path, candidate: &Path) -> bool {
    let Ok(job_c) = job.canonicalize() else {
        return false;
    };
    let Ok(cand) = candidate.canonicalize() else {
        return false;
    };
    cand.starts_with(&job_c)
}

#[tauri::command]
pub(crate) fn cancel_url_download() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    if let Ok(guard) = ACTIVE_PID.lock() {
        if let Some(pid) = *guard {
            #[cfg(unix)]
            {
                // Negative PID = process group (set via setsid in child).
                let _ = Command::new("kill")
                    .args(["-TERM", &format!("-{pid}")])
                    .status();
                let _ = Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
        }
    }
    Ok(())
}

fn download_url_media_blocking(
    app: AppHandle,
    url: String,
    mode: String,
) -> Result<UrlDownloadResult, String> {
    let url = url.trim();
    if !is_http_url(url) {
        return Err("请输入有效的 http(s) 链接（最长 2048）".into());
    }
    let mode = mode.trim().to_ascii_lowercase();
    let audio_only = mode == "audio";
    if !audio_only && mode != "video" {
        return Err("mode 须为 audio 或 video".into());
    }
    if ffmpeg_location_dir().is_none() {
        return Err(
            "需要本机 ffmpeg+ffprobe（brew install ffmpeg）才能提取音频或合并视频".into(),
        );
    }

    let (program, base) = look_for_ytdlp().ok_or_else(|| get_ytdlp_status().hint)?;

    let out_dir = downloads_dir()?;
    let job_dir = out_dir.join(format!(
        "job-{}",
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;
    let template = job_dir
        .join("%(title).80B [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();

    emit_progress(&app, "start", Some(0.0), "开始解析…");

    let mut args: Vec<String> = base.clone();
    args.extend([
        "--no-playlist".into(),
        "--newline".into(),
        "-o".into(),
        template,
        "--print".into(),
        "after_move:filepath".into(),
        "--print".into(),
        "filepath".into(),
        "--print".into(),
        "title".into(),
    ]);

    let ff_dir = ffmpeg_location_dir().ok_or_else(|| {
        "找不到 ffmpeg 目录（brew install ffmpeg）".to_string()
    })?;
    args.push("--ffmpeg-location".into());
    args.push(ff_dir.to_string_lossy().to_string());
    crate::elog::elog!(
        "[yt-dlp] --ffmpeg-location {}",
        ff_dir.display()
    );

    if audio_only {
        args.extend([
            "-f".into(),
            "bestaudio/best".into(),
            "-x".into(),
            "--audio-format".into(),
            "m4a".into(),
            "--audio-quality".into(),
            "0".into(),
        ]);
    } else {
        args.extend([
            "-f".into(),
            "bv*[height<=1080]+ba/b".into(),
            "--merge-output-format".into(),
            "mp4".into(),
        ]);
    }
    args.push(url.to_string());

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // GUI apps often lack Homebrew in PATH; keep ffmpeg/ffprobe resolvable.
    if let Ok(mut path_env) = std::env::var("PATH") {
        let prefix = ff_dir.to_string_lossy();
        if !path_env.split(':').any(|p| p == prefix.as_ref()) {
            path_env = format!("{prefix}:{path_env}");
            cmd.env("PATH", path_env);
        }
    } else {
        cmd.env("PATH", ff_dir.as_os_str());
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // Own process group so cancel can kill ffmpeg children too.
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 yt-dlp: {e}"))?;

    if let Ok(mut guard) = ACTIVE_PID.lock() {
        *guard = Some(child.id());
    }

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stdout_buf = Arc::new(Mutex::new(String::new()));

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let app_progress = app.clone();
    let stderr_collect = Arc::clone(&stderr_buf);
    let stderr_thread = std::thread::spawn(move || {
        let Some(stderr) = stderr else { return };
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if CANCEL_FLAG.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(mut g) = stderr_collect.lock() {
                g.push_str(&line);
                g.push('\n');
            }
            if let Some(p) = parse_percent(&line) {
                emit_progress(&app_progress, "download", Some(p), line);
            } else if line.contains("[ExtractAudio]")
                || line.contains("[Merger]")
                || line.contains("[download]")
            {
                emit_progress(&app_progress, "process", None, line);
            }
        }
    });

    let stdout_collect = Arc::clone(&stdout_buf);
    let stdout_thread = std::thread::spawn(move || {
        let Some(stdout) = stdout else { return };
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf);
        if let Ok(mut g) = stdout_collect.lock() {
            *g = buf;
        }
    });

    let status = child.wait().map_err(|e| format!("yt-dlp 等待失败: {e}"))?;
    let _ = stderr_thread.join();
    let _ = stdout_thread.join();
    if let Ok(mut guard) = ACTIVE_PID.lock() {
        *guard = None;
    }

    let stdout_text = stdout_buf.lock().map(|g| g.clone()).unwrap_or_default();
    let stderr_text = stderr_buf.lock().map(|g| g.clone()).unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&job_dir);
        return Err("已取消下载".into());
    }

    if !status.success() {
        let msg = stderr_text
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .or_else(|| stdout_text.lines().rev().find(|l| !l.trim().is_empty()))
            .unwrap_or("yt-dlp 失败（检查链接或更新 yt-dlp）");
        let _ = std::fs::remove_dir_all(&job_dir);
        return Err(format!("下载失败: {msg}"));
    }

    let lines: Vec<&str> = stdout_text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    let mut path_from_print: Option<PathBuf> = None;
    let mut title: Option<String> = None;
    // Prefer last existing path under job_dir; last non-path line may be title.
    for line in lines.iter().rev() {
        let p = PathBuf::from(line);
        if p.exists() && path_under_job(&job_dir, &p) {
            path_from_print = Some(p);
            break;
        }
        if title.is_none() && !line.contains('/') && !Path::new(line).exists() {
            title = Some((*line).to_string());
        }
    }

    let path = path_from_print
        .or_else(|| find_downloaded_file(&job_dir))
        .ok_or_else(|| "下载完成但未找到输出文件".to_string())?;

    if !path_under_job(&job_dir, &path) {
        let _ = std::fs::remove_dir_all(&job_dir);
        return Err("输出路径异常，已拒绝".into());
    }

    // Soft-check audio container when user asked for audio.
    if audio_only {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if crate::audio::is_video_extension(&ext) && ext != "webm" {
            // webm can be audio-only; still label as audio via media_kind.
        }
    }

    let media_kind = if audio_only { "audio" } else { "video" };
    emit_progress(&app, "done", Some(100.0), path.display().to_string());

    Ok(UrlDownloadResult {
        path: path.to_string_lossy().to_string(),
        media_kind: media_kind.into(),
        title,
        job_dir: job_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub(crate) async fn download_url_media(
    app: AppHandle,
    url: String,
    mode: String,
) -> Result<UrlDownloadResult, String> {
    if !DOWNLOAD_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err("已有下载任务进行中".into());
    }
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let result = tauri::async_runtime::spawn_blocking(move || {
        download_url_media_blocking(app, url, mode)
    })
    .await
    .map_err(|e| format!("下载任务失败: {e}"));

    DOWNLOAD_BUSY.store(false, Ordering::SeqCst);
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    match result {
        Ok(inner) => inner,
        Err(e) => Err(e),
    }
}

fn find_downloaded_file(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.ends_with(".part") || name.ends_with(".ytdl") {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "mp4" | "m4a" | "webm" | "mkv" | "wav" | "mp3" | "opus" | "flac" | "mov"
        ) {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            match &best {
                None => best = Some((modified, path)),
                Some((t, _)) if modified >= *t => best = Some((modified, path)),
                _ => {}
            }
        }
    }
    best.map(|(_, p)| p)
}

#[tauri::command]
pub(crate) fn cleanup_download_job(job_dir: String) -> Result<(), String> {
    let path = PathBuf::from(job_dir.trim());
    let root = downloads_dir()?;
    let Ok(canon) = path.canonicalize() else {
        return Ok(());
    };
    let Ok(root_c) = root.canonicalize() else {
        return Ok(());
    };
    if canon.starts_with(&root_c) {
        let _ = std::fs::remove_dir_all(&canon);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percent_basic() {
        assert_eq!(
            parse_percent("[download]  45.2% of 10.00MiB"),
            Some(45.2)
        );
    }

    #[test]
    fn http_url_gate() {
        assert!(is_http_url("https://www.youtube.com/watch?v=x"));
        assert!(!is_http_url("ftp://x"));
        assert!(!is_http_url(&format!("https://{}", "a".repeat(3000))));
        assert!(!is_http_url("https://x\ny"));
    }
}
