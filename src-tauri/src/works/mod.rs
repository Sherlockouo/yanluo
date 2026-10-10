//! Works（作品目录）— one real folder per finished file/URL transcription.
//!
//! The folder is the source of truth (`audio.<ext>`, `transcript.md`, notes…);
//! `work.json` is only an index. All persistent writes follow the atomic
//! snapshot invariant (tempfile in the same dir → write → flush → sync_all →
//! persist), and all I/O happens outside state mutexes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::config::{app_data_dir, AppConfig};
use crate::history::{CharacterAlignment, TranscriptSegment};
use crate::transcription::TranscriptionResult;

pub(crate) mod pipeline;
pub(crate) mod research;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ArtifactState {
    /// "pending" | "running" | "done" | "failed"
    #[serde(default = "default_artifact_status")]
    pub(crate) status: String,
    /// Path relative to the work folder.
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

impl Default for ArtifactState {
    fn default() -> Self {
        Self {
            status: default_artifact_status(),
            path: String::new(),
            updated_at: String::new(),
            error: None,
        }
    }
}

fn default_artifact_status() -> String {
    "pending".into()
}

fn default_source() -> String {
    "file".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Work {
    /// Stable id (`w{millis}`) — independent of the folder name, which may be
    /// renamed together with the title.
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) slug: String,
    pub(crate) created_at: String,
    /// "file" | "url"
    #[serde(default = "default_source")]
    pub(crate) source: String,
    /// "audio" | "video"
    #[serde(default)]
    pub(crate) media_kind: String,
    #[serde(default)]
    pub(crate) duration_seconds: f64,
    #[serde(default)]
    pub(crate) asr_provider: String,
    #[serde(default)]
    pub(crate) language: String,
    /// Media file name inside the work folder (`audio.<ext>`).
    #[serde(default)]
    pub(crate) audio_file: Option<String>,
    /// Back-link to the history entry that spawned this work.
    #[serde(default)]
    pub(crate) history_id: Option<String>,
    /// AI artifacts keyed by kind (summary / minutes / …). Filled by P3.
    #[serde(default)]
    pub(crate) artifacts: HashMap<String, ArtifactState>,
    /// Agent research runs (作品研究), newest first.
    #[serde(default)]
    pub(crate) research: Vec<research::ResearchEntry>,
}

/// Full-fidelity transcript snapshot written to `transcript.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WorkTranscript {
    pub(crate) text: String,
    pub(crate) raw_text: String,
    #[serde(default)]
    pub(crate) llm_text: Option<String>,
    pub(crate) language: String,
    pub(crate) duration_seconds: f64,
    #[serde(default)]
    pub(crate) segments: Vec<TranscriptSegment>,
    #[serde(default)]
    pub(crate) alignment: Option<CharacterAlignment>,
}

impl From<&TranscriptionResult> for WorkTranscript {
    fn from(r: &TranscriptionResult) -> Self {
        Self {
            text: r.text.clone(),
            raw_text: r.raw_text.clone(),
            llm_text: r.llm_text.clone(),
            language: r.language.clone(),
            duration_seconds: r.duration_seconds,
            segments: r.segments.clone(),
            alignment: r.alignment.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, no Tauri)
// ---------------------------------------------------------------------------

/// Slug from a title: CJK + alphanumerics kept, everything else collapses to
/// `-`; ASCII lowercased; capped so the folder name stays portable.
pub(crate) fn sanitize_slug(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let mut capped = String::new();
    for ch in trimmed.chars().take(48) {
        capped.push(ch);
    }
    let capped = capped.trim_end_matches('-');
    if capped.is_empty() {
        "work".into()
    } else {
        capped.to_string()
    }
}

/// `root/name`, `root/name-2`, … — first one that does not exist.
pub(crate) fn unique_child_dir(root: &Path, name: &str) -> PathBuf {
    let candidate = root.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for n in 2..1000u32 {
        let candidate = root.join(format!("{name}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Practically unreachable; fall back to a millis suffix.
    root.join(format!("{name}-{}", chrono::Utc::now().timestamp_millis()))
}

/// Recordings copies are named `{millis}-{stem}.{ext}` — strip the timestamp
/// prefix so the work title seed reads like the original file name.
pub(crate) fn title_seed_from_media(path: &str) -> String {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("work");
    if stem.len() > 14 && stem.as_bytes()[13] == b'-' && stem[..13].chars().all(|c| c.is_ascii_digit()) {
        let rest = stem[14..].trim();
        if !rest.is_empty() {
            return rest.to_string();
        }
    }
    stem.to_string()
}

/// Reject absolute paths and any `..` / root component — artifact reads/writes
/// must stay inside the work folder.
pub(crate) fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("路径不能为空".into());
    }
    let p = Path::new(rel);
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("非法路径: {rel}")),
        }
    }
    Ok(p.to_path_buf())
}

