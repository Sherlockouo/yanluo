use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::state::*;
use crate::config::*;
use crate::platform::*;

#[derive(Clone, Serialize)]
pub(crate) struct AudioLevelPayload {
    pub(crate) rms: f32,
    pub(crate) bands: Vec<f32>,
}

pub(crate) const HUD_BAND_COUNT: usize = 6;

pub(crate) fn spawn_audio_level_pump(app: AppHandle, recording: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while recording.load(Ordering::Acquire) {
            if let Some((rms, bands)) = AsrEngine::get_audio_level(&app, HUD_BAND_COUNT) {
                if let Ok(mut slot) = floating_status_slot(&app).lock() {
                    slot.rms = rms;
                }
                let payload = AudioLevelPayload { rms, bands };
                let _ = app.emit("audio-level", &payload);
                let _ = app.emit_to("floating", "audio-level", &payload);
            }
            std::thread::sleep(Duration::from_millis(16));
        }
        if let Ok(mut slot) = floating_status_slot(&app).lock() {
            slot.rms = 0.0;
        }
        let silence = AudioLevelPayload {
            rms: 0.0,
            bands: vec![0.0; HUD_BAND_COUNT],
        };
        let _ = app.emit("audio-level", &silence);
        let _ = app.emit_to("floating", "audio-level", &silence);
    });
}

#[derive(Clone, Serialize)]
pub(crate) struct FloatingStatus {
    pub(crate) visible: bool,
    pub(crate) state: String,
    pub(crate) text: String,
    pub(crate) rms: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) intention: Option<String>,
    /// Translate target language id (e.g. en-US). Translate sessions only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_language: Option<String>,
    /// True while clearing + re-translating after a live target switch.
    #[serde(default)]
    pub(crate) switching: bool,
}

impl Default for FloatingStatus {
    fn default() -> Self {
        Self {
            visible: false,
            state: "idle".into(),
            text: String::new(),
            rms: 0.0,
            intention: None,
            target_language: None,
            switching: false,
        }
    }
}

pub(crate) fn floating_status_slot(app: &AppHandle) -> Arc<Mutex<FloatingStatus>> {
    app.state::<Arc<Mutex<FloatingStatus>>>().inner().clone()
}

/// Remember the app that had focus before HUD / paste, so we can hand it back
/// and so Cmd+V lands in the right place.
pub(crate) fn set_floating_window_visible(app: &AppHandle, visible: bool) {
    let show_lang = visible
        && floating_status_slot(app)
            .lock()
            .map(|s| s.intention.as_deref() == Some("translate"))
            .unwrap_or(false);
    let app = app.clone();
    // Window show/hide must run on the AppKit main thread.
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            if visible {
                // Do NOT toggle Accessory/Regular here — that steals focus and
                // makes Fn/cancel "jump back" to ASR Workshop. HUD was created
                // under Accessory once at launch so FullScreenAuxiliary sticks.
                remember_frontmost_app();
                let width = window
                    .inner_size()
                    .ok()
                    .and_then(|s| {
                        window
                            .scale_factor()
                            .ok()
                            .map(|scale| s.width as f64 / scale.max(1.0))
                    })
                    .unwrap_or(FLOATING_HUD_MIN_W);
                let (x, y) = resolve_hud_logical_position(&app, width);
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                let _ = window.set_always_on_top(true);
                // Prefer orderFrontRegardless over Tauri show()/set_focus —
                // those activate the app and steal keyboard focus.
                #[cfg(target_os = "macos")]
                {
                    raise_floating_hud_level(&window, true);
                    eprintln!("[floating] orderFrontRegardless at logical ({x:.0}, {y:.0})");
                }
                #[cfg(not(target_os = "macos"))]
                match window.show() {
                    Ok(()) => eprintln!("[floating] show() at logical ({x:.0}, {y:.0})"),
                    Err(e) => eprintln!("[floating] show() failed: {e}"),
                }
                sync_floating_lang_chip(&app, show_lang);
            } else {
                persist_floating_hud_position(&window);
                sync_floating_lang_chip(&app, false);
                let app_hide = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(240));
                    let _ = app_hide.clone().run_on_main_thread(move || {
                        if let Some(window) = app_hide.get_webview_window("floating") {
                            if let Ok(slot) = floating_status_slot(&app_hide).lock() {
                                if slot.visible {
                                    return;
                                }
                            }
                            let _ = window.hide();
                            eprintln!("[floating] hide()");
                            sync_floating_lang_chip(&app_hide, false);
                            // Hand focus back if we somehow became active.
                            restore_previous_frontmost_app(true);
                        }
                    });
                });
            }
        } else {
            eprintln!("[floating] window missing when toggling visible={visible}");
        }
    });
}

