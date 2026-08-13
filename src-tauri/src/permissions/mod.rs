//! Permission probes, request prompts, and System Settings deep links.
//!
//! macOS only lists an app in Privacy panes **after** it requests that permission
//! **from this process**. Opening System Settings alone does not register the binary.
//! Mic / Speech must be requested **and recognized** in-process (see
//! `macos_tcc.m` / `macos_speech.m`) — never via `/usr/bin/swift` (TCC aborts).
//!
//! UX rules:
//! - Mic / Speech: Allow dialog when undecided; open Settings only if previously denied.
//! - Accessibility / Input Monitoring / Screen: always request in-process (registers the
//!   binary in TCC), then open the matching Privacy pane if still not granted — Apple's
//!   sheet alone often shows nothing on a second click, which feels like a dead button.
//! - `needs_relaunch`: Screen Capture (and sometimes event taps) only stick after relaunch.

use serde::Serialize;
use std::env;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub input_monitoring: bool,
    pub microphone: bool,
    pub speech_recognition: bool,
    pub screen_recording: bool,
    /// Absolute path of this process — look for this name in Privacy lists during `tauri dev`.
    pub executable_path: String,
    pub platform: String,
    pub apple_speech_available: bool,
}

/// Result of a single authorize action.
#[derive(Clone, Serialize)]
pub struct PermissionRequestResult {
    pub message: String,
    pub granted: bool,
    /// Frontend should open the matching Privacy pane when true.
    pub open_settings: bool,
    /// Frontend should offer / run app relaunch (Screen Capture, dead event tap).
    pub needs_relaunch: bool,
}

fn executable_path() -> String {
    env::current_exe()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unknown".into())
}

fn platform_label() -> String {
    if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else {
        "unknown".into()
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use core_foundation::string::CFStringRef;
    use std::ffi::c_void;

    pub type CFDictionaryRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        pub fn AXIsProcessTrusted() -> u8;
        pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        pub static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGPreflightListenEventAccess() -> bool;
        pub fn CGRequestListenEventAccess() -> bool;
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }

    // Linked from `macos_tcc.m` / `macos_system_audio.m`.
    unsafe extern "C" {
        pub fn asr_tcc_mic_authorized() -> bool;
        pub fn asr_tcc_speech_authorized() -> bool;
        pub fn asr_tcc_mic_status() -> i32;
        pub fn asr_tcc_speech_status() -> i32;
        pub fn asr_tcc_request_mic_async() -> bool;
        pub fn asr_tcc_request_speech_async() -> bool;
        pub fn asr_tcc_has_screen_capture_usage_description() -> bool;
    }
}

