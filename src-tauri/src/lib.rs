//! ASR Workshop backend — Tauri commands for model management, recording, and transcription.
//!
//! Architecture: a dedicated MLX worker thread owns the inference engine.
//! All MLX operations (model loading, transcription) happen on that thread.
//!
//! Streaming: the worker thread runs a self-paced loop — after each partial
//! transcription completes, it immediately grabs the latest accumulated audio
//! and starts the next round. No timer, no queue, no stale partials.

use serde::{Deserialize, Serialize};
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::runloop::CFRunLoop;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{
    CallbackResult, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventType,
};
use std::fs;
use std::ffi::c_void;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(not(target_os = "macos"))]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

mod audio_recorder;
use audio_recorder::AudioRecorder;

mod permissions;

// ---------------------------------------------------------------------------
// Send-safe wrapper for cpal::Stream (which is !Send on macOS).
// ---------------------------------------------------------------------------

struct SendWrapper<T>(pub T);
unsafe impl<T> Send for SendWrapper<T> {}
unsafe impl<T> Sync for SendWrapper<T> {}

impl<T> SendWrapper<T> {
    fn new(t: T) -> Self {
        Self(t)
    }
    fn into_inner(self) -> T {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Worker commands
// ---------------------------------------------------------------------------

#[allow(dead_code)]
enum WorkerCommand {
    LoadModel {
        path: PathBuf,
    },
    StartStreaming {
        chunk_sec: f64,
        rollback_tokens: usize,
        language: Option<String>,
    },
    TranscribeFile {
        path: PathBuf,
    },
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AsrEngine {
    model_dir: Mutex<String>,
    recorder: Mutex<Option<SendWrapper<AudioRecorder>>>,
    /// true while recording is active. Worker loop reads this.
    recording: Arc<AtomicBool>,
    model_loaded: Arc<AtomicBool>,
    /// Channel to the MLX worker thread.
    worker_tx: Mutex<Sender<WorkerCommand>>,
    config: Mutex<AppConfig>,
    history: Mutex<Vec<HistoryEntry>>,
    /// "fn" (HUD + paste) or "transcribe" (save audio, no paste).
    session_mode: Mutex<String>,
}

impl AsrEngine {
    fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<WorkerCommand>();

        let model_loaded = Arc::new(AtomicBool::new(false));
        let model_loaded_clone = model_loaded.clone();
        let app_for_worker = app.clone();
        std::thread::Builder::new()
            .name("mlx-worker".into())
            .spawn(move || {
                mlx_worker(rx, app_for_worker, model_loaded_clone);
            })
            .expect("failed to spawn MLX worker thread");

        let config = load_config_from_disk();
        let history = load_history_from_disk();

        Self {
            model_dir: Mutex::new(config.asr_model_dir.clone()),
            recorder: Mutex::new(None),
            recording: Arc::new(AtomicBool::new(false)),
            model_loaded,
            worker_tx: Mutex::new(tx),
            config: Mutex::new(config),
            history: Mutex::new(history),
            session_mode: Mutex::new("fn".into()),
        }
    }

    fn session_mode(app: &AppHandle) -> String {
        app.state::<AsrEngine>()
            .inner()
            .session_mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_else(|_| "fn".into())
    }

    fn set_session_mode(app: &AppHandle, mode: &str) {
        if let Ok(mut slot) = app.state::<AsrEngine>().inner().session_mode.lock() {
            *slot = mode.to_string();
        }
    }

    fn send_worker(&self, cmd: WorkerCommand) -> Result<(), String> {
        self.worker_tx
            .lock()
            .map_err(|e| e.to_string())?
            .send(cmd)
            .map_err(|e| e.to_string())
    }

    /// Grab a snapshot of all accumulated audio samples (16kHz mono f32).
    fn get_audio_snapshot(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.as_ref().map(|r| r.0.get_samples())
    }

    /// Take ownership of the recorder, stop it, and return all samples.
    fn take_recorder_and_stop(app: &AppHandle) -> Option<Vec<f32>> {
        let state = app.state::<AsrEngine>();
        let mut rec_guard = state.inner().recorder.lock().unwrap();
        rec_guard.take().map(|wrapper| {
            let rec = wrapper.into_inner();
            rec.stop().unwrap_or_default()
        })
    }
}

// ---------------------------------------------------------------------------
// App config, history, and persistence
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct AppConfig {
    asr_model_dir: String,
    asr_provider: AsrProvider,
    elevenlabs_api_key: String,
    elevenlabs_model: String,
    language: String,
    llm_enabled: bool,
    llm_api_base_url: String,
    llm_api_key: String,
    llm_model: String,
    vocabulary: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AsrProvider {
    Qwen,
    Apple,
    Elevenlabs,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            asr_model_dir: "/Users/xbcoder/project/Qwen3-ASR/models".into(),
            asr_provider: AsrProvider::Apple,
            elevenlabs_api_key: String::new(),
            elevenlabs_model: "scribe_v2".into(),
            language: read_user_default_language().unwrap_or_else(|| "zh-CN".into()),
            llm_enabled: false,
            llm_api_base_url: "https://api.openai.com/v1".into(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".into(),
            vocabulary: Vec::new(),
        }
    }
}

impl AsrProvider {
    fn label(&self) -> &'static str {
        match self {
            AsrProvider::Qwen => "qwen",
            AsrProvider::Apple => "apple",
            AsrProvider::Elevenlabs => "elevenlabs",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct HistoryEntry {
    id: String,
    text: String,
    raw_text: String,
    language: String,
    duration_seconds: f64,
    created_at: String,
    refined: bool,
    #[serde(default)]
    audio_path: Option<String>,
    /// "fn" | "transcribe"
    #[serde(default = "default_history_source")]
    source: String,
}

fn default_history_source() -> String {
    "fn".into()
}

fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("ASR Workshop")
}

fn recordings_dir() -> PathBuf {
    app_data_dir().join("recordings")
}

fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

fn history_path() -> PathBuf {
    app_data_dir().join("history.json")
}

fn load_config_from_disk() -> AppConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_config_to_disk(config: &AppConfig) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(), data).map_err(|e| e.to_string())?;
    write_user_default_language(&config.language);
    Ok(())
}

fn load_history_from_disk() -> Vec<HistoryEntry> {
    fs::read_to_string(history_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_history_to_disk(history: &[HistoryEntry]) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    fs::write(history_path(), data).map_err(|e| e.to_string())
}

fn read_user_default_language() -> Option<String> {
    let output = Command::new("defaults")
        .args(["read", "com.template.asr-workshop", "language"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn write_user_default_language(language: &str) {
    let _ = Command::new("defaults")
        .args(["write", "com.template.asr-workshop", "language", language])
        .status();
}

type TisInputSourceRef = *const c_void;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyInputSourceID: CFStringRef;
    fn TISCopyCurrentKeyboardInputSource() -> TisInputSourceRef;
    fn TISCopyCurrentASCIICapableKeyboardInputSource() -> TisInputSourceRef;
    fn TISSelectInputSource(input_source: TisInputSourceRef) -> i32;
    fn TISGetInputSourceProperty(
        input_source: TisInputSourceRef,
        property_key: CFStringRef,
    ) -> *const c_void;
}

struct InputSourceGuard {
    original: TisInputSourceRef,
    switched: bool,
}

impl Drop for InputSourceGuard {
    fn drop(&mut self) {
        unsafe {
            if self.switched && !self.original.is_null() {
                let _ = TISSelectInputSource(self.original);
            }
            if !self.original.is_null() {
                CFRelease(self.original as _);
            }
        }
    }
}

fn switch_to_ascii_if_cjk() -> Option<InputSourceGuard> {
    unsafe {
        let current = TISCopyCurrentKeyboardInputSource();
        if current.is_null() {
            return None;
        }
        let id = input_source_id(current).unwrap_or_default();
        if !is_cjk_input_source(&id) {
            CFRelease(current as _);
            return None;
        }
        let ascii = TISCopyCurrentASCIICapableKeyboardInputSource();
        if ascii.is_null() {
            CFRelease(current as _);
            return None;
        }
        let switched = TISSelectInputSource(ascii) == 0;
        CFRelease(ascii as _);
        Some(InputSourceGuard {
            original: current,
            switched,
        })
    }
}

fn input_source_id(source: TisInputSourceRef) -> Option<String> {
    unsafe {
        let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) as CFStringRef;
        if value.is_null() {
            return None;
        }
        Some(CFString::wrap_under_get_rule(value).to_string())
    }
}

fn is_cjk_input_source(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    lower.contains("inputmethod")
        || lower.contains("pinyin")
        || lower.contains("scim")
        || lower.contains("tcim")
        || lower.contains("japanese")
        || lower.contains("korean")
        || lower.contains("hangul")
        || lower.contains("kotoeri")
}

fn spawn_audio_level_pump(app: AppHandle, recording: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while recording.load(Ordering::Acquire) {
            if let Some(samples) = AsrEngine::get_audio_snapshot(&app) {
                let rms = compute_recent_rms(&samples);
                let _ = app.emit("audio-level", rms);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = app.emit("audio-level", 0.0_f32);
    });
}

fn compute_recent_rms(samples: &[f32]) -> f32 {
    let window = samples.len().min(1_600);
    if window == 0 {
        return 0.0;
    }
    let start = samples.len() - window;
    let energy = samples[start..]
        .iter()
        .map(|sample| sample * sample)
        .sum::<f32>()
        / window as f32;
    energy.sqrt().min(1.0)
}

#[derive(Clone, Serialize)]
struct FloatingStatus {
    visible: bool,
    state: String,
    text: String,
    rms: f32,
}

impl Default for FloatingStatus {
    fn default() -> Self {
        Self {
            visible: false,
            state: "idle".into(),
            text: String::new(),
            rms: 0.0,
        }
    }
}

fn floating_status_slot(app: &AppHandle) -> Arc<Mutex<FloatingStatus>> {
    app.state::<Arc<Mutex<FloatingStatus>>>().inner().clone()
}

fn set_floating_window_visible(app: &AppHandle, visible: bool) {
    let app = app.clone();
    // Window show/hide must run on the AppKit main thread.
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            if visible {
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
                // Preserve user-dragged Y; only snap X to center on first show / default.
                let (x, y) = match (window.outer_position(), window.scale_factor()) {
                    (Ok(pos), Ok(scale)) => {
                        let scale = scale.max(1.0);
                        let cur_y = pos.y as f64 / scale;
                        let default = floating_hud_logical_position(&app, width);
                        // If still near the default bottom band, re-center fully; else keep Y.
                        let near_default = (cur_y - default.1).abs() < 8.0;
                        if near_default {
                            default
                        } else {
                            (default.0, cur_y)
                        }
                    }
                    _ => floating_hud_logical_position(&app, width),
                };
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                // Re-assert always-on-top each show — macOS can drop it after hide.
                let _ = window.set_always_on_top(true);
                match window.show() {
                    Ok(()) => eprintln!("[floating] show() at logical ({x:.0}, {y:.0})"),
                    Err(e) => eprintln!("[floating] show() failed: {e}"),
                }
            } else {
                // Delay hide so the frontend exit scale animation (~0.22s) can play.
                let app_hide = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(240));
                    let _ = app_hide.clone().run_on_main_thread(move || {
                        if let Some(window) = app_hide.get_webview_window("floating") {
                            // Only hide if still idle / not re-shown.
                            if let Ok(slot) = floating_status_slot(&app_hide).lock() {
                                if slot.visible {
                                    return;
                                }
                            }
                            let _ = window.hide();
                            eprintln!("[floating] hide()");
                        }
                    });
                });
            }
        } else {
            eprintln!("[floating] window missing when toggling visible={visible}");
        }
    });
}