pub(crate) fn emit_floating_status(app: &AppHandle, visible: bool, state: &str, text: &str, rms: f32) {
    let mode = AsrEngine::session_mode(app);
    let intention = match mode.as_str() {
        "translate" => Some("translate".into()),
        "fn" => Some("transcribe".into()),
        _ => None,
    };
    let (target_language, switching) = if mode == "translate" {
        let target = app
            .state::<AsrEngine>()
            .inner()
            .config
            .lock()
            .ok()
            .map(|c| c.translate_target_language.clone())
            .filter(|s| !s.trim().is_empty());
        let switching = app
            .state::<AsrEngine>()
            .inner()
            .translate_stream
            .lock()
            .map(|st| st.switching)
            .unwrap_or(false);
        (target, switching)
    } else {
        (None, false)
    };
    let payload = FloatingStatus {
        visible,
        state: state.into(),
        text: text.into(),
        rms,
        intention,
        target_language,
        switching,
    };
    if let Ok(mut slot) = floating_status_slot(app).lock() {
        *slot = payload.clone();
    }
    set_floating_window_visible(app, visible);
    let _ = app.emit("floating-status", &payload);
    let _ = app.emit_to("floating", "floating-status", &payload);
    let _ = app.emit_to("floating-lang", "floating-status", &payload);
}

pub(crate) const FLOATING_HUD_H: f64 = 56.0;
/// Fixed HUD width — transcript scrolls inside; window does not grow.
pub(crate) const FLOATING_HUD_MIN_W: f64 = 320.0;
pub(crate) const FLOATING_HUD_MAX_W: f64 = 320.0;
pub(crate) const FLOATING_HUD_BOTTOM_INSET: f64 = 48.0;
pub(crate) const FLOATING_HUD_CORNER_RADIUS: f64 = 28.0;
/// Separate translate-target chip appended after the capsule.
pub(crate) const FLOATING_LANG_W: f64 = 54.0;
pub(crate) const FLOATING_LANG_H: f64 = 32.0;
pub(crate) const FLOATING_LANG_GAP: f64 = 8.0;
pub(crate) const FLOATING_LANG_CORNER_RADIUS: f64 = 16.0;
/// Expanded in-window menu (native NSMenu fails over fullscreen NonactivatingPanel).
pub(crate) const FLOATING_LANG_MENU_W: f64 = 172.0;
pub(crate) const FLOATING_LANG_MENU_ITEM_H: f64 = 34.0;
/// Must match `TRANSLATE_LANGUAGES` length in `src/lib/constants.ts`.
pub(crate) const FLOATING_LANG_MENU_ITEMS: f64 = 5.0;
pub(crate) const FLOATING_LANG_MENU_PAD_Y: f64 = 6.0;
pub(crate) const FLOATING_LANG_MENU_GAP: f64 = 2.0;

fn floating_lang_menu_height() -> f64 {
    // chip + top pad + N items + (N-1) gaps + bottom pad under list (before chip)
    FLOATING_LANG_H
        + FLOATING_LANG_MENU_PAD_Y
        + FLOATING_LANG_MENU_ITEMS * FLOATING_LANG_MENU_ITEM_H
        + (FLOATING_LANG_MENU_ITEMS - 1.0).max(0.0) * FLOATING_LANG_MENU_GAP
        + 4.0
}

fn lang_menu_open_flag() -> &'static AtomicBool {
    static OPEN: AtomicBool = AtomicBool::new(false);
    &OPEN
}

/// True while the translate-target in-window menu is expanded.
pub(crate) fn floating_lang_menu_is_open() -> bool {
    lang_menu_open_flag().load(Ordering::Acquire)
}

/// Collapse the lang menu from the global event tap (Esc).
pub(crate) fn close_floating_lang_menu(app: &AppHandle) {
    if !floating_lang_menu_is_open() {
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        apply_floating_lang_menu_open(&app, false);
        let _ = app.emit_to("floating-lang", "floating-lang-menu", false);
    });
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct HudPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

pub(crate) fn hud_position_path() -> PathBuf {
    app_data_dir().join("hud-position.json")
}

pub(crate) fn load_hud_position() -> Option<(f64, f64)> {
    let data = fs::read_to_string(hud_position_path()).ok()?;
    let pos: HudPosition = serde_json::from_str(&data).ok()?;
    if !pos.x.is_finite() || !pos.y.is_finite() {
        return None;
    }
    Some((pos.x, pos.y))
}

