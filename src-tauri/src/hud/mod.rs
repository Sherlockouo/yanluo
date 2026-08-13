use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
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

pub(crate) const HUD_BAND_COUNT: usize = 5;

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
        app.state::<AsrEngine>().inner().live_meter.clear();
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
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
            agent: None,
            cwd: None,
        }
    }
}

pub(crate) fn floating_status_slot(app: &AppHandle) -> Arc<Mutex<FloatingStatus>> {
    app.state::<Arc<Mutex<FloatingStatus>>>().inner().clone()
}

/// Called from HUD after exit — usually a no-op; native fade owns hide timing.
#[tauri::command]
pub(crate) fn finish_floating_hide(app: AppHandle) {
    finish_floating_hide_inner(&app);
}

fn finish_floating_hide_inner(app: &AppHandle) {
    if floating_status_slot(app)
        .lock()
        .map(|s| s.visible)
        .unwrap_or(false)
    {
        return;
    }
    // Cancel in-flight fade completion (already dismissing).
    let _ = crate::platform::bump_floating_fade_gen();
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if floating_status_slot(&app)
            .lock()
            .map(|s| s.visible)
            .unwrap_or(false)
        {
            return;
        }
        if let Some(window) = app.get_webview_window("floating") {
            let _ = window.hide();
            crate::elog::elog!("[floating] hide()");
        }
        sync_floating_lang_chip(&app, false);
        restore_previous_frontmost_app(true);
    });
}

/// Native HUD currently ordered-in (true between show and hide-start).
/// Recording→processing→editing re-emits visible=true; only place on false→true.
fn hud_native_up() -> &'static AtomicBool {
    static UP: AtomicBool = AtomicBool::new(false);
    &UP
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
    // catch_unwind: never let HUD show/hide abort the process (broken stderr
    // from eprintln!, ObjC edge cases, etc. — see crash in set_floating_window_visible).
    let _ = app.clone().run_on_main_thread(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(window) = app.get_webview_window("floating") {
                if visible {
                    // Invalidate any dismiss fade so re-summon isn't stuck at alpha 0.
                    let _ = crate::platform::bump_floating_fade_gen();
                    // Do NOT toggle Accessory/Regular here — that steals focus and
                    // makes Fn/cancel "jump back" to Yanluo. HUD was created
                    // under Accessory once at launch so FullScreenAuxiliary sticks.
                    remember_frontmost_app();
                    // Place only on hide→show. Mid-session emits (RMS / state) must
                    // not re-resolve — that snaps HUD away from drag / resize anchor.
                    let need_place = !hud_native_up().swap(true, Ordering::AcqRel);
                    if need_place {
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
                        mark_hud_programmatic_move();
                        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                        crate::elog::elog!(
                            "[floating] place at logical ({x:.0}, {y:.0})"
                        );
                    }
                    let _ = window.set_always_on_top(true);
                    // Prefer orderFrontRegardless over Tauri show()/set_focus —
                    // those activate the app and steal keyboard focus.
                    #[cfg(target_os = "macos")]
                    {
                        raise_floating_hud_level(&window, true);
                        crate::elog::elog!("[floating] orderFront (HUD natively visible)");
                    }
                    #[cfg(not(target_os = "macos"))]
                    match window.show() {
                        Ok(()) => {}
                        Err(e) => {
                            crate::elog::elog!("[floating] show() failed: {e}")
                        }
                    }
                    sync_floating_lang_chip(&app, show_lang);
                } else {
                    hud_native_up().store(false, Ordering::Release);
                    persist_floating_hud_position(&window);
                    // Fade native window alpha in lockstep with FE exit (220ms),
                    // then orderOut — do not wait for FE onExitComplete IPC lag.
                    let gen = crate::platform::bump_floating_fade_gen();
                    crate::platform::fade_out_floating_hud(&app, gen);
                }
            } else {
                crate::elog::elog!(
                    "[floating] window missing when toggling visible={visible}"
                );
            }
        }));
        if let Err(payload) = result {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            crate::elog::elog!("[floating] set_visible({visible}) panicked: {msg}");
        }
    });
}