fn emit_floating_status(app: &AppHandle, visible: bool, state: &str, text: &str, rms: f32) {
    let payload = FloatingStatus {
        visible,
        state: state.into(),
        text: text.into(),
        rms,
    };
    if let Ok(mut slot) = floating_status_slot(app).lock() {
        *slot = payload.clone();
    }
    set_floating_window_visible(app, visible);
    let _ = app.emit("floating-status", payload);
}

const FLOATING_HUD_H: f64 = 56.0;
const FLOATING_HUD_MIN_W: f64 = 240.0;
const FLOATING_HUD_MAX_W: f64 = 640.0;
const FLOATING_HUD_BOTTOM_INSET: f64 = 48.0;
const FLOATING_HUD_CORNER_RADIUS: f64 = 28.0;

fn floating_hud_logical_position(app: &AppHandle, win_w: f64) -> (f64, f64) {
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

#[cfg(target_os = "macos")]
fn configure_floating_hud_panel(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{
        NSColor, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    let Ok(ns_ptr) = window.ns_window() else {
        eprintln!("[floating] ns_window() failed");
        return;
    };

    unsafe {
        let ns_window = &*(ns_ptr as *const NSWindow);

        // Frameless, non-activating panel behavior — won't steal focus from the typed app.
        let mut mask = ns_window.styleMask();
        mask.insert(NSWindowStyleMask::Borderless);
        mask.insert(NSWindowStyleMask::NonactivatingPanel);
        mask.remove(NSWindowStyleMask::Titled);
        mask.remove(NSWindowStyleMask::Closable);
        mask.remove(NSWindowStyleMask::Miniaturizable);
        mask.remove(NSWindowStyleMask::Resizable);
        ns_window.setStyleMask(mask);

        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
        ns_window.setHasShadow(true);
        ns_window.setMovableByWindowBackground(true);
        ns_window.setIgnoresMouseEvents(false);

        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary;
        ns_window.setCollectionBehavior(behavior);
    }

    if let Err(e) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(FLOATING_HUD_CORNER_RADIUS),
    ) {
        eprintln!("[floating] apply_vibrancy failed: {e}");
    } else {
        eprintln!("[floating] HudWindow vibrancy applied (radius {FLOATING_HUD_CORNER_RADIUS})");
    }
}

fn create_floating_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("floating").is_some() {
        return Ok(());
    }
    let (x, y) = floating_hud_logical_position(app, FLOATING_HUD_MIN_W);
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
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .resizable(false)
        .initialization_script(
            r#"
            window.__ASR_FLOATING__ = true;
            document.documentElement.setAttribute('data-floating', '1');
            document.documentElement.classList.add('dark');
            document.documentElement.setAttribute('data-theme', 'dark');
            "#,
        )
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    configure_floating_hud_panel(&window);

    eprintln!("[floating] ASR HUD window created");
    Ok(())
}

