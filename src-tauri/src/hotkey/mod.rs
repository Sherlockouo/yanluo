use serde::Serialize;
#[cfg(target_os = "macos")]
use core_foundation::runloop::CFRunLoop;
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CallbackResult, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventType,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use crate::hud::{
    close_floating_lang_menu, emit_floating_status, floating_lang_menu_is_open,
    floating_status_slot,
};
use crate::state::*;
use crate::config::*;

#[derive(Clone, Debug, Default)]
pub(crate) enum HotkeyCaptureSlot {
    #[default]
    None,
    Transcribe,
    Translate,
    Cancel,
    Agent,
}

impl HotkeyCaptureSlot {
    pub(crate) fn from_str(s: &str) -> Self {
        match s {
            "transcribe" => Self::Transcribe,
            "translate" => Self::Translate,
            "cancel" => Self::Cancel,
            "agent" => Self::Agent,
            _ => Self::None,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Transcribe => "transcribe",
            Self::Translate => "translate",
            Self::Cancel => "cancel",
            Self::Agent => "agent",
        }
    }
}

/// Chord being assembled while settings capture is active.
#[derive(Clone, Debug, Default)]
struct CaptureChord {
    /// Fn is held; commit on Fn release so Shift/⌃/⌥ can join mid-hold.
    fn_armed: bool,
    /// Peak modifiers seen while the chord is active (survives early Shift release).
    peak_mods: Vec<String>,
}

fn merge_mods(peak: &mut Vec<String>, current: &[String]) {
    for m in current {
        if !peak.iter().any(|x| x == m) {
            peak.push(m.clone());
        }
    }
    peak.sort();
}

/// True while cancel hotkey should be consumed (recording / processing / HUD confirm).
fn cancel_hotkey_is_actionable(app: &AppHandle) -> bool {
    if let Some(engine) = app.try_state::<AsrEngine>() {
        if engine.inner().recording.load(Ordering::Acquire) {
            return true;
        }
        if engine
            .inner()
            .recorder
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
        {
            return true;
        }
        if AsrEngine::has_pending_hud_confirm(app) {
            return true;
        }
    }
    floating_status_slot(app)
        .lock()
        .map(|s| {
            s.visible
                && matches!(
                    s.state.as_str(),
                    "recording" | "processing" | "refining" | "editing"
                )
                && s.intention.as_deref() != Some("agent")
        })
        .unwrap_or(false)
}

fn hud_confirm_editing(app: &AppHandle) -> bool {
    AsrEngine::has_pending_hud_confirm(app)
        || floating_status_slot(app)
            .lock()
            .map(|s| {
                s.visible
                    && s.state == "editing"
                    && s.intention.as_deref() != Some("agent")
            })
            .unwrap_or(false)
}

/// Spinner mid-state (LLM refine / finalize): Fn accepts HUD text now.
fn hud_skip_pipeline(app: &AppHandle) -> bool {
    floating_status_slot(app)
        .lock()
        .map(|s| {
            s.visible
                && matches!(s.state.as_str(), "refining" | "processing")
                && s.intention.as_deref() != Some("agent")
        })
        .unwrap_or(false)
}

fn emit_hud_skip_or_confirm(app: &AppHandle) -> bool {
    if hud_confirm_editing(app) {
        // Fn consumed by HUD interaction — no session will start.
        crate::audio::discard_speculative_mic();
        let _ = app.emit_to("floating", "hud-confirm-request", ());
        let _ = app.emit("hud-confirm-request", ());
        return true;
    }
    if hud_skip_pipeline(app) {
        crate::audio::discard_speculative_mic();
        let _ = app.emit_to("floating", "hud-accept-preview-request", ());
        let _ = app.emit("hud-accept-preview-request", ());
        return true;
    }
    false
}

