use tauri::menu::{
    AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu,
};
#[cfg(not(target_os = "macos"))]
use tauri::menu::SubmenuBuilder;
use tauri::{AppHandle, Emitter, Manager};
use crate::hud::{emit_floating_status, floating_status_slot};
use crate::state::*;
use crate::config::*;

/// Standard macOS / desktop app menu (About · Settings · Edit · Window · Help).
/// Language / LLM live in the Settings UI — not as top-level menu bar hacks.
pub(crate) fn install_app_menu(app: &AppHandle) -> Result<(), String> {
    let pkg = app.package_info();
    // productName is ASCII "Yanluo" for WiX/filenames; menu/About stay 言落.
    let app_name = "言落".to_string();
    let about_metadata = AboutMetadata {
        name: Some(app_name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|p| vec![p]),
        ..Default::default()
    };

    let settings = MenuItemBuilder::with_id("app:settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)
        .map_err(|e| e.to_string())?;
    let check_updates = MenuItemBuilder::with_id("app:check-updates", "Check for Updates...")
        .build(app)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        &app_name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))
                .map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &settings,
            &check_updates,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::services(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide_others(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::show_all(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::quit(app, None).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&settings)
        .item(&check_updates)
        .separator()
        .quit()
        .build()
        .map_err(|e| e.to_string())?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::redo(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::cut(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::copy(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::paste(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::select_all(app, None).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::maximize(app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::close_window(app, None).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata))
                .map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
    .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &window_menu, &help_menu])
        .map_err(|e| e.to_string())?;

    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

/// Menu-bar status item (system tray) with Show / Settings / Quit.
pub(crate) fn install_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("tray:show", "显示言落")
        .build(app)
        .map_err(|e| e.to_string())?;
    let settings = MenuItemBuilder::with_id("tray:settings", "Settings...")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("tray:quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;

    let tray_menu = Menu::with_items(
        app,
        &[
            &show,
            &settings,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &quit,
        ],
    )
    .map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "missing default window icon for tray".to_string())?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&tray_menu)
        .tooltip("言落")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn menu_label(label: &str, selected: bool) -> String {
    if selected {
        format!("✓ {label}")
    } else {
        label.to_string()
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_settings_page(app: &AppHandle, page: &str) {
    show_main_window(app);
    let _ = app.emit("open-settings", page);
}

/// Persist translate target and refresh HUD / live stream.
pub(crate) fn apply_translate_target(app: &AppHandle, target: &str) {
    let previous = app
        .state::<AsrEngine>()
        .inner()
        .config
        .lock()
        .map(|c| c.translate_target_language.clone())
        .unwrap_or_default();
    if let Ok(mut config) = app.state::<AsrEngine>().inner().config.lock() {
        config.translate_target_language = target.to_string();
        let _ = save_config_to_disk(&config);
        let _ = app.emit("config-updated", config.clone());
    }
    if previous != target {
        crate::transcription::retarget_translate_stream(app);
    } else if floating_status_slot(app)
        .lock()
        .map(|s| s.visible)
        .unwrap_or(false)
    {
        let text = crate::transcription::peek_translate_out(app);
        let state = floating_status_slot(app)
            .lock()
            .map(|s| s.state.clone())
            .unwrap_or_else(|_| "recording".into());
        emit_floating_status(app, true, &state, &text, 0.0);
    }
}

pub(crate) fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(target) = id.strip_prefix("translate-target:") {
        apply_translate_target(app, target);
        return;
    }

    match id {
        "app:settings" | "tray:settings" => open_settings_page(app, "settings"),
        "app:check-updates" => open_settings_page(app, "updates"),
        "tray:show" => show_main_window(app),
        "tray:quit" => app.exit(0),
        _ => {}
    }
}