pub(crate) fn save_hud_position(x: f64, y: f64) {
    if !x.is_finite() || !y.is_finite() {
        return;
    }
    let _ = fs::create_dir_all(app_data_dir());
    let payload = HudPosition { x, y };
    if let Ok(data) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(hud_position_path(), data);
    }
}

pub(crate) fn floating_hud_logical_position(app: &AppHandle, win_w: f64) -> (f64, f64) {
    // Monitor position/size are PHYSICAL pixels; WebviewWindowBuilder::position expects LOGICAL.
    let win_w = win_w.clamp(FLOATING_HUD_MIN_W, FLOATING_HUD_MAX_W);
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let scale = monitor.scale_factor().max(1.0);
            let position = monitor.position();
            let size = monitor.size();
            let logical_x = position.x as f64 / scale;
            let logical_y = position.y as f64 / scale;
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            (
                logical_x + ((logical_w - win_w) / 2.0).max(12.0),
                logical_y + (logical_h - FLOATING_HUD_H - FLOATING_HUD_BOTTOM_INSET).max(12.0),
            )
        })
        .unwrap_or((200.0, 640.0))
}

pub(crate) fn resolve_hud_logical_position(app: &AppHandle, win_w: f64) -> (f64, f64) {
    load_hud_position().unwrap_or_else(|| floating_hud_logical_position(app, win_w))
}

pub(crate) fn persist_floating_hud_position(window: &tauri::WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    save_hud_position(pos.x as f64 / scale, pos.y as f64 / scale);
}

pub(crate) fn create_floating_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("floating").is_some() {
        let _ = create_floating_lang_window(app);
        return Ok(());
    }
    let (x, y) = resolve_hud_logical_position(app, FLOATING_HUD_MIN_W);
    eprintln!("[floating] creating HUD at logical ({x:.0}, {y:.0})");

    // Frontend detects this window via label + initialization script flag.
    // Do not put query params in PathBuf — they are not reliably preserved.
    let window = WebviewWindowBuilder::new(app, "floating", WebviewUrl::App("index.html".into()))
        .title("ASR HUD")
        .inner_size(FLOATING_HUD_MIN_W, FLOATING_HUD_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .resizable(false)
        .initialization_script(
            r#"
            window.__ASR_FLOATING__ = true;
            document.documentElement.setAttribute('data-floating', '1');
            // Theme follows main app via localStorage; do not force dark.
            (function(){
              var t = localStorage.getItem('asr-theme') === 'light' ? 'light' : 'dark';
              document.documentElement.classList.remove('light','dark');
              document.documentElement.classList.add(t);
              document.documentElement.setAttribute('data-theme', t);
            })();
            "#,
        )
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    configure_floating_hud_panel(&window, FLOATING_HUD_CORNER_RADIUS);

    // Persist user-dragged position across sessions; keep lang chip glued on.
    let win_for_move = window.clone();
    let app_for_move = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(_) = event {
            persist_floating_hud_position(&win_for_move);
            let show_lang = floating_status_slot(&app_for_move)
                .lock()
                .map(|s| s.visible && s.intention.as_deref() == Some("translate"))
                .unwrap_or(false);
            if show_lang {
                position_floating_lang_chip(&app_for_move);
            }
        }
    });

    eprintln!("[floating] ASR HUD window created");
    let _ = create_floating_lang_window(app);
    Ok(())
}

fn create_floating_lang_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("floating-lang").is_some() {
        return Ok(());
    }
    let (x, y) = resolve_hud_logical_position(app, FLOATING_HUD_MIN_W);
    let lang_x = x + FLOATING_HUD_MIN_W + FLOATING_LANG_GAP;
    let lang_y = y + ((FLOATING_HUD_H - FLOATING_LANG_H) / 2.0).max(0.0);

    let window = WebviewWindowBuilder::new(
        app,
        "floating-lang",
        WebviewUrl::App("index.html".into()),
    )
    .title("ASR Translate Target")
    .inner_size(FLOATING_LANG_W, FLOATING_LANG_H)
    .position(lang_x, lang_y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .resizable(false)
    .initialization_script(
        r#"
            window.__ASR_FLOATING_LANG__ = true;
            document.documentElement.setAttribute('data-floating', '1');
            document.documentElement.setAttribute('data-floating-lang', '1');
            (function(){
              var t = localStorage.getItem('asr-theme') === 'light' ? 'light' : 'dark';
              document.documentElement.classList.remove('light','dark');
              document.documentElement.classList.add(t);
              document.documentElement.setAttribute('data-theme', t);
            })();
            "#,
    )
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        configure_floating_lang_panel(&window, FLOATING_LANG_CORNER_RADIUS);
        // Chip stays glued to the capsule — don't let it be dragged alone.
        if let Ok(ns_ptr) = window.ns_window() {
            use objc2_app_kit::NSWindow;
            unsafe {
                let ns_window = &*(ns_ptr as *const NSWindow);
                ns_window.setMovableByWindowBackground(false);
                ns_window.setHasShadow(false);
            }
        }
        // configure / always-on-top can unhide on some macOS builds — force hide.
        let _ = window.hide();
    }

    let _ = window.hide();
    eprintln!("[floating-lang] translate target chip window created");
    Ok(())
}