#[tauri::command]
fn get_floating_status(app: AppHandle) -> FloatingStatus {
    floating_status_slot(&app)
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

/// Keep the frosted capsule horizontally centered as its elastic width changes.
/// Preserves the current Y so a user-dragged position is not reset.
#[tauri::command]
fn recenter_floating_hud(app: AppHandle, width: f64) {
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
                _ => floating_hud_logical_position(&app, width),
            };
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
    });
}

#[tauri::command]
fn get_permission_status() -> permissions::PermissionStatus {
    permissions::get_permission_status()
}

#[tauri::command]
fn open_permission_settings(kind: String) -> Result<(), String> {
    permissions::open_permission_settings(&kind)
}

fn install_app_menu(app: &AppHandle) -> Result<(), String> {
    let config = app
        .state::<AsrEngine>()
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .unwrap_or_default();
    let language = SubmenuBuilder::new(app, "Language")
        .text("lang:en-US", menu_label("English", config.language == "en-US"))
        .text("lang:zh-CN", menu_label("简体中文", config.language == "zh-CN"))
        .text("lang:zh-TW", menu_label("繁體中文", config.language == "zh-TW"))
        .text("lang:ja-JP", menu_label("日本語", config.language == "ja-JP"))
        .text("lang:ko-KR", menu_label("한국어", config.language == "ko-KR"))
        .build()
        .map_err(|e| e.to_string())?;
    let llm = SubmenuBuilder::new(app, "LLM Refinement")
        .text(
            "llm:toggle",
            if config.llm_enabled {
                "Disable Refinement"
            } else {
                "Enable Refinement"
            },
        )
        .text("llm:settings", "Settings...")
        .build()
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .item(&language)
        .item(&llm)
        .build()
        .map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

fn menu_label(label: &str, selected: bool) -> String {
    if selected {
        format!("✓ {label}")
    } else {
        label.to_string()
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(language) = id.strip_prefix("lang:") {
        if let Ok(mut config) = app.state::<AsrEngine>().inner().config.lock() {
            config.language = language.to_string();
            let _ = save_config_to_disk(&config);
            let _ = app.emit("config-updated", config.clone());
        }
        let _ = install_app_menu(app);
        return;
    }

    match id {
        "llm:toggle" => {
            if let Ok(mut config) = app.state::<AsrEngine>().inner().config.lock() {
                config.llm_enabled = !config.llm_enabled;
                let _ = save_config_to_disk(&config);
                let _ = app.emit("config-updated", config.clone());
            }
            let _ = install_app_menu(app);
        }
        "llm:settings" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = app.emit("open-settings", "llm");
            }
        }
        _ => {}
    }
}

