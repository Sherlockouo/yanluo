//! Works research (作品研究模式): one agent run scoped to a work folder.
//!
//! The run is dispatched without UI navigation or cwd memory, with its cwd set
//! to `research/` inside the work folder. The `research` entry in `work.json`
//! is written before the job can finish, and `on_job_finished` is idempotent
//! so it can run from the agent thread and from `start` (for fast jobs that
//! finish before the entry lands). Failures are recorded on the entry
//! (invariant #11).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use super::{atomic_write, list_works, resolve_work_dir, write_json};
use crate::agent::{dispatch_agent_impl, AgentJob, AgentRuntime, JobStatus};
use crate::config::AppConfig;
use crate::state::AsrEngine;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ResearchEntry {
    /// Agent job id; also the report file stem.
    pub(crate) id: String,
    pub(crate) question: String,
    /// "running" | "done" | "failed" | "cancelled"
    pub(crate) status: String,
    /// Report path relative to the work folder (`research/<id>.md`).
    #[serde(default)]
    pub(crate) path: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

fn research_prompt(dir: &Path, question: &str) -> String {
    format!(
        "你是研究助手。下面是一份音视频转写作品的材料：\n\
         - 逐字稿（带 [mm:ss] 时间戳）：{transcript}\n\
         - 已生成的笔记目录：{notes}\n\
         \n\
         研究问题：{question}\n\
         \n\
         要求：\n\
         1. 先阅读逐字稿与已有笔记，结论必须以原文为依据；引用原文时附上时间戳 ([mm:ss])。\n\
         2. 如需外部背景，可以补充，但必须与原文信息明确区分，并注明来源。\n\
         3. 输出 Markdown 研究报告：先给结论，再分节论证；原文没有的内容写「原文未提及」。\n\
         4. 只输出报告正文。",
        transcript = dir.join("transcript.md").display(),
        notes = dir.join("notes").display(),
    )
}

/// Dispatch a research run for one work. Returns the entry as persisted.
pub(crate) fn start(
    app: &AppHandle,
    engine: &AsrEngine,
    runtime: &Arc<AgentRuntime>,
    work_id: &str,
    question: &str,
) -> Result<ResearchEntry, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("研究问题为空".into());
    }
    let config = engine.config.lock().map_err(|e| e.to_string())?.clone();
    let (dir, _work) = resolve_work_dir(&config, work_id)?;
    let research_dir = dir.join("research");
    fs::create_dir_all(&research_dir).map_err(|e| format!("创建研究目录失败: {e}"))?;

    let job = dispatch_agent_impl(
        app,
        &config.agent_kind,
        &research_prompt(&dir, question),
        &research_dir.to_string_lossy(),
        None,
        engine,
        runtime,
        false,
        false,
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    let entry = ResearchEntry {
        id: job.id.clone(),
        question: question.to_string(),
        status: "running".into(),
        path: format!("research/{}.md", job.id),
        created_at: now.clone(),
        updated_at: now,
        error: None,
    };
    upsert_entry(&config, work_id, entry.clone())?;
    let _ = app.emit("works-updated", ());

    if let Some(finished) = runtime.find_job(&job.id) {
        on_job_finished(app, &finished);
    }
    Ok(entry)
}

/// Agent completion hook: writes the report and settles the entry status.
/// Non-terminal jobs and jobs that are not research runs are ignored.
pub(crate) fn on_job_finished(app: &AppHandle, job: &AgentJob) {
    let (mut status, mut error): (&str, Option<String>) = match job.status {
        JobStatus::Done => ("done", None),
        JobStatus::Error => ("failed", Some(job.error.clone())),
        JobStatus::Cancelled => ("cancelled", None),
        _ => return,
    };
    let Some(engine) = app.try_state::<AsrEngine>() else {
        return;
    };
    let Ok(config) = engine.config.lock().map(|c| c.clone()) else {
        return;
    };
    let Ok(works) = list_works(&config) else {
        return;
    };
    let Some(work) = works
        .into_iter()
        .find(|w| w.research.iter().any(|r| r.id == job.id))
    else {
        return;
    };
    let Ok((dir, _)) = resolve_work_dir(&config, &work.id) else {
        return;
    };

    if status == "done" {
        if job.result.trim().is_empty() {
            status = "failed";
            error = Some("研究没有产出报告".into());
        } else if let Err(e) = atomic_write(
            &dir.join(format!("research/{}.md", job.id)),
            job.result.as_bytes(),
        ) {
            status = "failed";
            error = Some(e);
        }
    }

    if let Err(e) = mutate_entry(&config, &work.id, &job.id, |entry| {
        entry.status = status.to_string();
        entry.error = error.clone();
        entry.updated_at = chrono::Utc::now().to_rfc3339();
    }) {
        crate::elog::elog!("[works] research status persist failed: {e}");
    }
    let _ = app.emit("works-updated", ());
}

fn upsert_entry(config: &AppConfig, work_id: &str, entry: ResearchEntry) -> Result<(), String> {
    let (dir, mut work) = resolve_work_dir(config, work_id)?;
    match work.research.iter_mut().find(|r| r.id == entry.id) {
        Some(existing) => *existing = entry,
        None => work.research.insert(0, entry),
    }
    write_json(&dir.join("work.json"), &work)
}

fn mutate_entry(
    config: &AppConfig,
    work_id: &str,
    entry_id: &str,
    f: impl FnOnce(&mut ResearchEntry),
) -> Result<(), String> {
    let (dir, mut work) = resolve_work_dir(config, work_id)?;
    let entry = work
        .research
        .iter_mut()
        .find(|r| r.id == entry_id)
        .ok_or_else(|| "研究记录不存在".to_string())?;
    f(entry);
    write_json(&dir.join("work.json"), &work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_points_at_transcript_and_notes() {
        let p = research_prompt(Path::new("/w/demo"), "这期讲了什么");
        assert!(p.contains("/w/demo/transcript.md"));
        assert!(p.contains("/w/demo/notes"));
        assert!(p.contains("研究问题：这期讲了什么"));
    }
}