/// `[mm:ss]` anchor cadence for the human-readable transcript.
const ANCHOR_EVERY_SECONDS: f64 = 30.0;

pub(crate) fn format_anchor(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    format!("{:02}:{:02}", total / 60, total % 60)
}

/// Render `transcript.md`: title, meta line, then the text. When segments
/// exist, group them into paragraphs with a `[mm:ss]` anchor roughly every
/// 30s (and at the very start).
pub(crate) fn render_transcript_md(work: &Work, transcript: &WorkTranscript) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", work.title));
    out.push_str(&format!(
        "> {} · {:.1}s · {} · {}\n\n",
        work.created_at, work.duration_seconds, work.language, work.asr_provider
    ));
    if transcript.segments.is_empty() {
        out.push_str(transcript.text.trim());
        out.push('\n');
        return out;
    }
    let mut last_anchor = f64::NEG_INFINITY;
    let mut para = String::new();
    let flush = |out: &mut String, para: &mut String| {
        let p = para.trim();
        if !p.is_empty() {
            out.push_str(p);
            out.push_str("\n\n");
        }
        para.clear();
    };
    for seg in &transcript.segments {
        if seg.start - last_anchor >= ANCHOR_EVERY_SECONDS {
            flush(&mut out, &mut para);
            para.push_str(&format!("[{}] ", format_anchor(seg.start)));
            last_anchor = seg.start;
        }
        para.push_str(seg.text.trim());
    }
    flush(&mut out, &mut para);
    out
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

pub(crate) fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2.min(path.len())..]);
        }
    }
    PathBuf::from(path)
}

/// `config.works_dir` (trimmed, `~` expanded) if set, else `{app}/works`.
/// Creates the directory lazily.
pub(crate) fn works_root(config: &AppConfig) -> Result<PathBuf, String> {
    let root = if config.works_dir.trim().is_empty() {
        app_data_dir().join("works")
    } else {
        expand_tilde(config.works_dir.trim())
    };
    fs::create_dir_all(&root).map_err(|e| format!("创建作品目录失败: {e}"))?;
    Ok(root)
}

/// Atomic compact snapshot write: tempfile in the same dir → write → flush →
/// sync_all → persist (invariant #6).
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("无效路径 {:?}", path))?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(bytes).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
}

/// Folder name derived from the index: `{yyyy-mm-dd}-{slug}`.
pub(crate) fn folder_name(work: &Work) -> String {
    let date: String = work.created_at.chars().take(10).collect();
    format!("{date}-{}", work.slug)
}

fn read_work_in(dir: &Path) -> Option<Work> {
    let path = dir.join("work.json");
    let data = match fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            crate::elog::elog!("[works] read failed {:?}: {e}", path);
            return None;
        }
    };
    match serde_json::from_str(&data) {
        Ok(w) => Some(w),
        Err(e) => {
            crate::elog::elog!("[works] parse failed {:?}: {e}", path);
            None
        }
    }
}

/// Newest first (created_at desc, RFC3339 sorts lexicographically).
pub(crate) fn list_works(config: &AppConfig) -> Result<Vec<Work>, String> {
    let root = works_root(config)?;
    let mut works = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("读取作品目录失败: {e}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if let Some(work) = read_work_in(&dir) {
            works.push(work);
        }
    }
    works.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(works)
}

/// Resolve a work id to (folder, index) by scanning the root.
pub(crate) fn resolve_work_dir(config: &AppConfig, id: &str) -> Result<(PathBuf, Work), String> {
    let id = id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("无效的作品 id".into());
    }
    let root = works_root(config)?;
    let entries = fs::read_dir(&root).map_err(|e| format!("读取作品目录失败: {e}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if let Some(work) = read_work_in(&dir) {
            if work.id == id {
                return Ok((dir, work));
            }
        }
    }
    Err("作品不存在".into())
}

pub(crate) fn get_work(config: &AppConfig, id: &str) -> Result<Work, String> {
    Ok(resolve_work_dir(config, id)?.1)
}

