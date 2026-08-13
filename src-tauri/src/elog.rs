//! Non-panicking stderr log.
//!
//! Rust's `eprintln!` calls `std::io::stdio::_eprint`, which **panics** when
//! stderr is broken (closed PTY, dead pipe after launching terminal exits, etc.).
//! A GUI app that keeps `eprintln!` on hot paths (HUD show, recording) will
//! SIGABRT the whole process. Prefer [`elog!`] instead.

use std::io::Write;

/// Write one line to stderr; never panics on I/O failure.
/// Prefixes a millisecond-precision wall-clock timestamp — the Fn→HUD→ASR
/// latency chain is measured across threads/process events, so log lines
/// without timestamps can't be correlated after the fact.
#[inline]
pub(crate) fn write_stderr_line(args: std::fmt::Arguments<'_>) {
    let mut err = std::io::stderr().lock();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = err.write_fmt(format_args!("[{ts}] "));
    let _ = err.write_fmt(args);
    let _ = err.write_all(b"\n");
}

macro_rules! elog {
    ($($arg:tt)*) => {{
        $crate::elog::write_stderr_line(format_args!($($arg)*))
    }};
}
pub(crate) use elog;