/// Place the lang chip just to the right of the capsule (same vertical center).
/// When the menu is open, expand **upward from the chip** — left edges stay aligned
/// so the list sits directly above the trigger (not shifted left).
/// Does not orderFront — callers that need visibility must raise explicitly.
pub(crate) fn position_floating_lang_chip(app: &AppHandle) {
    let Some(hud) = app.get_webview_window("floating") else {
        return;
    };
    let Some(lang) = app.get_webview_window("floating-lang") else {
        return;
    };
    let Ok(scale) = hud.scale_factor() else {
        return;
    };
    let scale = scale.max(1.0);
    let Ok(pos) = hud.outer_position() else {
        return;
    };
    let Ok(size) = hud.outer_size() else {
        return;
    };
    // Collapsed chip anchor: right of HUD, vertically centered on the capsule.
    let chip_x = pos.x as f64 / scale + size.width as f64 / scale + FLOATING_LANG_GAP;
    let chip_y = pos.y as f64 / scale
        + ((size.height as f64 / scale - FLOATING_LANG_H) / 2.0).max(0.0);

    let menu_open = lang_menu_open_flag().load(Ordering::Acquire);
    if menu_open {
        let menu_w = FLOATING_LANG_MENU_W;
        let menu_h = floating_lang_menu_height();
        // Keep the trigger's left edge fixed; grow up + to the right.
        let x = chip_x;
        let y = chip_y + FLOATING_LANG_H - menu_h;
        let _ = lang.set_size(tauri::LogicalSize::new(menu_w, menu_h));
        let _ = lang.set_position(tauri::LogicalPosition::new(x, y));
    } else {
        let _ = lang.set_size(tauri::LogicalSize::new(FLOATING_LANG_W, FLOATING_LANG_H));
        let _ = lang.set_position(tauri::LogicalPosition::new(chip_x, chip_y));
    }
    let _ = lang.set_always_on_top(true);
}

fn translate_lang_chip_should_show(app: &AppHandle) -> bool {
    floating_status_slot(app)
        .lock()
        .map(|s| s.visible && s.intention.as_deref() == Some("translate"))
        .unwrap_or(false)
}

/// Show/hide the separate translate-target chip. Call on the AppKit main thread.
pub(crate) fn sync_floating_lang_chip(app: &AppHandle, show: bool) {
    let Some(lang) = app.get_webview_window("floating-lang") else {
        return;
    };
    if show {
        // Do not collapse an open menu on every floating-status tick.
        if !lang_menu_open_flag().load(Ordering::Acquire) {
            let _ = lang.set_size(tauri::LogicalSize::new(FLOATING_LANG_W, FLOATING_LANG_H));
        }
        position_floating_lang_chip(app);
        #[cfg(target_os = "macos")]
        {
            raise_floating_hud_level(&lang, true);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = lang.show();
        }
    } else {
        lang_menu_open_flag().store(false, Ordering::Release);
        let _ = lang.set_size(tauri::LogicalSize::new(FLOATING_LANG_W, FLOATING_LANG_H));
        let _ = lang.hide();
    }
}

/// Expand/collapse the translate-target chip into an in-window menu.
/// Native `NSMenu.popup` does not reliably appear over fullscreen apps from a
/// NonactivatingPanel, so the chip window itself grows to host the list.
#[tauri::command]
pub(crate) fn set_floating_lang_menu_open(app: AppHandle, open: bool) -> Result<(), String> {
    let app_clone = app.clone();
    app_clone
        .run_on_main_thread(move || {
            apply_floating_lang_menu_open(&app, open);
        })
        .map_err(|e| e.to_string())
}