/// Create a work folder from a finished transcription: copy the source media
/// as `audio.<ext>` (the recordings/ original is kept), then write
/// `transcript.json`, `transcript.md`, and the `work.json` index.
pub(crate) fn create_work(
    config: &AppConfig,
    result: &TranscriptionResult,
    source_media: Option<&str>,
    source: &str,
    media_kind: &str,
    history_id: Option<String>,
) -> Result<Work, String> {
    let root = works_root(config)?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let seed = source_media
        .map(title_seed_from_media)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未命名作品".into());
    let slug = sanitize_slug(&seed);
    let dir = unique_child_dir(&root, &format!("{date}-{slug}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建作品文件夹失败: {e}"))?;

    let mut audio_file = None;
    if let Some(src_str) = source_media {
        let src = Path::new(src_str);
        if src.is_file() {
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("wav")
                .to_ascii_lowercase();
            let name = format!("audio.{ext}");
            match fs::copy(src, dir.join(&name)) {
                Ok(_) => audio_file = Some(name),
                Err(e) => crate::elog::elog!("[works] copy media {:?} failed: {e}", src),
            }
        }
    }

    let work = Work {
        id: format!("w{}", chrono::Utc::now().timestamp_millis()),
        title: seed,
        slug,
        created_at,
        source: if source == "url" { "url".into() } else { "file".into() },
        media_kind: media_kind.to_string(),
        duration_seconds: result.duration_seconds,
        asr_provider: config.asr_provider.label().to_string(),
        language: result.language.clone(),
        audio_file,
        history_id,
        artifacts: HashMap::new(),
        research: Vec::new(),
    };
    let transcript = WorkTranscript::from(result);
    write_json(&dir.join("transcript.json"), &transcript)?;
    atomic_write(
        &dir.join("transcript.md"),
        render_transcript_md(&work, &transcript).as_bytes(),
    )?;
    write_json(&dir.join("work.json"), &work)?;
    Ok(work)
}

/// Rename the title. The folder is only renamed while it still carries the
/// auto-generated `{date}-{slug}` name — a user-renamed folder is left alone.
pub(crate) fn rename_work(config: &AppConfig, id: &str, new_title: &str) -> Result<Work, String> {
    let title = new_title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    let (dir, mut work) = resolve_work_dir(config, id)?;
    let root = works_root(config)?;
    // Auto-generated folder name for the slug currently stored on disk.
    let old_auto = folder_name(&work);
    work.title = title.to_string();
    work.slug = sanitize_slug(title);
    let mut target_dir = dir.clone();
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if dir_name == old_auto {
        let new_name = folder_name(&work);
        if new_name != dir_name {
            let target = unique_child_dir(&root, &new_name);
            fs::rename(&dir, &target).map_err(|e| format!("重命名作品文件夹失败: {e}"))?;
            target_dir = target;
        }
    }
    write_json(&target_dir.join("work.json"), &work)?;
    Ok(work)
}

pub(crate) fn delete_work(config: &AppConfig, id: &str) -> Result<(), String> {
    let (dir, _work) = resolve_work_dir(config, id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("删除作品失败: {e}"))?;
    Ok(())
}

pub(crate) fn read_artifact(config: &AppConfig, id: &str, rel_path: &str) -> Result<String, String> {
    let (dir, _work) = resolve_work_dir(config, id)?;
    let rel = safe_rel_path(rel_path)?;
    let path = dir.join(rel);
    fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}

pub(crate) fn write_artifact(
    config: &AppConfig,
    id: &str,
    rel_path: &str,
    content: &str,
) -> Result<(), String> {
    let (dir, _work) = resolve_work_dir(config, id)?;
    let rel = safe_rel_path(rel_path)?;
    atomic_write(&dir.join(rel), content.as_bytes())
}

/// Update one artifact's state in the work.json index (atomic write).
pub(crate) fn set_artifact_state(
    config: &AppConfig,
    id: &str,
    kind: &str,
    state: ArtifactState,
) -> Result<Work, String> {
    let (dir, mut work) = resolve_work_dir(config, id)?;
    work.artifacts.insert(kind.to_string(), state);
    write_json(&dir.join("work.json"), &work)?;
    Ok(work)
}

