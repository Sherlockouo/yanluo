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

        // Best-effort for `tauri:dev:local` / bare `target/*/yanluo`.
        // Release packaging relies on `beforeBundleCommand` (runs after cargo).
        match stage_mlx_metallib() {
            Ok(dest) => println!("cargo:warning=staged mlx.metallib → {}", dest.display()),
            Err(e) => {
                // Not fatal: this build.rs can run before qwen3-asr-rs OUT_DIR
                // exists; bundle hook stages for real.
                if std::env::var_os("CARGO_FEATURE_QWEN_LOCAL").is_some() {
                    println!(
                        "cargo:warning=mlx.metallib not staged yet ({e}); beforeBundleCommand will copy"
                    );
                }
            }
        }
    }
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn stage_mlx_metallib() -> Result<std::path::PathBuf, String> {
    use std::fs;
    use std::path::PathBuf;

    let profile_dir = resolve_profile_dir()?;
    let src = find_metallib_near(&profile_dir)
        .ok_or_else(|| format!("no mlx.metallib near {}", profile_dir.display()))?;

    println!("cargo:rerun-if-changed={}", src.display());

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let generated = manifest.join("generated");
    fs::create_dir_all(&generated).map_err(|e| e.to_string())?;
    copy_if_needed(&src, &generated.join("mlx.metallib"))?;
    fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
    let beside_bin = profile_dir.join("mlx.metallib");
    copy_if_needed(&src, &beside_bin)?;
    Ok(beside_bin)
}

/// `target[/triple]/{profile}` for this build unit.
#[cfg(target_os = "macos")]
fn resolve_profile_dir() -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;

    // OUT_DIR = …/target[/triple]/{profile}/build/<crate>-<hash>/out
    if let Ok(out) = std::env::var("OUT_DIR") {
        let out = PathBuf::from(out);
        if let Some(profile_dir) = out.ancestors().nth(3) {
            return Ok(profile_dir.to_path_buf());
        }
    }

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    if let Ok(td) = std::env::var("CARGO_TARGET_DIR") {
        return Ok(PathBuf::from(td).join(&profile));
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    Ok(manifest.join("target").join(profile))
}

#[cfg(target_os = "macos")]
fn find_metallib_near(profile_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::fs;
    use std::time::SystemTime;

    // 1) Fast path: sibling build units under the same profile.
    let build_root = profile_dir.join("build");
    if let Some(p) = pick_best_metallib_in_build_root(&build_root) {
        return Some(p);
    }

    // 2) Walk target root (covers triples / other profiles). Cap depth.
    let target_root = profile_dir.parent()?;
    let mut best: Option<(u8, SystemTime, u64, std::path::PathBuf)> = None;
    let mut stack: Vec<(std::path::PathBuf, u8)> = vec![(target_root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 8 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            let name = ent.file_name();
            let name = name.to_string_lossy();
            if ent.file_type().map(|t| t.is_file()).unwrap_or(false) && name == "mlx.metallib" {
                let Ok(meta) = fs::metadata(&path) else {
                    continue;
                };
                if meta.len() < 1024 {
                    continue;
                }
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let path_str = path.to_string_lossy();
                let rank = if path_str.contains("/out/lib/") {
                    3u8
                } else if path_str.contains("/lib/") {
                    2
                } else {
                    1
                };
                let key = (rank, mtime, meta.len());
                let replace = match &best {
                    None => true,
                    Some((br, bm, bl, _)) => key > (*br, *bm, *bl),
                };
                if replace {
                    best = Some((rank, mtime, meta.len(), path));
                }
                continue;
            }
            if !ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if name == ".git"
                || name == "incremental"
                || name == "deps"
                || name == "examples"
                || name == ".fingerprint"
            {
                continue;
            }
            let interesting = name == "build"
                || name == "out"
                || name == "lib"
                || name == "release"
                || name == "debug"
                || name == "metal"
                || name == "kernels"
                || name.starts_with("qwen3-asr-rs-")
                || name.contains("mlx")
                || name.contains("apple")
                || name.contains("darwin")
                || depth < 2;
            if interesting {
                stack.push((path, depth + 1));
            }
        }
    }
    best.map(|(_, _, _, p)| p)
}

#[cfg(target_os = "macos")]
fn pick_best_metallib_in_build_root(build_root: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::fs;
    use std::time::SystemTime;

    if !build_root.is_dir() {
        return None;
    }
    let mut best: Option<(SystemTime, u64, std::path::PathBuf)> = None;
    let Ok(entries) = fs::read_dir(build_root) else {
        return None;
    };
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("qwen3-asr-rs-") {
            continue;
        }
        let lib = ent.path().join("out/lib/mlx.metallib");
        let Ok(meta) = fs::metadata(&lib) else {
            continue;
        };
        if !meta.is_file() || meta.len() < 1024 {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let replace = match &best {
            None => true,
            Some((bm, bl, _)) => (mtime, meta.len()) > (*bm, *bl),
        };
        if replace {
            best = Some((mtime, meta.len(), lib));
        }
    }
    best.map(|(_, _, p)| p)
}

#[cfg(target_os = "macos")]
fn copy_if_needed(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::fs;
    if dest.is_file() {
        let same = fs::metadata(src)
            .ok()
            .zip(fs::metadata(dest).ok())
            .is_some_and(|(a, b)| a.len() == b.len() && a.modified().ok() == b.modified().ok());
        if same {
            return Ok(());
        }
    }
    fs::copy(src, dest).map_err(|e| format!("copy {} → {}: {e}", src.display(), dest.display()))?;
    Ok(())
}
