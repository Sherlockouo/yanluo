//! Strategy C: translate stable ASR prefixes while recording (translate mode only).
//! HUD shows translation only — never raw ASR.

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::AppConfig;
use crate::hud::{emit_floating_status, floating_status_slot};
use crate::state::AsrEngine;
use super::{translate_transcript, PartialResult};

const STABLE_MS: u128 = 500;
const MIN_CHARS: usize = 4;

#[derive(Debug)]
pub(crate) struct TranslateStreamState {
    pub(crate) last_asr: String,
    pub(crate) last_change: Instant,
    /// ASR prefix already sent through LLM.
    pub(crate) src_done: String,
    /// Cumulative translation for HUD / finalize.
    pub(crate) out_done: String,
    pub(crate) inflight: bool,
    pub(crate) epoch: u64,
    /// Live target-language switch in progress (HUD shows switching UX).
    pub(crate) switching: bool,
}

impl Default for TranslateStreamState {
    fn default() -> Self {
        Self {
            last_asr: String::new(),
            last_change: Instant::now(),
            src_done: String::new(),
            out_done: String::new(),
            inflight: false,
            epoch: 0,
            switching: false,
        }
    }
}

pub(crate) fn reset_translate_stream(app: &AppHandle) {
    if let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() {
        let epoch = st.epoch.wrapping_add(1);
        *st = TranslateStreamState::default();
        st.epoch = epoch;
    }
}

/// Current streamed translation (for HUD while final ASR/LLM runs).
pub(crate) fn peek_translate_out(app: &AppHandle) -> String {
    app.state::<AsrEngine>()
        .inner()
        .translate_stream
        .lock()
        .map(|st| st.out_done.clone())
        .unwrap_or_default()
}

pub(crate) fn take_translate_stream(app: &AppHandle) -> (String, String) {
    if let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() {
        let src = std::mem::take(&mut st.src_done);
        let out = std::mem::take(&mut st.out_done);
        st.last_asr.clear();
        st.inflight = false;
        st.epoch = st.epoch.wrapping_add(1);
        return (src, out);
    }
    (String::new(), String::new())
}

/// Fn / transcribe: emit ASR partials. Translate: track text, never show raw on HUD.
#[allow(dead_code)]
pub(crate) fn handle_asr_partial(app: &AppHandle, text: &str) {
    handle_asr_partial_ex(app, text, "", text, 0);
}

/// Emit structured partial (committed + active). `text` is the HUD display string.
pub(crate) fn handle_asr_partial_ex(
    app: &AppHandle,
    text: &str,
    committed: &str,
    active: &str,
    segment_index: usize,
) {
    if text.is_empty() && committed.is_empty() && active.is_empty() {
        return;
    }
    let mode = AsrEngine::session_mode(app);
    if mode != "translate" {
        let payload = PartialResult {
            text: text.to_string(),
            committed: committed.to_string(),
            active: active.to_string(),
            segment_index,
        };
        // Dual-emit: floating webview may miss broadcast-only events (parity with audio-level).
        let _ = app.emit("partial-result", &payload);
        let _ = app.emit_to("floating", "partial-result", &payload);
        // Keep Rust slot in sync with HUD — accept_floating_preview / stop_recording
        // read slot.text; FE keepLive alone is not enough (mid-pipeline Fn was silent-empty).
        if !text.is_empty() {
            if let Ok(mut slot) = floating_status_slot(app).lock() {
                slot.text = text.to_string();
            }
        }
        return;
    }

    let text = super::sanitize_asr_for_translate(text);
    if text.is_empty() {
        return;
    }

    if let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() {
        if text != st.last_asr {
            if !st.src_done.is_empty() && !text.starts_with(&st.src_done) {
                crate::elog::elog!("[llm] translate stream reset (ASR rewrite)");
                st.src_done.clear();
                st.out_done.clear();
                st.epoch = st.epoch.wrapping_add(1);
                st.inflight = false;
            }
            st.last_asr = text;
            st.last_change = Instant::now();
        }
    }
}