pub(crate) fn emit_floating_status(app: &AppHandle, visible: bool, state: &str, text: &str, rms: f32) {
    let mode = AsrEngine::session_mode(app);
    let intention = match mode.as_str() {
        "translate" => Some("translate".into()),
        "fn" => Some("transcribe".into()),
        "agent" => Some("agent".into()),
        _ => None,
    };
    let (agent_kind, cwd) = if mode == "agent" {
        app.state::<AsrEngine>()
            .inner()
            .config
            .lock()
            .ok()
            .map(|c| (Some(c.agent_kind.clone()), Some(c.agent_cwd.clone())))
            .unwrap_or((None, None))
    } else {
        (None, None)
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
        agent: agent_kind,
        cwd,
    };
    if let Ok(mut slot) = floating_status_slot(app).lock() {
        *slot = payload.clone();
    }
    // Close HUD → drop outside menus so next summon starts clean
    // (Esc after @/picker left stale agent_picker_mode / hidden window).
    if !visible || state == "idle" {
        close_floating_agent_menu(app);
        if floating_lang_menu_is_open() {
            close_floating_lang_menu(app);
        }
    }
    set_floating_window_visible(app, visible);
    // Agent HUD needs key focus for Raycast menus / paste (⌘. ⌘/ ⌘V); editing too.
    // AppKit: always hop to main thread (mlx-worker must not call makeKey*).
    let keyable = visible && (state == "editing" || mode == "agent");
    crate::platform::set_floating_hud_keyable(app, keyable);
    let _ = app.emit("floating-status", &payload);
    let _ = app.emit_to("floating", "floating-status", &payload);
    let _ = app.emit_to("floating-lang", "floating-status", &payload);
}

pub(crate) const FLOATING_HUD_H: f64 = 56.0;
/// Compact listen/process floor; confirm/edit grows toward MAX_W.
pub(crate) const FLOATING_HUD_MIN_W: f64 = 400.0;
pub(crate) const FLOATING_HUD_MAX_W: f64 = 560.0;
/// Gap from monitor bottom to capsule bottom — clear Dock / taskbar.
/// Floor only; default Y also uses a proportional lower-third offset.
pub(crate) const FLOATING_HUD_BOTTOM_INSET: f64 = 160.0;
/// Default vertical bias: fraction of monitor height from top (lower-middle).
const FLOATING_HUD_DEFAULT_Y_FRAC: f64 = 0.78;
pub(crate) const FLOATING_HUD_CORNER_RADIUS: f64 = 28.0;
/// Separate translate-target chip appended after the capsule.
pub(crate) const FLOATING_LANG_W: f64 = 54.0;
pub(crate) const FLOATING_LANG_H: f64 = 32.0;
pub(crate) const FLOATING_LANG_GAP: f64 = 8.0;
pub(crate) const FLOATING_LANG_CORNER_RADIUS: f64 = 16.0;
/// Expanded in-window menu (native NSMenu fails over fullscreen NonactivatingPanel).
pub(crate) const FLOATING_LANG_MENU_W: f64 = 172.0;
pub(crate) const FLOATING_LANG_MENU_ITEM_H: f64 = 34.0;
/// Built-in translate targets (5) + Qwen catalog (~26). Grows with extras.
pub(crate) const FLOATING_LANG_MENU_ITEMS_BASE: f64 = 31.0;
pub(crate) const FLOATING_LANG_MENU_PAD_Y: f64 = 6.0;
pub(crate) const FLOATING_LANG_MENU_GAP: f64 = 2.0;

fn floating_lang_menu_item_count(app: &AppHandle) -> usize {
    let extras = app
        .try_state::<AsrEngine>()
        .and_then(|e| e.inner().config.lock().ok())
        .map(|c| c.extra_languages.len())
        .unwrap_or(0);
    let total = (FLOATING_LANG_MENU_ITEMS_BASE as usize).saturating_add(extras);
    // Window hosts a scrollable list — cap height (~10 rows) so menu stays on-screen.
    total.clamp(5, 10)
}

fn floating_lang_menu_height(app: &AppHandle) -> f64 {
    let n = floating_lang_menu_item_count(app) as f64;
    FLOATING_LANG_H
        + FLOATING_LANG_MENU_PAD_Y
        + n * FLOATING_LANG_MENU_ITEM_H
        + (n - 1.0).max(0.0) * FLOATING_LANG_MENU_GAP
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

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub(crate) struct HudMonitorPos {
    /// Logical offset from that monitor's top-left.
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub(crate) struct HudPositionFile {
    /// Per-monitor remembered drag offsets (key = monitor name or origin).
    #[serde(default)]
    pub(crate) by_monitor: std::collections::HashMap<String, HudMonitorPos>,
    /// Last absolute logical top-left — fallback when monitor key misses.
    #[serde(default)]
    pub(crate) last_x: Option<f64>,
    #[serde(default)]
    pub(crate) last_y: Option<f64>,
    /// Legacy absolute logical coords (pre per-monitor). Migrated on load.
    #[serde(default)]
    pub(crate) x: Option<f64>,
    #[serde(default)]
    pub(crate) y: Option<f64>,
}

fn skip_hud_move_persist() -> &'static AtomicU32 {
    static FLAG: AtomicU32 = AtomicU32::new(0);
    &FLAG
}

/// Next N `Moved` events are from programmatic set_size/set_position — don't overwrite memory.
pub(crate) fn mark_hud_programmatic_move() {
    // size + position often each emit Moved
    skip_hud_move_persist().fetch_add(2, Ordering::Release);
}

pub(crate) fn hud_position_path() -> PathBuf {
    app_data_dir().join("hud-position.json")
}

fn monitor_key(monitor: &tauri::Monitor) -> String {
    monitor
        .name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let p = monitor.position();
            format!("@{},{}", p.x, p.y)
        })
}

