//! macOS system-audio capture via ScreenCaptureKit (no BlackHole required).
//!
//! Safety:
//! - Refuse to touch ScreenCaptureKit when NSScreenCaptureUsageDescription is
//!   missing (`tauri dev` naked binary) — otherwise macOS TCC aborts the process.
//! - Never free the handle while an async SCKit callback may still run.

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <AudioToolbox/AudioToolbox.h>

#include <math.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*AsrSystemAudioCallback)(const float *samples, size_t count, void *ctx);

@interface AsrSystemAudioSink : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) AsrSystemAudioCallback callback;
@property(nonatomic, assign) void *ctx;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, assign) double sourceSampleRate;
@property(nonatomic, assign) UInt32 sourceChannels;
@end

@implementation AsrSystemAudioSink

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                    ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeAudio || self.callback == NULL) {
    return;
  }
  if (sampleBuffer == NULL || !CMSampleBufferIsValid(sampleBuffer) ||
      CMSampleBufferGetNumSamples(sampleBuffer) == 0) {
    return;
  }

  CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
  if (formatDesc == NULL) {
    return;
  }
  const AudioStreamBasicDescription *asbd =
      CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
  if (asbd == NULL) {
    return;
  }

  self.sourceSampleRate = asbd->mSampleRate > 0 ? asbd->mSampleRate : 48000.0;
  self.sourceChannels = asbd->mChannelsPerFrame > 0 ? asbd->mChannelsPerFrame : 2;

  CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
  if (blockBuffer == NULL) {
    return;
  }

  size_t length = 0;
  char *dataPointer = NULL;
  if (CMBlockBufferGetDataPointer(blockBuffer, 0, NULL, &length, &dataPointer) !=
          kCMBlockBufferNoErr ||
      dataPointer == NULL || length == 0) {
    return;
  }

  if (asbd->mFormatID != kAudioFormatLinearPCM) {
    return;
  }

  const float *interleaved = NULL;
  float *converted = NULL;
  size_t frameCount = 0;

  if ((asbd->mFormatFlags & kAudioFormatFlagIsFloat) && asbd->mBitsPerChannel == 32) {
    interleaved = (const float *)dataPointer;
    frameCount = length / (sizeof(float) * self.sourceChannels);
  } else if (!(asbd->mFormatFlags & kAudioFormatFlagIsFloat) &&
             asbd->mBitsPerChannel == 16 &&
             !(asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved)) {
    // Some output routes (esp. after headphone / BT switch) deliver int16.
    size_t samples = length / sizeof(int16_t);
    frameCount = samples / self.sourceChannels;
    if (frameCount == 0) {
      return;
    }
    converted = (float *)malloc(samples * sizeof(float));
    if (converted == NULL) {
      return;
    }
    const int16_t *src = (const int16_t *)dataPointer;
    const bool is_signed = (asbd->mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
    if (is_signed) {
      const float scale = 1.0f / 32768.0f;
      for (size_t i = 0; i < samples; i++) {
        converted[i] = (float)src[i] * scale;
      }
    } else {
      const float scale = 1.0f / 32768.0f;
      for (size_t i = 0; i < samples; i++) {
        converted[i] = ((float)(uint16_t)src[i] - 32768.0f) * scale;
      }
    }
    interleaved = converted;
  } else {
    static _Atomic int logged_fmt = 0;
    if (atomic_exchange(&logged_fmt, 1) == 0) {
      NSLog(@"[system-audio] unsupported PCM format flags=0x%x bits=%u",
            (unsigned)asbd->mFormatFlags, (unsigned)asbd->mBitsPerChannel);
    }
    return;
  }

  if (frameCount == 0) {
    free(converted);
    return;
  }

  const double targetSr = 16000.0;
  const double ratio = targetSr / self.sourceSampleRate;
  size_t outCount = (size_t)llround((double)frameCount * ratio);
  if (outCount == 0) {
    free(converted);
    return;
  }

  float *mono = (float *)malloc(frameCount * sizeof(float));
  float *out = (float *)malloc(outCount * sizeof(float));
  if (mono == NULL || out == NULL) {
    free(mono);
    free(out);
    free(converted);
    return;
  }

  for (size_t i = 0; i < frameCount; i++) {
    float sum = 0.0f;
    for (UInt32 c = 0; c < self.sourceChannels; c++) {
      sum += interleaved[i * self.sourceChannels + c];
    }
    mono[i] = sum / (float)self.sourceChannels;
  }

  for (size_t i = 0; i < outCount; i++) {
    double srcPos = (double)i / ratio;
    size_t idx = (size_t)srcPos;
    double frac = srcPos - (double)idx;
    float s0 = mono[idx < frameCount ? idx : frameCount - 1];
    float s1 = mono[(idx + 1) < frameCount ? (idx + 1) : frameCount - 1];
    out[i] = s0 * (1.0f - (float)frac) + s1 * (float)frac;
  }

  self.callback(out, outCount, self.ctx);
  free(mono);
  free(out);
  free(converted);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  if (error != nil) {
    NSLog(@"[system-audio] stream stopped with error: %@", error);
  }
}

