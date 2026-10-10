//! Works AI artifact pipeline (作品 AI 内容管线): transcript → summary /
//! minutes / study notes / platform copy.
//!
//! Base text comes from a long-form refine of `transcript.json`, cached as
//! `notes/_refined.md` (with a source-hash marker on line 1); artifacts land
//! in `notes/<kind>.md`. The verbatim transcript stays untouched — notes are
//! derived from the refined copy. Generation runs on a spawned thread, never
//! on the command path; every state transition updates `work.json` and emits
//! `work-artifact-progress` (invariant #11 — failures are recorded, not
//! swallowed).

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use super::{
    atomic_write, clear_artifact_state, folder_name, resolve_work_dir, set_artifact_state,
    ArtifactState, Work, WorkTranscript,
};
use crate::config::AppConfig;
use crate::state::AsrEngine;
use crate::transcription::{
    refine_transcript_with_cases_abortable, run_llm_transform, split_for_refine,
};

pub(crate) const KIND_SUMMARY: &str = "summary";
pub(crate) const KIND_MINUTES: &str = "minutes";
pub(crate) const KIND_STUDY_NOTES: &str = "study_notes";
pub(crate) const KIND_POST_XIAOHONGSHU: &str = "post_xiaohongshu";
pub(crate) const KIND_SCRIPT_DOUYIN: &str = "script_douyin";
pub(crate) const KIND_ARTICLE_WECHAT: &str = "article_wechat";

/// Above this, map-reduce: chunk → per-chunk summary → generate from the
/// combined summaries instead of the full text (context guard).
const MAP_REDUCE_THRESHOLD: usize = 12_000;
const MAP_CHUNK_LIMIT: usize = 6_000;
/// Title proposal sees only the head of the transcript.
const TITLE_INPUT_LIMIT: usize = 2_000;

// ---------------------------------------------------------------------------
// Built-in prompts — MUST stay byte-identical to the frontend mirrors in
// src/lib/constants.ts (guarded by `prompt_sync_tests` below).
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_WORK_PROMPT_SUMMARY: &str = "\
你是中文内容摘要助手。输入是一段转写文本（可能来自播客、视频或会议）。\n\
\n\
输出格式：\n\
1. 先用一段话（100 字以内）总结全文核心内容。\n\
2. 然后列出 5 个要点，每点一行，以「- 」开头。\n\
\n\
规则：\n\
1. 只基于原文信息，不添加原文没有的观点、数字或结论。\n\
2. 保留关键人名、数字、结论和术语的原始写法。\n\
3. 只输出正文，不解释、不添加“摘要”等标题。";

pub(crate) const DEFAULT_WORK_PROMPT_MINUTES: &str = "\
你是中文会议纪要助手。输入是一段会议或讨论转写文本。\n\
\n\
按以下结构输出 Markdown：\n\
## 议题\n（讨论了什么，逐条列出）\n\
## 结论\n（达成了什么共识）\n\
## 决议\n（明确拍板的事项）\n\
## 行动项\n（每条包含：事项、负责人、截止时间——仅当原文提到时才写负责人和截止时间，没提到就不写，不虚构）\n\
## 悬而未决\n（讨论了但没有结论的问题；没有则写「无」）\n\
\n\
规则：\n\
1. 只基于原文，不虚构发言人、负责人或时间。\n\
2. 逐字稿没有说话人分离时，不写发言人姓名。\n\
3. 只输出纪要正文，不解释、不添加额外标题。";

pub(crate) const DEFAULT_WORK_PROMPT_STUDY_NOTES: &str = "\
你是中文学习笔记助手。输入是一段转写文本（可能带 [mm:ss] 时间戳前缀）。\n\
\n\
输出 Markdown 结构化笔记：\n\
1. 用分级标题（## / ###）组织内容层次，标题概括主题。\n\
2. 每个主题下用列表记要点。\n\
3. 末尾设「金句摘录」一节，摘录原文中有代表性的句子。\n\
\n\
规则：\n\
1. 只基于原文，不添加原文没有的知识点。\n\
2. 保留术语、数字、名称的原始写法。\n\
3. 只输出笔记正文，不解释。";