/// In-memory mirror of hud-position.json. The HUD show path resolves the
/// position on the AppKit main thread; reading the file synchronously every
/// summon added avoidable latency (and a disk stall would freeze the popup).
/// Single-process writer → cache is authoritative once warmed.
fn hud_position_cache() -> &'static Mutex<Option<HudPositionFile>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<HudPositionFile>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn load_hud_position_file() -> HudPositionFile {
    // Hot path: cached copy (clone — the file is a handful of monitor keys).
    if let Ok(cache) = hud_position_cache().lock() {
        if let Some(file) = cache.as_ref() {
            return file.clone();
        }
    }
    let Ok(data) = fs::read_to_string(hud_position_path()) else {
        return HudPositionFile::default();
    };
    let mut file: HudPositionFile = serde_json::from_str(&data).unwrap_or_default();
    // Drop corrupt top-left junk (often from wrong-scale persist on external displays).
    let before = file.by_monitor.len();
    file.by_monitor
        .retain(|_, p| saved_offset_usable(p.x, p.y));
    if file.by_monitor.len() != before {
        save_hud_position_file(&file);
        crate::elog::elog!(
            "[hud/position] purged {} corrupt top-left monitor offset(s)",
            before - file.by_monitor.len()
        );
    }
    if let Ok(mut cache) = hud_position_cache().lock() {
        *cache = Some(file.clone());
    }
    file
}

fn save_hud_position_file(file: &HudPositionFile) {
    if let Ok(mut cache) = hud_position_cache().lock() {
        *cache = Some(file.clone());
    }
    let _ = fs::create_dir_all(app_data_dir());
    if let Ok(data) = serde_json::to_string_pretty(file) {
        let _ = fs::write(hud_position_path(), data);
    }
}

/// Capsule centered horizontally; vertically lower-middle (not flush to bottom).
fn hud_default_on_monitor(monitor: &tauri::Monitor, win_w: f64) -> (f64, f64) {
    let win_w = win_w.clamp(FLOATING_HUD_MIN_W, FLOATING_HUD_MAX_W);
    let (lx, ly, lw, lh) = monitor_logical_rect(monitor);
    let x = lx + ((lw - win_w) / 2.0).max(12.0);
    // Prefer ~78% down the screen; never closer to bottom than BOTTOM_INSET.
    let by_frac = ly + lh * FLOATING_HUD_DEFAULT_Y_FRAC - FLOATING_HUD_H / 2.0;
    let by_inset = ly + (lh - FLOATING_HUD_H - FLOATING_HUD_BOTTOM_INSET).max(12.0);
    let y = by_frac.min(by_inset).max(ly + 12.0);
    (x, y)
}