/// Drop an artifact entry entirely — cancel before any output returns the tab
/// to "not generated".
pub(crate) fn clear_artifact_state(config: &AppConfig, id: &str, kind: &str) -> Result<(), String> {
    let (dir, mut work) = resolve_work_dir(config, id)?;
    work.artifacts.remove(kind);
    write_json(&dir.join("work.json"), &work)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_cjk_and_collapses_separators() {
        assert_eq!(sanitize_slug("Hello World"), "hello-world");
        assert_eq!(sanitize_slug("产品发布会 复盘！！"), "产品发布会-复盘");
        assert_eq!(sanitize_slug("  -- weird__name -- "), "weird-name");
        assert_eq!(sanitize_slug("!!!"), "work");
        assert_eq!(sanitize_slug(""), "work");
        assert!(sanitize_slug(&"很长的标题".repeat(40)).chars().count() <= 48);
    }

    #[test]
    fn unique_child_dir_appends_suffix_on_collision() {
        let root = tempfile::tempdir().unwrap();
        let first = unique_child_dir(root.path(), "2026-10-10-demo");
        assert_eq!(first.file_name().unwrap(), "2026-10-10-demo");
        fs::create_dir_all(&first).unwrap();
        let second = unique_child_dir(root.path(), "2026-10-10-demo");
        assert_eq!(second.file_name().unwrap(), "2026-10-10-demo-2");
        fs::create_dir_all(&second).unwrap();
        let third = unique_child_dir(root.path(), "2026-10-10-demo");
        assert_eq!(third.file_name().unwrap(), "2026-10-10-demo-3");
    }

    #[test]
    fn safe_rel_path_rejects_escape() {
        assert!(safe_rel_path("notes/summary.md").is_ok());
        assert!(safe_rel_path("transcript.md").is_ok());
        assert!(safe_rel_path("../escape.md").is_err());
        assert!(safe_rel_path("a/../../b").is_err());
        assert!(safe_rel_path("/abs/path.md").is_err());
        assert!(safe_rel_path("").is_err());
        assert!(safe_rel_path("./dot.md").is_err());
    }

    #[test]
    fn title_seed_strips_recordings_timestamp_prefix() {
        assert_eq!(
            title_seed_from_media("/data/recordings/1759996800000-产品发布会.m4a"),
            "产品发布会"
        );
        assert_eq!(title_seed_from_media("/data/recordings/demo.wav"), "demo");
        assert_eq!(title_seed_from_media("demo.wav"), "demo");
    }

    #[test]
    fn markdown_groups_segments_with_anchors() {
        let work = Work {
            id: "w1".into(),
            title: "测试".into(),
            slug: "测试".into(),
            created_at: "2026-10-10T12:00:00Z".into(),
            source: "file".into(),
            media_kind: "audio".into(),
            duration_seconds: 90.0,
            asr_provider: "qwen".into(),
            language: "zh".into(),
            audio_file: None,
            history_id: None,
            artifacts: HashMap::new(),
            research: Vec::new(),
        };
        let transcript = WorkTranscript {
            text: "你好世界再见".into(),
            raw_text: "你好世界再见".into(),
            llm_text: None,
            language: "zh".into(),
            duration_seconds: 90.0,
            segments: vec![
                TranscriptSegment { text: "你好".into(), start: 0.0, end: 1.0, speaker: None },
                TranscriptSegment { text: "世界".into(), start: 10.0, end: 11.0, speaker: None },
                TranscriptSegment { text: "再见".into(), start: 45.0, end: 46.0, speaker: None },
            ],
            alignment: None,
        };
        let md = render_transcript_md(&work, &transcript);
        assert!(md.starts_with("# 测试\n"));
        assert!(md.contains("[00:00] 你好世界"));
        assert!(md.contains("[00:45] 再见"));
    }

    #[test]
    fn markdown_without_segments_is_plain_text() {
        let work = Work {
            id: "w1".into(),
            title: "t".into(),
            slug: "t".into(),
            created_at: "2026-10-10T12:00:00Z".into(),
            source: "file".into(),
            media_kind: "audio".into(),
            duration_seconds: 1.0,
            asr_provider: "apple".into(),
            language: "en".into(),
            audio_file: None,
            history_id: None,
            artifacts: HashMap::new(),
            research: Vec::new(),
        };
        let transcript = WorkTranscript {
            text: "plain text".into(),
            raw_text: "plain text".into(),
            llm_text: None,
            language: "en".into(),
            duration_seconds: 1.0,
            segments: Vec::new(),
            alignment: None,
        };
        let md = render_transcript_md(&work, &transcript);
        assert!(md.trim_end().ends_with("plain text"));
        assert!(!md.contains("[00:00]"));
    }
}