@end

typedef struct AsrSystemAudioHandle {
  void *sink; // AsrSystemAudioSink * (__bridge_retained)
  atomic_int cancelled; // 1 = caller timed out / abandoned; async must not publish
  atomic_int finished;  // 1 = async start path completed (success or fail)
} AsrSystemAudioHandle;

static bool asr_has_screen_capture_usage_description(void) {
  id value =
      [[NSBundle mainBundle] objectForInfoDictionaryKey:@"NSScreenCaptureUsageDescription"];
  return [value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0;
}

static AsrSystemAudioSink *asr_handle_sink(AsrSystemAudioHandle *handle) {
  if (handle == NULL || handle->sink == NULL) {
    return nil;
  }
  return (__bridge AsrSystemAudioSink *)handle->sink;
}

static void asr_handle_set_sink(AsrSystemAudioHandle *handle, AsrSystemAudioSink *sink) {
  if (handle->sink != NULL) {
    (void)(__bridge_transfer AsrSystemAudioSink *)handle->sink;
    handle->sink = NULL;
  }
  if (sink != nil) {
    handle->sink = (__bridge_retained void *)sink;
  }
}

static void asr_fail(AsrSystemAudioHandle *handle, dispatch_semaphore_t sem,
                     __strong NSError **outError, NSError *error) {
  if (outError && error) {
    *outError = error;
  }
  atomic_store(&handle->finished, 1);
  dispatch_semaphore_signal(sem);
}

/// Dedicated queue for SCKit setup — never the AppKit main queue.
/// Waiting on main from a Tauri/command thread deadlocks when AppKit is busy
/// (HUD show, vibrancy, permission sheets) and freezes the whole app.
static dispatch_queue_t asr_system_audio_queue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("app.asr-workshop.system-audio", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

static void asr_start_capture(AsrSystemAudioHandle *handle, AsrSystemAudioCallback callback,
                              void *ctx, dispatch_semaphore_t sem,
                              __strong NSError **outError) {
  if (atomic_load(&handle->cancelled)) {
    asr_fail(handle, sem, outError, nil);
    return;
  }

  AsrSystemAudioSink *sink = [AsrSystemAudioSink new];
  sink.callback = callback;
  sink.ctx = ctx;
  asr_handle_set_sink(handle, sink);

  [SCShareableContent
      getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
        if (atomic_load(&handle->cancelled)) {
          asr_fail(handle, sem, outError, nil);
          return;
        }
        if (error != nil || content.displays.count == 0) {
          asr_fail(handle, sem, outError,
                   error ?: [NSError errorWithDomain:@"asr.system-audio"
                                                code:1
                                            userInfo:@{
                                              NSLocalizedDescriptionKey :
                                                  @"No shareable display for system audio"
                                            }]);
          return;
        }

        SCDisplay *display = content.displays.firstObject;
        // Exclude our own HUD / main windows so SCKit does not try to capture
        // the frosted panels (can stall start on some macOS builds).
        NSArray<SCWindow *> *ownWindows = content.windows;
        NSMutableArray<SCWindow *> *exclude = [NSMutableArray array];
        NSString *ownName = NSBundle.mainBundle.bundleIdentifier;
        for (SCWindow *w in ownWindows) {
          NSString *bundle = w.owningApplication.bundleIdentifier;
          if (bundle.length > 0 && ownName.length > 0 && [bundle isEqualToString:ownName]) {
            [exclude addObject:w];
          }
        }
        SCContentFilter *filter =
            [[SCContentFilter alloc] initWithDisplay:display excludingWindows:exclude];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.width = 2;
        config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 1);
        config.showsCursor = NO;
        config.capturesAudio = YES;
        config.excludesCurrentProcessAudio = YES;
        if (@available(macOS 13.0, *)) {
          config.sampleRate = 48000;
          config.channelCount = 2;
        }

        SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                              configuration:config
                                                   delegate:sink];
        NSError *addErr = nil;
        BOOL ok = [stream addStreamOutput:sink
                                     type:SCStreamOutputTypeAudio
                       sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)
                                    error:&addErr];
        if (!ok || addErr != nil) {
          asr_fail(handle, sem, outError,
                   addErr ?: [NSError errorWithDomain:@"asr.system-audio"
                                                 code:2
                                             userInfo:@{
                                               NSLocalizedDescriptionKey :
                                                   @"Failed to add audio stream output"
                                             }]);
          return;
        }

        [stream startCaptureWithCompletionHandler:^(NSError *startErr) {
          if (atomic_load(&handle->cancelled)) {
            if (startErr == nil) {
              [stream stopCaptureWithCompletionHandler:^(__unused NSError *e){
              }];
            }
            asr_fail(handle, sem, outError, nil);
            return;
          }
          if (startErr != nil) {
            asr_fail(handle, sem, outError, startErr);
            return;
          }
          sink.stream = stream;
          atomic_store(&handle->finished, 1);
          dispatch_semaphore_signal(sem);
        }];
      }];
}

