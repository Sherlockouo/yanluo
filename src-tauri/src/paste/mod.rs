use crate::platform::*;
use std::sync::mpsc::{self};
use std::time::Duration;
use tauri::AppHandle;

fn paste_current_clipboard() -> Result<(), String> {
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

    post_cmd_v()?;
    Ok(())
}

fn run_paste_sequence(
    write_clipboard: impl FnOnce() -> Result<(), String>,
    hide_hud: impl FnOnce() -> Result<(), String>,
    paste: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    write_clipboard()?;
    hide_hud()?;
    paste()
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
        let result = run_paste_sequence(
            || write_clipboard_text(&text),
            || crate::hud::hide_floating_before_paste(&paste_app),
            paste_current_clipboard,
        );
        crate::elog::elog!(
            "[paste] clipboard written -> HUD native visible=false -> Cmd+V; total_us={} success={}",
            started.elapsed().as_micros(), result.is_ok()
        );
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule paste on main thread: {e}"))?;
    rx.recv()
        .map_err(|e| format!("paste main-thread channel closed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn clipboard_is_written_before_hud_hides_and_paste_posts() {
        let steps = RefCell::new(Vec::new());
        run_paste_sequence(
            || {
                steps.borrow_mut().push("clipboard");
                Ok(())
            },
            || {
                steps.borrow_mut().push("hide");
                Ok(())
            },
            || {
                steps.borrow_mut().push("paste");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*steps.borrow(), ["clipboard", "hide", "paste"]);
    }
}
