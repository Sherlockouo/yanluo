//! Agent summon: Claude / Codex CLI dispatch + job store (uses floating HUD).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::*;
use crate::hud::{emit_floating_status, floating_status_slot, set_floating_window_visible};
use crate::platform::*;
use crate::state::*;

const MAX_JOBS: usize = 40;
const MAX_EVENTS: usize = 400;
const MAX_EVENT_TEXT: usize = 8_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentKind {
    Claude,
    Codex,
    Pi,
}

impl AgentKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "codex" => Self::Codex,
            "pi" => Self::Pi,
            _ => Self::Claude,
        }
    }

    /// Human-facing display name for error copy ("Claude" / "Codex" / "Pi").
    fn label(&self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Pi => "Pi",
        }
    }
}

/// Display name for a lowercase CLI bin name ("claude" / "codex" / "pi").
/// Used where only the resolved-bin string (not `AgentKind`) is in scope.
fn agent_bin_label(bin_name: &str) -> &'static str {
    match bin_name {
        "codex" => "Codex",
        "pi" => "Pi",
        _ => "Claude",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobStatus {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

/// One timeline row for a job (user turns + assistant/tool stream).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AgentJobEvent {
    pub(crate) seq: u32,
    pub(crate) ts: String,
    /// `user` | `assistant` | `tool` | `tool_result` | `status` | `error` | `system`
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AgentJob {
    pub(crate) id: String,
    pub(crate) agent: AgentKind,
    pub(crate) prompt: String,
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) attachments: Vec<String>,
    pub(crate) status: JobStatus,
    pub(crate) progress: String,
    pub(crate) result: String,
    pub(crate) error: String,
    pub(crate) started_at: String,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
    /// Claude/Codex conversation id for multi-turn resume.
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    /// Full stream timeline (persisted in agent-jobs.json).
    #[serde(default)]
    pub(crate) events: Vec<AgentJobEvent>,
    /// Attachments for the in-flight / next turn only (spawn --add-dir / -i).
    #[serde(default)]
    pub(crate) turn_attachments: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PathInfo {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) size: u64,
    pub(crate) ext: String,
    /// Short text preview for text-like files (empty otherwise).
    pub(crate) preview: String,
    pub(crate) previewable: bool,
}

pub(crate) struct AgentRuntime {
    jobs: Mutex<Vec<AgentJob>>,
    children: Mutex<HashMap<String, u32>>,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// HUD Raycast menu open — Esc closes menu first (hotkey tap reads this).
    pub(crate) hud_menu_open: AtomicBool,
}

impl AgentRuntime {
    pub(crate) fn new() -> Self {
        let jobs = load_jobs_from_disk();
        Self {
            jobs: Mutex::new(jobs),
            children: Mutex::new(HashMap::new()),
            cancel_flags: Mutex::new(HashMap::new()),
            hud_menu_open: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
pub(crate) fn set_agent_hud_menu_open(
    open: bool,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<(), String> {
    runtime.hud_menu_open.store(open, Ordering::Release);
    Ok(())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_job_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("agent-{ms}-{}", (ms % 9973) as u32)
}

/// Valid UUID for Claude `--session-id` / `--resume`.
fn new_session_uuid() -> String {
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let x = ns ^ (pid << 48) ^ (ns.rotate_left(13));
    format!(
        "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
        (x & 0xffff_ffff) as u32,
        ((x >> 32) & 0xffff) as u16,
        ((x >> 48) & 0x0fff) as u16,
        ((x >> 60) & 0x0fff) as u16,
        (x >> 72) & 0xffff_ffff_ffff
    )
}

fn push_event(job: &mut AgentJob, kind: &str, title: &str, text: &str) {
    let seq = job.events.last().map(|e| e.seq + 1).unwrap_or(0);
    job.events.push(AgentJobEvent {
        seq,
        ts: now_rfc3339(),
        kind: kind.into(),
        title: truncate(title, 120),
        text: truncate(text, MAX_EVENT_TEXT),
    });
    if job.events.len() > MAX_EVENTS {
        let drop_n = job.events.len() - MAX_EVENTS;
        job.events.drain(0..drop_n);
    }
}

fn extract_session_id(v: &Value) -> Option<String> {
    // Pi JSON mode header: {"type":"session","id":"uuid",...}
    if v.get("type").and_then(|x| x.as_str()) == Some("session") {
        if let Some(s) = v.get("id").and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    for key in [
        "session_id",
        "sessionId",
        "thread_id",
        "threadId",
        "conversation_id",
        "conversationId",
    ] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    if let Some(s) = v.pointer("/session/id").and_then(|x| x.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(s) = v.pointer("/thread/id").and_then(|x| x.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

fn pi_message_text(message: &Value) -> Option<String> {
    let role = message.get("role").and_then(|x| x.as_str()).unwrap_or("");
    if role != "assistant" && role != "toolResult" {
        // still try content for assistant-shaped payloads
    }
    if let Some(s) = message.get("content").and_then(|c| c.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(arr) = message.get("content").and_then(|c| c.as_array()) {
        let mut parts = Vec::new();
        for block in arr {
            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                if !t.trim().is_empty() {
                    parts.push(t.to_string());
                }
            } else if let Some(t) = block.as_str() {
                if !t.trim().is_empty() {
                    parts.push(t.to_string());
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n\n"));
        }
    }
    None
}

/// Normalize a stream-json line into a durable timeline event (skip noisy deltas).
fn event_from_stream_line(line: &str) -> Option<(Option<String>, AgentJobEvent)> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        let t = line.trim();
        if t.is_empty() {
            return None;
        }
        return Some((
            None,
            AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "status".into(),
                title: "log".into(),
                text: truncate(t, MAX_EVENT_TEXT),
            },
        ));
    };
    let session = extract_session_id(&v);
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let mut draft: Option<AgentJobEvent> = None;

    match t {
        "assistant" => {
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                let mut texts = Vec::new();
                let mut tools = Vec::new();
                for block in content {
                    let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if bt == "tool_use" {
                        let name = block
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("tool");
                        let input = block
                            .get("input")
                            .map(|i| i.to_string())
                            .unwrap_or_default();
                        tools.push((name.to_string(), input));
                    } else if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                        if !text.trim().is_empty() {
                            texts.push(text.to_string());
                        }
                    }
                }
                if !texts.is_empty() {
                    draft = Some(AgentJobEvent {
                        seq: 0,
                        ts: now_rfc3339(),
                        kind: "assistant".into(),
                        title: "assistant".into(),
                        text: truncate(&texts.join("\n\n"), MAX_EVENT_TEXT),
                    });
                } else if let Some((name, input)) = tools.into_iter().next() {
                    draft = Some(AgentJobEvent {
                        seq: 0,
                        ts: now_rfc3339(),
                        kind: "tool".into(),
                        title: format!("tool · {name}"),
                        text: truncate(&input, MAX_EVENT_TEXT),
                    });
                }
            }
        }
        "user" => {
            // Claude may echo user/tool_result in stream
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|x| x.as_str()) == Some("tool_result") {
                        let text = block
                            .get("content")
                            .and_then(|c| {
                                c.as_str().map(|s| s.to_string()).or_else(|| {
                                    Some(c.to_string())
                                })
                            })
                            .unwrap_or_default();
                        draft = Some(AgentJobEvent {
                            seq: 0,
                            ts: now_rfc3339(),
                            kind: "tool_result".into(),
                            title: "tool_result".into(),
                            text: truncate(&text, MAX_EVENT_TEXT),
                        });
                        break;
                    }
                }
            }
        }
        "tool_use" => {
            let name = v
                .get("name")
                .or_else(|| v.get("tool_name"))
                .and_then(|x| x.as_str())
                .unwrap_or("tool");
            let input = v
                .get("input")
                .map(|i| i.to_string())
                .unwrap_or_default();
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "tool".into(),
                title: format!("tool · {name}"),
                text: truncate(&input, MAX_EVENT_TEXT),
            });
        }
        "tool_result" => {
            let name = v
                .get("name")
                .or_else(|| v.get("tool_name"))
                .and_then(|x| x.as_str())
                .unwrap_or("tool");
            let text = v
                .get("content")
                .or_else(|| v.get("result"))
                .map(|c| {
                    c.as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| c.to_string())
                })
                .unwrap_or_default();
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "tool_result".into(),
                title: format!("result · {name}"),
                text: truncate(&text, MAX_EVENT_TEXT),
            });
        }
        "result" => {
            if let Some(r) = v.get("result").and_then(|x| x.as_str()) {
                if !r.trim().is_empty() {
                    draft = Some(AgentJobEvent {
                        seq: 0,
                        ts: now_rfc3339(),
                        kind: "assistant".into(),
                        title: "assistant".into(),
                        text: truncate(r, MAX_EVENT_TEXT),
                    });
                }
            }
        }
        "agent_message" | "message" | "item.completed" => {
            if let Some(text) = v
                .get("text")
                .or_else(|| v.pointer("/item/text"))
                .or_else(|| v.pointer("/message/content"))
                .and_then(|x| {
                    x.as_str().map(|s| s.to_string()).or_else(|| {
                        x.as_array().and_then(|arr| {
                            arr.iter().find_map(|b| {
                                b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            })
                        })
                    })
                })
            {
                if !text.trim().is_empty() {
                    draft = Some(AgentJobEvent {
                        seq: 0,
                        ts: now_rfc3339(),
                        kind: "assistant".into(),
                        title: t.into(),
                        text: truncate(&text, MAX_EVENT_TEXT),
                    });
                }
            }
        }
        "task_started" | "turn.started" | "task_complete" | "turn.completed" => {
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "status".into(),
                title: t.into(),
                text: String::new(),
            });
        }
        // Pi `--mode json`
        "session" => {
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "system".into(),
                title: "session".into(),
                text: session.clone().unwrap_or_default(),
            });
        }
        "tool_execution_start" => {
            let name = v
                .get("toolName")
                .or_else(|| v.get("tool_name"))
                .and_then(|x| x.as_str())
                .unwrap_or("tool");
            let input = v
                .get("args")
                .map(|i| i.to_string())
                .unwrap_or_default();
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "tool".into(),
                title: format!("tool · {name}"),
                text: truncate(&input, MAX_EVENT_TEXT),
            });
        }
        "tool_execution_end" => {
            let name = v
                .get("toolName")
                .or_else(|| v.get("tool_name"))
                .and_then(|x| x.as_str())
                .unwrap_or("tool");
            let text = v
                .get("result")
                .map(|c| {
                    c.as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| c.to_string())
                })
                .unwrap_or_default();
            draft = Some(AgentJobEvent {
                seq: 0,
                ts: now_rfc3339(),
                kind: "tool_result".into(),
                title: format!("result · {name}"),
                text: truncate(&text, MAX_EVENT_TEXT),
            });
        }
        "message_end" => {
            if let Some(message) = v.get("message") {
                let role = message.get("role").and_then(|x| x.as_str()).unwrap_or("");
                if role == "assistant" {
                    if let Some(text) = pi_message_text(message) {
                        draft = Some(AgentJobEvent {
                            seq: 0,
                            ts: now_rfc3339(),
                            kind: "assistant".into(),
                            title: "assistant".into(),
                            text: truncate(&text, MAX_EVENT_TEXT),
                        });
                    }
                }
            }
        }
        "agent_start" | "agent_end" | "turn_start" | "turn_end"
        | "message_start" | "message_update" | "message_delta" | "message_stop"
        | "tool_execution_update"
        | "queue_update" | "compaction_start" | "compaction_end"
        | "auto_retry_start" | "auto_retry_end"
        | "content_block_delta" | "content_block_start" | "content_block_stop" => {
            // lifecycle / delta noise — skip timeline
        }
        "system" => {
            // Keep session_id from system events; skip noisy hook spam in timeline.
            let subtype = v.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
            if subtype == "init" || subtype.contains("session") {
                draft = Some(AgentJobEvent {
                    seq: 0,
                    ts: now_rfc3339(),
                    kind: "system".into(),
                    title: subtype.into(),
                    text: session.clone().unwrap_or_default(),
                });
            }
        }
        _ => {}
    }

    draft.map(|e| (session, e))
}