pub(crate) const DEFAULT_WORK_PROMPT_POST_XIAOHONGSHU: &str = "\
你是小红书文案写手。根据输入的转写内容写一篇小红书笔记。\n\
\n\
风格：\n\
1. 第一行是吸睛标题，含 1-2 个 emoji，不超过 20 字。\n\
2. 正文用短段落，每段 1-3 句，口语化、有真实感，适当穿插 emoji。\n\
3. 结尾加 3-6 个相关 tag，格式为 #话题。\n\
\n\
规则：\n\
1. 内容必须忠于原文，不编造事实、数字或功效。\n\
2. 只输出文案正文，不解释、不添加“文案”等标注。";

pub(crate) const DEFAULT_WORK_PROMPT_SCRIPT_DOUYIN: &str = "\
你是抖音口播脚本写手。根据输入的转写内容写一条 60 秒口播脚本（约 250-300 字）。\n\
\n\
结构：\n\
1. 开头 3 秒钩子：用疑问、反常识或利益点抓住注意力。\n\
2. 主体：把原文核心内容讲清楚，口语化，短句为主。\n\
3. 结尾 CTA：引导点赞、关注或评论。\n\
\n\
规则：\n\
1. 内容忠于原文，不编造事实或数据。\n\
2. 只输出可直接照读的口播正文，不写镜头说明、不解释。";

pub(crate) const DEFAULT_WORK_PROMPT_ARTICLE_WECHAT: &str = "\
你是公众号长文作者。根据输入的转写内容写一篇公众号文章。\n\
\n\
要求：\n\
1. 有清晰的标题（第一行，# 开头）和小标题分段（## 开头）。\n\
2. 观点明确，论述完整，保留原文的事实、案例、数字和金句。\n\
3. 语言流畅书面化，但保留原作者的表达风格。\n\
4. 只基于原文内容展开，不编造原文没有的事实。\n\
5. 只输出文章正文，不解释。";

/// Map step of map-reduce: compress one chunk, keep everything citable.
pub(crate) const DEFAULT_WORK_MAP_SUMMARY: &str = "\
你是中文内容压缩助手。把输入的转写片段压缩成要点列表，供后续二次生成使用。\n\
\n\
规则：\n\
1. 保留全部关键信息：观点、结论、数字、人名、术语、金句原句。\n\
2. 丢弃口水话、重复和纯过渡内容。\n\
3. 输出为「- 」开头的要点列表，不解释、不加标题。";

/// LLM titling: one short title line for the work.
pub(crate) const DEFAULT_WORK_TITLE: &str = "\
你是标题助手。根据输入内容为这段音/视频转写拟一个标题。\n\
\n\
规则：\n\
1. 不超过 20 个字，概括主题，不用书名号、引号或标点结尾。\n\
2. 只输出标题本身，一行，不解释。";

/// Extra rule appended when the input carries [mm:ss] anchors; None for kinds
/// that never cite moments (platform copy).
fn timestamp_rule(kind: &str) -> Option<&'static str> {
    match kind {
        KIND_STUDY_NOTES => Some(
            "\n4. 输入带 [mm:ss] 时间戳：金句摘录必须附上对应时间戳引用，格式 ([mm:ss])。",
        ),
        KIND_SUMMARY | KIND_MINUTES => Some(
            "\n4. 输入带 [mm:ss] 时间戳：每个要点或议题后附上对应时间戳，格式 ([mm:ss])，便于回看原音频。",
        ),
        _ => None,
    }
}

/// kind → `notes/<kind>.md`; None for unknown kinds (validated at entry).
pub(crate) fn artifact_rel_path(kind: &str) -> Option<String> {
    match kind {
        KIND_SUMMARY | KIND_MINUTES | KIND_STUDY_NOTES | KIND_POST_XIAOHONGSHU
        | KIND_SCRIPT_DOUYIN | KIND_ARTICLE_WECHAT => Some(format!("notes/{kind}.md")),
        _ => None,
    }
}

