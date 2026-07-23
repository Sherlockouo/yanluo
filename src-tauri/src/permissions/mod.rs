//! Permission probes, request prompts, and System Settings deep links.
//!
//! macOS only lists an app in Privacy panes **after** it requests that permission
//! **from this process**. Opening System Settings alone does not register the binary.
//! Mic / Speech must be requested **and recognized** in-process (see
//! `macos_tcc.m` / `macos_speech.m`) — never via `/usr/bin/swift` (TCC aborts).
//!
//! UX rules:
//! - Never stack an OS prompt **and** `open` System Settings for the same click.
//! - Mic / Speech: show the Allow dialog when undecided; open Settings only if denied.
//! - Accessibility / Input Monitoring / Screen: the request APIs already surface
//!   Apple's prompt or Settings — do not open Settings again on top.

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
    /// Frontend should open System Settings only when this is true.
    pub open_settings: bool,
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

/// Trigger the right OS flow for this permission — without stacking Settings on top.
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
                    });
                }
                // Apple's prompt already offers “打开系统设置”. Do not also `open` Settings.
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
                        message: "辅助功能已授权".into(),
                        granted: true,
                        open_settings: false,
                    })
                } else {
                    Ok(PermissionRequestResult {
                        message: format!(
                            "请在系统弹窗中打开辅助功能，并开启本应用。开发模式列表名看路径：\n{}",
                            executable_path()
                        ),
                        granted: false,
                        open_settings: false,
                    })
                }
            }
            "input_monitoring" => {
                if input_monitoring_granted() {
                    return Ok(PermissionRequestResult {
                        message: "输入监视已授权".into(),
                        granted: true,
                        open_settings: false,
                    });
                }
                // CGRequestListenEventAccess opens Privacy → Input Monitoring itself.
                let granted = unsafe { ffi::CGRequestListenEventAccess() };
                Ok(PermissionRequestResult {
                    message: if granted {
                        "输入监视已授权".into()
                    } else {
                        format!(
                            "请在系统设置中打开「输入监视」开关。开发模式列表名看路径：\n{}",
                            executable_path()
                        )
                    },
                    granted,
                    open_settings: false,
                })
            }
            "microphone" => {
                let status = unsafe { ffi::asr_tcc_mic_status() };
                match status {
                    2 => Ok(PermissionRequestResult {
                        message: "麦克风已授权".into(),
                        granted: true,
                        open_settings: false,
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
                        })
                    }
                    1 | 3 => Ok(PermissionRequestResult {
                        message: "麦克风此前被拒绝，请在系统设置中开启。".into(),
                        granted: false,
                        open_settings: true,
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
                        })
                    }
                    1 | 3 => Ok(PermissionRequestResult {
                        message: "语音识别此前被拒绝，请在系统设置中开启。".into(),
                        granted: false,
                        open_settings: true,
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
                    });
                }
                // CGRequestScreenCaptureAccess opens Privacy → Screen Recording itself.
                let granted = unsafe { ffi::CGRequestScreenCaptureAccess() };
                Ok(PermissionRequestResult {
                    message: if granted {
                        "屏幕录制已授权（可用于系统音频采集）".into()
                    } else {
                        format!(
                            "请在系统设置中打开「屏幕录制」后重启应用。开发模式列表名看路径：\n{}",
                            executable_path()
                        )
                    },
                    granted,
                    open_settings: false,
                })
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