fn start_fn_event_tap(app: AppHandle) {
    std::thread::Builder::new()
        .name("fn-event-tap".into())
        .spawn(move || {
            let fn_down = Arc::new(AtomicBool::new(false));
            let fn_down_cb = fn_down.clone();
            let app_cb = app.clone();
            let installed = CGEventTap::with_enabled(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                vec![CGEventType::FlagsChanged],
                move |_proxy, event_type, event| {
                    if event_type as u32 != CGEventType::FlagsChanged as u32 {
                        return CallbackResult::Keep;
                    }
                    let has_fn = event
                        .get_flags()
                        .contains(CGEventFlags::CGEventFlagSecondaryFn);
                    let was_down = fn_down_cb.swap(has_fn, Ordering::AcqRel);
                    if has_fn && !was_down {
                        let _ = app_cb.emit("fn-key-down", ());
                        return CallbackResult::Drop;
                    }
                    if !has_fn && was_down {
                        let _ = app_cb.emit("fn-key-up", ());
                        return CallbackResult::Drop;
                    }
                    if has_fn {
                        return CallbackResult::Drop;
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

fn refine_transcript(config: &AppConfig, input: &str) -> Result<String, String> {
    if !config.llm_enabled
        || config.llm_api_base_url.trim().is_empty()
        || config.llm_api_key.trim().is_empty()
        || config.llm_model.trim().is_empty()
        || input.trim().is_empty()
    {
        return Ok(input.to_string());
    }

    #[derive(Serialize)]
    struct Message<'a> {
        role: &'a str,
        content: String,
    }

    #[derive(Serialize)]
    struct Request<'a> {
        model: &'a str,
        temperature: f32,
        messages: Vec<Message<'a>>,
    }

    #[derive(Deserialize)]
    struct Response {
        choices: Vec<Choice>,
    }

    #[derive(Deserialize)]
    struct Choice {
        message: ResponseMessage,
    }

    #[derive(Deserialize)]
    struct ResponseMessage {
        content: String,
    }

    let glossary = if config.vocabulary.is_empty() {
        String::new()
    } else {
        format!("\n用户词库，尽量保留这些词的正确写法: {}", config.vocabulary.join(", "))
    };
    let system = format!(
        "你是语音识别文本的保守纠错器。只修复明显语音识别错误，例如中文谐音错误、中英文技术术语误识别（配森->Python、杰森->JSON、麦赛口->MySQL）。绝对不要改写、润色、补充、总结、删除任何看起来正确的内容。不要改变语气、标点风格或语言混杂方式。如果输入看起来正确，必须原样返回。只输出最终文本，不要解释。{}",
        glossary
    );
    let request = Request {
        model: config.llm_model.trim(),
        temperature: 0.0,
        messages: vec![
            Message {
                role: "system",
                content: system,
            },
            Message {
                role: "user",
                content: input.to_string(),
            },
        ],
    };
    let base = config.llm_api_base_url.trim().trim_end_matches('/');
    let url = format!("{base}/chat/completions");
    let response = reqwest::blocking::Client::new()
        .post(url)
        .bearer_auth(config.llm_api_key.trim())
        .json(&request)
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("LLM HTTP {}", response.status()));
    }
    let parsed: Response = response.json().map_err(|e| e.to_string())?;
    Ok(parsed
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| input.to_string()))
}

fn inject_text_via_paste(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    // HIToolbox input-source APIs assert they run on the main dispatch queue.
    // Callers must invoke this via `inject_text_via_paste_on_main`.
    let _input_source_guard = switch_to_ascii_if_cjk();

    write_clipboard_text(text)?;
    post_cmd_v()?;
    // Leave transcript on the clipboard (user expectation: "写入剪切板").
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_clipboard_text(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let ns = NSString::from_str(text);
    if !pb.setString_forType(&ns, unsafe { NSPasteboardTypeString }) {
        return Err("failed to write NSPasteboard".into());
    }
    eprintln!("[paste] clipboard written ({} chars)", text.chars().count());
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_clipboard_text(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or("pbcopy stdin unavailable")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// Synthesize ⌘V via CGEvent so paste goes to the currently focused app
/// without requiring Automation (Apple Events) permission for System Events.
#[cfg(target_os = "macos")]
fn post_cmd_v() -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "CGEventSource unavailable".to_string())?;

    let key_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
        .map_err(|_| "failed to create key-down".to_string())?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);

    let key_up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
        .map_err(|_| "failed to create key-up".to_string())?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);

    key_down.post(CGEventTapLocation::HID);
    key_up.post(CGEventTapLocation::HID);
    eprintln!("[paste] Cmd+V posted via CGEvent");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn post_cmd_v() -> Result<(), String> {
    let status = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to keystroke "v" using command down"#,
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(
            "Paste failed (grant Accessibility permission to ASR Workshop in System Settings)"
                .into(),
        );
    }
    Ok(())
}

/// Dispatch paste + input-source switching onto the AppKit main thread.
/// Calling TIS*/HIToolbox from mlx-worker causes EXC_BREAKPOINT (_dispatch_assert_queue_fail).
fn inject_text_via_paste_on_main(app: &AppHandle, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let text = text.to_string();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = inject_text_via_paste(&text);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule paste on main thread: {e}"))?;
    rx.recv()
        .map_err(|e| format!("paste main-thread channel closed: {e}"))?
}

fn save_recording_wav(samples: &[f32], id: &str) -> Result<PathBuf, String> {
    let dir = recordings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.wav"));
    let bytes = samples_to_wav_bytes(samples)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

fn append_history(
    app: &AppHandle,
    result: &TranscriptionResult,
    source: &str,
    audio_path: Option<String>,
) {
    let state = app.state::<AsrEngine>();
    let mut history = match state.inner().history.lock() {
        Ok(history) => history,
        Err(_) => return,
    };
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        history.len().saturating_add(1)
    );
    history.insert(
        0,
        HistoryEntry {
            id,
            text: result.text.clone(),
            raw_text: result.raw_text.clone(),
            language: result.language.clone(),
            duration_seconds: result.duration_seconds,
            created_at: chrono::Utc::now().to_rfc3339(),
            refined: result.refined,
            audio_path,
            source: source.to_string(),
        },
    );
    history.truncate(200);
    let _ = save_history_to_disk(&history);
}

fn finalize_successful_result(
    app: &AppHandle,
    result: &mut TranscriptionResult,
    samples: Option<&[f32]>,
    audio_path_override: Option<String>,
) {
    let source = AsrEngine::session_mode(app);
    let is_transcribe = source == "transcribe";

    let config = app
        .state::<AsrEngine>()
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .unwrap_or_default();
    if config.llm_enabled
        && !config.llm_api_base_url.is_empty()
        && !config.llm_api_key.is_empty()
        && !config.llm_model.is_empty()
    {
        emit_floating_status(app, !is_transcribe, "refining", "Refining...", 0.0);
        match refine_transcript(&config, &result.text) {
            Ok(refined) => {
                result.refined = refined != result.text;
                result.text = refined;
            }
            Err(e) => {
                eprintln!("[llm] refine failed: {e}");
            }
        }
    }

    if is_transcribe {
        emit_floating_status(app, false, "processing", &result.text, 0.0);
    } else {
        emit_floating_status(app, true, "processing", &result.text, 0.0);
        match inject_text_via_paste_on_main(app, &result.text) {
            Ok(()) => {
                eprintln!("[paste] injected {} chars", result.text.chars().count());
            }
            Err(e) => {
                eprintln!("[paste] injection failed: {e}");
                let _ = app.emit(
                    "partial-error",
                    format!("已写入剪切板，但粘贴失败（请检查辅助功能权限）: {e}"),
                );
            }
        }
    }

    let audio_path = if is_transcribe {
        if audio_path_override.is_some() {
            audio_path_override
        } else {
            samples.and_then(|s| {
                if s.is_empty() {
                    return None;
                }
                let id = format!("{}", chrono::Utc::now().timestamp_millis());
                match save_recording_wav(s, &id) {
                    Ok(path) => {
                        eprintln!("[transcribe] saved audio {:?}", path);
                        Some(path.to_string_lossy().to_string())
                    }
                    Err(e) => {
                        eprintln!("[transcribe] save audio failed: {e}");
                        None
                    }
                }
            })
        }
    } else {
        None
    };

    append_history(app, result, &source, audio_path);
}