pub(crate) fn default_prompt(kind: &str) -> Option<&'static str> {
    match kind {
        KIND_SUMMARY => Some(DEFAULT_WORK_PROMPT_SUMMARY),
        KIND_MINUTES => Some(DEFAULT_WORK_PROMPT_MINUTES),
        KIND_STUDY_NOTES => Some(DEFAULT_WORK_PROMPT_STUDY_NOTES),
        KIND_POST_XIAOHONGSHU => Some(DEFAULT_WORK_PROMPT_POST_XIAOHONGSHU),
        KIND_SCRIPT_DOUYIN => Some(DEFAULT_WORK_PROMPT_SCRIPT_DOUYIN),
        KIND_ARTICLE_WECHAT => Some(DEFAULT_WORK_PROMPT_ARTICLE_WECHAT),
        _ => None,
    }
}

/// Effective prompt: user override (`works_prompts`) wins when non-empty.
pub(crate) fn prompt_for(config: &AppConfig, kind: &str) -> Result<String, String> {
    if let Some(custom) = config.works_prompts.get(kind) {
        if !custom.trim().is_empty() {
            return Ok(custom.trim().to_string());
        }
    }
    default_prompt(kind)
        .map(str::to_string)
        .ok_or_else(|| format!("未知的产物类型: {kind}"))
}

fn needs_map_reduce(text: &str) -> bool {
    text.chars().count() > MAP_REDUCE_THRESHOLD
}

/// Source-hash marker cached on line 1 of `notes/_refined.md`.
fn refined_marker(source_hash: u64) -> String {
    format!("<!-- yanluo:src={source_hash:016x} -->")
}

fn parse_refined_marker(content: &str) -> Option<u64> {
    let line = content.lines().next()?;
    let hex = line
        .strip_prefix("<!-- yanluo:src=")?
        .strip_suffix(" -->")?;
    u64::from_str_radix(hex, 16).ok()
}

