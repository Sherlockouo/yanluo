//! macOS permission probes + System Settings deep links.

use serde::Serialize;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub input_monitoring: bool,
    pub microphone: bool,
    pub speech_recognition: bool,
}

#[cfg(target_os = "macos")]
mod ffi {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        pub fn AXIsProcessTrusted() -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGPreflightListenEventAccess() -> bool;
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

/// Probe TCC-backed permissions via a short Swift snippet (AVFoundation / Speech).
#[cfg(target_os = "macos")]
fn tcc_status(kind: &str) -> bool {
    let script = match kind {
        "microphone" => r#"
import AVFoundation
import Foundation
let status = AVCaptureDevice.authorizationStatus(for: .audio)
FileHandle.standardOutput.write((status == .authorized ? "1" : "0").data(using: .utf8)!)
"#,
        "speech" => r#"
import Speech
import Foundation
let status = SFSpeechRecognizer.authorizationStatus()
FileHandle.standardOutput.write((status == .authorized ? "1" : "0").data(using: .utf8)!)
"#,
        _ => return false,
    };
    Command::new("swift")
        .args(["-e", script])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn tcc_status(_kind: &str) -> bool {
    false
}

pub fn get_permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: accessibility_granted(),
        input_monitoring: input_monitoring_granted(),
        microphone: tcc_status("microphone"),
        speech_recognition: tcc_status("speech"),
    }
}

pub fn open_permission_settings(kind: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Prefer modern Privacy & Security pane anchors; fall back to legacy.
        let url = match kind {
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "input_monitoring" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "speech_recognition" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
            }
            _ => return Err(format!("unknown permission kind: {kind}")),
        };
        let status = Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        Err("failed to open System Settings".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("permission settings only available on macOS".into())
    }
}
