// Vendored from esaxx-rs 0.1.10 (Apache-2.0) with one fix: the upstream
// build.rs hardcodes `static_crt(true)` — on MSVC that compiles the C++
// helper with /MT (static CRT), which collides with libtorch's /MD at link
// time (LNK2038 RuntimeLibrary mismatch) on Windows qwen-local builds.
// `static_crt` only affects MSVC/MinGW; the macos branch kept it for
// symmetry. Dropping it links the dynamic CRT everywhere, matching the rest
// of the dependency tree.
#[cfg(feature = "cpp")]
#[cfg(not(target_os = "macos"))]
fn main() {
    cc::Build::new()
        .cpp(true)
        .flag("-std=c++11")
        .file("src/esaxx.cpp")
        .include("src")
        .compile("esaxx");
}

#[cfg(feature = "cpp")]
#[cfg(target_os = "macos")]
fn main() {
    cc::Build::new()
        .cpp(true)
        .flag("-std=c++11")
        .flag("-stdlib=libc++")
        .file("src/esaxx.cpp")
        .include("src")
        .compile("esaxx");
}

#[cfg(not(feature = "cpp"))]
fn main() {}
