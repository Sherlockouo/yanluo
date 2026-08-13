#[cfg(target_os = "macos")]
use core_foundation::base::{CFRelease, TCFType};
#[cfg(target_os = "macos")]
use core_foundation::string::{CFString, CFStringRef};
#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(not(target_os = "macos"))]
use std::io::Write;
#[cfg(not(target_os = "macos"))]
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use crate::hud::*;

#[cfg(target_os = "macos")]
pub(crate) type TisInputSourceRef = *const c_void;

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(crate) struct InputSourceGuard {
    original: TisInputSourceRef,
    switched: bool,
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
pub(crate) fn switch_to_ascii_if_cjk() -> Option<InputSourceGuard> {
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

#[cfg(not(target_os = "macos"))]
pub(crate) fn switch_to_ascii_if_cjk() -> Option<()> {
    None
}

#[cfg(target_os = "macos")]
pub(crate) fn input_source_id(source: TisInputSourceRef) -> Option<String> {
    unsafe {
        let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) as CFStringRef;
        if value.is_null() {
            return None;
        }
        Some(CFString::wrap_under_get_rule(value).to_string())
    }
}

pub(crate) fn is_cjk_input_source(id: &str) -> bool {
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
#[cfg(target_os = "macos")]
pub(crate) fn overlay_focus_slot() -> &'static Mutex<Option<i32>> {
    static SLOT: Mutex<Option<i32>> = Mutex::new(None);
    &SLOT
}

#[cfg(target_os = "macos")]
pub(crate) fn remember_frontmost_app() {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};

    let us = NSRunningApplication::currentApplication();
    let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        return;
    };
    if front.processIdentifier() == us.processIdentifier() {
        return;
    }
    if let Ok(mut slot) = overlay_focus_slot().lock() {
        *slot = Some(front.processIdentifier());
    }
}

/// Activate the remembered frontmost app. `clear` drops the stored pid.
#[cfg(target_os = "macos")]
pub(crate) fn restore_previous_frontmost_app(clear: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication,
    };

    let pid = {
        let Ok(mut slot) = overlay_focus_slot().lock() else {
            return;
        };
        if clear {
            slot.take()
        } else {
            *slot
        }
    };
    let Some(pid) = pid else {
        return;
    };
    let Some(prev) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return;
    };
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        app.yieldActivationToApplication(&prev);
    }
    let ok = prev.activateWithOptions(NSApplicationActivationOptions::empty());
    crate::elog::elog!("[focus] restore pid={pid} ok={ok} clear={clear}");
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn remember_frontmost_app() {}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_previous_frontmost_app(_clear: bool) {}