fn transcribe_with_elevenlabs(config: &AppConfig, samples: &[f32]) -> Result<TranscriptionResult, String> {
    if config.elevenlabs_api_key.trim().is_empty() {
        return Err("ElevenLabs API Key not configured".into());
    }
    let wav = samples_to_wav_bytes(samples)?;
    let part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model_id", config.elevenlabs_model.clone())
        .text("language_code", normalize_language_for_elevenlabs(&config.language))
        .text("tag_audio_events", "false");
    if !config.vocabulary.is_empty() {
        form = form.text("keyterms", config.vocabulary.join(", "));
    }

    #[derive(Deserialize)]
    struct ElevenLabsResponse {
        text: Option<String>,
        language_code: Option<String>,
    }

    let response = reqwest::blocking::Client::new()
        .post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", config.elevenlabs_api_key.trim())
        .multipart(form)
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("ElevenLabs HTTP {}", response.status()));
    }
    let parsed: ElevenLabsResponse = response.json().map_err(|e| e.to_string())?;
    let text = parsed.text.unwrap_or_default();
    Ok(TranscriptionResult {
        text: text.clone(),
        raw_text: text,
        language: parsed.language_code.unwrap_or_else(|| config.language.clone()),
        duration_seconds: samples.len() as f64 / 16_000.0,
        refined: false,
        error: None,
    })
}

fn transcribe_with_apple_speech(config: &AppConfig, samples: &[f32]) -> Result<TranscriptionResult, String> {
    let mut audio_file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    audio_file
        .write_all(&samples_to_wav_bytes(samples)?)
        .map_err(|e| e.to_string())?;
    let audio_path = audio_file.path().to_string_lossy().to_string();
    let mut script_file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    script_file
        .write_all(APPLE_SPEECH_SWIFT.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = Command::new("/usr/bin/swift")
        .arg(script_file.path())
        .arg(&audio_path)
        .arg(&config.language)
        .output()
        .map_err(|e| format!("Apple Speech bridge failed to start: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Apple Speech bridge failed".into()
        } else {
            stderr
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(TranscriptionResult {
        text: text.clone(),
        raw_text: text,
        language: config.language.clone(),
        duration_seconds: samples.len() as f64 / 16_000.0,
        refined: false,
        error: None,
    })
}

const APPLE_SPEECH_SWIFT: &str = r#"
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 3 else {
  fputs("usage: apple_speech.swift <audio-path> <locale>\n", stderr)
  exit(2)
}

let audioURL = URL(fileURLWithPath: args[1])
let requestedLocale = args[2]
let candidates = Array(NSOrderedSet(array: [
  requestedLocale,
  requestedLocale.replacingOccurrences(of: "_", with: "-"),
  "zh-CN",
  "en-US",
]).array as! [String])

let semaphore = DispatchSemaphore(value: 0)
var finalText = ""
var finalError: String?

func authorizeAndRecognize(localeId: String) {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
        recognizer.isAvailable else {
    return
  }

  let request = SFSpeechURLRecognitionRequest(url: audioURL)
  request.shouldReportPartialResults = false
  if #available(macOS 13.0, *) {
    request.addsPunctuation = true
  }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      finalText = result.bestTranscription.formattedString
      if result.isFinal {
        semaphore.signal()
      }
      return
    }
    if let error = error {
      finalError = error.localizedDescription
      semaphore.signal()
    }
  }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else {
    let hint: String
    switch status {
    case .denied:
      hint = "denied — enable Speech Recognition for ASR Workshop in System Settings → Privacy & Security"
    case .restricted:
      hint = "restricted by system policy"
    case .notDetermined:
      hint = "not determined — permission prompt may have been blocked"
    default:
      hint = "status=\(status.rawValue)"
    }
    finalError = "Speech recognition permission \(hint)"
    semaphore.signal()
    return
  }

  var started = false
  for localeId in candidates {
    if let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
       recognizer.isAvailable {
      authorizeAndRecognize(localeId: localeId)
      started = true
      break
    }
  }
  if !started {
    finalError = "Speech recognizer unavailable for locales: \(candidates.joined(separator: ", "))"
    semaphore.signal()
  }
}

let waitResult = semaphore.wait(timeout: .now() + 60)
if waitResult == .timedOut {
  fputs("Apple Speech timed out after 60s\n", stderr)
  exit(1)
}
if let finalError = finalError {
  fputs(finalError + "\n", stderr)
  exit(1)
}
if finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("Apple Speech returned empty transcript (no speech detected or unsupported audio)\n", stderr)
  exit(1)
}
print(finalText)
"#;

fn samples_to_wav_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
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