/// Monitor containing the mouse cursor.
///
/// # Coordinate‐system note (macOS multi‐monitor bug fix)
///
/// `AppHandle::cursor_position()` returns a **physical** position
/// (CG‐logical × primary‐monitor scale‐factor) while
/// `AppHandle::monitor_from_point()` hit‐tests against `CGDisplayBounds`
/// rects which are in **CG logical** coordinates.  When the primary
/// display is Retina (scale=2) the physical coords can fall outside the
/// CG‐logical bounds of the correct monitor — especially for monitors
/// stacked above the primary (negative Y) — causing a miss and the HUD
/// landing on the wrong screen.
///
/// Fix: obtain cursor position directly from `CGEvent` (CG global logical
/// coords, same space as `CGDisplayBounds`), iterate `CGDisplay::active_displays()`
/// for hit‐testing in that space, then map the winning `CGDirectDisplayID` back
/// to a Tauri `Monitor` by matching the CG logical origin.
///
/// ## Worked example
///
/// Setup: primary = Retina 3024×1964 physical, scale=2, CG logical 1512×982 at (0,0).
///        Upper external = 2560×1440 physical, scale=1, CG logical 2560×1440 at (0,−1440).
///
/// Mouse at CG logical (500, −700) — middle of upper screen.
///
/// 1. `CGEvent::new(src).location()` → CGPoint { x:500, y:−700 }
/// 2. Upper monitor CGDisplayBounds = { origin:(0,−1440), size:(2560,1440) }
///    → rect covers x∈[0,2560], y∈[−1440, 0].
///    500∈[0,2560] ✓, −700∈[−1440,0] ✓  → HIT.
/// 3. Map CGDisplayID back to Tauri Monitor via matching CG logical origin:
///    Monitor::position() = CG_logical_origin × monitor_scale.
///    For upper monitor (scale=1): position = (0,−1440).
///    CGDisplayBounds.origin = (0,−1440).  Match by
///    (position.x / scale, position.y / scale) == (origin.x, origin.y).
/// 4. `monitor_logical_rect` for the hit monitor returns (0, −1440, 2560, 1440).
///    Default HUD pos: x = 0 + (2560−400)/2 = 1080, y = −1440 + (1440−56−120) = −176.
/// 5. `set_position(LogicalPosition(1080, −176))` → tao converts to AppKit via
///    `NSPoint(1080, pixels_high − (−176)) = NSPoint(1080, 982+176) = (1080, 1158)`.
///    This is correct AppKit coords for a point on the upper screen.
///
/// Old (broken) path for same cursor:
///   cursor_position() = (500*2, −700*2) = (1000, −1400) [physical].
///   monitor_from_point(1000, −1400) tests against CGDisplayBounds{0,−1440,2560,1440}:
///   x=1000∈[0,2560] ✓  y=−1400∈[−1440,0] ✓ — happens to pass HERE but would FAIL
///   for cursor at CG logical (1300, −700) → phys (2600,−1400): x=2600>2560 MISS.
///   Any cursor in the right ~half of the upper monitor would miss, falling back to
///   primary (lower) screen.
#[cfg(target_os = "macos")]
fn cursor_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    use core_graphics::display::{CGDisplay, CGDirectDisplayID};
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // 1. Get cursor in CG global logical coordinates.
    let cg_point = {
        let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
        let evt = CGEvent::new(src).ok()?;
        evt.location() // CGPoint in global display (logical) coords
    };

    // 2. Hit‐test against CGDisplayBounds (same coord space).
    let displays = CGDisplay::active_displays().ok()?;
    let mut hit_id: Option<CGDirectDisplayID> = None;
    for &disp_id in &displays {
        let bounds = CGDisplay::new(disp_id).bounds();
        if bounds.contains(&cg_point) {
            hit_id = Some(disp_id);
            break;
        }
    }

    let hit_id = match hit_id {
        Some(id) => id,
        None => {
            crate::elog::elog!(
                "[hud/position] no CG display contains cursor ({:.1}, {:.1})",
                cg_point.x, cg_point.y
            );
            return None;
        }
    };

    // 3. Map CGDirectDisplayID → Tauri Monitor.
    //    Match by comparing CG logical origin (from CGDisplayBounds) against
    //    each Tauri Monitor's position (= CG_logical_origin × monitor_scale).
    let hit_bounds = CGDisplay::new(hit_id).bounds();
    let hit_origin_lx = hit_bounds.origin.x;
    let hit_origin_ly = hit_bounds.origin.y;

    let monitors = app.available_monitors().ok()?;
    let matched = monitors.into_iter().find(|m| {
        let scale = m.scale_factor().max(1.0);
        let pos = m.position();
        let mon_lx = pos.x as f64 / scale;
        let mon_ly = pos.y as f64 / scale;
        // Allow small epsilon for floating‐point from scale division.
        (mon_lx - hit_origin_lx).abs() < 1.0 && (mon_ly - hit_origin_ly).abs() < 1.0
    });

    if matched.is_none() {
        crate::elog::elog!(
            "[hud/position] CG display {} at ({:.0},{:.0}) has no matching Tauri Monitor",
            hit_id, hit_origin_lx, hit_origin_ly
        );
    }
    matched
}

/// Fallback for non‐macOS: use Tauri APIs directly (they share one scale on most setups).
#[cfg(not(target_os = "macos"))]
fn cursor_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let pos = match app.cursor_position() {
        Ok(p) => p,
        Err(e) => {
            crate::elog::elog!("[hud/position] cursor_position failed: {e}");
            return None;
        }
    };
    let mon = app.monitor_from_point(pos.x, pos.y).ok().flatten();
    if mon.is_none() {
        crate::elog::elog!(
            "[hud/position] no monitor found at cursor ({:.0}, {:.0})",
            pos.x, pos.y
        );
    }
    mon
}

fn monitor_contains_logical(monitor: &tauri::Monitor, x: f64, y: f64) -> bool {
    let (lx, ly, lw, lh) = monitor_logical_rect(monitor);
    x >= lx && x < lx + lw && y >= ly && y < ly + lh
}