/// VAD/hard-cap commit: freeze ASR prefix and nudge translate without waiting
/// for another STABLE_MS of idle partials.
pub(crate) fn notify_asr_committed(app: &AppHandle, committed: &str) {
    if AsrEngine::session_mode(app) != "translate" {
        return;
    }
    let text = super::sanitize_asr_for_translate(committed);
    if text.is_empty() {
        return;
    }
    if let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() {
        if !st.src_done.is_empty() && !text.starts_with(&st.src_done) {
            st.src_done.clear();
            st.out_done.clear();
            st.epoch = st.epoch.wrapping_add(1);
            st.inflight = false;
        }
        st.last_asr = text;
        // Make the next tick eligible immediately.
        st.last_change = Instant::now()
            .checked_sub(Duration::from_millis(STABLE_MS as u64 + 50))
            .unwrap_or_else(Instant::now);
    }
    tick_translate_stable(app);
}

/// Called on the streaming poll loop (~50ms). Spawns async translate when prefix is stable.
pub(crate) fn tick_translate_stable(app: &AppHandle) {
    if AsrEngine::session_mode(app) != "translate" {
        return;
    }

    let config = app
        .state::<AsrEngine>()
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    if config.llm_api_base_url.trim().is_empty() || config.llm_model.trim().is_empty() {
        return;
    }

    let (segment, epoch) = {
        let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() else {
            return;
        };
        if st.inflight || st.last_asr.is_empty() {
            return;
        }
        if st.last_change.elapsed().as_millis() < STABLE_MS {
            return;
        }
        if !st.src_done.is_empty() && !st.last_asr.starts_with(&st.src_done) {
            st.src_done.clear();
            st.out_done.clear();
            st.epoch = st.epoch.wrapping_add(1);
        }
        let rest = match st.last_asr.get(st.src_done.len()..) {
            Some(r) => r,
            None => {
                st.src_done.clear();
                st.out_done.clear();
                return;
            }
        };
        let segment = pick_stable_segment(rest).to_string();
        if segment.chars().count() < MIN_CHARS {
            return;
        }
        st.inflight = true;
        (segment, st.epoch)
    };

    crate::elog::elog!(
        "[llm] translate stable segment chars={} epoch={}",
        segment.chars().count(),
        epoch
    );

    let app2 = app.clone();
    std::thread::Builder::new()
        .name("llm-translate-stream".into())
        .spawn(move || {
            match translate_transcript(&config, &segment) {
                Ok(tr) => {
                    apply_stream_translation(&app2, epoch, &segment, &tr);
                }
                Err(e) => {
                    crate::elog::elog!("[llm] translate stream failed: {e}");
                    if let Ok(mut st) = app2.state::<AsrEngine>().inner().translate_stream.lock() {
                        if st.epoch == epoch {
                            st.inflight = false;
                        }
                    }
                }
            }
        })
        .ok();
}

fn apply_stream_translation(app: &AppHandle, epoch: u64, segment: &str, translated: &str) {
    let out = {
        let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() else {
            return;
        };
        if st.epoch != epoch {
            return;
        }
        st.src_done.push_str(segment);
        append_translation(&mut st.out_done, translated);
        st.inflight = false;
        st.switching = false;
        st.out_done.clone()
    };
    if out.is_empty() {
        return;
    }
    // Translate mode: HUD text is translation only.
    emit_floating_status(app, true, "recording", &out, 0.0);
    let _ = app.emit(
        "partial-result",
        &PartialResult::display(out),
    );
}

fn pick_stable_segment(rest: &str) -> &str {
    const PUNCT: &[char] = &['。', '！', '？', '.', '!', '?', '\n', '；', ';', '，', ',', '、'];
    let mut last_end = None;
    for (i, ch) in rest.char_indices() {
        if PUNCT.contains(&ch) {
            last_end = Some(i + ch.len_utf8());
        }
    }
    if let Some(end) = last_end {
        let piece = &rest[..end];
        if piece.chars().count() >= MIN_CHARS {
            return piece;
        }
    }
    rest
}

