fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/macos_tcc.m");
        println!("cargo:rerun-if-changed=src/macos_speech.m");
        println!("cargo:rerun-if-changed=src/macos_system_audio.m");
        println!("cargo:rerun-if-changed=src/macos_system_audio.h");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Speech");
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        cc::Build::new()
            .file("src/macos_tcc.m")
            .file("src/macos_speech.m")
            .file("src/macos_system_audio.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("macos_native");
    }
    tauri_build::build()
}
