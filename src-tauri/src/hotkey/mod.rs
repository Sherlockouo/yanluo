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
use crate::state::*;
use crate::config::*;

#[derive(Clone, Debug, Default)]
pub(crate) enum HotkeyCaptureSlot {
    #[default]
    None,
    Transcribe,
    Translate,
    Cancel,
}

impl HotkeyCaptureSlot {
    pub(crate) fn from_str(s: &str) -> Self {
        match s {
            "transcribe" => Self::Transcribe,
            "translate" => Self::Translate,
            "cancel" => Self::Cancel,
            _ => Self::None,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Transcribe => "transcribe",
            Self::Translate => "translate",
            Self::Cancel => "cancel",
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

pub(crate) fn start_fn_event_tap(app: AppHandle) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        eprintln!("[fn] global Fn listener is macOS-only");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        #[derive(Clone, Serialize)]
        struct HotkeyPayload {
            intention: String,
            #[serde(skip_serializing_if = "std::ops::Not::not")]
            shift: bool,
        }

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

        fn read_hotkeys(app: &AppHandle) -> (HotkeyBinding, HotkeyBinding, HotkeyBinding) {
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
                            )
                        })
                })
                .unwrap_or_else(|| {
                    (
                        default_hotkey_transcribe(),
                        default_hotkey_translate(),
                        default_hotkey_cancel(),
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
                let chord = Arc::new(Mutex::new(CaptureChord::default()));
                let chord_cb = chord.clone();
                let app_cb = app.clone();
                let escape_keycode = KeyCode::ESCAPE as i64;
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
                                // Modifiers alone never arrive as KeyDown.
                                if let Ok(mut c) = chord_cb.lock() {
                                    *c = CaptureChord::default();
                                }
                                let binding = binding_from_event(&key, mods);
                                apply_captured(&app_cb, &capturing, binding);
                                return CallbackResult::Drop;
                            }

                            let (hk_transcribe, hk_translate, hk_cancel) = read_hotkeys(&app_cb);

                            if binding_matches(&hk_cancel, &key, &mods) {
                                let _ = app_cb.emit("escape-key-down", ());
                                return CallbackResult::Drop;
                            }

                            // Non-Fn action hotkeys (e.g. ⌃+Space) — full equivalent of ⇧+Fn etc.
                            if !binding_is_fn(&hk_translate)
                                && binding_matches(&hk_translate, &key, &mods)
                            {
                                let _ = app_cb.emit(
                                    "fn-key-down",
                                    HotkeyPayload {
                                        intention: "translate".into(),
                                        shift: true,
                                    },
                                );
                                return CallbackResult::Drop;
                            }
                            if !binding_is_fn(&hk_transcribe)
                                && binding_matches(&hk_transcribe, &key, &mods)
                            {
                                let _ = app_cb.emit(
                                    "fn-key-down",
                                    HotkeyPayload {
                                        intention: "transcribe".into(),
                                        shift: false,
                                    },
                                );
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
                                }
                                return CallbackResult::Drop;
                            }

                            if was_down && c.fn_armed {
                                merge_mods(&mut c.peak_mods, &mods);
                                let final_mods = c.peak_mods.clone();
                                *c = CaptureChord::default();
                                drop(c);

                                let (hk_transcribe, hk_translate, _hk_cancel) =
                                    read_hotkeys(&app_cb);

                                if binding_is_fn(&hk_translate)
                                    && binding_matches(&hk_translate, "fn", &final_mods)
                                {
                                    let _ = app_cb.emit(
                                        "fn-key-down",
                                        HotkeyPayload {
                                            intention: "translate".into(),
                                            shift: true,
                                        },
                                    );
                                    return CallbackResult::Drop;
                                }
                                if binding_is_fn(&hk_transcribe)
                                    && binding_matches(&hk_transcribe, "fn", &final_mods)
                                {
                                    let _ = app_cb.emit(
                                        "fn-key-down",
                                        HotkeyPayload {
                                            intention: "transcribe".into(),
                                            shift: false,
                                        },
                                    );
                                    return CallbackResult::Drop;
                                }
                                if binding_is_fn(&hk_transcribe) || binding_is_fn(&hk_translate)
                                {
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