AsrSystemAudioHandle *asr_system_audio_start(AsrSystemAudioCallback callback, void *ctx,
                                             char *err_buf, size_t err_buf_len) {
  if (callback == NULL) {
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len, "null callback");
    }
    return NULL;
  }

  // TCC aborts the process if this key is missing (common with `tauri dev`).
  if (!asr_has_screen_capture_usage_description()) {
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len,
               "missing NSScreenCaptureUsageDescription (tauri dev naked binary). "
               "Use packaged .app, or switch capture mode to external-only.");
    }
    return NULL;
  }

  // Never block the AppKit main thread waiting on SCKit.
  if ([NSThread isMainThread]) {
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len,
               "asr_system_audio_start must not run on the main thread");
    }
    return NULL;
  }

  AsrSystemAudioHandle *handle = calloc(1, sizeof(AsrSystemAudioHandle));
  if (handle == NULL) {
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len, "oom");
    }
    return NULL;
  }
  atomic_store(&handle->cancelled, 0);
  atomic_store(&handle->finished, 0);

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSError *error = nil;

  dispatch_async(asr_system_audio_queue(), ^{
    asr_start_capture(handle, callback, ctx, sem, &error);
  });

  long wait =
      dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)8 * NSEC_PER_SEC));
  if (wait != 0) {
    // Mark cancelled; async completion will observe and tear down. Do NOT free here.
    atomic_store(&handle->cancelled, 1);
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len,
               "system audio start timed out (grant Screen Recording in System Settings?)");
    }
    // Detach cleanup on a background queue once finished flips.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      for (int i = 0; i < 50 && !atomic_load(&handle->finished); i++) {
        usleep(100 * 1000);
      }
      AsrSystemAudioSink *sink = asr_handle_sink(handle);
      if (sink.stream != nil) {
        [sink.stream stopCaptureWithCompletionHandler:^(__unused NSError *e){
        }];
      }
      asr_handle_set_sink(handle, nil);
      free(handle);
    });
    return NULL;
  }

  if (error != nil || asr_handle_sink(handle) == nil || asr_handle_sink(handle).stream == nil) {
    if (err_buf && err_buf_len > 0) {
      const char *msg = error.localizedDescription.UTF8String ?: "system audio start failed";
      snprintf(err_buf, err_buf_len, "%s", msg);
    }
    asr_handle_set_sink(handle, nil);
    free(handle);
    return NULL;
  }

  return handle;
}

void asr_system_audio_stop(AsrSystemAudioHandle *handle) {
  if (handle == NULL) {
    return;
  }
  atomic_store(&handle->cancelled, 1);
  AsrSystemAudioSink *sink = asr_handle_sink(handle);
  SCStream *stream = sink.stream;
  if (stream != nil) {
    // Never semaphore-wait on the main thread — stopCapture may complete there.
    if ([NSThread isMainThread]) {
      [stream stopCaptureWithCompletionHandler:^(__unused NSError *error){
      }];
    } else {
      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      [stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {
        dispatch_semaphore_signal(sem);
      }];
      dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)3 * NSEC_PER_SEC));
    }
  }
  if (sink != nil) {
    sink.stream = nil;
    sink.callback = NULL;
    sink.ctx = NULL;
  }
  asr_handle_set_sink(handle, nil);
  free(handle);
}

/// Exported for permissions.rs — false means calling ScreenCapture APIs would TCC-abort.
bool asr_tcc_has_screen_capture_usage_description(void) {
  return asr_has_screen_capture_usage_description();
}
