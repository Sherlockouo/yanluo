use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use crate::config::*;

pub(crate) fn save_recording_wav(samples: &[f32], id: &str) -> Result<PathBuf, String> {
    let dir = recordings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.wav"));
    let bytes = samples_to_wav_bytes(samples)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

pub(crate) fn samples_to_wav_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            writer
                .write_sample((clamped * i16::MAX as f32) as i16)
                .map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

pub(crate) const MEDIA_DECODE_HINT: &str = "无法解码媒体。支持常见音频（WAV/MP3/M4A/FLAC/OGG/Opus 等）与视频（MP4/MOV/MKV/WebM 等）；也可先转为 16kHz WAV。视频与部分格式需本机安装 ffmpeg。";

fn ffmpeg_works(bin: &str) -> bool {
    Command::new(bin)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Absolute path to ffmpeg when possible (Tauri GUI apps often lack Homebrew in PATH).
pub(crate) fn ffmpeg_bin() -> Option<&'static str> {
    // Prefer absolute paths: `Command::new("ffmpeg")` may succeed in shell
    // but `Path::new("ffmpeg").parent()` is useless for yt-dlp `--ffmpeg-location`.
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ];
    for candidate in CANDIDATES {
        if ffmpeg_works(candidate) {
            return Some(*candidate);
        }
    }
    None
}

/// Directory containing ffmpeg + ffprobe for yt-dlp `--ffmpeg-location`.
pub(crate) fn ffmpeg_location_dir() -> Option<PathBuf> {
    let ff = ffmpeg_bin()?;
    let path = if Path::new(ff).is_absolute() {
        PathBuf::from(ff)
    } else {
        // Resolve via `which` so we never pass a bare name to yt-dlp.
        let out = Command::new("which")
            .arg("ffmpeg")
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return None;
        }
        PathBuf::from(s)
    };
    let dir = path.parent()?.to_path_buf();
    let probe = dir.join("ffprobe");
    if !probe.is_file() && !ffmpeg_works(probe.to_str()?) {
        // Still return dir — some installs name-only work via PATH inside that dir.
        eprintln!(
            "[ffmpeg] ffprobe missing next to {} — yt-dlp may fail postprocess",
            path.display()
        );
    }
    Some(dir)
}

pub(crate) fn convert_media_to_wav_16k(src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.to_str().ok_or("invalid media path")?;
    let dest_s = dest.to_str().ok_or("invalid output path")?;

    let af_ok = Command::new("/usr/bin/afconvert")
        .args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src_s, dest_s])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if af_ok && dest.exists() {
        return Ok(());
    }
    let _ = fs::remove_file(dest);

    let Some(ffmpeg) = ffmpeg_bin() else {
        return Err(MEDIA_DECODE_HINT.into());
    };
    let ff_ok = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            src_s,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            dest_s,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ff_ok && dest.exists() {
        return Ok(());
    }
    let _ = fs::remove_file(dest);
    Err(MEDIA_DECODE_HINT.into())
}

/// Load audio as 16 kHz mono f32.
/// WAV is read directly; other audio/video goes through afconvert, then ffmpeg.
pub(crate) fn load_audio_samples_16k(path: &Path) -> Result<Vec<f32>, String> {
    if let Ok(samples) = read_wav_as_f32_mono_16k(path) {
        return Ok(samples);
    }
    let dir = recordings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let converted = dir.join(format!(
        "convert-{}.wav",
        chrono::Utc::now().timestamp_millis()
    ));
    convert_media_to_wav_16k(path, &converted)?;
    let samples = read_wav_as_f32_mono_16k(&converted);
    let _ = fs::remove_file(&converted);
    samples
}

pub(crate) fn is_video_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "mpeg" | "mpg" | "3gp" | "3g2"
    )
}

/// Copy source into recordings for playback. Videos keep their original
/// container so the UI can play `<video>`; ASR still decodes via afconvert/ffmpeg.
/// `kind_override`: when `Some("audio"|"video")`, prefer that over extension guess.
pub(crate) fn persist_media_for_playback(
    src: &Path,
    kind_override: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match kind_override.map(|s| s.trim().to_ascii_lowercase()) {
        Some(ref k) if k == "audio" || k == "video" => k.clone(),
        _ => {
            if is_video_extension(&ext) {
                "video".into()
            } else {
                "audio".into()
            }
        }
    };
    let path = copy_into_recordings(src)?;
    Ok((path, kind))
}

/// Expand word/char segments into ElevenLabs CharacterAlignmentResponseModel.
pub(crate) fn read_wav_as_f32_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let rate = spec.sample_rate;

    let mono: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample.max(1) as f32;
            let max = (2f32.powi(bits as i32 - 1) - 1.0).max(1.0);
            let raw: Vec<i32> = reader
                .samples::<i32>()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            raw.chunks(channels)
                .map(|frame| {
                    let sum: f32 = frame.iter().map(|s| *s as f32 / max).sum();
                    sum / channels as f32
                })
                .collect()
        }
        hound::SampleFormat::Float => {
            let raw: Vec<f32> = reader
                .samples::<f32>()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            raw.chunks(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                .collect()
        }
    };

    if rate == 16_000 {
        return Ok(mono);
    }
    // Linear resample to 16 kHz.
    let ratio = rate as f64 / 16_000.0;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    Ok(out)
}

pub(crate) fn copy_into_recordings(src: &Path) -> Result<PathBuf, String> {
    let dir = recordings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav");
    let dest = dir.join(format!(
        "{}-{}.{}",
        chrono::Utc::now().timestamp_millis(),
        src.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio")
            .chars()
            .take(40)
            .collect::<String>(),
        ext
    ));
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}