/// Hit-test in **physical** pixels (`Monitor::position` / `size` space).
/// Safer than converting with `window.scale_factor()` first (wrong scale → miss → junk offsets).
fn monitor_from_physical(app: &AppHandle, px: i32, py: i32) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|m| {
        let p = m.position();
        let s = m.size();
        let w = s.width as i32;
        let h = s.height as i32;
        px >= p.x && px < p.x + w && py >= p.y && py < p.y + h
    })
}

/// Convert window outer physical position → CG logical using the **containing monitor** scale.
fn outer_logical_xy(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<(f64, f64, f64, tauri::Monitor)> {
    let pos = window.outer_position().ok()?;
    let mon = monitor_from_physical(app, pos.x, pos.y).or_else(|| cursor_monitor(app))?;
    let scale = mon.scale_factor().max(1.0);
    let wx = pos.x as f64 / scale;
    let wy = pos.y as f64 / scale;
    Some((wx, wy, scale, mon))
}

/// Saved offset usable? Reject negatives (scale bug) and top-left junk.
/// Real user drags sit mid/lower; (0,~30) is the classic external-display bug.
fn saved_offset_usable(x: f64, y: f64) -> bool {
    x.is_finite()
        && y.is_finite()
        && x >= 0.0
        && y >= 0.0
        && !(x < 48.0 && y < 80.0)
}

pub(crate) fn floating_hud_logical_position(app: &AppHandle, win_w: f64) -> (f64, f64) {
    // Follow the cursor's screen — the user is looking there, not necessarily
    // at the primary monitor. Fall back to primary when cursor is unknown.
    if let Some(monitor) = cursor_monitor(app) {
        return hud_default_on_monitor(&monitor, win_w);
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| hud_default_on_monitor(&m, win_w))
        .unwrap_or((200.0, 640.0))
}

/// Monitor rect in **CG logical coordinates** (origin at primary top‐left, y‐down).
///
/// Tauri `Monitor::position()` = CG_logical_origin × monitor_scale (physical).
/// Tauri `Monitor::size()` = CG_logical_size × monitor_scale (physical).
/// Dividing each by the monitor's own scale_factor reconstructs the CG logical rect,
/// which is the coordinate space used by `set_position(LogicalPosition)` and
/// `CGDisplayBounds`.
fn monitor_logical_rect(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor().max(1.0);
    let position = monitor.position();
    let size = monitor.size();
    (
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

pub(crate) fn resolve_hud_logical_position(app: &AppHandle, win_w: f64) -> (f64, f64) {
    let Some(cm) = cursor_monitor(app) else {
        return floating_hud_logical_position(app, win_w);
    };
    let key = monitor_key(&cm);
    let mut file = load_hud_position_file();

    // Migrate legacy absolute x/y → per-monitor offset once.
    if file.by_monitor.is_empty() {
        if let (Some(sx), Some(sy)) = (file.x.or(file.last_x), file.y.or(file.last_y)) {
            if sx.is_finite() && sy.is_finite() {
                let mon = app
                    .available_monitors()
                    .ok()
                    .into_iter()
                    .flatten()
                    .find(|m| monitor_contains_logical(m, sx, sy))
                    .unwrap_or_else(|| cm.clone());
                let (lx, ly, _, _) = monitor_logical_rect(&mon);
                file.by_monitor.insert(
                    monitor_key(&mon),
                    HudMonitorPos {
                        x: sx - lx,
                        y: sy - ly,
                    },
                );
                file.last_x = Some(sx);
                file.last_y = Some(sy);
                file.x = None;
                file.y = None;
                save_hud_position_file(&file);
            }
        }
    }

    let (lx, ly, lw, lh) = monitor_logical_rect(&cm);
    let max_x = (lw - win_w.clamp(FLOATING_HUD_MIN_W, FLOATING_HUD_MAX_W)).max(0.0);
    let max_y = (lh - FLOATING_HUD_H).max(0.0);

    if let Some(saved) = file.by_monitor.get(&key) {
        if saved_offset_usable(saved.x, saved.y) {
            let x = lx + saved.x.clamp(0.0, max_x);
            let y = ly + saved.y.clamp(0.0, max_y);
            return (x, y);
        }
        crate::elog::elog!(
            "[hud/position] ignore corrupt offset on '{key}' ({:.0},{:.0}) → default",
            saved.x, saved.y
        );
    }

    // Fallback: last absolute point if it still lands on this monitor (not top-left junk).
    if let (Some(sx), Some(sy)) = (file.last_x.or(file.x), file.last_y.or(file.y)) {
        if sx.is_finite()
            && sy.is_finite()
            && monitor_contains_logical(&cm, sx, sy)
            && saved_offset_usable(sx - lx, sy - ly)
        {
            return (sx.clamp(lx, lx + max_x), sy.clamp(ly, ly + max_y));
        }
    }

    // Different display (or never dragged here) → default on cursor monitor.
    hud_default_on_monitor(&cm, win_w)
}

pub(crate) fn persist_floating_hud_position(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let Some((wx, wy, _scale, mon)) = outer_logical_xy(&app, window) else {
        return;
    };
    let (lx, ly, _, _) = monitor_logical_rect(&mon);
    let ox = wx - lx;
    let oy = wy - ly;
    // Never persist top-left junk / negative offsets (wrong-scale artifacts).
    if !saved_offset_usable(ox, oy) {
        crate::elog::elog!(
            "[hud/position] skip persist junk offset ({ox:.0},{oy:.0}) on {}",
            monitor_key(&mon)
        );
        return;
    }
    let mut file = load_hud_position_file();
    file.by_monitor.insert(
        monitor_key(&mon),
        HudMonitorPos { x: ox, y: oy },
    );
    file.last_x = Some(wx);
    file.last_y = Some(wy);
    file.x = None;
    file.y = None;
    save_hud_position_file(&file);
}

pub(crate) fn create_floating_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("floating").is_some() {
        let _ = create_floating_lang_window(app);
        let _ = create_floating_agent_menu_window(app);
        return Ok(());
    }
    let (x, y) = resolve_hud_logical_position(app, FLOATING_HUD_MIN_W);
    crate::elog::elog!("[floating] creating HUD at logical ({x:.0}, {y:.0})");

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

    // Persist user-dragged position across sessions; keep lang chip + agent menu glued on.
    let win_for_move = window.clone();
    let app_for_move = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(_) = event {
            let skip = skip_hud_move_persist();
            let prev = skip.load(Ordering::Acquire);
            if prev > 0 {
                skip.fetch_sub(1, Ordering::AcqRel);
                // Programmatic show/resize — keep per-monitor memory intact.
            } else {
                persist_floating_hud_position(&win_for_move);
            }
            let show_lang = floating_status_slot(&app_for_move)
                .lock()
                .map(|s| s.visible && s.intention.as_deref() == Some("translate"))
                .unwrap_or(false);
            if show_lang {
                position_floating_lang_chip(&app_for_move);
            }
            if floating_agent_menu_is_open() {
                position_floating_agent_menu(
                    &app_for_move,
                    agent_picker_item_count(),
                );
            }
        }
    });

    crate::elog::elog!("[floating] ASR HUD window created");
    let _ = create_floating_lang_window(app);
    let _ = create_floating_agent_menu_window(app);
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
    crate::elog::elog!("[floating-lang] translate target chip window created");
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
        let menu_h = floating_lang_menu_height(app);
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

/// Keep horizontal center; grow/shrink **upward** (bottom edge stays put).
///
/// Do **not** clamp with `.max(8.0)` — multi-monitor CG logical Y is often
/// negative (screen above primary). That clamp yanked HUD onto the primary.
fn anchored_resize_xy(
    cur_x: f64,
    cur_y: f64,
    cur_w: f64,
    cur_h: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let center_x = cur_x + cur_w / 2.0;
    let bottom = cur_y + cur_h;
    (center_x - width / 2.0, bottom - height)
}

/// Keep the frosted capsule anchored on its current center as elastic width changes.
/// Preserves user-dragged X/Y (only adjusts X for width delta) and persists it.
#[tauri::command]
pub(crate) fn recenter_floating_hud(app: AppHandle, width: f64) {
    let app_clone = app.clone();
    let _ = app_clone.run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            let width = width.clamp(FLOATING_HUD_MIN_W, 560.0);
            let (x, y, height) = match (
                outer_logical_xy(&app, &window),
                window.outer_size(),
            ) {
                (Some((cur_x, cur_y, scale, _)), Ok(size)) => {
                    let cur_w = size.width as f64 / scale;
                    let cur_h = (size.height as f64 / scale).clamp(FLOATING_HUD_H, 280.0);
                    let (x, y) =
                        anchored_resize_xy(cur_x, cur_y, cur_w, cur_h, width, cur_h);
                    (x, y, cur_h)
                }
                _ => {
                    let (x, y) = resolve_hud_logical_position(&app, width);
                    (x, y, FLOATING_HUD_H)
                }
            };
            mark_hud_programmatic_move();
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
    });
}