/// Load audio as 16 kHz mono f32. WAV is read directly; other formats go through afconvert.
fn load_audio_samples_16k(path: &Path) -> Result<Vec<f32>, String> {
    if let Ok(samples) = read_wav_as_f32_mono_16k(path) {
        return Ok(samples);
    }
    let dir = recordings_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let converted = dir.join(format!(
        "convert-{}.wav",
        chrono::Utc::now().timestamp_millis()
    ));
    let status = Command::new("/usr/bin/afconvert")
        .args([
            "-f",
            "WAVE",
            "-d",
            "LEI16@16000",
            "-c",
            "1",
            path.to_str().ok_or("invalid audio path")?,
            converted.to_str().ok_or("invalid output path")?,
        ])
        .status()
        .map_err(|e| format!("afconvert failed to start: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(&converted);
        return Err(
            "无法解码音频。请上传 WAV / M4A / MP3 / CAF，或先转为 16kHz WAV。".into(),
        );
    }
    let samples = read_wav_as_f32_mono_16k(&converted);
    let _ = fs::remove_file(&converted);
    samples
}

fn read_wav_as_f32_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
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

fn copy_into_recordings(src: &Path) -> Result<PathBuf, String> {
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

fn normalize_language_for_elevenlabs(language: &str) -> String {
    match language {
        "zh-CN" | "zh-TW" => "zh".into(),
        "en-US" => "en".into(),
        "ja-JP" => "ja".into(),
        "ko-KR" => "ko".into(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// MLX worker thread — owns the inference engine, all MLX ops happen here.
// ---------------------------------------------------------------------------

#[cfg(feature = "qwen-local")]
fn mlx_worker(rx: Receiver<WorkerCommand>, app: AppHandle, model_loaded: Arc<AtomicBool>) {
    qwen3_asr_rs::backend::mlx::stream::init_mlx(true);
    eprintln!("[mlx-worker] MLX initialized, waiting for commands...");

    let mut inference: Option<qwen3_asr_rs::inference::AsrInference> = None;
    let recording = app.state::<AsrEngine>().inner().recording.clone();

    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::LoadModel { path } => {
                eprintln!("[mlx-worker] Loading model from {:?}", path);
                match qwen3_asr_rs::inference::AsrInference::load(
                    &path,
                    qwen3_asr_rs::tensor::Device::Gpu(0),
                ) {
                    Ok(inf) => {
                        eprintln!("[mlx-worker] Model loaded successfully");
                        inference = Some(inf);
                        model_loaded.store(true, Ordering::Release);
                        let _ = app.emit("model-loaded", &path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        eprintln!("[mlx-worker] Model load failed: {}", e);
                        model_loaded.store(false, Ordering::Release);
                        let _ = app.emit("model-error", &format!("Failed to load model: {}", e));
                    }
                }
            }

            WorkerCommand::StartStreaming {
                chunk_sec,
                rollback_tokens,
                language,
            } => {
                let inf = match inference.as_mut() {
                    Some(inf) => inf,
                    None => {
                        eprintln!("[mlx-worker] StartStreaming but no model loaded");
                        continue;
                    }
                };

                let chunk_samples = (chunk_sec * 16000.0) as usize;

                eprintln!(
                    "[mlx-worker] streaming: chunk={}s ({} samples), rollback={}",
                    chunk_sec, chunk_samples, rollback_tokens
                );

                let mut stream_state =
                    match inf.init_streaming(language.as_deref(), rollback_tokens) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[mlx-worker] init_streaming failed: {}", e);
                            let _ = app.emit("partial-error", &format!("init_streaming: {e}"));
                            continue;
                        }
                    };

                eprintln!(
                    "[mlx-worker] streaming loop started (rollback={})",
                    rollback_tokens
                );
                let mut partial_count = 0usize;
                let mut last_transcribed_samples = 0usize;

                // --- Self-paced streaming loop ---
                // After each transcription, wait for at least chunk_sec of new
                // audio before the next round.
                loop {
                    if !recording.load(Ordering::Acquire) {
                        break;
                    }

                    std::thread::sleep(Duration::from_millis(50));

                    let samples = match AsrEngine::get_audio_snapshot(&app) {
                        Some(s) => s,
                        None => break, // recorder gone
                    };

                    // Wait until enough new audio has accumulated.
                    let new_samples = samples.len().saturating_sub(last_transcribed_samples);
                    if samples.len() < chunk_samples || new_samples < chunk_samples {
                        continue;
                    }

                    partial_count += 1;
                    let duration = samples.len() as f64 / 16000.0;
                    eprintln!(
                        "[mlx-worker] partial #{}: {:.1}s audio (+{:.1}s new)",
                        partial_count,
                        duration,
                        new_samples as f64 / 16000.0
                    );

                    match inf.streaming_transcribe_partial(&samples, &mut stream_state) {
                        Ok(r) => {
                            last_transcribed_samples = samples.len();

                            if recording.load(Ordering::Acquire) {
                                eprintln!(
                                    "[mlx-worker] partial #{} done: lang={} text_len={}",
                                    partial_count,
                                    r.language,
                                    r.text.len()
                                );
                                // Only emit if there's new text — avoids
                                // flicker when a partial step produces no
                                // new complete chunk.
                                if !r.text.is_empty() {
                                    let _ =
                                        app.emit("partial-result", &PartialResult { text: r.text });
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[mlx-worker] partial #{} failed: {}", partial_count, e);
                            let _ = app.emit("partial-error", &format!("{e}"));
                        }
                    }
                }

                eprintln!("[mlx-worker] streaming loop ended, doing final transcription");

                // --- Final transcription ---
                // Take the recorder, stop it, get all samples.
                let samples = match AsrEngine::take_recorder_and_stop(&app) {
                    Some(s) => s,
                    None => {
                        eprintln!("[mlx-worker] recorder already gone, skipping final");
                        let _ = app.emit(
                            "transcription-result",
                            &TranscriptionResult {
                                text: String::new(),
                                raw_text: String::new(),
                                language: String::new(),
                                duration_seconds: 0.0,
                                refined: false,
                                error: Some("Recorder not found".into()),
                            },
                        );
                        continue;
                    }
                };

                let duration = samples.len() as f64 / 16000.0;
                eprintln!("[mlx-worker] final: {:.1}s audio", duration);

                // Final transcription: process everything including tail frames.
                let mut result = match inf.streaming_transcribe(&samples, &mut stream_state) {
                    Ok(r) => TranscriptionResult {
                        text: r.text.clone(),
                        raw_text: r.text,
                        language: r.language,
                        duration_seconds: r.duration_seconds,
                        refined: false,
                        error: None,
                    },
                    Err(e) => TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: String::new(),
                        duration_seconds: duration,
                        refined: false,
                        error: Some(format!("{e}")),
                    },
                };

                if result.error.is_none() {
                    finalize_successful_result(&app, &mut result, Some(&samples), None);
                }
                emit_floating_status(&app, false, "idle", "", 0.0);

                eprintln!(
                    "[mlx-worker] final done: lang={} text_len={} error={:?}",
                    result.language,
                    result.text.len(),
                    result.error
                );
                let _ = app.emit("transcription-result", &result);
            }

            WorkerCommand::TranscribeFile { path } => {
                AsrEngine::set_session_mode(&app, "transcribe");
                let saved = match copy_into_recordings(&path) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit(
                            "transcription-result",
                            &TranscriptionResult {
                                text: String::new(),
                                raw_text: String::new(),
                                language: String::new(),
                                duration_seconds: 0.0,
                                refined: false,
                                error: Some(e),
                            },
                        );
                        continue;
                    }
                };
                let samples = match load_audio_samples_16k(&path) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = app.emit(
                            "transcription-result",
                            &TranscriptionResult {
                                text: String::new(),
                                raw_text: String::new(),
                                language: String::new(),
                                duration_seconds: 0.0,
                                refined: false,
                                error: Some(e),
                            },
                        );
                        continue;
                    }
                };
                let duration = samples.len() as f64 / 16_000.0;
                let language = app
                    .state::<AsrEngine>()
                    .inner()
                    .config
                    .lock()
                    .ok()
                    .map(|c| c.language.clone());
                let mut result = match inference.as_mut() {
                    Some(inf) => match inf.transcribe_samples(&samples, language.as_deref()) {
                        Ok(r) => TranscriptionResult {
                            text: r.text.clone(),
                            raw_text: r.text,
                            language: r.language,
                            duration_seconds: r.duration_seconds,
                            refined: false,
                            error: None,
                        },
                        Err(e) => TranscriptionResult {
                            text: String::new(),
                            raw_text: String::new(),
                            language: language.unwrap_or_default(),
                            duration_seconds: duration,
                            refined: false,
                            error: Some(format!("{e}")),
                        },
                    },
                    None => TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: String::new(),
                        duration_seconds: duration,
                        refined: false,
                        error: Some("Model not loaded".into()),
                    },
                };
                if result.error.is_none() {
                    finalize_successful_result(
                        &app,
                        &mut result,
                        None,
                        Some(saved.to_string_lossy().to_string()),
                    );
                }
                let _ = app.emit("transcription-result", &result);
            }
        }
    }

    eprintln!("[mlx-worker] channel closed, exiting");
}