pub(crate) fn append_translation(dst: &mut String, piece: &str) {
    let piece = piece.trim();
    if piece.is_empty() {
        return;
    }
    if !dst.is_empty() {
        let last = dst.chars().last().unwrap();
        let first = piece.chars().next().unwrap();
        if last.is_ascii_alphanumeric() && first.is_ascii_alphanumeric() {
            dst.push(' ');
        }
    }
    dst.push_str(piece);
}

/// Wait briefly for an in-flight stable translate before finalize consumes the stream.
#[allow(dead_code)]
pub(crate) fn wait_translate_inflight(app: &AppHandle, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        let inflight = app
            .state::<AsrEngine>()
            .inner()
            .translate_stream
            .lock()
            .map(|st| st.inflight)
            .unwrap_or(false);
        if !inflight {
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Live target-language change during an active translate session:
/// wipe accumulated translation and re-translate the full current ASR.
pub(crate) fn retarget_translate_stream(app: &AppHandle) {
    if AsrEngine::session_mode(app) != "translate" {
        return;
    }

    let config = app
        .state::<AsrEngine>()
        .inner()
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();

    let (asr, epoch) = {
        let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() else {
            return;
        };
        st.src_done.clear();
        st.out_done.clear();
        st.inflight = true;
        st.switching = true;
        st.epoch = st.epoch.wrapping_add(1);
        // Allow tick to resume after retarget finishes even if ASR is quiet.
        st.last_change = Instant::now()
            .checked_sub(Duration::from_millis(STABLE_MS as u64 + 50))
            .unwrap_or_else(Instant::now);
        (st.last_asr.clone(), st.epoch)
    };

    crate::elog::elog!(
        "[llm] translate retarget → {} (asr_chars={})",
        config.translate_target_language,
        asr.chars().count()
    );

    // Clear HUD text immediately; badge updates via emit (switching=true).
    emit_floating_status(app, true, "recording", "", 0.0);
    let _ = app.emit(
        "partial-result",
        &PartialResult::display(String::new()),
    );
    let _ = app.emit_to(
        "floating",
        "partial-result",
        &PartialResult::display(String::new()),
    );

    if asr.trim().is_empty() || !llm_ready(&config) {
        if let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() {
            if st.epoch == epoch {
                st.inflight = false;
                st.switching = false;
            }
        }
        emit_floating_status(app, true, "recording", "", 0.0);
        return;
    }

    let app2 = app.clone();
    std::thread::Builder::new()
        .name("llm-translate-retarget".into())
        .spawn(move || {
            match translate_transcript(&config, &asr) {
                Ok(tr) => apply_retarget_translation(&app2, epoch, &asr, &tr),
                Err(e) => {
                    crate::elog::elog!("[llm] translate retarget failed: {e}");
                    if let Ok(mut st) = app2.state::<AsrEngine>().inner().translate_stream.lock() {
                        if st.epoch == epoch {
                            st.inflight = false;
                            st.switching = false;
                        }
                    }
                    emit_floating_status(&app2, true, "recording", "", 0.0);
                    let _ = app2.emit("partial-error", format!("切换目标语言后重译失败: {e}"));
                }
            }
        })
        .ok();
}

fn apply_retarget_translation(app: &AppHandle, epoch: u64, asr: &str, translated: &str) {
    let out = {
        let Ok(mut st) = app.state::<AsrEngine>().inner().translate_stream.lock() else {
            return;
        };
        if st.epoch != epoch {
            return;
        }
        // Full replace — not append — so the new target owns the whole buffer.
        st.src_done = asr.to_string();
        st.out_done = translated.trim().to_string();
        st.inflight = false;
        st.switching = false;
        st.out_done.clone()
    };
    emit_floating_status(app, true, "recording", &out, 0.0);
    let payload = PartialResult::display(out);
    let _ = app.emit("partial-result", &payload);
    let _ = app.emit_to("floating", "partial-result", &payload);
}

#[allow(dead_code)]
pub(crate) fn llm_ready(config: &AppConfig) -> bool {
    !config.llm_api_base_url.trim().is_empty() && !config.llm_model.trim().is_empty()
}
