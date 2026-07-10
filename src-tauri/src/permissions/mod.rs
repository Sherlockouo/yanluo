//! Permission probes, request prompts, and System Settings deep links.
//!
//! macOS only lists an app in Privacy panes **after** it requests that permission
//! **from this process**. Opening System Settings alone does not register the binary.
//! Mic / Speech must be requested in-process (see `macos_tcc.m`) — never via `swift -e`.

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

/// Trigger the system prompt so this binary appears in the Privacy list.
pub fn request_permission(kind: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        match kind {
            "accessibility" => {
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
                Ok(if trusted != 0 {
                    "辅助功能已授权".into()
                } else {
                    format!(
                        "已弹出辅助功能提示。开发模式下请在列表中找：\n{}",
                        executable_path()
                    )
                })
            }
            "input_monitoring" => {
                let granted = unsafe { ffi::CGRequestListenEventAccess() };
                Ok(if granted {
                    "输入监视已授权".into()
                } else {
                    format!(
                        "已请求输入监视。请在系统设置中打开开关：\n{}",
                        executable_path()
                    )
                })
            }
            "microphone" => {
                // Non-blocking: never join/wait on the dialog (avoids main-thread deadlock).
                let started = unsafe { ffi::asr_tcc_request_mic_async() };
                if !started {
                    return Err(
                        "当前进程没有 NSMicrophoneUsageDescription（tauri dev 裸二进制常见）。请用打包后的 .app 请求麦克风权限。"
                            .into(),
                    );
                }
                Ok(format!(
                    "已弹出麦克风授权。允许后列表中找：\n{}",
                    executable_path()
                ))
            }
            "speech_recognition" => {
                // Must be main-queue + non-blocking. Missing usage description → TCC abort.
                let started = unsafe { ffi::asr_tcc_request_speech_async() };
                if !started {
                    return Err(
                        "当前进程没有 NSSpeechRecognitionUsageDescription（tauri dev 裸二进制常见）。请用打包后的 .app 请求语音识别权限。"
                            .into(),
                    );
                }
                Ok(format!(
                    "已弹出语音识别授权。开发模式列表名多为 asr-workshop：\n{}",
                    executable_path()
                ))
            }
            "screen_recording" => {
                if !unsafe { ffi::asr_tcc_has_screen_capture_usage_description() } {
                    return Err(
                        "当前进程没有 NSScreenCaptureUsageDescription（tauri dev 裸二进制会闪退）。请用打包后的 .app 请求屏幕录制，或录音源先选「只录外部」。"
                            .into(),
                    );
                }
                let granted = unsafe { ffi::CGRequestScreenCaptureAccess() };
                Ok(if granted {
                    "屏幕录制已授权（可用于系统音频采集）".into()
                } else {
                    format!(
                        "已请求屏幕录制。请在系统设置中打开开关后重启应用：\n{}",
                        executable_path()
                    )
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