fn load_jobs_from_disk() -> Vec<AgentJob> {
    fs::read_to_string(agent_jobs_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn persist_jobs(jobs: &[AgentJob]) {
    let _ = fs::create_dir_all(app_data_dir());
    if let Ok(data) = serde_json::to_string_pretty(jobs) {
        let _ = fs::write(agent_jobs_path(), data);
    }
}

fn emit_job(app: &AppHandle, job: &AgentJob) {
    let _ = app.emit("agent-job-updated", job);
}

fn update_job<F>(app: &AppHandle, runtime: &AgentRuntime, id: &str, f: F) -> Option<AgentJob>
where
    F: FnOnce(&mut AgentJob),
{
    let mut jobs = runtime.jobs.lock().ok()?;
    let job = jobs.iter_mut().find(|j| j.id == id)?;
    f(job);
    let snapshot = job.clone();
    persist_jobs(&jobs);
    drop(jobs);
    emit_job(app, &snapshot);
    Some(snapshot)
}

fn resolve_bin(name: &str) -> Option<PathBuf> {
    if let Ok(out) = Command::new("which").arg(name).output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && Path::new(&path).exists() {
                return Some(PathBuf::from(path));
            }
        }
    }
    let mut prefixes: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        prefixes.insert(0, PathBuf::from(&home).join(".bun/bin"));
        prefixes.insert(1, PathBuf::from(&home).join(".local/bin"));
    }
    for prefix in prefixes {
        let p = prefix.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    t.chars().take(max).collect::<String>() + "…"
}

fn extract_progress(line: &str) -> Option<String> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        let t = line.trim();
        if t.is_empty() {
            return None;
        }
        return Some(truncate(t, 120));
    };
    // Claude stream-json
    if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
        match t {
            "assistant" => {
                if let Some(content) = v
                    .pointer("/message/content")
                    .and_then(|c| c.as_array())
                {
                    for block in content {
                        if block.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                            let name = block
                                .get("name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("tool");
                            return Some(format!("tool · {name}"));
                        }
                        if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                            if !text.trim().is_empty() {
                                return Some(truncate(text, 120));
                            }
                        }
                    }
                }
            }
            "content_block_delta" => {
                if let Some(text) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
                    if !text.trim().is_empty() {
                        return Some(truncate(text, 120));
                    }
                }
            }
            "tool_use" | "tool_result" | "tool_execution_start" | "tool_execution_end" => {
                let name = v
                    .get("name")
                    .or_else(|| v.get("tool_name"))
                    .or_else(|| v.get("toolName"))
                    .and_then(|x| x.as_str())
                    .unwrap_or(t);
                return Some(format!("{t} · {name}"));
            }
            "message_end" => {
                if let Some(message) = v.get("message") {
                    if let Some(text) = pi_message_text(message) {
                        return Some(truncate(&text, 120));
                    }
                }
            }
            "result" => {
                if let Some(r) = v.get("result").and_then(|x| x.as_str()) {
                    return Some(truncate(r, 120));
                }
            }
            // Codex json events
            "item.completed" | "agent_message" | "message" => {
                if let Some(text) = v
                    .get("text")
                    .or_else(|| v.pointer("/item/text"))
                    .or_else(|| v.pointer("/message/content"))
                    .and_then(|x| {
                        x.as_str()
                            .map(|s| s.to_string())
                            .or_else(|| x.as_array().and_then(|arr| {
                                arr.iter().find_map(|b| {
                                    b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                                })
                            }))
                    })
                {
                    if !text.trim().is_empty() {
                        return Some(truncate(&text, 120));
                    }
                }
            }
            "task_started" | "turn.started" => return Some("running…".into()),
            "task_complete" | "turn.completed" => return Some("finishing…".into()),
            _ => {}
        }
    }
    if let Some(msg) = v.get("msg").and_then(|x| x.as_str()) {
        return Some(truncate(msg, 120));
    }
    None
}