/// Resize floating HUD (agent / confirm-edit grow). Bottom edge stays put.
#[tauri::command]
pub(crate) fn resize_floating_hud(app: AppHandle, width: f64, height: f64) {
    let app_clone = app.clone();
    let _ = app_clone.run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            let width = width.clamp(FLOATING_HUD_MIN_W, 560.0);
            let height = height.clamp(FLOATING_HUD_H, 280.0);
            let (x, y) = match outer_logical_xy(&app, &window) {
                Some((cur_x, cur_y, scale, _)) => {
                    let cur_w = window
                        .outer_size()
                        .ok()
                        .map(|s| s.width as f64 / scale)
                        .unwrap_or(width);
                    let cur_h = window
                        .outer_size()
                        .ok()
                        .map(|s| s.height as f64 / scale)
                        .unwrap_or(FLOATING_HUD_H);
                    anchored_resize_xy(cur_x, cur_y, cur_w, cur_h, width, height)
                }
                None => resolve_hud_logical_position(&app, width),
            };
            mark_hud_programmatic_move();
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
    });
}

/// Sync floating HUD vibrancy with the main app theme (light/dark).
#[tauri::command]
pub(crate) fn set_floating_theme(theme: String, app: AppHandle) {
    let dark = theme != "light";
    let _ = app.clone().run_on_main_thread(move || {
        for label in ["floating", "floating-lang", "floating-agent-menu"] {
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
                        } else if label == "floating-agent-menu" {
                            false // menu raises itself when open
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

// —— Agent picker menu (separate window above HUD, like floating-lang) ——

pub(crate) const FLOATING_AGENT_MENU_W: f64 = 200.0;
pub(crate) const FLOATING_AGENT_MENU_ROW: f64 = 32.0;
pub(crate) const FLOATING_AGENT_MENU_PAD: f64 = 8.0;
/// Room around panel so radius + CSS shadow aren't clipped (dark fringe).
pub(crate) const FLOATING_AGENT_MENU_INSET: f64 = 12.0;

fn agent_picker_mode_slot() -> &'static Mutex<String> {
    static MODE: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    MODE.get_or_init(|| Mutex::new(String::new()))
}

fn agent_picker_item_count_slot() -> &'static AtomicUsize {
    static COUNT: AtomicUsize = AtomicUsize::new(1);
    &COUNT
}

fn agent_picker_item_count() -> usize {
    agent_picker_item_count_slot()
        .load(Ordering::Acquire)
        .max(1)
}

pub(crate) fn agent_picker_mode() -> String {
    agent_picker_mode_slot()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

pub(crate) fn floating_agent_menu_is_open() -> bool {
    !agent_picker_mode().is_empty()
}

fn create_floating_agent_menu_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("floating-agent-menu").is_some() {
        return Ok(());
    }
    let (x, y) = resolve_hud_logical_position(app, FLOATING_HUD_MIN_W);
    let window = WebviewWindowBuilder::new(
        app,
        "floating-agent-menu",
        WebviewUrl::App("index.html".into()),
    )
    .title("ASR Agent Menu")
    .inner_size(agent_menu_width(), agent_menu_height(1))
    .position(x, y - 40.0)
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
            window.__ASR_FLOATING_AGENT_MENU__ = true;
            document.documentElement.setAttribute('data-floating', '1');
            document.documentElement.setAttribute('data-floating-agent-menu', '1');
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
        // Opaque-ish overlay: NonactivatingPanel, NO vibrancy (vibrancy hid text).
        crate::platform::configure_floating_agent_menu_panel(
            &window,
            FLOATING_LANG_CORNER_RADIUS,
        );
        if let Ok(ns_ptr) = window.ns_window() {
            use objc2_app_kit::NSWindow;
            unsafe {
                let ns_window = &*(ns_ptr as *const NSWindow);
                ns_window.setMovableByWindowBackground(false);
                // CSS shadow only — native shadow + radius on clear window = dark fringe.
                ns_window.setHasShadow(false);
            }
        }
        let _ = window.hide();
    }
    let _ = window.hide();
    crate::elog::elog!("[floating-agent-menu] picker window created");
    Ok(())
}

fn agent_menu_height(item_count: usize) -> f64 {
    let n = item_count.max(1) as f64;
    FLOATING_AGENT_MENU_INSET * 2.0
        + FLOATING_AGENT_MENU_PAD
        + n * FLOATING_AGENT_MENU_ROW
}

fn agent_menu_width() -> f64 {
    FLOATING_AGENT_MENU_W + FLOATING_AGENT_MENU_INSET * 2.0
}

fn position_floating_agent_menu(app: &AppHandle, item_count: usize) {
    let Some(hud) = app.get_webview_window("floating") else {
        return;
    };
    let Some(menu) = app.get_webview_window("floating-agent-menu") else {
        return;
    };
    let Ok(scale) = hud.scale_factor() else {
        return;
    };
    let scale = scale.max(1.0);
    let Ok(pos) = hud.outer_position() else {
        return;
    };
    let mode = agent_picker_mode();
    let h = agent_menu_height(item_count);
    let w = agent_menu_width();
    // Above HUD top-left; cwd menu slightly inset. Gap clears shadow bleed.
    let x_off = if mode == "cwd" { 110.0 } else { 8.0 };
    let x = pos.x as f64 / scale + x_off - FLOATING_AGENT_MENU_INSET;
    let y = pos.y as f64 / scale - h - 4.0;
    let _ = menu.set_size(tauri::LogicalSize::new(w, h));
    let _ = menu.set_position(tauri::LogicalPosition::new(x, y));
    let _ = menu.set_always_on_top(true);
}

fn apply_agent_picker_open(app: &AppHandle, mode: &str, item_count: usize) {
    let Some(menu) = app.get_webview_window("floating-agent-menu") else {
        let _ = create_floating_agent_menu_window(app);
        // retry once after create
        if app.get_webview_window("floating-agent-menu").is_none() {
            return;
        }
        return apply_agent_picker_open(app, mode, item_count);
    };
    let mode = mode.trim();
    if mode.is_empty() || (mode != "agent" && mode != "cwd") {
        if let Ok(mut slot) = agent_picker_mode_slot().lock() {
            slot.clear();
        }
        let _ = menu.hide();
        let _ = app.emit_to("floating-agent-menu", "agent-picker", "");
        let _ = app.emit_to("floating", "agent-picker", "");
        return;
    }
    if let Ok(mut slot) = agent_picker_mode_slot().lock() {
        *slot = mode.to_string();
    }
    agent_picker_item_count_slot().store(item_count.max(1), Ordering::Release);
    position_floating_agent_menu(app, item_count);
    // Raise without set_focus — focus steal caused double-click-to-toggle.
    // After hide(), orderFront alone can leave window stuck; show() first.
    let _ = menu.show();
    #[cfg(target_os = "macos")]
    raise_floating_hud_level(&menu, true);
    let _ = app.emit_to("floating-agent-menu", "agent-picker", mode);
    let _ = app.emit_to("floating", "agent-picker", mode);
    // Hidden webview may mount late — re-emit so list paints.
    let app_re = app.clone();
    let mode_re = mode.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let _ = app_re.emit_to("floating-agent-menu", "agent-picker", &mode_re);
        let _ = app_re.emit_to("floating", "agent-picker", &mode_re);
        std::thread::sleep(Duration::from_millis(120));
        let _ = app_re.emit_to("floating-agent-menu", "agent-picker", &mode_re);
    });
}