/// Startup-only: restore Regular + Dock. Main stays hidden until FE paints
/// (see `revealMainWindow` in main.tsx) — avoids long white flash.
/// Safety net: show after 3s if FE never revealed.
#[cfg(target_os = "macos")]
pub(crate) fn restore_regular_activation_at_launch(app: &AppHandle) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use std::time::Duration;

    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = app.set_dock_visibility(true);
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).activate();
    }

    let fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3000));
        if let Some(main) = fallback.get_webview_window("main") {
            match main.is_visible() {
                Ok(true) => {}
                _ => {
                    let _ = main.show();
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_regular_activation_at_launch(app: &AppHandle) {
    let _ = app;
}
#[cfg(target_os = "macos")]
pub(crate) fn raise_floating_hud_level(window: &tauri::WebviewWindow, order_front: bool) {
    use objc2_app_kit::{
        NSMainMenuWindowLevel, NSWindow, NSWindowCollectionBehavior,
    };

    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_always_on_top(true);

    let Ok(ns_ptr) = window.ns_window() else {
        return;
    };
    unsafe {
        let ns_window = &*(ns_ptr as *const NSWindow);
        // MainMenu level is enough for overlays; PopUp is fine too but MainMenu
        // is the common choice for fullscreen-auxiliary HUDs.
        ns_window.setLevel(NSMainMenuWindowLevel + 2);
        // Absolute mask — do not OR with Tauri defaults (Managed /
        // MoveToActiveSpace / Stationary eject HUD from fullscreen Spaces).
        // Transient also keeps overlays off fullscreen Spaces; omit it.
        // Canonical: CanJoinAllSpaces | FullScreenAuxiliary (+ Stage Manager).
        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::CanJoinAllApplications;
        ns_window.setCollectionBehavior(behavior);
        // Always opaque for show — cancel any in-flight dismiss fade.
        ns_window.setAlphaValue(1.0);
        if order_front {
            ns_window.orderFrontRegardless();
        }
    }
}

/// Match FE HUD exit (`duration.slow` = 220ms). Native alpha tracks capsule.
pub(crate) const FLOATING_EXIT_SECS: f64 = 0.22;

static FLOATING_FADE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn bump_floating_fade_gen() -> u64 {
    FLOATING_FADE_GEN.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1
}

fn floating_fade_gen() -> u64 {
    FLOATING_FADE_GEN.load(std::sync::atomic::Ordering::Acquire)
}

/// Fade HUD (+ optional lang chip) with content exit, then orderOut.
/// `gen` from [`bump_floating_fade_gen`] — superseded show/hide no-ops completion.
#[cfg(target_os = "macos")]
pub(crate) fn fade_out_floating_hud(app: &AppHandle, gen: u64) {
    use std::ptr::NonNull;
    use block2::RcBlock;
    use objc2_app_kit::{
        NSAnimatablePropertyContainer, NSAnimationContext, NSWindow,
    };

    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(window) = app.get_webview_window("floating") else {
            return;
        };
        let Ok(ns_ptr) = window.ns_window() else {
            finish_fade_hide(&app, gen);
            return;
        };

        let lang_ns = app
            .get_webview_window("floating-lang")
            .and_then(|w| w.ns_window().ok());

        unsafe {
            let ns_window = &*(ns_ptr as *const NSWindow);
            ns_window.setAlphaValue(1.0);

            let changes = RcBlock::new(move |ctx: NonNull<NSAnimationContext>| {
                let ctx = unsafe { ctx.as_ref() };
                ctx.setDuration(FLOATING_EXIT_SECS);
                ctx.setAllowsImplicitAnimation(true);
                let ns_window = &*(ns_ptr as *const NSWindow);
                ns_window.animator().setAlphaValue(0.0);
                if let Some(lang_ptr) = lang_ns {
                    let lang = &*(lang_ptr as *const NSWindow);
                    lang.animator().setAlphaValue(0.0);
                }
            });
            let app_done = app.clone();
            let completion = RcBlock::new(move || {
                finish_fade_hide(&app_done, gen);
            });
            NSAnimationContext::runAnimationGroup_completionHandler(
                &changes,
                Some(&completion),
            );
        }
    });
}

#[cfg(target_os = "macos")]
fn finish_fade_hide(app: &AppHandle, gen: u64) {
    if floating_fade_gen() != gen {
        return;
    }
    if floating_status_slot(app)
        .lock()
        .map(|s| s.visible)
        .unwrap_or(false)
    {
        return;
    }
    if let Some(window) = app.get_webview_window("floating") {
        let _ = window.hide();
        if let Ok(ns_ptr) = window.ns_window() {
            unsafe {
                use objc2_app_kit::NSWindow;
                let ns_window = &*(ns_ptr as *const NSWindow);
                ns_window.setAlphaValue(1.0);
            }
        }
        crate::elog::elog!("[floating] hide()");
    }
    if let Some(lang) = app.get_webview_window("floating-lang") {
        let _ = lang.hide();
        if let Ok(ns_ptr) = lang.ns_window() {
            unsafe {
                use objc2_app_kit::NSWindow;
                let ns_window = &*(ns_ptr as *const NSWindow);
                ns_window.setAlphaValue(1.0);
            }
        }
    }
    restore_previous_frontmost_app(true);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn fade_out_floating_hud(app: &AppHandle, gen: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            (FLOATING_EXIT_SECS * 1000.0) as u64,
        ));
        if floating_fade_gen() != gen {
            return;
        }
        if floating_status_slot(&app)
            .lock()
            .map(|s| s.visible)
            .unwrap_or(false)
        {
            return;
        }
        let _ = app.clone().run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window("floating") {
                let _ = window.hide();
                crate::elog::elog!("[floating] hide()");
            }
            sync_floating_lang_chip(&app, false);
        });
    });
}