fn extract_result_text(line: &str, acc: &mut String) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if v.get("type").and_then(|x| x.as_str()) == Some("result") {
        if let Some(r) = v.get("result").and_then(|x| x.as_str()) {
            *acc = r.to_string();
            return;
        }
    }
    // Codex last message patterns
    if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
        if matches!(t, "agent_message" | "message" | "item.completed") {
            if let Some(text) = v
                .get("text")
                .or_else(|| v.pointer("/item/text"))
                .and_then(|x| x.as_str())
            {
                if !text.trim().is_empty() {
                    *acc = text.to_string();
                }
            }
        }
        // Pi JSON mode final assistant text
        if t == "message_end" {
            if let Some(message) = v.get("message") {
                if message.get("role").and_then(|x| x.as_str()) == Some("assistant") {
                    if let Some(text) = pi_message_text(message) {
                        *acc = text;
                    }
                }
            }
        }
    }
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// True when `mine` is still the registered cancel flag for this job.
/// After interrupt+continue, a newer turn replaces the flag — stale threads must not
/// clear handles or overwrite status.
fn owns_cancel_flag(runtime: &AgentRuntime, job_id: &str, mine: &Arc<AtomicBool>) -> bool {
    runtime
        .cancel_flags
        .lock()
        .ok()
        .and_then(|g| g.get(job_id).map(|f| Arc::ptr_eq(f, mine)))
        .unwrap_or(false)
}

fn release_run_handles(
    runtime: &AgentRuntime,
    job_id: &str,
    cancel: &Arc<AtomicBool>,
    pid: Option<u32>,
) {
    if let Some(expected) = pid {
        if let Ok(mut map) = runtime.children.lock() {
            if map.get(job_id).copied() == Some(expected) {
                map.remove(job_id);
            }
        }
    }
    if let Ok(mut map) = runtime.cancel_flags.lock() {
        if map
            .get(job_id)
            .map(|f| Arc::ptr_eq(f, cancel))
            .unwrap_or(false)
        {
            map.remove(job_id);
        }
    }
}

/// Stop in-flight child so a follow-up turn can take over (cancel flag + kill).
fn interrupt_running_job(runtime: &AgentRuntime, job_id: &str) {
    if let Ok(flags) = runtime.cancel_flags.lock() {
        if let Some(f) = flags.get(job_id) {
            f.store(true, Ordering::SeqCst);
        }
    }
    if let Ok(mut children) = runtime.children.lock() {
        if let Some(pid) = children.remove(job_id) {
            kill_pid(pid);
        }
    }
}

fn resolve_agent_bin(configured: &str, fallback_name: &str) -> Result<PathBuf, String> {
    let label = agent_bin_label(fallback_name);
    let configured = configured.trim();
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        if p.is_file() || p.exists() {
            return Ok(p);
        }
        return Err(format!(
            "{label} CLI 路径不存在：{configured}。请在设置 → 派活 里确认路径。"
        ));
    }
    resolve_bin(fallback_name).ok_or_else(|| {
        format!("未找到 {label} CLI。安装后在设置 → 派活 里确认路径。")
    })
}

/// Walk up from `path` looking for a `.git` dir/file (worktrees included).
fn is_inside_git_repo(path: &Path) -> bool {
    let mut cur = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| path.to_path_buf())
    };
    loop {
        let git = cur.join(".git");
        if git.is_dir() || git.is_file() {
            return true;
        }
        if !cur.pop() {
            return false;
        }
    }
}

fn path_is_trusted(trusted: &[String], cwd: &str) -> bool {
    let cwd = Path::new(cwd);
    trusted.iter().any(|t| {
        let t = Path::new(t.trim());
        !t.as_os_str().is_empty() && (cwd == t || cwd.starts_with(t))
    })
}

fn remember_trusted_dir(engine: &AsrEngine, app: &AppHandle, cwd: &str) {
    let Ok(mut config) = engine.config.lock() else {
        return;
    };
    if path_is_trusted(&config.agent_trusted_dirs, cwd) {
        return;
    }
    config.agent_trusted_dirs.push(cwd.to_string());
    let snapshot = config.clone();
    drop(config);
    let _ = save_config_to_disk(&snapshot);
    let _ = app.emit("config-updated", &snapshot);
}

/// Codex outside a git repo needs `--skip-git-repo-check`.
/// Default `{app}/agent` is auto-trusted. Other dirs: remember on first dispatch
/// (sending from the app = grant). Never use blocking OS dialogs here — they
/// deadlock Tauri's command / main thread.
fn ensure_codex_cwd_allowed(
    app: &AppHandle,
    engine: &AsrEngine,
    cwd: &str,
) -> Result<(), String> {
    if is_inside_git_repo(Path::new(cwd)) {
        return Ok(());
    }
    let trusted = engine
        .config
        .lock()
        .map(|c| c.agent_trusted_dirs.clone())
        .unwrap_or_default();
    if path_is_trusted(&trusted, cwd) {
        return Ok(());
    }
    // Auto-trust default workdir and any cwd the user dispatched into.
    remember_trusted_dir(engine, app, cwd);
    Ok(())
}