/// Fn key-down: warm the mic while the chord is still being decided (release
/// commits). Config-gated (`speculative_mic`), External capture only, skipped
/// while a session is live or while rebinding chords. Never blocks the tap —
/// stream construction happens on its own thread.
fn maybe_begin_speculative_mic(app: &AppHandle) {
    // t0 of the press→popup→first-word chain (timestamps via elog).
    crate::elog::elog!("[fn] key-down: arming (speculative warm-start attempt)");
    let Some(engine) = app.try_state::<AsrEngine>() else {
        return;
    };
    if engine.inner().recording.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let Some(cfg) = engine.inner().config.lock().ok() else {
        return;
    };
    if !cfg.speculative_mic
        || cfg.audio_capture_mode != crate::audio::AudioCaptureMode::External
        || (!binding_is_fn(&cfg.hotkey_transcribe) && !binding_is_fn(&cfg.hotkey_translate))
    {
        return;
    }
    drop(cfg);
    crate::audio::begin_speculative_mic(engine.inner().live_meter.clone());
}

pub(crate) fn start_fn_event_tap(app: AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        crate::elog::elog!("[fn] global Fn listener is macOS-only");
        return;
    }
        #[cfg(target_os = "macos")]
        {
            #[derive(Clone, Serialize)]
            struct CapturedPayload {
            slot: String,
            binding: HotkeyBinding,
        }

        #[derive(Clone, Serialize)]
        struct CapturePreview {
            label: String,
        }

        fn modifiers_from_flags(flags: CGEventFlags) -> Vec<String> {
            let mut mods = Vec::new();
            if flags.contains(CGEventFlags::CGEventFlagControl) {
                mods.push("control".into());
            }
            if flags.contains(CGEventFlags::CGEventFlagAlternate) {
                mods.push("option".into());
            }
            if flags.contains(CGEventFlags::CGEventFlagShift) {
                mods.push("shift".into());
            }
            if flags.contains(CGEventFlags::CGEventFlagCommand) {
                mods.push("command".into());
            }
            mods
        }

        fn read_hotkeys(
            app: &AppHandle,
        ) -> (HotkeyBinding, HotkeyBinding, HotkeyBinding, HotkeyBinding) {
            app.try_state::<AsrEngine>()
                .and_then(|engine| {
                    engine
                        .inner()
                        .config
                        .lock()
                        .ok()
                        .map(|c| {
                            (
                                c.hotkey_transcribe.clone(),
                                c.hotkey_translate.clone(),
                                c.hotkey_cancel.clone(),
                                c.hotkey_agent.clone(),
                            )
                        })
                })
                .unwrap_or_else(|| {
                    (
                        default_hotkey_transcribe(),
                        default_hotkey_translate(),
                        default_hotkey_cancel(),
                        default_hotkey_agent(),
                    )
                })
        }

        fn capture_slot(app: &AppHandle) -> HotkeyCaptureSlot {
            app.try_state::<Arc<Mutex<HotkeyCaptureSlot>>>()
                .and_then(|s| s.lock().ok().map(|g| g.clone()))
                .unwrap_or_default()
        }

        fn clear_capture(app: &AppHandle) {
            if let Some(slot) = app.try_state::<Arc<Mutex<HotkeyCaptureSlot>>>() {
                if let Ok(mut g) = slot.lock() {
                    *g = HotkeyCaptureSlot::None;
                }
            }
        }

        fn emit_preview(app: &AppHandle, key: &str, mods: &[String]) {
            let label = format_hotkey_label(key, mods);
            let _ = app.emit("hotkey-capture-preview", CapturePreview { label });
        }

        fn apply_captured(app: &AppHandle, slot: &HotkeyCaptureSlot, binding: HotkeyBinding) {
            if matches!(slot, HotkeyCaptureSlot::None) {
                return;
            }
            if let Some(engine) = app.try_state::<AsrEngine>() {
                if let Ok(mut config) = engine.inner().config.lock() {
                    match slot {
                        HotkeyCaptureSlot::Transcribe => config.hotkey_transcribe = binding.clone(),
                        HotkeyCaptureSlot::Translate => config.hotkey_translate = binding.clone(),
                        HotkeyCaptureSlot::Cancel => config.hotkey_cancel = binding.clone(),
                        HotkeyCaptureSlot::Agent => config.hotkey_agent = binding.clone(),
                        HotkeyCaptureSlot::None => {}
                    }
                    let snapshot = config.clone();
                    drop(config);
                    let _ = save_config_to_disk(&snapshot);
                    let _ = app.emit("config-updated", &snapshot);
                }
            }
            let _ = app.emit(
                "hotkey-captured",
                CapturedPayload {
                    slot: slot.as_str().into(),
                    binding,
                },
            );
            clear_capture(app);
        }

        std::thread::Builder::new()
            .name("fn-event-tap".into())
            .spawn(move || {
                use core_graphics::event::{EventField, KeyCode};

                let fn_down = Arc::new(AtomicBool::new(false));
                let fn_down_cb = fn_down.clone();
                let suppress_fn_release = Arc::new(AtomicBool::new(false));
                let suppress_fn_release_cb = suppress_fn_release.clone();
                let chord = Arc::new(Mutex::new(CaptureChord::default()));
                let chord_cb = chord.clone();
                let app_cb = app.clone();
                let escape_keycode = KeyCode::ESCAPE as i64;
                let space_keycode = 49i64;
                let installed = CGEventTap::with_enabled(
                    CGEventTapLocation::HID,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::Default,
                    // KeyUp needed so non-Fn chords can also finalize on release if we extend later;
                    // today KeyDown commits non-Fn chords (modifiers already held).
                    vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
                    move |_proxy, event_type, event| {
                        let et = event_type as u32;
                        let capturing = capture_slot(&app_cb);
                        let is_capturing = !matches!(capturing, HotkeyCaptureSlot::None);

                        if et == CGEventType::KeyDown as u32 {
                            let keycode = event
                                .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                            let autorepeat = event
                                .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT);
                            if autorepeat != 0 {
                                return CallbackResult::Keep;
                            }
                            let flags = event.get_flags();
                            let mods = modifiers_from_flags(flags);
                            let key = if keycode == escape_keycode {
                                "escape".to_string()
                            } else {
                                keycode.to_string()
                            };
                            let fn_held = fn_down_cb.load(Ordering::Acquire);

                            if is_capturing {
                                // Esc aborts (unless recording the cancel slot itself).
                                if key == "escape"
                                    && !matches!(capturing, HotkeyCaptureSlot::Cancel)
                                    && mods.is_empty()
                                {
                                    if let Ok(mut c) = chord_cb.lock() {
                                        *c = CaptureChord::default();
                                    }
                                    clear_capture(&app_cb);
                                    let _ = app_cb.emit("hotkey-capture-cancelled", ());
                                    return CallbackResult::Drop;
                                }
                                // Regular key + any modifiers (⌃⌥⇧⌘+Key) — commit now.
                                // Fn+key (e.g. Fn+Space for agent): include pseudo "fn" mod.
                                if let Ok(mut c) = chord_cb.lock() {
                                    *c = CaptureChord::default();
                                }
                                let mut capture_mods = mods.clone();
                                if fn_held && !capture_mods.iter().any(|m| m == "fn") {
                                    capture_mods.push("fn".into());
                                    capture_mods.sort();
                                }
                                let binding = binding_from_event(&key, capture_mods);
                                apply_captured(&app_cb, &capturing, binding);
                                return CallbackResult::Drop;
                            }

                            let (hk_transcribe, hk_translate, hk_cancel, hk_agent) =
                                read_hotkeys(&app_cb);

                            // Lang / agent picker Esc close (outside-HUD menus).
                            if key == "escape" && mods.is_empty() {
                                if floating_lang_menu_is_open() {
                                    close_floating_lang_menu(&app_cb);
                                    return CallbackResult::Drop;
                                }
                                if crate::hud::floating_agent_menu_is_open() {
                                    crate::hud::close_floating_agent_menu(&app_cb);
                                    return CallbackResult::Drop;
                                }
                            }

                            // Agent mode Esc: cancel / dismiss.
                            if key == "escape" && mods.is_empty() {
                                let agent_open = floating_status_slot(&app_cb)
                                    .lock()
                                    .map(|s| {
                                        s.visible && s.intention.as_deref() == Some("agent")
                                    })
                                    .unwrap_or(false);
                                if agent_open {
                                    let hud_state = floating_status_slot(&app_cb)
                                        .lock()
                                        .map(|s| s.state.clone())
                                        .unwrap_or_default();
                                    let recording = app_cb
                                        .try_state::<AsrEngine>()
                                        .map(|e| e.inner().recording.load(Ordering::Acquire))
                                        .unwrap_or(false);
                                    if recording
                                        || matches!(
                                            hud_state.as_str(),
                                            "recording" | "processing" | "refining"
                                        )
                                    {
                                        crate::elog::elog!("[asr] agent Esc → cancel ({hud_state})");
                                        if let Some(engine) = app_cb.try_state::<AsrEngine>() {
                                            crate::commands::cancel_recording_with_reason(
                                                &app_cb,
                                                engine.inner(),
                                                "agent-esc",
                                            );
                                        }
                                        let _ = app_cb.emit_to("floating", "agent-voice-cancel", ());
                                    } else {
                                        emit_floating_status(&app_cb, false, "idle", "", 0.0);
                                    }
                                    return CallbackResult::Drop;
                                }
                            }

                            // Agent summon: Fn held + Space (default), or configured binding.
                            if fn_held {
                                let mut agent_mods = mods.clone();
                                if !agent_mods.iter().any(|m| m == "fn") {
                                    agent_mods.push("fn".into());
                                }
                                if binding_matches(&hk_agent, &key, &agent_mods)
                                    || (hk_agent.key == "49"
                                        && keycode == space_keycode
                                        && hk_agent.modifiers.iter().any(|m| m == "fn")
                                        && mods.is_empty())
                                {
                                    suppress_fn_release_cb.store(true, Ordering::Release);
                                    if let Ok(mut c) = chord_cb.lock() {
                                        *c = CaptureChord::default();
                                    }
                                    let _ = app_cb.emit("agent-summon", ());
                                    return CallbackResult::Drop;
                                }
                            }
                            if !hk_agent.modifiers.iter().any(|m| m == "fn")
                                && binding_matches(&hk_agent, &key, &mods)
                            {
                                let _ = app_cb.emit("agent-summon", ());
                                return CallbackResult::Drop;
                            }

                            if binding_matches(&hk_cancel, &key, &mods) {
                                // Never swallow cancel when idle — other apps need the key.
                                if cancel_hotkey_is_actionable(&app_cb) {
                                    if hud_confirm_editing(&app_cb) {
                                        let _ = app_cb.emit_to("floating", "hud-cancel-request", ());
                                        let _ = app_cb.emit("hud-cancel-request", ());
                                    } else {
                                        let _ = app_cb.emit("escape-key-down", ());
                                    }
                                    return CallbackResult::Drop;
                                }
                                return CallbackResult::Keep;
                            }

                            // Non-Fn action hotkeys (e.g. ⌃+Space) — full equivalent of ⇧+Fn etc.
                            if !binding_is_fn(&hk_translate)
                                && binding_matches(&hk_translate, &key, &mods)
                            {
                                if emit_hud_skip_or_confirm(&app_cb) {
                                    return CallbackResult::Drop;
                                }
                                // Native fast path — no webview round-trip before the
                                // HUD starts showing (see handle_fn_toggle).
                                let _ = app_cb.emit("fn-toggle-native", "translate");
                                return CallbackResult::Drop;
                            }
                            if !binding_is_fn(&hk_transcribe)
                                && binding_matches(&hk_transcribe, &key, &mods)
                            {
                                if emit_hud_skip_or_confirm(&app_cb) {
                                    return CallbackResult::Drop;
                                }
                                let _ = app_cb.emit("fn-toggle-native", "transcribe");
                                return CallbackResult::Drop;
                            }

                            return CallbackResult::Keep;
                        }

                        if et != CGEventType::FlagsChanged as u32 {
                            return CallbackResult::Keep;
                        }

                        let flags = event.get_flags();
                        let has_fn = flags.contains(CGEventFlags::CGEventFlagSecondaryFn);
                        let was_down = fn_down_cb.swap(has_fn, Ordering::AcqRel);
                        let mods = modifiers_from_flags(flags);

                        // --- Capture mode: multi-key chords ---
                        // Fn commits on *release* so Shift/⌃/⌥ can be added while Fn is held.
                        // Peak mods survive releasing Shift a frame before Fn.
                        if is_capturing {
                            if let Ok(mut c) = chord_cb.lock() {
                                if has_fn {
                                    merge_mods(&mut c.peak_mods, &mods);
                                    if !was_down {
                                        c.fn_armed = true;
                                    }
                                    let preview_mods = if c.peak_mods.is_empty() {
                                        mods.clone()
                                    } else {
                                        c.peak_mods.clone()
                                    };
                                    emit_preview(&app_cb, "fn", &preview_mods);
                                    return CallbackResult::Drop;
                                }

                                // Fn released while armed → commit chord.
                                if was_down && c.fn_armed {
                                    merge_mods(&mut c.peak_mods, &mods);
                                    let final_mods = c.peak_mods.clone();
                                    *c = CaptureChord::default();
                                    drop(c);
                                    let binding = binding_from_event("fn", final_mods);
                                    apply_captured(&app_cb, &capturing, binding);
                                    return CallbackResult::Drop;
                                }

                                // Modifier-only preview (⇧ / ⌃ / …) — wait for Fn or a key.
                                if !mods.is_empty() {
                                    emit_preview(&app_cb, "…", &mods);
                                }
                            }
                            return CallbackResult::Keep;
                        }

        // --- Normal mode: Fn action commits on *release* ---
        // Same as capture: Fn→then→Shift still counts as ⇧+Fn.
        // Peak mods survive releasing Shift a frame before Fn.
        if let Ok(mut c) = chord_cb.lock() {
            if has_fn {
                merge_mods(&mut c.peak_mods, &mods);
                if !was_down {
                    c.fn_armed = true;
                    // Press→release is dead time otherwise; warm the mic now.
                    maybe_begin_speculative_mic(&app_cb);
                }
                return CallbackResult::Drop;
            }

                            if was_down && c.fn_armed {
                                merge_mods(&mut c.peak_mods, &mods);
                                let final_mods = c.peak_mods.clone();
                                *c = CaptureChord::default();
                                drop(c);

                                // Fn+Space already handled on KeyDown — skip transcribe.
                                if suppress_fn_release_cb.swap(false, Ordering::AcqRel) {
                                    return CallbackResult::Drop;
                                }

                                let (hk_transcribe, hk_translate, _hk_cancel, _hk_agent) =
                                    read_hotkeys(&app_cb);

                                if binding_is_fn(&hk_translate)
                                    && binding_matches(&hk_translate, "fn", &final_mods)
                                {
                                    if emit_hud_skip_or_confirm(&app_cb) {
                                        return CallbackResult::Drop;
                                    }
                                    // Native fast path — no webview round-trip before the
                                    // HUD starts showing (see handle_fn_toggle).
                                    let _ = app_cb.emit("fn-toggle-native", "translate");
                                    return CallbackResult::Drop;
                                }
                                if binding_is_fn(&hk_transcribe)
                                    && binding_matches(&hk_transcribe, "fn", &final_mods)
                                {
                                    if emit_hud_skip_or_confirm(&app_cb) {
                                        return CallbackResult::Drop;
                                    }
                                    let _ = app_cb.emit("fn-toggle-native", "transcribe");
                                    return CallbackResult::Drop;
                                }
                                if binding_is_fn(&hk_transcribe) || binding_is_fn(&hk_translate)
                                {
                                    // Fn chord matched no action — press armed but unused.
                                    crate::audio::discard_speculative_mic();
                                    return CallbackResult::Drop;
                                }
                            }
                        }
                        CallbackResult::Keep
                    },
                    CFRunLoop::run_current,
                );
                if installed.is_err() {
                    let _ = app.emit(
                        "fn-listener-error",
                        "Fn global listener failed. Grant Accessibility/Input Monitoring permissions.",
                    );
                }
            })
            .expect("failed to spawn fn event tap thread");
    }
}