#[cfg(not(feature = "qwen-local"))]
fn mlx_worker(rx: Receiver<WorkerCommand>, app: AppHandle, model_loaded: Arc<AtomicBool>) {
    eprintln!("[mlx-worker] qwen-local feature disabled; MLX backend not compiled");
    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCommand::LoadModel { .. } => {
                model_loaded.store(false, Ordering::Release);
                let _ = app.emit(
                    "model-error",
                    "Local Qwen backend disabled. Run `cargo run --features qwen-local` with full Xcode Metal toolchain installed.",
                );
            }
            WorkerCommand::StartStreaming { .. } => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: String::new(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some("Local Qwen backend disabled".into()),
                    },
                );
            }
            WorkerCommand::TranscribeFile { .. } => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: String::new(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some("Local Qwen backend disabled".into()),
                    },
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn has_model_weights(path: &Path) -> bool {
    path.join("model.safetensors").exists() || path.join("model.safetensors.index.json").exists()
}

#[tauri::command]
fn set_model_dir(path: String, engine: State<'_, AsrEngine>) -> Result<(), String> {
    *engine.inner().model_dir.lock().map_err(|e| e.to_string())? = path;
    if let Ok(mut config) = engine.inner().config.lock() {
        config.asr_model_dir = engine
            .inner()
            .model_dir
            .lock()
            .map(|dir| dir.clone())
            .unwrap_or_default();
        let _ = save_config_to_disk(&config);
    }
    Ok(())
}

