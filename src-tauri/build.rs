fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/macos_tcc.m");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Speech");
        cc::Build::new()
            .file("src/macos_tcc.m")
            .flag("-fobjc-arc")
            .compile("macos_tcc");
    }
    tauri_build::build()
}