#[cfg(target_os = "macos")]
fn accessibility_granted() -> bool {
    unsafe { ffi::AXIsProcessTrusted() != 0 }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn input_monitoring_granted() -> bool {
    unsafe { ffi::CGPreflightListenEventAccess() }
}

#[cfg(not(target_os = "macos"))]
fn input_monitoring_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn microphone_granted() -> bool {
    unsafe { ffi::asr_tcc_mic_authorized() }
}

#[cfg(not(target_os = "macos"))]
fn microphone_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn speech_granted() -> bool {
    unsafe { ffi::asr_tcc_speech_authorized() }
}

#[cfg(not(target_os = "macos"))]
fn speech_granted() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn screen_recording_granted() -> bool {
    unsafe { ffi::CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
fn screen_recording_granted() -> bool {
    false
}

pub fn get_permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: accessibility_granted(),
        input_monitoring: input_monitoring_granted(),
        microphone: microphone_granted(),
        speech_recognition: speech_granted(),
        screen_recording: screen_recording_granted(),
        executable_path: executable_path(),
        platform: platform_label(),
        apple_speech_available: cfg!(target_os = "macos"),
    }
}

/// Trigger OS request, then open Settings when the grant cannot finish in-dialog.
pub fn request_permission(kind: &str) -> Result<PermissionRequestResult, String> {
    #[cfg(target_os = "macos")]
    {
        match kind {
            "accessibility" => {
                if accessibility_granted() {
                    return Ok(PermissionRequestResult {
                        message: "辅助功能已授权".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    });
                }
                // Registers this binary in TCC + may show Apple's sheet.
                use core_foundation::base::TCFType;
                use core_foundation::boolean::CFBoolean;
                use core_foundation::dictionary::CFDictionary;
                use core_foundation::string::CFString;

                let key = unsafe {
                    CFString::wrap_under_get_rule(ffi::kAXTrustedCheckOptionPrompt)
                };
                let pairs = [(key, CFBoolean::true_value())];
                let options = CFDictionary::from_CFType_pairs(&pairs);
                let trusted = unsafe {
                    ffi::AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as _)
                };
                if trusted != 0 {
                    Ok(PermissionRequestResult {
                        message: "辅助功能已授权。若粘贴仍失败，请重启应用。".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    })
                } else {
                    // Second click often shows no sheet — open Privacy pane so the
                    // click always has a visible next step.
                    Ok(PermissionRequestResult {
                        message: format!(
                            "请在系统设置 → 辅助功能中开启本应用（列表名 Yanluo）。开发路径：\n{}",
                            executable_path()
                        ),
                        granted: false,
                        open_settings: true,
                        needs_relaunch: false,
                    })
                }
            }
            "input_monitoring" => {
                if input_monitoring_granted() {
                    return Ok(PermissionRequestResult {
                        message: "输入监视已授权".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    });
                }
                let granted = unsafe { ffi::CGRequestListenEventAccess() };
                if granted {
                    Ok(PermissionRequestResult {
                        message: "输入监视已授权。全局快捷键若仍无效，请重启应用。".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: true,
                    })
                } else {
                    Ok(PermissionRequestResult {
                        message: format!(
                            "请在系统设置 → 输入监视中开启本应用。开启后需重启才能生效。开发路径：\n{}",
                            executable_path()
                        ),
                        granted: false,
                        open_settings: true,
                        needs_relaunch: true,
                    })
                }
            }
            "microphone" => {
                let status = unsafe { ffi::asr_tcc_mic_status() };
                match status {
                    2 => Ok(PermissionRequestResult {
                        message: "麦克风已授权".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    }),
                    0 => {
                        let started = unsafe { ffi::asr_tcc_request_mic_async() };
                        if !started {
                            return Err(
                                "当前进程没有 NSMicrophoneUsageDescription（tauri dev 裸二进制常见）。请用打包后的 .app 请求麦克风权限。"
                                    .into(),
                            );
                        }
                        Ok(PermissionRequestResult {
                            message: "已弹出麦克风授权，请点「允许」。".into(),
                            granted: false,
                            open_settings: false,
                            needs_relaunch: false,
                        })
                    }
                    1 | 3 => Ok(PermissionRequestResult {
                        message: "麦克风此前被拒绝，请在系统设置中开启。".into(),
                        granted: false,
                        open_settings: true,
                        needs_relaunch: false,
                    }),
                    _ => Err("无法读取麦克风权限状态".into()),
                }
            }
            "speech_recognition" => {
                let status = unsafe { ffi::asr_tcc_speech_status() };
                match status {
                    2 => Ok(PermissionRequestResult {
                        message: "语音识别已授权".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    }),
                    0 => {
                        let started = unsafe { ffi::asr_tcc_request_speech_async() };
                        if !started {
                            return Err(
                                "当前进程没有 NSSpeechRecognitionUsageDescription（tauri dev 裸二进制常见）。请用打包后的 .app 请求语音识别权限。"
                                    .into(),
                            );
                        }
                        Ok(PermissionRequestResult {
                            message: "已弹出语音识别授权，请点「允许」。".into(),
                            granted: false,
                            open_settings: false,
                            needs_relaunch: false,
                        })
                    }
                    1 | 3 => Ok(PermissionRequestResult {
                        message: "语音识别此前被拒绝，请在系统设置中开启。".into(),
                        granted: false,
                        open_settings: true,
                        needs_relaunch: false,
                    }),
                    _ => Err("无法读取语音识别权限状态".into()),
                }
            }
            "screen_recording" => {
                if !unsafe { ffi::asr_tcc_has_screen_capture_usage_description() } {
                    return Err(
                        "当前进程没有 NSScreenCaptureUsageDescription（tauri dev 裸二进制会闪退）。请用打包后的 .app 请求屏幕录制，或录音源先选「只录外部」。"
                            .into(),
                    );
                }
                if screen_recording_granted() {
                    return Ok(PermissionRequestResult {
                        message: "屏幕录制已授权".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: false,
                    });
                }
                let granted = unsafe { ffi::CGRequestScreenCaptureAccess() };
                if granted {
                    Ok(PermissionRequestResult {
                        message: "屏幕录制已授权。采集系统声请重启应用后生效。".into(),
                        granted: true,
                        open_settings: false,
                        needs_relaunch: true,
                    })
                } else {
                    Ok(PermissionRequestResult {
                        message: format!(
                            "请在系统设置 → 屏幕录制中开启本应用，然后重启。开发路径：\n{}",
                            executable_path()
                        ),
                        granted: false,
                        open_settings: true,
                        needs_relaunch: true,
                    })
                }
            }
            _ => Err(format!("unknown permission kind: {kind}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("权限请求仅在 macOS 可用".into())
    }
}

pub fn open_permission_settings(kind: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Prefer the Ventura+ Privacy & Security deep link; fall back once.
        let (modern, legacy) = match kind {
            "accessibility" => (
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ),
            "input_monitoring" => (
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ListenEvent",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
            ),
            "microphone" => (
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            ),
            "speech_recognition" => (
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_SpeechRecognition",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
            ),
            "screen_recording" => (
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ),
            "keyboard" => (
                "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
                "x-apple.systempreferences:com.apple.preference.keyboard",
            ),
            _ => return Err(format!("unknown permission kind: {kind}")),
        };
        for url in [modern, legacy] {
            if Command::new("open")
                .arg(url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        Err("failed to open System Settings".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("permission settings only available on macOS".into())
    }
}