fn spawn_agent_process(
    agent: &AgentKind,
    prompt: &str,
    cwd: &Path,
    attachments: &[String],
    configured_bin: &str,
    skip_git_repo_check: bool,
    // Existing CLI session to resume (`claude --resume` / `codex exec resume`).
    resume_session: Option<&str>,
    // Claude only: force session id on first turn.
    new_session_id: Option<&str>,
    // Underlying model (`claude --model` / `codex -m`). Empty → omit.
    model: Option<&str>,
) -> Result<Child, String> {
    let resume = resume_session.map(|s| s.trim()).filter(|s| !s.is_empty());
    let model = model.map(|s| s.trim()).filter(|s| !s.is_empty());
    let mut args: Vec<String> = match agent {
        AgentKind::Claude => {
            let mut v = vec![
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--permission-mode".into(),
                "bypassPermissions".into(),
            ];
            if let Some(m) = model {
                v.push("--model".into());
                v.push(m.to_string());
            }
            if let Some(sid) = resume {
                v.push("--resume".into());
                v.push(sid.to_string());
            } else if let Some(sid) = new_session_id.map(|s| s.trim()).filter(|s| !s.is_empty()) {
                v.push("--session-id".into());
                v.push(sid.to_string());
            }
            v
        }
        AgentKind::Codex => {
            let mut v = if let Some(sid) = resume {
                let mut v = vec![
                    "exec".into(),
                    "resume".into(),
                    "--json".into(),
                    "-C".into(),
                    cwd.to_string_lossy().to_string(),
                    "-s".into(),
                    "workspace-write".into(),
                ];
                if skip_git_repo_check {
                    v.push("--skip-git-repo-check".into());
                }
                v.push(sid.to_string());
                v
            } else {
                let mut v = vec![
                    "exec".into(),
                    "--json".into(),
                    "-C".into(),
                    cwd.to_string_lossy().to_string(),
                    "-s".into(),
                    "workspace-write".into(),
                ];
                if skip_git_repo_check {
                    v.push("--skip-git-repo-check".into());
                }
                v
            };
            if let Some(m) = model {
                v.push("-m".into());
                v.push(m.to_string());
            }
            v
        }
        AgentKind::Pi => {
            let mut v = vec![
                "-p".into(),
                "--mode".into(),
                "json".into(),
                "--approve".into(),
            ];
            if let Some(m) = model {
                v.push("--model".into());
                v.push(m.to_string());
            }
            if let Some(sid) = resume {
                v.push("--session".into());
                v.push(sid.to_string());
            }
            v
        }
    };

    // Claude: grant tool access to cwd + kit + attached dirs / file parents.
    // `--add-dir` is variadic — without `--` it swallows the prompt as another dir.
    if matches!(agent, AgentKind::Claude) {
        let mut dirs: Vec<String> = vec![cwd.to_string_lossy().to_string()];
        if let Ok(kit) = crate::agent_kit::sync_agent_kit() {
            let s = kit.to_string_lossy().to_string();
            if !s.is_empty() && !dirs.iter().any(|d| d == &s) {
                dirs.push(s);
            }
        }
        for p in attachments {
            let path = Path::new(p);
            let dir = if path.is_dir() {
                path.to_path_buf()
            } else {
                path.parent()
                    .map(|x| x.to_path_buf())
                    .unwrap_or_else(|| cwd.to_path_buf())
            };
            let s = dir.to_string_lossy().to_string();
            if !s.is_empty() && !dirs.iter().any(|d| d == &s) {
                dirs.push(s);
            }
        }
        for d in dirs {
            args.push("--add-dir".into());
            args.push(d);
        }
    }

    // Codex: pass images as vision inputs (path-in-prompt alone is not enough).
    if matches!(agent, AgentKind::Codex) {
        for p in attachments {
            let path = Path::new(p);
            let ext = path
                .extension()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if path.is_file() && is_image_ext(&ext) {
                args.push("-i".into());
                args.push(p.clone());
            }
        }
    }

    // Pi: `@path` CLI args are file-only (inline text/image via file-processor).
    // Directories → EISDIR in detectSupportedImageMimeTypeFromFile; keep them in
    // compose_prompt so the model explores with tools (cwd / absolute paths).
    if matches!(agent, AgentKind::Pi) {
        for p in attachments {
            let path = Path::new(p);
            if path.is_file() {
                args.push(format!("@{p}"));
            }
        }
    }

    // End-of-options: Claude `--add-dir` and Codex `-i` are both variadic.
    // Pi takes positional messages; still use `--` when prompt might look like a flag.
    if matches!(agent, AgentKind::Claude | AgentKind::Codex) {
        args.push("--".into());
    }
    args.push(prompt.to_string());

    let bin_name = match agent {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Pi => "pi",
    };
    let bin = resolve_agent_bin(configured_bin, bin_name)?;

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(cwd)
        // Codex treats open stdin as more prompt input → hang on "Reading additional input…".
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Ok(mut path_env) = std::env::var("PATH") {
        let mut prefixes = vec![
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ];
        if let Ok(home) = std::env::var("HOME") {
            prefixes.insert(0, format!("{home}/.bun/bin"));
            prefixes.insert(1, format!("{home}/.local/bin"));
        }
        for prefix in prefixes {
            if !path_env.split(':').any(|p| p == prefix) {
                path_env = format!("{prefix}:{path_env}");
            }
        }
        cmd.env("PATH", path_env);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    cmd.spawn().map_err(|e| {
        format!(
            "启动 {} CLI 失败（{e}）。请在设置 → 派活 里确认路径与执行权限。",
            agent.label()
        )
    })
}

fn compose_prompt(voice: &str, attachments: &[String]) -> String {
    let voice = voice.trim();
    if attachments.is_empty() {
        return voice.to_string();
    }
    let mut out = String::new();
    if !voice.is_empty() {
        out.push_str(voice);
        out.push_str("\n\n");
    }
    out.push_str("Attachments:\n");
    for p in attachments {
        let path = Path::new(p);
        let ext = path
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if path.is_dir() {
            out.push_str(&format!(
                "- directory: {p}  (list/read files under this path; do not open as a single file)\n"
            ));
        } else if path.is_file() && is_image_ext(&ext) {
            out.push_str(&format!("- image: {p}\n"));
        } else {
            out.push_str(&format!("- {p}\n"));
        }
    }
    out
}

/// Kit self-knowledge for the CLI only — never stored in job.prompt / user timeline.
fn with_kit_preamble(user_prompt: &str, kit_path: &Path) -> String {
    let kit = kit_path.to_string_lossy();
    let mut out = String::new();
    out.push_str("[QuietType] 改本机设置前先读 AGENTS.md 与 skills/yanluo-settings.md；");
    out.push_str("用 bin/yanluo-config set …（白名单）。kit 目录: ");
    out.push_str(&kit);
    out.push_str("\n---\n");
    out.push_str(user_prompt.trim());
    out
}

fn run_job_thread(app: AppHandle, runtime: Arc<AgentRuntime>, job_id: String) {
    let (agent, prompt, cwd, attachments, cancel, resume_session, new_session_id) = {
        let jobs = match runtime.jobs.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(job) = jobs.iter().find(|j| j.id == job_id) else {
            return;
        };
        let cancel = runtime
            .cancel_flags
            .lock()
            .ok()
            .and_then(|g| g.get(&job_id).cloned())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        // Resume when job already has session AND this isn't the first event-only seed:
        // if last event is user and we already ran before (events contain prior assistant/tool),
        // or status was re-queued via continue — detect via any prior assistant/tool event.
        let had_prior_turn = job.events.iter().any(|e| {
            matches!(e.kind.as_str(), "assistant" | "tool" | "tool_result")
        });
        let resume = if had_prior_turn {
            job.session_id.clone()
        } else {
            None
        };
        let new_sid = if resume.is_none() && matches!(job.agent, AgentKind::Claude) {
            job.session_id.clone()
        } else {
            None
        };
        let spawn_attach = if !job.turn_attachments.is_empty() {
            job.turn_attachments.clone()
        } else {
            job.attachments.clone()
        };
        (
            job.agent.clone(),
            job.prompt.clone(),
            PathBuf::from(&job.cwd),
            spawn_attach,
            cancel,
            resume,
            new_sid,
        )
    };

    let configured_bin = app
        .try_state::<AsrEngine>()
        .and_then(|e| e.inner().config.lock().ok())
        .map(|c| {
            let kind = agent.as_str();
            let profile_bin = c
                .agent_profiles
                .iter()
                .find(|p| p.kind == kind && p.id == c.agent_profile_id)
                .or_else(|| c.agent_profiles.iter().find(|p| p.kind == kind))
                .map(|p| p.bin.trim().to_string())
                .filter(|b| !b.is_empty());
            if let Some(b) = profile_bin {
                return b;
            }
            match agent {
                AgentKind::Claude => c.agent_claude_bin.clone(),
                AgentKind::Codex => c.agent_codex_bin.clone(),
                AgentKind::Pi => c.agent_pi_bin.clone(),
            }
        })
        .unwrap_or_default();

    let configured_model = app
        .try_state::<AsrEngine>()
        .and_then(|e| e.inner().config.lock().ok())
        .and_then(|c| {
            let kind = agent.as_str();
            c.agent_profiles
                .iter()
                .find(|p| p.kind == kind && p.id == c.agent_profile_id)
                .or_else(|| c.agent_profiles.iter().find(|p| p.kind == kind))
                .or_else(|| {
                    c.agent_profiles
                        .iter()
                        .find(|p| p.id == c.agent_profile_id)
                })
                .map(|p| p.model.trim().to_string())
                .filter(|m| !m.is_empty())
        });

    let skip_git = matches!(agent, AgentKind::Codex) && !is_inside_git_repo(&cwd);

    if !owns_cancel_flag(&runtime, &job_id, &cancel) {
        return;
    }
    update_job(&app, &runtime, &job_id, |j| {
        j.status = JobStatus::Running;
        j.progress = "starting…".into();
        j.finished_at = None;
        j.error.clear();
    });

    // For continue turns, prompt on job is the LATEST user message only.
    let run_prompt = {
        let jobs = runtime.jobs.lock().ok();
        jobs.and_then(|g| {
            g.iter()
                .find(|j| j.id == job_id)
                .and_then(|j| {
                    j.events
                        .iter()
                        .rev()
                        .find(|e| e.kind == "user")
                        .map(|e| e.text.clone())
                })
        })
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(prompt)
    };

    let kit = crate::agent_kit::sync_agent_kit()
        .unwrap_or_else(|_| crate::agent_kit::agent_kit_dir());
    let cli_prompt = with_kit_preamble(&run_prompt, &kit);

    let mut child = match spawn_agent_process(
        &agent,
        &cli_prompt,
        &cwd,
        &attachments,
        &configured_bin,
        skip_git,
        resume_session.as_deref(),
        new_session_id.as_deref(),
        configured_model.as_deref(),
    ) {
        Ok(c) => c,
        Err(e) => {
            if owns_cancel_flag(&runtime, &job_id, &cancel) {
                update_job(&app, &runtime, &job_id, |j| {
                    j.status = JobStatus::Error;
                    j.error = e.clone();
                    push_event(j, "error", "spawn", &e);
                    j.finished_at = Some(now_rfc3339());
                });
                release_run_handles(&runtime, &job_id, &cancel, None);
            }
            return;
        }
    };

    let pid = child.id();
    if !owns_cancel_flag(&runtime, &job_id, &cancel) {
        // Superseded before child registered — kill stray process.
        kill_pid(pid);
        let mut child = child;
        let _ = child.kill();
        return;
    }
    if let Ok(mut map) = runtime.children.lock() {
        map.insert(job_id.clone(), pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut result_acc = String::new();

    let app_out = app.clone();
    let runtime_out = Arc::clone(&runtime);
    let job_out = job_id.clone();
    let cancel_out = Arc::clone(&cancel);
    let stdout_thread = std::thread::spawn(move || {
        let Some(stdout) = stdout else {
            return String::new();
        };
        let reader = BufReader::new(stdout);
        let mut result = String::new();
        for line in reader.lines().flatten() {
            if cancel_out.load(Ordering::Relaxed)
                || !owns_cancel_flag(&runtime_out, &job_out, &cancel_out)
            {
                break;
            }
            extract_result_text(&line, &mut result);
            let progress = extract_progress(&line);
            let parsed = event_from_stream_line(&line);
            if !owns_cancel_flag(&runtime_out, &job_out, &cancel_out) {
                break;
            }
            update_job(&app_out, &runtime_out, &job_out, |j| {
                if let Some(p) = progress {
                    j.progress = p;
                }
                if let Some((sid, mut ev)) = parsed {
                    if j.session_id.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                        if let Some(s) = sid.filter(|s| !s.trim().is_empty()) {
                            j.session_id = Some(s);
                        }
                    }
                    let seq = j.events.last().map(|e| e.seq + 1).unwrap_or(0);
                    ev.seq = seq;
                    let dup = j
                        .events
                        .last()
                        .map(|last| {
                            last.kind == ev.kind
                                && last.title == ev.title
                                && last.text == ev.text
                        })
                        .unwrap_or(false);
                    if !dup {
                        j.events.push(ev);
                        if j.events.len() > MAX_EVENTS {
                            let drop_n = j.events.len() - MAX_EVENTS;
                            j.events.drain(0..drop_n);
                        }
                    }
                }
            });
        }
        result
    });

    let cancel_err = Arc::clone(&cancel);
    let stderr_thread = std::thread::spawn(move || {
        let Some(stderr) = stderr else {
            return String::new();
        };
        let reader = BufReader::new(stderr);
        let mut buf = String::new();
        for line in reader.lines().flatten() {
            if cancel_err.load(Ordering::Relaxed) {
                break;
            }
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = child.wait();
    let stdout_result = stdout_thread.join().unwrap_or_default();
    let stderr_acc = stderr_thread.join().unwrap_or_default();
    if !stdout_result.is_empty() {
        result_acc = stdout_result;
    }

    let still_mine = owns_cancel_flag(&runtime, &job_id, &cancel);
    release_run_handles(&runtime, &job_id, &cancel, Some(pid));
    if !still_mine {
        // Newer turn already owns this job (interrupt → continue).
        return;
    }

    if cancel.load(Ordering::SeqCst) {
        update_job(&app, &runtime, &job_id, |j| {
            j.status = JobStatus::Cancelled;
            j.progress = "cancelled".into();
            push_event(j, "status", "cancelled", "");
            j.finished_at = Some(now_rfc3339());
        });
        return;
    }

    match status {
        Ok(s) if s.success() => {
            update_job(&app, &runtime, &job_id, |j| {
                j.status = JobStatus::Done;
                j.progress = "done".into();
                if !result_acc.trim().is_empty() {
                    j.result = result_acc.clone();
                    // Avoid duplicate assistant + result cards with the same body.
                    let already = j.events.iter().any(|e| {
                        e.kind == "assistant" && e.text.trim() == result_acc.trim()
                    });
                    if !already {
                        push_event(j, "assistant", "assistant", &result_acc);
                    }
                } else if j.result.is_empty() {
                    if let Some(last) = j
                        .events
                        .iter()
                        .rev()
                        .find(|e| e.kind == "assistant" && !e.text.trim().is_empty())
                    {
                        j.result = last.text.clone();
                    }
                }
                j.finished_at = Some(now_rfc3339());
            });
        }
        Ok(s) => {
            let err = if !stderr_acc.trim().is_empty() {
                truncate(&stderr_acc, 400)
            } else {
                format!("exit {}", s.code().unwrap_or(-1))
            };
            update_job(&app, &runtime, &job_id, |j| {
                j.status = JobStatus::Error;
                j.error = err.clone();
                push_event(j, "error", "exit", &err);
                if !result_acc.trim().is_empty() {
                    j.result = result_acc;
                }
                j.finished_at = Some(now_rfc3339());
            });
        }
        Err(e) => {
            update_job(&app, &runtime, &job_id, |j| {
                j.status = JobStatus::Error;
                j.error = e.to_string();
                push_event(j, "error", "wait", &e.to_string());
                j.finished_at = Some(now_rfc3339());
            });
        }
    }
}

#[tauri::command]
pub(crate) fn list_agent_jobs(
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<AgentJob>, String> {
    runtime
        .jobs
        .lock()
        .map(|g| g.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_agent_job(
    id: String,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<Option<AgentJob>, String> {
    runtime
        .jobs
        .lock()
        .map(|g| g.iter().find(|j| j.id == id).cloned())
        .map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AgentBinDetect {
    pub(crate) claude: Option<String>,
    pub(crate) codex: Option<String>,
    pub(crate) pi: Option<String>,
}

#[tauri::command]
pub(crate) fn detect_agent_bins() -> AgentBinDetect {
    AgentBinDetect {
        claude: resolve_bin("claude").map(|p| p.to_string_lossy().into_owned()),
        codex: resolve_bin("codex").map(|p| p.to_string_lossy().into_owned()),
        pi: resolve_bin("pi").map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub(crate) fn set_agent_defaults(
    app: AppHandle,
    agent: Option<String>,
    cwd: Option<String>,
    claude_bin: Option<String>,
    codex_bin: Option<String>,
    profile_id: Option<String>,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
    let mut config = engine
        .inner()
        .config
        .lock()
        .map_err(|e| e.to_string())?;
    ensure_agent_profiles(&mut config);
    let profile_set = if let Some(ref pid) = profile_id {
        let pid = pid.trim().to_string();
        if config.agent_profiles.iter().any(|p| p.id == pid) {
            config.agent_profile_id = pid.clone();
            if let Some(p) = config.agent_profiles.iter().find(|p| p.id == pid) {
                config.agent_kind = AgentKind::from_str(&p.kind).as_str().into();
            }
            true
        } else {
            false
        }
    } else {
        false
    };
    if let Some(a) = agent {
        let kind = AgentKind::from_str(&a);
        config.agent_kind = kind.as_str().into();
        // Prefer matching profile by kind if profile_id not set this call.
        if !profile_set {
            if let Some(p) = config
                .agent_profiles
                .iter()
                .find(|p| p.kind == kind.as_str())
            {
                config.agent_profile_id = p.id.clone();
            }
        }
    }
    if let Some(c) = cwd {
        let trimmed = c.trim().to_string();
        config.agent_cwd = trimmed.clone();
        if !trimmed.is_empty() {
            push_agent_cwd_history(&mut config, &trimmed);
        }
    }
    if let Some(p) = claude_bin {
        config.agent_claude_bin = p.trim().to_string();
    }
    if let Some(p) = codex_bin {
        config.agent_codex_bin = p.trim().to_string();
    }
    let snapshot = config.clone();
    drop(config);
    save_config_to_disk(&snapshot)?;
    let _ = app.emit("config-updated", &snapshot);
    // Refresh floating HUD agent/cwd chips if agent session visible.
    let agent_open = floating_status_slot(&app)
        .lock()
        .map(|s| s.visible && s.intention.as_deref() == Some("agent"))
        .unwrap_or(false);
    if agent_open {
        let state = floating_status_slot(&app)
            .lock()
            .map(|s| s.state.clone())
            .unwrap_or_else(|_| "recording".into());
        let text = floating_status_slot(&app)
            .lock()
            .map(|s| s.text.clone())
            .unwrap_or_default();
        emit_floating_status(&app, true, &state, &text, 0.0);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn dispatch_agent(
    app: AppHandle,
    agent: String,
    prompt: String,
    cwd: String,
    attachments: Option<Vec<String>>,
    engine: State<'_, AsrEngine>,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<AgentJob, String> {
    let attachments: Vec<String> = attachments
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if prompt.trim().is_empty() && attachments.is_empty() {
        return Err("prompt 为空".into());
    }
    let prompt = compose_prompt(&prompt, &attachments);
    let mut cwd = cwd.trim().to_string();
    {
        let mut cfg = engine
            .inner()
            .config
            .lock()
            .map_err(|e| e.to_string())?;
        if cwd.is_empty() || !Path::new(&cwd).is_dir() {
            cwd = resolve_agent_cwd(&mut cfg)?;
        }
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("目录不存在: {cwd}"));
    }
    let kind = AgentKind::from_str(&agent);

    if matches!(kind, AgentKind::Codex) {
        ensure_codex_cwd_allowed(&app, engine.inner(), &cwd)?;
    }

    // Persist defaults + cwd history for HUD picker.
    if let Ok(mut config) = engine.inner().config.lock() {
        config.agent_kind = kind.as_str().into();
        config.agent_cwd = cwd.clone();
        push_agent_cwd_history(&mut config, &cwd);
        let snapshot = config.clone();
        drop(config);
        let _ = save_config_to_disk(&snapshot);
        let _ = app.emit("config-updated", &snapshot);
    }

    let job_id = new_job_id();
    let session_id = match kind {
        AgentKind::Claude => Some(new_session_uuid()),
        AgentKind::Codex | AgentKind::Pi => None,
    };
    let mut job = AgentJob {
        id: job_id.clone(),
        agent: kind,
        prompt: prompt.clone(),
        cwd,
        turn_attachments: attachments.clone(),
        attachments,
        status: JobStatus::Queued,
        progress: "queued".into(),
        result: String::new(),
        error: String::new(),
        started_at: now_rfc3339(),
        finished_at: None,
        session_id,
        events: Vec::new(),
    };
    push_event(&mut job, "user", "user", &prompt);

    {
        let mut jobs = runtime.jobs.lock().map_err(|e| e.to_string())?;
        jobs.insert(0, job.clone());
        if jobs.len() > MAX_JOBS {
            jobs.truncate(MAX_JOBS);
        }
        persist_jobs(&jobs);
    }
    emit_job(&app, &job);

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = runtime.cancel_flags.lock() {
        map.insert(job.id.clone(), Arc::clone(&cancel));
    }

    let runtime_arc = runtime.inner().clone();
    let app_clone = app.clone();
    let job_id = job.id.clone();
    std::thread::Builder::new()
        .name(format!("agent-{}", &job_id[..job_id.len().min(16)]))
        .spawn(move || run_job_thread(app_clone, runtime_arc, job_id))
        .map_err(|e| e.to_string())?;

    // Hide floating HUD after dispatch — follow progress on Agent page.
    emit_floating_status(&app, false, "idle", "", 0.0);
    crate::menu::show_main_window(&app);
    let _ = app.emit("open-agent-job", &job.id);

    Ok(job)
}

/// Continue an existing job conversation (Claude `--resume` / Codex `exec resume` / Pi `--session`).
/// If the job is still queued/running, interrupts the current turn first (steer mid-flight).
#[tauri::command]
pub(crate) fn continue_agent_job(
    app: AppHandle,
    job_id: String,
    prompt: String,
    attachments: Option<Vec<String>>,
    engine: State<'_, AsrEngine>,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<AgentJob, String> {
    let attachments: Vec<String> = attachments
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if prompt.trim().is_empty() && attachments.is_empty() {
        return Err("prompt 为空".into());
    }
    let prompt = compose_prompt(&prompt, &attachments);

    let (cwd, agent, session_id, was_active) = {
        let jobs = runtime.jobs.lock().map_err(|e| e.to_string())?;
        let job = jobs
            .iter()
            .find(|j| j.id == job_id)
            .ok_or_else(|| format!("任务不存在: {job_id}"))?;
        let was_active = matches!(job.status, JobStatus::Queued | JobStatus::Running);
        let sid = job
            .session_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "无法续聊：缺少 session id（旧任务或 Codex 未回报会话）".to_string()
            })?;
        (job.cwd.clone(), job.agent.clone(), sid, was_active)
    };

    if was_active {
        interrupt_running_job(runtime.inner(), &job_id);
    }

    if matches!(agent, AgentKind::Codex) {
        ensure_codex_cwd_allowed(&app, engine.inner(), &cwd)?;
    }

    // Register the new turn's cancel flag BEFORE mutating job status, so a
    // dying previous thread sees !owns_cancel_flag and does not clobber Queued.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = runtime.cancel_flags.lock() {
        map.insert(job_id.clone(), Arc::clone(&cancel));
    }

    let snapshot = update_job(&app, runtime.inner(), &job_id, |j| {
        // Keep original prompt (first turn) for list; timeline holds all turns.
        if !attachments.is_empty() {
            for p in &attachments {
                if !j.attachments.iter().any(|x| x == p) {
                    j.attachments.push(p.clone());
                }
            }
        }
        j.turn_attachments = attachments.clone();
        if was_active {
            push_event(j, "status", "interrupted", "已中断，按新指令继续");
        }
        push_event(j, "user", "user", &prompt);
        j.status = JobStatus::Queued;
        j.progress = "queued".into();
        j.error.clear();
        j.finished_at = None;
        j.session_id = Some(session_id.clone());
    })
    .ok_or_else(|| format!("任务不存在: {job_id}"))?;

    let runtime_arc = runtime.inner().clone();
    let app_clone = app.clone();
    let id = job_id.clone();
    std::thread::Builder::new()
        .name(format!("agent-{}", &id[..id.len().min(16)]))
        .spawn(move || run_job_thread(app_clone, runtime_arc, id))
        .map_err(|e| e.to_string())?;

    Ok(snapshot)
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "txt"
            | "md"
            | "markdown"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "css"
            | "py"
            | "go"
            | "swift"
            | "sh"
            | "zsh"
            | "bash"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "java"
            | "kt"
            | "sql"
            | "xml"
            | "csv"
            | "log"
            | "env"
            | "gitignore"
            | "dockerfile"
    )
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "heic"
    )
}

fn is_html_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "html" | "htm" | "xhtml"
    )
}

fn is_pdf_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("pdf")
}

fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "avi" | "ogv"
    )
}

fn is_audio_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "flac" | "opus" | "aiff" | "aif"
    )
}

#[tauri::command]
pub(crate) fn read_clipboard_attachments() -> Result<Vec<String>, String> {
    read_clipboard_attachment_paths()
}

#[tauri::command]
pub(crate) fn get_path_info(path: String) -> Result<PathInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("不存在: {path}"));
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let kind: String = if meta.is_dir() {
        "dir".into()
    } else if is_image_ext(&ext) {
        "image".into()
    } else if is_pdf_ext(&ext) {
        "pdf".into()
    } else if is_html_ext(&ext) {
        "html".into()
    } else if is_video_ext(&ext) {
        "video".into()
    } else if is_audio_ext(&ext) {
        "audio".into()
    } else if is_text_ext(&ext) || ext.is_empty() && meta.len() < 512_000 {
        "text".into()
    } else {
        "file".into()
    };
    let mut preview = String::new();
    let previewable = matches!(
        kind.as_str(),
        "text" | "image" | "dir" | "pdf" | "html" | "video" | "audio"
    );
    if kind == "text" && meta.len() < 512_000 {
        if let Ok(data) = fs::read_to_string(p) {
            preview = data.chars().take(4000).collect();
        }
    } else if kind == "dir" {
        if let Ok(rd) = fs::read_dir(p) {
            let mut names: Vec<String> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .take(40)
                .collect();
            names.sort();
            preview = names.join("\n");
        }
    }
    Ok(PathInfo {
        path,
        name,
        kind,
        size: meta.len(),
        ext,
        preview,
        previewable,
    })
}


