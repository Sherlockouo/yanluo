pub mod recorder;
pub mod media;
pub mod vad;

pub use recorder::*;
pub(crate) use media::*;
pub(crate) use vad::*;

use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// Global audio chunk notification. Signaled by recorder callbacks to wake the
/// mlx-worker from its polling sleep.
static AUDIO_CHUNK_NOTIFY: OnceLock<Arc<(Mutex<bool>, Condvar)>> = OnceLock::new();

pub(crate) fn audio_chunk_notify() -> &'static Arc<(Mutex<bool>, Condvar)> {
    AUDIO_CHUNK_NOTIFY.get_or_init(|| Arc::new((Mutex::new(false), Condvar::new())))
}