/// FNV-1a 64 — no new dependency for a cache-freshness hash.
pub(crate) fn fnv1a64(text: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Segments → `[mm:ss] text` lines so the model can cite timestamps.
/// Falls back to plain text when no segments exist.
pub(crate) fn timestamped_input(transcript: &WorkTranscript) -> String {
    if transcript.segments.is_empty() {
        return transcript.text.clone();
    }
    let mut out = String::new();
    for seg in &transcript.segments {
        out.push_str(&format!(
            "[{}] {}\n",
            super::format_anchor(seg.start),
            seg.text.trim()
        ));
    }
    out
}

/// Clean an LLM title proposal: first line, no quotes/book-title marks,
/// capped at 20 chars. Empty after cleaning → None (keep old title).
pub(crate) fn clean_generated_title(raw: &str) -> Option<String> {
    let line = raw.lines().next().unwrap_or("").trim();
    let cleaned: String = line
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’' | '《' | '》' | '#'))
        .collect::<String>()
        .trim()
        .trim_end_matches(['。', '.', '！', '!', '？', '?', '：', ':'])
        .chars()
        .take(20)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Auto-rename is only allowed while the folder still carries the
/// auto-generated `{date}-{slug}` name.
pub(crate) fn title_is_default(work: &Work, dir: &std::path::Path) -> bool {
    dir.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == folder_name(work))
        .unwrap_or(false)
}

/// Resolve the LLM stage config for the pipeline: `works_llm_provider` empty
/// → main flat `llm_*` fields; otherwise mirror the organize-stage creds
/// lookup from `llm_credentials`.
fn stage_config(config: &AppConfig) -> Result<AppConfig, String> {
    let mut stage = config.clone();
    let provider = config.works_llm_provider.trim();
    if !provider.is_empty() && provider != config.llm_provider {
        let creds = config
            .llm_credentials
            .get(provider)
            .ok_or_else(|| format!("作品生成服务商 {provider} 尚未配置"))?;
        stage.llm_api_base_url = creds.api_base_url.clone();
        stage.llm_api_key = creds.api_key.clone();
        stage.llm_model = creds.model.clone();
    }
    if stage.llm_api_base_url.trim().is_empty() {
        return Err("未配置作品生成的 API Base URL".into());
    }
    if stage.llm_model.trim().is_empty() {
        return Err("未配置作品生成的 Model".into());
    }
    Ok(stage)
}

#[derive(Clone, Serialize)]
struct WorkArtifactProgress {
    work_id: String,
    kind: String,
    status: String,
}

fn emit_progress(app: &AppHandle, work_id: &str, kind: &str, status: &str) {
    let _ = app.emit(
        "work-artifact-progress",
        WorkArtifactProgress {
            work_id: work_id.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
        },
    );
}

fn flag_key(work_id: &str, kind: &str) -> String {
    format!("{work_id}:{kind}")
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn artifact_running() -> ArtifactState {
    ArtifactState {
        status: "running".into(),
        ..Default::default()
    }
}

/// Register a cancel flag for `{work_id}:{kind}`; rejects duplicates while a
/// non-aborted run is in flight (mirrors the agent cancel-flag pattern).
fn register_flag(engine: &AsrEngine, key: &str) -> Result<Arc<AtomicBool>, String> {
    let mut map = engine
        .work_artifact_flags
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(existing) = map.get(key) {
        if !existing.load(Ordering::Acquire) {
            return Err("该产物正在生成中".into());
        }
    }
    let flag = Arc::new(AtomicBool::new(false));
    map.insert(key.to_string(), Arc::clone(&flag));
    Ok(flag)
}

/// Remove the flag only if it is still ours (a re-run may have replaced it).
fn unregister_flag(engine: &AsrEngine, key: &str, flag: &Arc<AtomicBool>) {
    if let Ok(mut map) = engine.work_artifact_flags.lock() {
        if map.get(key).map(|f| Arc::ptr_eq(f, flag)).unwrap_or(false) {
            map.remove(key);
        }
    }
}

/// Request cancellation of an in-flight generation. No-op when not running.
pub(crate) fn cancel_artifact(app: &AppHandle, work_id: &str, kind: &str) -> Result<(), String> {
    if artifact_rel_path(kind).is_none() {
        return Err(format!("未知的产物类型: {kind}"));
    }
    let engine = app.state::<AsrEngine>();
    let key = flag_key(work_id, kind);
    if let Ok(map) = engine.inner().work_artifact_flags.lock() {
        if let Some(flag) = map.get(&key) {
            flag.store(true, Ordering::Release);
        }
    }
    Ok(())
}

/// Start artifact generation on a background thread. Validates kind, resolves
/// the work, flips the artifact to `running`, and returns immediately; the
/// outcome arrives via `work-artifact-progress` + `works-updated`.
pub(crate) fn generate_artifact(app: &AppHandle, work_id: &str, kind: &str) -> Result<(), String> {
    let rel_path = artifact_rel_path(kind).ok_or_else(|| format!("未知的产物类型: {kind}"))?;
    let engine = app.state::<AsrEngine>();
    let config = engine
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .map_err(|e| e.to_string())?;
    // Fail fast before flipping state.
    let (_dir, _work) = resolve_work_dir(&config, work_id)?;
    let key = flag_key(work_id, kind);
    let flag = register_flag(engine.inner(), &key)?;

    set_artifact_state(&config, work_id, kind, artifact_running())?;
    emit_progress(app, work_id, kind, "running");

    let app_t = app.clone();
    let work_id = work_id.to_string();
    let kind = kind.to_string();
    std::thread::Builder::new()
        .name(format!("works-pipeline-{kind}"))
        .spawn(move || {
            run_generation(&app_t, &config, &work_id, &kind, &rel_path, &flag);
            let engine = app_t.state::<AsrEngine>();
            unregister_flag(engine.inner(), &key, &flag);
        })
        .map_err(|e| format!("启动生成线程失败: {e}"))?;
    Ok(())
}

/// Load `notes/_refined.md` when its source-hash marker matches the current
/// transcript; otherwise refine the full transcript (long-form, chunked) and
/// cache it. Without a configured LLM the raw text is the base (logged).
fn refined_base_text(
    dir: &std::path::Path,
    stage: &AppConfig,
    transcript: &WorkTranscript,
    should_abort: &mut impl FnMut() -> bool,
) -> Result<String, String> {
    let hash = fnv1a64(&transcript.text);
    let cache = dir.join("notes/_refined.md");
    if let Ok(cached) = std::fs::read_to_string(&cache) {
        if parse_refined_marker(&cached) == Some(hash) {
            let body = cached.lines().skip(1).collect::<Vec<_>>().join("\n");
            if !body.trim().is_empty() {
                return Ok(body);
            }
        }
    }
    if !stage.llm_enabled {
        crate::elog::elog!("[works] LLM 未启用 — 用原始逐字稿作为生成底稿");
        return Ok(transcript.text.clone());
    }
    match refine_transcript_with_cases_abortable(stage, &transcript.text, &[], should_abort) {
        Ok(refined) => {
            let content = format!("{}\n\n{}", refined_marker(hash), refined);
            if let Err(e) = atomic_write(&cache, content.as_bytes()) {
                crate::elog::elog!("[works] cache _refined.md failed: {e}");
            }
            Ok(refined)
        }
        Err(e) if e == "aborted" => Err(e),
        Err(e) => {
            crate::elog::elog!("[works] base refine failed ({e}) — falling back to raw text");
            Ok(transcript.text.clone())
        }
    }
}

/// Map-reduce for long inputs: chunk summaries joined, else the text as-is.
fn condense_input(
    stage: &AppConfig,
    text: &str,
    should_abort: &mut impl FnMut() -> bool,
) -> Result<String, String> {
    if !needs_map_reduce(text) {
        return Ok(text.to_string());
    }
    let chunks = split_for_refine(text, MAP_CHUNK_LIMIT);
    crate::elog::elog!(
        "[works] map-reduce: {} chars → {} chunk summaries",
        text.chars().count(),
        chunks.len()
    );
    let mut summaries = Vec::with_capacity(chunks.len());
    for chunk in &chunks {
        if should_abort() {
            return Err("aborted".into());
        }
        let summary = run_llm_transform(
            stage,
            chunk,
            DEFAULT_WORK_MAP_SUMMARY.to_string(),
            "works-map",
            false,
            should_abort,
        )?;
        summaries.push(summary);
    }
    Ok(summaries.join("\n\n"))
}

fn run_generation(
    app: &AppHandle,
    config: &AppConfig,
    work_id: &str,
    kind: &str,
    rel_path: &str,
    flag: &Arc<AtomicBool>,
) {
    let result = run_generation_inner(app, config, work_id, kind, rel_path, flag);
    match result {
        Ok(()) => {
            emit_progress(app, work_id, kind, "done");
            let _ = app.emit("works-updated", ());
        }
        Err(e) if e == "aborted" => {
            crate::elog::elog!("[works] {kind} cancelled for {work_id}");
            // Back to "not generated" so the tab shows 生成 again.
            if let Err(e) = clear_artifact_state(config, work_id, kind) {
                crate::elog::elog!("[works] clear cancelled artifact failed: {e}");
            }
            emit_progress(app, work_id, kind, "cancelled");
            let _ = app.emit("works-updated", ());
        }
        Err(e) => {
            crate::elog::elog!("[works] {kind} failed for {work_id}: {e}");
            let state = ArtifactState {
                status: "failed".into(),
                path: rel_path.to_string(),
                updated_at: now_rfc3339(),
                error: Some(e),
            };
            if let Err(e) = set_artifact_state(config, work_id, kind, state) {
                crate::elog::elog!("[works] persist failed state failed: {e}");
            }
            emit_progress(app, work_id, kind, "failed");
            let _ = app.emit("works-updated", ());
        }
    }
}

fn run_generation_inner(
    app: &AppHandle,
    config: &AppConfig,
    work_id: &str,
    kind: &str,
    rel_path: &str,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut should_abort = || flag.load(Ordering::Acquire);
    let (dir, work) = resolve_work_dir(config, work_id)?;
    let stage = stage_config(config)?;

    let transcript_raw = std::fs::read_to_string(dir.join("transcript.json"))
        .map_err(|e| format!("读取逐字稿失败: {e}"))?;
    let transcript: WorkTranscript =
        serde_json::from_str(&transcript_raw).map_err(|e| format!("解析逐字稿失败: {e}"))?;
    if transcript.text.trim().is_empty() {
        return Err("逐字稿为空".into());
    }
    if should_abort() {
        return Err("aborted".into());
    }

    let base = refined_base_text(&dir, &stage, &transcript, &mut should_abort)?;

    // Kinds that cite moments (summary / minutes / study notes) get timestamped
    // lines when short enough to skip map-reduce, so the model can anchor
    // claims to [mm:ss]; other kinds use the plain refined base.
    let mut prompt = prompt_for(config, kind)?;
    let input = match timestamp_rule(kind) {
        Some(rule) if !transcript.segments.is_empty() => {
            let stamped = timestamped_input(&transcript);
            if !needs_map_reduce(&stamped) {
                prompt.push_str(rule);
                stamped
            } else {
                condense_input(&stage, &base, &mut should_abort)?
            }
        }
        _ => condense_input(&stage, &base, &mut should_abort)?,
    };

    let output = run_llm_transform(&stage, &input, prompt, kind, false, &mut should_abort)?;
    if should_abort() {
        return Err("aborted".into());
    }

    atomic_write(&dir.join(rel_path), output.as_bytes())?;
    let state = ArtifactState {
        status: "done".into(),
        path: rel_path.to_string(),
        updated_at: now_rfc3339(),
        error: None,
    };
    set_artifact_state(config, work_id, kind, state)?;

    // LLM titling after the FIRST successful artifact, while the title is
    // still the default file-stem one (folder keeps the auto slug).
    if title_is_default(&work, &dir) && work.artifacts.is_empty() {
        maybe_retitle(app, config, &stage, work_id, &base, flag);
    }
    Ok(())
}

/// Best-effort LLM title proposal + rename. Any failure is logged and skipped
/// — titling never fails a finished generation.
fn maybe_retitle(
    app: &AppHandle,
    config: &AppConfig,
    stage: &AppConfig,
    work_id: &str,
    base: &str,
    flag: &Arc<AtomicBool>,
) {
    if !stage.llm_enabled {
        return;
    }
    let head: String = base.chars().take(TITLE_INPUT_LIMIT).collect();
    let mut should_abort = || flag.load(Ordering::Acquire);
    let raw = match run_llm_transform(
        stage,
        &head,
        DEFAULT_WORK_TITLE.to_string(),
        "works-title",
        false,
        &mut should_abort,
    ) {
        Ok(t) => t,
        Err(e) => {
            crate::elog::elog!("[works] title generation failed: {e}");
            return;
        }
    };
    let Some(title) = clean_generated_title(&raw) else {
        crate::elog::elog!("[works] title generation returned empty");
        return;
    };
    match super::rename_work(config, work_id, &title) {
        Ok(_) => {
            crate::elog::elog!("[works] auto-titled {work_id} → {title}");
            let _ = app.emit("works-updated", ());
        }
        Err(e) => crate::elog::elog!("[works] auto-rename failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_paths_cover_all_kinds() {
        assert_eq!(artifact_rel_path("summary").as_deref(), Some("notes/summary.md"));
        assert_eq!(
            artifact_rel_path("study_notes").as_deref(),
            Some("notes/study_notes.md")
        );
        assert_eq!(
            artifact_rel_path("article_wechat").as_deref(),
            Some("notes/article_wechat.md")
        );
        assert!(artifact_rel_path("nope").is_none());
        assert!(artifact_rel_path("../escape").is_none());
    }

    #[test]
    fn map_reduce_threshold() {
        assert!(!needs_map_reduce(&"短".repeat(100)));
        assert!(needs_map_reduce(&"长".repeat(MAP_REDUCE_THRESHOLD + 1)));
    }

    #[test]
    fn refined_marker_roundtrip() {
        let content = format!("{}\n\n正文", refined_marker(0xdead_beef));
        assert_eq!(parse_refined_marker(&content), Some(0xdead_beef));
        assert_eq!(parse_refined_marker("没有标记"), None);
    }

    #[test]
    fn title_cleaning_strips_quotes_and_caps() {
        assert_eq!(clean_generated_title("《一次很好的复盘》。").as_deref(), Some("一次很好的复盘"));
        assert_eq!(clean_generated_title("\"Title\"").as_deref(), Some("Title"));
        assert_eq!(clean_generated_title("第一行\n第二行").as_deref(), Some("第一行"));
        assert_eq!(clean_generated_title("\"\""), None);
        let long = "很长的标题".repeat(10);
        assert!(clean_generated_title(&long).unwrap().chars().count() <= 20);
    }

    #[test]
    fn timestamped_input_anchors_segments() {
        let t = WorkTranscript {
            text: "ignored".into(),
            raw_text: String::new(),
            llm_text: None,
            language: "zh".into(),
            duration_seconds: 60.0,
            segments: vec![crate::history::TranscriptSegment {
                text: "你好".into(),
                start: 61.0,
                end: 62.0,
                speaker: None,
            }],
            alignment: None,
        };
        assert_eq!(timestamped_input(&t), "[01:01] 你好\n");
        let plain = WorkTranscript {
            segments: Vec::new(),
            text: "plain".into(),
            ..t
        };
        assert_eq!(timestamped_input(&plain), "plain");
    }

    #[test]
    fn prompt_override_wins_and_validates_kind() {
        let mut config = AppConfig::default();
        assert_eq!(prompt_for(&config, "summary").unwrap(), DEFAULT_WORK_PROMPT_SUMMARY);
        config
            .works_prompts
            .insert("summary".into(), "  自定义  ".into());
        assert_eq!(prompt_for(&config, "summary").unwrap(), "自定义");
        assert!(prompt_for(&config, "nope").is_err());
    }
}

#[cfg(test)]
mod prompt_sync_tests {
    use super::*;

    /// Built-in work prompts must be byte-identical across the Rust backend
    /// and the frontend Settings preview (src/lib/constants.ts) — same
    /// convention as `refine_prompt_sync_tests` in transcription/mod.rs.
    fn ts_constant(ts: &str, name: &str) -> String {
        let marker = format!("export const {name} = `\\\n");
        let start = ts
            .find(&marker)
            .unwrap_or_else(|| panic!("{name} not found in constants.ts"))
            + marker.len();
        let rest = &ts[start..];
        let end = rest.find("`;").expect("unterminated template literal");
        rest[..end].to_string()
    }

    #[test]
    fn prompts_match_frontend_constants() {
        let ts = include_str!("../../../src/lib/constants.ts");
        let pairs: [(&str, &str); 8] = [
            ("DEFAULT_WORK_PROMPT_SUMMARY", DEFAULT_WORK_PROMPT_SUMMARY),
            ("DEFAULT_WORK_PROMPT_MINUTES", DEFAULT_WORK_PROMPT_MINUTES),
            ("DEFAULT_WORK_PROMPT_STUDY_NOTES", DEFAULT_WORK_PROMPT_STUDY_NOTES),
            ("DEFAULT_WORK_PROMPT_POST_XIAOHONGSHU", DEFAULT_WORK_PROMPT_POST_XIAOHONGSHU),
            ("DEFAULT_WORK_PROMPT_SCRIPT_DOUYIN", DEFAULT_WORK_PROMPT_SCRIPT_DOUYIN),
            ("DEFAULT_WORK_PROMPT_ARTICLE_WECHAT", DEFAULT_WORK_PROMPT_ARTICLE_WECHAT),
            ("DEFAULT_WORK_MAP_SUMMARY", DEFAULT_WORK_MAP_SUMMARY),
            ("DEFAULT_WORK_TITLE", DEFAULT_WORK_TITLE),
        ];
        for (name, rust) in pairs {
            assert_eq!(ts_constant(ts, name), rust, "{name} drifted from constants.ts");
        }
    }
}