#[tauri::command]
pub(crate) fn cancel_agent_job(
    app: AppHandle,
    id: String,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<(), String> {
    if let Ok(flags) = runtime.cancel_flags.lock() {
        if let Some(f) = flags.get(&id) {
            f.store(true, Ordering::SeqCst);
        }
    }
    if let Ok(mut children) = runtime.children.lock() {
        if let Some(pid) = children.remove(&id) {
            kill_pid(pid);
        }
    }
    update_job(&app, runtime.inner(), &id, |j| {
        if matches!(j.status, JobStatus::Queued | JobStatus::Running) {
            j.status = JobStatus::Cancelled;
            j.progress = "cancelled".into();
            j.finished_at = Some(now_rfc3339());
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_agent_job(
    app: AppHandle,
    id: String,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<bool, String> {
    // Cancel if still running.
    if let Ok(flags) = runtime.cancel_flags.lock() {
        if let Some(f) = flags.get(&id) {
            f.store(true, Ordering::SeqCst);
        }
    }
    if let Ok(mut children) = runtime.children.lock() {
        if let Some(pid) = children.remove(&id) {
            kill_pid(pid);
        }
    }
    let mut jobs = runtime.jobs.lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|j| j.id != id);
    let removed = jobs.len() < before;
    persist_jobs(&jobs);
    drop(jobs);
    if removed {
        // Notify UI to drop the row.
        let _ = app.emit(
            "agent-job-deleted",
            serde_json::json!({ "id": id }),
        );
    }
    Ok(removed)
}

#[tauri::command]
pub(crate) fn clear_agent_jobs(
    app: AppHandle,
    finished_only: Option<bool>,
    runtime: State<'_, Arc<AgentRuntime>>,
) -> Result<usize, String> {
    let finished_only = finished_only.unwrap_or(true);

    if !finished_only {
        let active_ids: Vec<String> = runtime
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|j| matches!(j.status, JobStatus::Queued | JobStatus::Running))
            .map(|j| j.id.clone())
            .collect();
        for id in active_ids {
            if let Ok(flags) = runtime.cancel_flags.lock() {
                if let Some(f) = flags.get(&id) {
                    f.store(true, Ordering::SeqCst);
                }
            }
            if let Ok(mut children) = runtime.children.lock() {
                if let Some(pid) = children.remove(&id) {
                    kill_pid(pid);
                }
            }
        }
    }

    let mut jobs = runtime.jobs.lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    if finished_only {
        jobs.retain(|j| matches!(j.status, JobStatus::Queued | JobStatus::Running));
    } else {
        jobs.clear();
    }
    let removed = before.saturating_sub(jobs.len());
    persist_jobs(&jobs);
    drop(jobs);
    let _ = app.emit("agent-jobs-reload", ());
    Ok(removed)
}

/// Called from hotkey event tap.
/// Fn+Space: show floating HUD + start voice; again while recording → stop voice.
pub(crate) fn handle_agent_summon(app: &AppHandle) {
    let recording = app
        .try_state::<AsrEngine>()
        .map(|e| e.inner().recording.load(Ordering::Acquire))
        .unwrap_or(false);
    let session = AsrEngine::session_mode(app);
    let agent_visible = floating_status_slot(app)
        .lock()
        .map(|s| s.visible && s.intention.as_deref() == Some("agent"))
        .unwrap_or(false);

    if agent_visible && recording && session == "agent" {
        let _ = app.emit("agent-voice-stop", ());
        let _ = app.emit_to("floating", "agent-voice-stop", ());
        return;
    }

    // Already editing? Second Fn+Space while editing = noop (user edits/Enter).
    if agent_visible && session == "agent" && !recording {
        let editing = floating_status_slot(app)
            .lock()
            .map(|s| s.state == "editing")
            .unwrap_or(false);
        if editing {
            let _ = app.emit_to("floating", "agent-focus-edit", ());
            return;
        }
    }

    // Set session before first status emit so intention=agent (avoids wipe/race).
    AsrEngine::set_session_mode(app, "agent");
    emit_floating_status(app, true, "recording", "", 0.0);
    set_floating_window_visible(app, true);

    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        let _ = app2.emit("agent-voice-start", ());
        let _ = app2.emit_to("floating", "agent-voice-start", ());
    });
}

#[tauri::command]
pub(crate) fn show_agent_hud(app: AppHandle) -> Result<(), String> {
    handle_agent_summon(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn hide_agent_hud(app: AppHandle) -> Result<(), String> {
    crate::hud::close_floating_agent_menu(&app);
    emit_floating_status(&app, false, "idle", "", 0.0);
    Ok(())
}

// ── Agent model catalog (disk cache + background refresh) ──────────────

const AGENT_MODELS_TTL_SECS: u64 = 6 * 3600;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AgentModelOpt {
    pub(crate) id: String,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AgentModelsCache {
    /// Unix secs when last successfully refreshed.
    #[serde(default)]
    pub(crate) fetched_at: u64,
    #[serde(default)]
    pub(crate) claude: Vec<AgentModelOpt>,
    #[serde(default)]
    pub(crate) codex: Vec<AgentModelOpt>,
    #[serde(default)]
    pub(crate) pi: Vec<AgentModelOpt>,
}

fn agent_models_path() -> PathBuf {
    app_data_dir().join("agent-models.json")
}

fn static_claude_models() -> Vec<AgentModelOpt> {
    vec![
        AgentModelOpt {
            id: "sonnet".into(),
            label: "Sonnet".into(),
        },
        AgentModelOpt {
            id: "opus".into(),
            label: "Opus".into(),
        },
        AgentModelOpt {
            id: "haiku".into(),
            label: "Haiku".into(),
        },
        AgentModelOpt {
            id: "fable".into(),
            label: "Fable".into(),
        },
    ]
}

fn static_codex_models() -> Vec<AgentModelOpt> {
    vec![
        AgentModelOpt {
            id: String::new(),
            label: "默认".into(),
        },
        AgentModelOpt {
            id: "gpt-5.4".into(),
            label: "GPT-5.4".into(),
        },
        AgentModelOpt {
            id: "gpt-5.2".into(),
            label: "GPT-5.2".into(),
        },
        AgentModelOpt {
            id: "o3".into(),
            label: "o3".into(),
        },
    ]
}

fn static_pi_models() -> Vec<AgentModelOpt> {
    vec![
        AgentModelOpt {
            id: String::new(),
            label: "默认".into(),
        },
        AgentModelOpt {
            id: "openai/gpt-5.4".into(),
            label: "openai · gpt-5.4".into(),
        },
        AgentModelOpt {
            id: "anthropic/claude-sonnet-4-5".into(),
            label: "anthropic · claude-sonnet-4-5".into(),
        },
    ]
}

fn fallback_models_cache() -> AgentModelsCache {
    AgentModelsCache {
        fetched_at: 0,
        claude: static_claude_models(),
        codex: static_codex_models(),
        pi: static_pi_models(),
    }
}

fn load_models_cache() -> AgentModelsCache {
    let Ok(data) = fs::read_to_string(agent_models_path()) else {
        return fallback_models_cache();
    };
    serde_json::from_str(&data).unwrap_or_else(|_| fallback_models_cache())
}

fn save_models_cache(cache: &AgentModelsCache) {
    let _ = fs::create_dir_all(app_data_dir());
    if let Ok(data) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(agent_models_path(), data);
    }
}

fn models_cache_fresh(cache: &AgentModelsCache) -> bool {
    if cache.fetched_at == 0 {
        return false;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(cache.fetched_at) < AGENT_MODELS_TTL_SECS
        && !cache.claude.is_empty()
        && !cache.codex.is_empty()
        && !cache.pi.is_empty()
}

fn parse_pi_list_models(stdout: &str) -> Vec<AgentModelOpt> {
    let mut out = vec![AgentModelOpt {
        id: String::new(),
        label: "默认".into(),
    }];
    let mut rows: Vec<(String, String, String)> = Vec::new();
    for line in stdout.lines().skip(1) {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        // provider model context max-out thinking images  (≥6 cols; model has no spaces)
        if parts.len() < 6 {
            continue;
        }
        let thinking = parts[parts.len() - 2];
        let images = parts[parts.len() - 1];
        if !matches!(thinking, "yes" | "no") || !matches!(images, "yes" | "no") {
            continue;
        }
        let provider = parts[0];
        let model = parts[1];
        if provider == "provider" || model == "model" {
            continue;
        }
        let id = format!("{provider}/{model}");
        let label = format!("{provider} · {model}");
        rows.push((provider.to_string(), id, label));
    }
    let priority = |p: &str| -> u8 {
        match p {
            "anthropic" => 0,
            "openai" => 1,
            "google" => 2,
            "merouter" => 3,
            _ => 9,
        }
    };
    rows.sort_by(|a, b| {
        priority(&a.0)
            .cmp(&priority(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });
    for (_, id, label) in rows {
        out.push(AgentModelOpt { id, label });
    }
    out
}

fn fetch_codex_models() -> Vec<AgentModelOpt> {
    let mut out = vec![AgentModelOpt {
        id: String::new(),
        label: "默认".into(),
    }];
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return static_codex_models(),
    };
    let path = PathBuf::from(home).join(".codex/models_cache.json");
    let Ok(data) = fs::read_to_string(&path) else {
        return static_codex_models();
    };
    let Ok(v) = serde_json::from_str::<Value>(&data) else {
        return static_codex_models();
    };
    let Some(arr) = v.get("models").and_then(|m| m.as_array()) else {
        return static_codex_models();
    };
    let mut seen = std::collections::HashSet::new();
    for m in arr {
        let slug = m
            .get("slug")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if slug.is_empty() || !seen.insert(slug.to_string()) {
            continue;
        }
        let label = m
            .get("display_name")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| slug.to_string());
        out.push(AgentModelOpt {
            id: slug.to_string(),
            label,
        });
    }
    if out.len() == 1 {
        return static_codex_models();
    }
    out
}

fn fetch_pi_models(configured_bin: &str) -> Vec<AgentModelOpt> {
    let bin = match resolve_agent_bin(configured_bin, "pi") {
        Ok(p) => p,
        Err(_) => return static_pi_models(),
    };
    let mut cmd = Command::new(&bin);
    cmd.arg("--list-models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Ok(mut path_env) = std::env::var("PATH") {
        if let Ok(home) = std::env::var("HOME") {
            for prefix in [
                format!("{home}/.bun/bin"),
                format!("{home}/.local/bin"),
                "/opt/homebrew/bin".into(),
                "/usr/local/bin".into(),
            ] {
                if !path_env.split(':').any(|p| p == prefix) {
                    path_env = format!("{prefix}:{path_env}");
                }
            }
        }
        cmd.env("PATH", path_env);
    }
    let Ok(out) = cmd.output() else {
        return static_pi_models();
    };
    if !out.status.success() {
        return static_pi_models();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let parsed = parse_pi_list_models(&text);
    if parsed.len() <= 1 {
        return static_pi_models();
    }
    parsed
}

fn fetch_all_models(app: Option<&AppHandle>) -> AgentModelsCache {
    let (claude_bin, codex_bin, pi_bin) = app
        .and_then(|a| a.try_state::<AsrEngine>())
        .and_then(|e| e.inner().config.lock().ok())
        .map(|c| {
            let profile_bin = |kind: &str| {
                c.agent_profiles
                    .iter()
                    .find(|p| p.kind == kind && !p.bin.trim().is_empty())
                    .map(|p| p.bin.trim().to_string())
                    .unwrap_or_default()
            };
            (
                {
                    let b = profile_bin("claude");
                    if b.is_empty() {
                        c.agent_claude_bin.clone()
                    } else {
                        b
                    }
                },
                {
                    let b = profile_bin("codex");
                    if b.is_empty() {
                        c.agent_codex_bin.clone()
                    } else {
                        b
                    }
                },
                {
                    let b = profile_bin("pi");
                    if b.is_empty() {
                        c.agent_pi_bin.clone()
                    } else {
                        b
                    }
                },
            )
        })
        .unwrap_or_default();
    let _ = (claude_bin, codex_bin); // claude has no list CLI
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    AgentModelsCache {
        fetched_at: now,
        claude: static_claude_models(),
        codex: fetch_codex_models(),
        pi: fetch_pi_models(&pi_bin),
    }
}

fn models_refresh_lock() -> &'static Mutex<bool> {
    static LOCK: std::sync::OnceLock<Mutex<bool>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(false))
}

/// Kick background refresh if stale (or `force`). Returns current cache immediately.
pub(crate) fn kick_agent_models_refresh(app: &AppHandle, force: bool) {
    let cache = load_models_cache();
    if !force && models_cache_fresh(&cache) {
        return;
    }
    {
        let Ok(mut busy) = models_refresh_lock().lock() else {
            return;
        };
        if *busy {
            return;
        }
        *busy = true;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let next = fetch_all_models(Some(&app2));
        save_models_cache(&next);
        let _ = app2.emit("agent-models-updated", &next);
        if let Ok(mut busy) = models_refresh_lock().lock() {
            *busy = false;
        }
    });
}

/// Schedule deferred background refresh after app launch (local-first: don't block UI).
pub(crate) fn schedule_agent_models_refresh(app: &AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        kick_agent_models_refresh(&app2, false);
    });
}

#[tauri::command]
pub(crate) fn get_agent_models() -> AgentModelsCache {
    let cache = load_models_cache();
    if cache.claude.is_empty() && cache.codex.is_empty() && cache.pi.is_empty() {
        return fallback_models_cache();
    }
    // Fill missing kinds from static so UI never blank.
    let mut c = cache;
    if c.claude.is_empty() {
        c.claude = static_claude_models();
    }
    if c.codex.is_empty() {
        c.codex = static_codex_models();
    }
    if c.pi.is_empty() {
        c.pi = static_pi_models();
    }
    c
}

#[tauri::command]
pub(crate) fn refresh_agent_models(app: AppHandle, force: Option<bool>) -> AgentModelsCache {
    let force = force.unwrap_or(false);
    if force {
        // Sync path for explicit UI refresh — wait for CLI list.
        let next = fetch_all_models(Some(&app));
        save_models_cache(&next);
        let _ = app.emit("agent-models-updated", &next);
        return next;
    }
    kick_agent_models_refresh(&app, false);
    get_agent_models()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_session_and_tool_events() {
        let (sid, ev) = event_from_stream_line(
            r#"{"type":"session","version":3,"id":"abc-123","cwd":"/tmp"}"#,
        )
        .expect("session");
        assert_eq!(sid.as_deref(), Some("abc-123"));
        assert_eq!(ev.kind, "system");

        let (_, tool) = event_from_stream_line(
            r#"{"type":"tool_execution_start","toolCallId":"1","toolName":"bash","args":{"command":"ls"}}"#,
        )
        .expect("tool");
        assert_eq!(tool.kind, "tool");
        assert!(tool.title.contains("bash"));

        let (_, result) = event_from_stream_line(
            r#"{"type":"tool_execution_end","toolCallId":"1","toolName":"bash","result":"ok","isError":false}"#,
        )
        .expect("result");
        assert_eq!(result.kind, "tool_result");

        let (_, msg) = event_from_stream_line(
            r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
        )
        .expect("assistant");
        assert_eq!(msg.kind, "assistant");
        assert_eq!(msg.text, "hello");

        assert!(
            event_from_stream_line(r#"{"type":"message_update","message":{}}"#).is_none()
        );
    }

    #[test]
    fn parse_pi_list_models_table() {
        let sample = "\
provider       model                                context  max-out  thinking  images
openai         gpt-5.4                              272K     128K     yes       yes   
huggingface    deepseek-ai/DeepSeek-R1              64K      32.8K    yes       no    
merouter       claude-sonnet-4.6                    200K     64K      no        yes   
";
        let list = parse_pi_list_models(sample);
        assert_eq!(list[0].id, "");
        assert!(list.iter().any(|m| m.id == "openai/gpt-5.4"));
        assert!(list
            .iter()
            .any(|m| m.id == "huggingface/deepseek-ai/DeepSeek-R1"));
        // anthropic/openai/google/merouter float first — openai before huggingface
        let oi = list.iter().position(|m| m.id.starts_with("openai/")).unwrap();
        let hi = list
            .iter()
            .position(|m| m.id.starts_with("huggingface/"))
            .unwrap();
        assert!(oi < hi);
    }
}
