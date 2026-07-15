//! C API for macOS system-audio capture (ScreenCaptureKit).

#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*AsrSystemAudioCallback)(const float *samples, size_t count, void *ctx);

typedef struct AsrSystemAudioHandle AsrSystemAudioHandle;

/// Start capturing system (speaker) audio as 16 kHz mono f32 chunks.
/// Returns NULL on failure; writes a message into err_buf when provided.
/// Must not be called on the AppKit main thread (blocks waiting for SCKit).
AsrSystemAudioHandle *asr_system_audio_start(AsrSystemAudioCallback callback, void *ctx,
                                             char *err_buf, size_t err_buf_len);

void asr_system_audio_stop(AsrSystemAudioHandle *handle);

#ifdef __cplusplus
}
#endif
