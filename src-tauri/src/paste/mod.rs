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
        std::thread::sleep(Duration::from_millis(40));
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
    app.run_on_main_thread(move || {
        let result = inject_text_via_paste(&text);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule paste on main thread: {e}"))?;
    rx.recv()
        .map_err(|e| format!("paste main-thread channel closed: {e}"))?
}
