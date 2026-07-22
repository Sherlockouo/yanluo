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

        // MLX looks for mlx.metallib beside the executable (dladdr). Copy from
        // qwen3-asr-rs OUT_DIR so `tauri:dev:local` / bare binary runs work.
        if let Err(e) = stage_mlx_metallib() {
            println!("cargo:warning=mlx.metallib stage skipped: {e}");
        }
    }
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn stage_mlx_metallib() -> Result<(), String> {
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let target_root = manifest.join("target").join(&profile);
    let build_root = target_root.join("build");
    if !build_root.is_dir() {
        return Err(format!("no build dir at {}", build_root.display()));
    }

    let mut best: Option<(SystemTime, PathBuf)> = None;
    let entries = fs::read_dir(&build_root).map_err(|e| e.to_string())?;
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("qwen3-asr-rs-") {
            continue;
        }
        let lib = ent.path().join("out/lib/mlx.metallib");
        if !lib.is_file() {
            continue;
        }
        let mtime = fs::metadata(&lib)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, lib));
        }
    }
    let Some((_, src)) = best else {
        return Err("qwen3-asr-rs mlx.metallib not built yet".into());
    };

    let generated = manifest.join("generated");
    fs::create_dir_all(&generated).map_err(|e| e.to_string())?;
    copy_if_needed(&src, &generated.join("mlx.metallib"))?;
    // Beside the final binary (target/{profile}/yanluo).
    fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
    copy_if_needed(&src, &target_root.join("mlx.metallib"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_if_needed(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::fs;
    if dest.is_file() {
        let same = fs::metadata(src).ok().zip(fs::metadata(dest).ok()).is_some_and(
            |(a, b)| a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        );
        if same {
            return Ok(());
        }
    }
    fs::copy(src, dest).map_err(|e| format!("copy {} → {}: {e}", src.display(), dest.display()))?;
    println!("cargo:warning=staged mlx.metallib → {}", dest.display());
    Ok(())
}
