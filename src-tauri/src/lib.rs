//! ASR Workshop backend — Tauri application wiring.

mod audio;
mod commands;
mod config;
mod history;
mod hotkey;
mod hud;
mod menu;
mod paste;
mod permissions;
mod platform;
mod state;
mod transcription;
mod update;

pub(crate) use hotkey::*;
pub(crate) use hud::*;
pub(crate) use menu::*;
pub(crate) use platform::*;
pub(crate) use state::*;

use std::sync::{Arc, Mutex};
use tauri::Manager;

pub fn main() {
    // Info.plist is already embedded by `tauri::generate_context!()` —
    // do not call embed_plist again (duplicate `_EMBED_INFO_PLIST` symbol).

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Arc::new(Mutex::new(FloatingStatus::default())));
            app.manage(Arc::new(Mutex::new(HotkeyCaptureSlot::None)));

            // HUD must be *created* under Accessory or macOS ignores
            // CanJoinAllSpaces / FullScreenAuxiliary (won't overlay fullscreen apps).
            // Immediately restore Regular + Dock so startup still shows an icon.
            #[cfg(target_os = "macos")]
            {
                let _ = app
                    .handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            if let Err(e) = create_floating_window(&handle) {
                eprintln!("[floating] create window failed: {e}");
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = handle.get_webview_window("floating") {
                    let _ = window.hide();
                    raise_floating_hud_level(&window, false);
                }
                if let Some(window) = handle.get_webview_window("floating-lang") {
                    let _ = window.hide();
                    // Do not raise/orderFront while hidden — that flashed the EN chip on launch.
                }
                let app_restore = app.handle().clone();
                let _ = app_restore.clone().run_on_main_thread(move || {
                    restore_regular_activation_at_launch(&app_restore);
                });
            }

            app.manage(AsrEngine::new(handle.clone()));
            if let Err(e) = install_app_menu(&handle) {
                eprintln!("[menu] install failed: {e}");
            }
            if let Err(e) = install_tray(&handle) {
                eprintln!("[tray] install failed: {e}");
            }
            start_fn_event_tap(handle);
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::set_model_dir,
            commands::get_model_dir,
            commands::get_app_config,
            commands::save_app_config,
            commands::begin_hotkey_capture,
            commands::cancel_hotkey_capture,
            commands::get_history,
            commands::clear_history,
            commands::delete_history_entry,
            commands::prune_history,
            commands::prune_history_older_than,
            commands::test_llm_refinement,
            commands::load_model,
            hud::get_floating_status,
            hud::recenter_floating_hud,
            hud::set_floating_theme,
            hud::popup_translate_target_menu,
            hud::set_floating_lang_menu_open,
            hud::set_translate_target_language,
            commands::get_permission_status,
            commands::open_permission_settings,
            commands::request_permission,
            commands::get_app_info,
            commands::get_platform,
            commands::start_recording,
            commands::stop_recording,
            commands::cancel_recording,
            commands::transcribe_file,
            update::check_for_update,
            update::download_and_install_update,
            update::open_update_download_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
