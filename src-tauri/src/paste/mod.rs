use std::sync::mpsc::{self};
use std::time::Duration;
use tauri::AppHandle;
use crate::platform::*;

pub(crate) fn inject_text_via_paste(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    // HIToolbox input-source APIs assert they run on the main dispatch queue.
    // Callers must invoke this via `inject_text_via_paste_on_main`.
    let _input_source_guard = switch_to_ascii_if_cjk();

    // Make sure the app that had focus when Fn started is frontmost before ⌘V.
    // Without this, paste lands in whatever became active (often our terminal / main).
    #[cfg(target_os = "macos")]
    {
        restore_previous_frontmost_app(false);
        // Adaptive wait: poll target app's isActive instead of blind 40ms sleep.
        // Falls back to 40ms cap if it never becomes active.
        use objc2_app_kit::NSWorkspace;
        let active = (|| {
            let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            Some(front.isActive())
        })();
        if !active.unwrap_or(false) {
            for _ in 0..8 {
                std::thread::sleep(Duration::from_millis(5));
                let ok = (|| {
                    let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
                    Some(front.isActive())
                })();
                if ok.unwrap_or(true) {
                    break;
                }
            }
        }
    }

    write_clipboard_text(text)?;
    post_cmd_v()?;
    // Leave transcript on the clipboard (user expectation: "写入剪切板").
    Ok(())
}

pub(crate) fn inject_text_via_paste_on_main(app: &AppHandle, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let text = text.to_string();
    let (tx, rx) = mpsc::channel();
    let paste_app = app.clone();
    app.run_on_main_thread(move || {
        let started = std::time::Instant::now();
        let result = crate::hud::hide_floating_before_paste(&paste_app).and_then(|()| {
            let hidden_us = started.elapsed().as_micros();
            let result = inject_text_via_paste(&text);
            crate::elog::elog!(
                "[paste] HUD native visible=false before Cmd+V; hide_us={hidden_us} total_us={} success={}",
                started.elapsed().as_micros(), result.is_ok()
            );
            result
        });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule paste on main thread: {e}"))?;
    rx.recv()
        .map_err(|e| format!("paste main-thread channel closed: {e}"))?
}