#[tauri::command]
fn get_model_dir(engine: State<'_, AsrEngine>) -> Result<String, String> {
    engine
        .inner()
        .model_dir
        .lock()
        .map(|d| d.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_config(engine: State<'_, AsrEngine>) -> Result<AppConfig, String> {
    engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_app_config(config: AppConfig, engine: State<'_, AsrEngine>) -> Result<(), String> {
    {
        let mut current = engine.inner().config.lock().map_err(|e| e.to_string())?;
        *current = config.clone();
    }
    {
        let mut model_dir = engine.inner().model_dir.lock().map_err(|e| e.to_string())?;
        *model_dir = config.asr_model_dir.clone();
    }
    save_config_to_disk(&config)
}

#[tauri::command]
fn get_history(engine: State<'_, AsrEngine>) -> Result<Vec<HistoryEntry>, String> {
    engine
        .inner()
        .history
        .lock()
        .map(|history| history.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_history(engine: State<'_, AsrEngine>) -> Result<(), String> {
    {
        let mut history = engine.inner().history.lock().map_err(|e| e.to_string())?;
        history.clear();
    }
    save_history_to_disk(&[])
}

#[tauri::command]
fn test_llm_refinement(text: String, engine: State<'_, AsrEngine>) -> Result<String, String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    refine_transcript(&config, &text)
}

#[tauri::command]
fn load_model(engine: State<'_, AsrEngine>) -> Result<(), String> {
    let dir = engine
        .inner()
        .model_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if dir.is_empty() {
        return Err("Model directory not configured".into());
    }
    let path = PathBuf::from(&dir);
    if !has_model_weights(&path) {
        return Err(format!(
            "Model weights not found in {} (expected model.safetensors or model.safetensors.index.json)",
            dir
        ));
    }
    engine.send_worker(WorkerCommand::LoadModel { path })
}

/// Minimum audio length (in samples) before we attempt a partial transcription.
#[cfg(feature = "qwen-local")]
const MIN_PARTIAL_SAMPLES: usize = 16_000; // 1 second @ 16kHz

#[tauri::command]
fn start_recording(
    chunk_sec: Option<f64>,
    rollback_tokens: Option<usize>,
    language: Option<String>,
    mode: Option<String>,
    app: AppHandle,
    engine: State<'_, AsrEngine>,
) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    // Reject if already recording.
    {
        let guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Already recording".into());
        }
    }
    if matches!(config.asr_provider, AsrProvider::Qwen)
        && !engine.inner().model_loaded.load(Ordering::Acquire)
    {
        return Err("Model not loaded".into());
    }

    let session = match mode.as_deref() {
        Some("transcribe") => "transcribe",
        _ => "fn",
    };
    AsrEngine::set_session_mode(&app, session);

    let rec = AudioRecorder::start().map_err(|e| e.to_string())?;
    {
        let mut guard = engine.inner().recorder.lock().map_err(|e| e.to_string())?;
        *guard = Some(SendWrapper::new(rec));
    }
    engine.inner().recording.store(true, Ordering::Release);

    // Fn mode shows the floating HUD; Transcribe tab keeps UI in-page.
    let show_hud = session == "fn";
    emit_floating_status(&app, show_hud, "recording", "", 0.0);
    spawn_audio_level_pump(app.clone(), engine.inner().recording.clone());

    // Defaults: 0.5s chunk, rollback=1.
    let chunk_sec = chunk_sec.unwrap_or(0.5);
    let rollback_tokens = rollback_tokens.unwrap_or(1);
    let language = language.or_else(|| {
        engine
            .inner()
            .config
            .lock()
            .ok()
            .map(|config| config.language.clone())
    });

    // Tell the local streaming worker to enter the loop only for Qwen.
    if matches!(config.asr_provider, AsrProvider::Qwen) {
        engine.send_worker(WorkerCommand::StartStreaming {
            chunk_sec,
            rollback_tokens,
            language,
        })?;
    }
    eprintln!(
        "[asr] recording started, provider={} mode={} chunk={}s rollback={}",
        config.asr_provider.label(),
        session,
        chunk_sec,
        rollback_tokens
    );

    Ok(())
}

#[tauri::command]
fn stop_recording(app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    let session = AsrEngine::session_mode(&app);
    let show_hud = session == "fn";

    // Signal the worker's streaming loop to stop.
    // The worker will then do the final transcription automatically.
    engine.inner().recording.store(false, Ordering::Release);
    emit_floating_status(&app, show_hud, "processing", "Transcribing...", 0.0);
    if matches!(config.asr_provider, AsrProvider::Qwen) {
        eprintln!("[asr] stop signaled, worker will finish current partial then do final");
        return Ok(());
    }

    let samples = AsrEngine::take_recorder_and_stop(&app)
        .ok_or_else(|| "Recorder not found".to_string())?;
    std::thread::spawn(move || {
        let mut result = match config.asr_provider {
            AsrProvider::Elevenlabs => transcribe_with_elevenlabs(&config, &samples)
                .unwrap_or_else(|error| TranscriptionResult {
                    text: String::new(),
                    raw_text: String::new(),
                    language: config.language.clone(),
                    duration_seconds: samples.len() as f64 / 16_000.0,
                    refined: false,
                    error: Some(error),
                }),
            AsrProvider::Apple => transcribe_with_apple_speech(&config, &samples).unwrap_or_else(
                |error| TranscriptionResult {
                    text: String::new(),
                    raw_text: String::new(),
                    language: config.language.clone(),
                    duration_seconds: samples.len() as f64 / 16_000.0,
                    refined: false,
                    error: Some(error),
                },
            ),
            AsrProvider::Qwen => unreachable!(),
        };
        if result.error.is_none() {
            finalize_successful_result(&app, &mut result, Some(&samples), None);
        }
        emit_floating_status(&app, false, "idle", "", 0.0);
        let _ = app.emit("transcription-result", &result);
    });
    Ok(())
}

#[tauri::command]
fn transcribe_file(path: String, app: AppHandle, engine: State<'_, AsrEngine>) -> Result<(), String> {
    let config = engine
        .inner()
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|e| e.to_string())?;
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    if engine.inner().recording.load(Ordering::Acquire) {
        return Err("正在录音中，请先结束录音".into());
    }

    AsrEngine::set_session_mode(&app, "transcribe");
    emit_floating_status(&app, false, "processing", "Transcribing...", 0.0);

    if matches!(config.asr_provider, AsrProvider::Qwen) {
        if !engine.inner().model_loaded.load(Ordering::Acquire) {
            return Err("Model not loaded".into());
        }
        engine.send_worker(WorkerCommand::TranscribeFile { path: src })?;
        return Ok(());
    }

    std::thread::spawn(move || {
        let saved = match copy_into_recordings(&src) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: config.language.clone(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some(e),
                    },
                );
                emit_floating_status(&app, false, "idle", "", 0.0);
                return;
            }
        };
        let samples = match load_audio_samples_16k(&src) {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit(
                    "transcription-result",
                    &TranscriptionResult {
                        text: String::new(),
                        raw_text: String::new(),
                        language: config.language.clone(),
                        duration_seconds: 0.0,
                        refined: false,
                        error: Some(e),
                    },
                );
                emit_floating_status(&app, false, "idle", "", 0.0);
                return;
            }
        };
        let mut result = match config.asr_provider {
            AsrProvider::Elevenlabs => transcribe_with_elevenlabs(&config, &samples)
                .unwrap_or_else(|error| TranscriptionResult {
                    text: String::new(),
                    raw_text: String::new(),
                    language: config.language.clone(),
                    duration_seconds: samples.len() as f64 / 16_000.0,
                    refined: false,
                    error: Some(error),
                }),
            AsrProvider::Apple => transcribe_with_apple_speech(&config, &samples).unwrap_or_else(
                |error| TranscriptionResult {
                    text: String::new(),
                    raw_text: String::new(),
                    language: config.language.clone(),
                    duration_seconds: samples.len() as f64 / 16_000.0,
                    refined: false,
                    error: Some(error),
                },
            ),
            AsrProvider::Qwen => unreachable!(),
        };
        if result.error.is_none() {
            finalize_successful_result(
                &app,
                &mut result,
                None,
                Some(saved.to_string_lossy().to_string()),
            );
        }
        emit_floating_status(&app, false, "idle", "", 0.0);
        let _ = app.emit("transcription-result", &result);
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "qwen-local"), allow(dead_code))]
#[derive(Clone, Serialize)]
struct PartialResult {
    text: String,
}

#[derive(Clone, Serialize)]
struct TranscriptionResult {
    text: String,
    raw_text: String,
    language: String,
    duration_seconds: f64,
    refined: bool,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Arc::new(Mutex::new(FloatingStatus::default())));
            if let Err(e) = create_floating_window(&handle) {
                eprintln!("[floating] create window failed: {e}");
            }
            app.manage(AsrEngine::new(handle.clone()));
            if let Err(e) = install_app_menu(&handle) {
                eprintln!("[menu] install failed: {e}");
            }
            start_fn_event_tap(handle);
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            set_model_dir,
            get_model_dir,
            get_app_config,
            save_app_config,
            get_history,
            clear_history,
            test_llm_refinement,
            load_model,
            get_floating_status,
            recenter_floating_hud,
            get_permission_status,
            open_permission_settings,
            start_recording,
            stop_recording,
            transcribe_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