/// Agent edit mode: temporarily drop NonactivatingPanel so textarea can take keys.
/// Must run on the AppKit main thread (mlx-worker must not call this directly).
#[cfg(target_os = "macos")]
pub(crate) fn set_floating_hud_keyable(app: &tauri::AppHandle, keyable: bool) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(window) = app.get_webview_window("floating") else {
            return;
        };
        use objc2_app_kit::{NSWindow, NSWindowStyleMask};
        let Ok(ns_ptr) = window.ns_window() else {
            return;
        };
        unsafe {
            let ns_window = &*(ns_ptr as *const NSWindow);
            let mut mask = ns_window.styleMask();
            if keyable {
                mask.remove(NSWindowStyleMask::NonactivatingPanel);
                ns_window.setStyleMask(mask);
                ns_window.makeKeyAndOrderFront(None);
            } else {
                mask.insert(NSWindowStyleMask::NonactivatingPanel);
                ns_window.setStyleMask(mask);
            }
        }
        if keyable {
            let _ = window.set_focus();
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_floating_hud_keyable(app: &tauri::AppHandle, keyable: bool) {
    if !keyable {
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("floating") {
            let _ = window.set_focus();
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn configure_floating_hud_panel(window: &tauri::WebviewWindow, corner_radius: f64) {
    // No native shadow — rectangular NSWindow shadow rings the pill corners.
    // No CSS edge hairline either (reads as hard dark stroke).
    configure_floating_overlay_panel(window, corner_radius, false, true);
}

/// Translate-target chip / menu: frosted like the HUD, but never a native shadow
/// (shadow + resize left a rectangular ring under the rounded menu).
#[cfg(target_os = "macos")]
pub(crate) fn configure_floating_lang_panel(window: &tauri::WebviewWindow, corner_radius: f64) {
    configure_floating_overlay_panel(window, corner_radius, false, true);
}

/// Agent/cwd picker outside HUD: NonactivatingPanel, no vibrancy, no native
/// shadow (native shadow + clear radius = dark fringe; CSS shadow in inset pad).
#[cfg(target_os = "macos")]
pub(crate) fn configure_floating_agent_menu_panel(
    window: &tauri::WebviewWindow,
    corner_radius: f64,
) {
    configure_floating_overlay_panel(window, corner_radius, false, false);
}

#[cfg(target_os = "macos")]
fn configure_floating_overlay_panel(
    window: &tauri::WebviewWindow,
    corner_radius: f64,
    has_shadow: bool,
    with_vibrancy: bool,
) {
    use objc2_app_kit::{
        NSColor, NSMainMenuWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_always_on_top(true);

    let Ok(ns_ptr) = window.ns_window() else {
        crate::elog::elog!("[floating] ns_window() failed");
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
        ns_window.setHasShadow(has_shadow);
        // false: true steals drag-to-select in textarea (window moves instead).
        // Drag chrome via FE startDragging / -webkit-app-region on handles only.
        ns_window.setMovableByWindowBackground(false);
        ns_window.setIgnoresMouseEvents(false);
        ns_window.setLevel(NSMainMenuWindowLevel + 2);

        // Same absolute mask as raise_floating_hud_level — stay above fullscreen.
        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::CanJoinAllApplications;
        ns_window.setCollectionBehavior(behavior);
    }

    if !with_vibrancy {
        crate::elog::elog!("[floating] overlay panel without vibrancy/shadow");
        return;
    }

    if let Err(e) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(corner_radius),
    ) {
        crate::elog::elog!("[floating] apply_vibrancy failed: {e}");
    } else {
        crate::elog::elog!("[floating] HudWindow vibrancy applied (radius {corner_radius})");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn write_clipboard_text(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let ns = NSString::from_str(text);
    if !pb.setString_forType(&ns, unsafe { NSPasteboardTypeString }) {
        return Err("failed to write NSPasteboard".into());
    }
    crate::elog::elog!("[paste] clipboard written ({} chars)", text.chars().count());
    Ok(())
}

/// Read the current text on the general pasteboard (for paste-undo: snapshot
/// the clipboard before we overwrite it so undo can restore it).
#[cfg(target_os = "macos")]
pub(crate) fn read_clipboard_text() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let pb = NSPasteboard::generalPasteboard();
    let s = pb.stringForType(unsafe { NSPasteboardTypeString })?;
    Some(s.to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_clipboard_text() -> Option<String> {
    // Paste-undo clipboard snapshot is macOS-only for now (auto-paste itself
    // is macOS-only — see `post_cmd_v` below).
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn write_clipboard_text(text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let escaped = text.replace('\'', "''");
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Set-Clipboard -Value '{escaped}'"),
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err("failed to write clipboard via PowerShell".into());
    }
    #[cfg(target_os = "linux")]
    {
        for (bin, args) in [
            ("wl-copy", vec![] as Vec<&str>),
            ("xclip", vec!["-selection", "clipboard"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ] {
            if let Ok(mut child) = Command::new(bin)
                .args(&args)
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                if let Some(stdin) = child.stdin.as_mut() {
                    if stdin.write_all(text.as_bytes()).is_ok() && child.wait().is_ok() {
                        return Ok(());
                    }
                }
            }
        }
        return Err("clipboard helper not found (install wl-copy, xclip, or xsel)".into());
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = text;
        Err("clipboard write unsupported on this platform".into())
    }
}

/// Synthesize ⌘V via CGEvent so paste goes to the currently focused app
/// without requiring Automation (Apple Events) permission for System Events.
#[cfg(target_os = "macos")]
pub(crate) fn post_cmd_v() -> Result<(), String> {
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
    crate::elog::elog!("[paste] Cmd+V posted via CGEvent");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn post_cmd_v() -> Result<(), String> {
    // Auto-paste (synthetic keystroke) is macOS-only; text remains on the clipboard.
    crate::elog::elog!("[paste] auto-paste skipped (non-macOS); text is on clipboard");
    Ok(())
}

/// Read file paths and/or a bitmap image from the general pasteboard.
/// Images are written under `{app_data}/agent/clipboard/`.
#[cfg(target_os = "macos")]
pub(crate) fn read_clipboard_attachment_paths() -> Result<Vec<String>, String> {
    use objc2_app_kit::{
        NSFilenamesPboardType, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSArray, NSString};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    let pb = NSPasteboard::generalPasteboard();
    let mut out: Vec<String> = Vec::new();

    // Finder / file manager paths.
    if let Some(plist) = pb.propertyListForType(unsafe { NSFilenamesPboardType }) {
        if let Some(arr) = plist.downcast_ref::<NSArray>() {
            for i in 0..arr.count() {
                let item = arr.objectAtIndex(i);
                if let Some(s) = item.downcast_ref::<NSString>() {
                    let path = s.to_string();
                    if !path.is_empty() && PathBuf::from(&path).exists() {
                        out.push(path);
                    }
                }
            }
        }
    }

    if !out.is_empty() {
        return Ok(out);
    }

    // Bitmap image → temp file under agent/clipboard.
    let png = pb.dataForType(unsafe { NSPasteboardTypePNG });
    let tiff = if png.is_none() {
        pb.dataForType(unsafe { NSPasteboardTypeTIFF })
    } else {
        None
    };
    let (data, ext) = match (png, tiff) {
        (Some(d), _) => (Some(d), "png"),
        (None, Some(d)) => (Some(d), "tiff"),
        _ => (None, ""),
    };
    if let Some(data) = data {
        let dir = crate::config::app_data_dir().join("agent").join("clipboard");
        fs::create_dir_all(&dir).map_err(|e| format!("创建 clipboard 目录失败: {e}"))?;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("paste-{ts}.{ext}"));
        let ns_path = NSString::from_str(&path.to_string_lossy());
        if !data.writeToFile_atomically(&ns_path, true) {
            return Err("写入剪贴板图片失败".into());
        }
        out.push(path.to_string_lossy().into_owned());
    }

    Ok(out)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_clipboard_attachment_paths() -> Result<Vec<String>, String> {
    Err("剪贴板附件仅支持 macOS".into())
}

/// Open a local path with the OS default app (Preview / Explorer / xdg-open).
pub(crate) fn open_path_in_system(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("不存在: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", path])
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前平台不支持系统打开".into())
}