fn apply_floating_lang_menu_open(app: &AppHandle, open: bool) {
    let Some(lang) = app.get_webview_window("floating-lang") else {
        return;
    };
    let should_show = translate_lang_chip_should_show(app);

    // Closing the menu (or spurious calls from webview HMR/unmount) must NEVER
    // orderFront a hidden chip — that was flashing EN on app launch.
    if !open {
        lang_menu_open_flag().store(false, Ordering::Release);
        let _ = lang.set_size(tauri::LogicalSize::new(FLOATING_LANG_W, FLOATING_LANG_H));
        if should_show {
            position_floating_lang_chip(app);
            #[cfg(target_os = "macos")]
            raise_floating_hud_level(&lang, true);
        } else {
            let _ = lang.hide();
        }
        return;
    }

    if !should_show {
        lang_menu_open_flag().store(false, Ordering::Release);
        let _ = lang.hide();
        return;
    }

    lang_menu_open_flag().store(true, Ordering::Release);
    position_floating_lang_chip(app);
    #[cfg(target_os = "macos")]
    raise_floating_hud_level(&lang, true);
}

/// Apply translate target from the HUD chip menu (shows BCP-47 codes in UI).
#[tauri::command]
pub(crate) fn set_translate_target_language(
    app: AppHandle,
    language: String,
) -> Result<(), String> {
    let language = language.trim().to_string();
    const ALLOWED: &[&str] = &["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"];
    if !ALLOWED.contains(&language.as_str()) {
        return Err(format!("unsupported translate target: {language}"));
    }
    crate::menu::apply_translate_target(&app, &language);
    let app_clone = app.clone();
    let _ = app_clone.run_on_main_thread(move || {
        apply_floating_lang_menu_open(&app, false);
    });
    Ok(())
}

/// Legacy entry — kept for older frontends; expands the in-window menu instead.
#[tauri::command]
pub(crate) fn popup_translate_target_menu(app: AppHandle) -> Result<(), String> {
    set_floating_lang_menu_open(app, true)
}

#[tauri::command]
pub(crate) fn get_floating_status(app: AppHandle) -> FloatingStatus {
    floating_status_slot(&app)
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

/// Keep the frosted capsule anchored on its current center as elastic width changes.
/// Preserves user-dragged X/Y (only adjusts X for width delta) and persists it.
#[tauri::command]
pub(crate) fn recenter_floating_hud(app: AppHandle, width: f64) {
    let app_clone = app.clone();
    let _ = app_clone.run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            let width = width.clamp(FLOATING_HUD_MIN_W, FLOATING_HUD_MAX_W);
            let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
            let (x, y) = match (window.outer_position(), window.outer_size()) {
                (Ok(pos), Ok(size)) => {
                    let cur_x = pos.x as f64 / scale;
                    let cur_y = pos.y as f64 / scale;
                    let cur_w = size.width as f64 / scale;
                    let center_x = cur_x + cur_w / 2.0;
                    ((center_x - width / 2.0).max(8.0), cur_y)
                }
                _ => resolve_hud_logical_position(&app, width),
            };
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
            save_hud_position(x, y);
            let _ = window.set_always_on_top(true);
            #[cfg(target_os = "macos")]
            {
                // Never orderFront here — recenter can run while HUD is hidden
                // (AsrHud mount) and would flash the capsule on launch.
                let visible = floating_status_slot(&app)
                    .lock()
                    .map(|s| s.visible)
                    .unwrap_or(false);
                raise_floating_hud_level(&window, visible);
            }
        }
    });
}

/// Sync floating HUD vibrancy with the main app theme (light/dark).
#[tauri::command]
pub(crate) fn set_floating_theme(theme: String, app: AppHandle) {
    let dark = theme != "light";
    let _ = app.clone().run_on_main_thread(move || {
        for label in ["floating", "floating-lang"] {
            let Some(window) = app.get_webview_window(label) else {
                continue;
            };
            let _ = window.set_theme(Some(if dark {
                tauri::Theme::Dark
            } else {
                tauri::Theme::Light
            }));
            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::{
                    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
                    NSAppearanceNameDarkAqua, NSWindow,
                };
                if let Ok(ns_ptr) = window.ns_window() {
                    unsafe {
                        let ns_window = &*(ns_ptr as *const NSWindow);
                        let name = if dark {
                            NSAppearanceNameDarkAqua
                        } else {
                            NSAppearanceNameAqua
                        };
                        let appearance = NSAppearance::appearanceNamed(name);
                        ns_window.setAppearance(appearance.as_deref());
                    }
                }
                // Theme sync must NOT orderFront — that was flashing HUD on launch.
                let visible = floating_status_slot(&app)
                    .lock()
                    .map(|s| {
                        if label == "floating-lang" {
                            s.visible && s.intention.as_deref() == Some("translate")
                        } else {
                            s.visible
                        }
                    })
                    .unwrap_or(false);
                if visible {
                    raise_floating_hud_level(&window, true);
                }
            }
            let _ = window.set_always_on_top(true);
        }
    });
}