/// Resize open picker only (no focus / no mode change).
#[tauri::command]
pub(crate) fn resize_floating_agent_menu(
    app: AppHandle,
    item_count: Option<usize>,
) -> Result<(), String> {
    let count = item_count.unwrap_or(4).clamp(1, 16);
    if agent_picker_mode().is_empty() {
        return Ok(());
    }
    agent_picker_item_count_slot().store(count, Ordering::Release);
    let app_clone = app.clone();
    app_clone
        .run_on_main_thread(move || {
            position_floating_agent_menu(&app, count);
        })
        .map_err(|e| e.to_string())
}

/// Open/close agent or cwd picker outside the HUD capsule.
#[tauri::command]
pub(crate) fn set_agent_picker(
    app: AppHandle,
    mode: String,
    item_count: Option<usize>,
) -> Result<(), String> {
    let count = item_count.unwrap_or(4).clamp(1, 16);
    let app_clone = app.clone();
    app_clone
        .run_on_main_thread(move || {
            apply_agent_picker_open(&app, &mode, count);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_agent_picker() -> String {
    agent_picker_mode()
}

/// Collapse agent picker from Esc / HUD hide (always clear — tolerates desync).
pub(crate) fn close_floating_agent_menu(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        apply_agent_picker_open(&app, "", 1);
    });
}

/// After native file dialog (or ESC cancel), AppKit / React Aria can leave the
/// floating HUD unable to receive clicks/keys. Re-assert keyable + order front.
#[tauri::command]
pub(crate) fn restore_floating_interaction(app: AppHandle) -> Result<(), String> {
    let (visible, state, intention) = floating_status_slot(&app)
        .lock()
        .map(|s| (s.visible, s.state.clone(), s.intention.clone()))
        .unwrap_or((false, String::new(), None));
    if !visible {
        return Ok(());
    }
    let keyable = state == "editing" || intention.as_deref() == Some("agent");
    crate::platform::set_floating_hud_keyable(&app, keyable);
    let app2 = app.clone();
    let _ = app2.clone().run_on_main_thread(move || {
        if let Some(window) = app2.get_webview_window("floating") {
            let _ = window.set_always_on_top(true);
            #[cfg(target_os = "macos")]
            crate::platform::raise_floating_hud_level(&window, true);
            let _ = window.set_focus();
        }
    });
    Ok(())
}
