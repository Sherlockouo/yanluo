#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <stdbool.h>
#import <string.h>

// In-process SFSpeechRecognizer — same TCC identity as the app.
// NEVER spawn /usr/bin/swift for recognition: that binary has no
// NSSpeechRecognitionUsageDescription and TCC aborts (SIGABRT / exit 137).

typedef void (*asr_speech_partial_fn)(const char *utf8, void *ctx);

static void asr_speech_write_err(char *err_buf, size_t err_len, NSString *msg) {
  if (!err_buf || err_len == 0) {
    return;
  }
  const char *utf8 = msg.UTF8String ?: "Apple Speech error";
  strncpy(err_buf, utf8, err_len - 1);
  err_buf[err_len - 1] = '\0';
}

static void asr_speech_write_out(char *out_buf, size_t out_len, NSString *text) {
  if (!out_buf || out_len == 0) {
    return;
  }
  const char *utf8 = text.UTF8String ?: "";
  strncpy(out_buf, utf8, out_len - 1);
  out_buf[out_len - 1] = '\0';
}

static bool asr_speech_has_usage_description(void) {
  id value = [[NSBundle mainBundle]
      objectForInfoDictionaryKey:@"NSSpeechRecognitionUsageDescription"];
  return [value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0;
}

static SFSpeechRecognizer *asr_speech_pick_recognizer(const char *locale,
                                                      NSString **used_out,
                                                      char *err_buf,
                                                      size_t err_len) {
  NSString *requested =
      locale && locale[0] != '\0' ? @(locale) : @"zh-CN";
  NSMutableArray<NSString *> *candidates = [NSMutableArray arrayWithObjects:
                                                               requested,
                                                               [requested
                                                                   stringByReplacingOccurrencesOfString:
                                                                       @"_"
                                                                                           withString:
                                                                                               @"-"],
                                                               @"zh-CN",
                                                               @"en-US",
                                                               nil];
  NSOrderedSet *unique = [NSOrderedSet orderedSetWithArray:candidates];
  candidates = [[unique array] mutableCopy];

  for (NSString *localeId in candidates) {
    SFSpeechRecognizer *r =
        [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:localeId]];
    if (r && r.isAvailable) {
      if (used_out) {
        *used_out = localeId;
      }
      return r;
    }
  }
  asr_speech_write_err(
      err_buf, err_len,
      [NSString
          stringWithFormat:@"Speech recognizer unavailable for locales: %@",
                           [candidates componentsJoinedByString:@", "]]);
  return nil;
}

static int asr_speech_check_auth(char *err_buf, size_t err_len) {
  if (!asr_speech_has_usage_description()) {
    asr_speech_write_err(
        err_buf, err_len,
        @"当前进程没有 NSSpeechRecognitionUsageDescription（tauri "
        @"dev 裸二进制常见）。请用打包后的 .app，或确认 Info.plist "
        @"已嵌入。");
    return 2;
  }

  SFSpeechRecognizerAuthorizationStatus auth =
      [SFSpeechRecognizer authorizationStatus];
  if (auth != SFSpeechRecognizerAuthorizationStatusAuthorized) {
    NSString *hint;
    switch (auth) {
    case SFSpeechRecognizerAuthorizationStatusDenied:
      hint = @"denied — 系统设置 → 隐私与安全性 → 语音识别，打开 "
             @"QuietType";
      break;
    case SFSpeechRecognizerAuthorizationStatusRestricted:
      hint = @"restricted by system policy";
      break;
    case SFSpeechRecognizerAuthorizationStatusNotDetermined:
      hint = @"not determined — 先在设置页点「语音识别」授权";
      break;
    default:
      hint = [NSString stringWithFormat:@"status=%ld", (long)auth];
      break;
    }
    asr_speech_write_err(
        err_buf, err_len,
        [NSString stringWithFormat:@"Speech recognition permission %@", hint]);
    return 3;
  }
  return 0;
}

/// Recognize a local audio file. Returns 0 on success (UTF-8 in out_buf),
/// non-zero on failure (message in err_buf). Blocks up to 60s.
/// Safe to call from a background Rust thread.
int asr_speech_recognize_file(const char *path, const char *locale,
                              char *out_buf, size_t out_len, char *err_buf,
                              size_t err_len) {
  if (out_buf && out_len > 0) {
    out_buf[0] = '\0';
  }
  if (err_buf && err_len > 0) {
    err_buf[0] = '\0';
  }

  if (!path || path[0] == '\0') {
    asr_speech_write_err(err_buf, err_len, @"audio path is empty");
    return 1;
  }
  int auth_rc = asr_speech_check_auth(err_buf, err_len);
  if (auth_rc != 0) {
    return auth_rc;
  }

  NSString *usedLocale = nil;
  SFSpeechRecognizer *recognizer =
      asr_speech_pick_recognizer(locale, &usedLocale, err_buf, err_len);
  if (!recognizer) {
    return 4;
  }
  (void)usedLocale;

  NSURL *audioURL =
      [NSURL fileURLWithPath:@(path) isDirectory:NO];
  if (![[NSFileManager defaultManager] fileExistsAtPath:audioURL.path]) {
    asr_speech_write_err(
        err_buf, err_len,
        [NSString stringWithFormat:@"audio file not found: %@", audioURL.path]);
    return 5;
  }

  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:audioURL];
  request.shouldReportPartialResults = YES;
  if (@available(macOS 13.0, *)) {
    request.addsPunctuation = YES;
  }

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSString *finalText = nil;
  __block NSString *finalError = nil;
  __block SFSpeechRecognitionTask *task = nil;

  task = [recognizer
      recognitionTaskWithRequest:request
                   resultHandler:^(SFSpeechRecognitionResult *_Nullable result,
                                   NSError *_Nullable error) {
                     if (result) {
                       finalText = result.bestTranscription.formattedString;
                       if (result.isFinal) {
                         dispatch_semaphore_signal(sem);
                       }
                       return;
                     }
                     if (error) {
                       finalError = error.localizedDescription ?: @"recognition failed";
                       dispatch_semaphore_signal(sem);
                     }
                   }];
  (void)task;

  long wait = dispatch_semaphore_wait(
      sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)60 * NSEC_PER_SEC));
  if (wait != 0) {
    [task cancel];
    asr_speech_write_err(err_buf, err_len, @"Apple Speech timed out after 60s");
    return 6;
  }
  if (finalError) {
    asr_speech_write_err(err_buf, err_len, finalError);
    return 7;
  }
  NSString *text =
      [finalText stringByTrimmingCharactersInSet:
                     [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (text.length == 0) {
    asr_speech_write_err(
        err_buf, err_len,
        @"Apple Speech returned empty transcript (no speech detected or "
        @"unsupported audio)");
    return 8;
  }
  asr_speech_write_out(out_buf, out_len, text);
  return 0;
}

// ---------------------------------------------------------------------------
// Live buffer streaming (SFSpeechAudioBufferRecognitionRequest)
// ---------------------------------------------------------------------------

@interface AsrSpeechStreamSession : NSObject
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) AVAudioFormat *format;
@property(nonatomic, strong) dispatch_semaphore_t doneSem;
@property(nonatomic, copy) NSString *latestText;
@property(nonatomic, copy) NSString *finalError;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) asr_speech_partial_fn partialCb;
@property(nonatomic, assign) void *partialCtx;
@end

@implementation AsrSpeechStreamSession
@end

static AsrSpeechStreamSession *g_stream = nil;
static NSLock *g_stream_lock = nil;

static void asr_speech_stream_ensure_lock(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    g_stream_lock = [[NSLock alloc] init];
  });
}

/// Start live recognition. Partials invoke `cb(utf8, ctx)` on a GCD queue.
/// Returns 0 on success.
int asr_speech_stream_start(const char *locale, asr_speech_partial_fn cb,
                            void *ctx, char *err_buf, size_t err_len) {
  if (err_buf && err_len > 0) {
    err_buf[0] = '\0';
  }
  asr_speech_stream_ensure_lock();
  [g_stream_lock lock];
  if (g_stream != nil) {
    [g_stream_lock unlock];
    asr_speech_write_err(err_buf, err_len, @"Apple Speech stream already active");
    return 10;
  }

  int auth_rc = asr_speech_check_auth(err_buf, err_len);
  if (auth_rc != 0) {
    [g_stream_lock unlock];
    return auth_rc;
  }

  NSString *usedLocale = nil;
  SFSpeechRecognizer *recognizer =
      asr_speech_pick_recognizer(locale, &usedLocale, err_buf, err_len);
  if (!recognizer) {
    [g_stream_lock unlock];
    return 4;
  }

  SFSpeechAudioBufferRecognitionRequest *request =
      [[SFSpeechAudioBufferRecognitionRequest alloc] init];
  request.shouldReportPartialResults = YES;
  if (@available(macOS 13.0, *)) {
    request.addsPunctuation = YES;
  }
  // Do not force on-device — missing language packs yield empty transcripts.

  AVAudioFormat *format =
      [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                       sampleRate:16000.0
                                         channels:1
                                      interleaved:NO];
  if (!format) {
    [g_stream_lock unlock];
    asr_speech_write_err(err_buf, err_len, @"failed to create AVAudioFormat 16k mono f32");
    return 11;
  }

  AsrSpeechStreamSession *session = [[AsrSpeechStreamSession alloc] init];
  session.recognizer = recognizer;
  session.request = request;
  session.format = format;
  session.doneSem = dispatch_semaphore_create(0);
  session.latestText = @"";
  session.finalError = nil;
  session.finished = NO;
  session.partialCb = cb;
  session.partialCtx = ctx;

  __weak AsrSpeechStreamSession *weakSession = session;
  session.task = [recognizer
      recognitionTaskWithRequest:request
                   resultHandler:^(SFSpeechRecognitionResult *_Nullable result,
                                   NSError *_Nullable error) {
                     AsrSpeechStreamSession *s = weakSession;
                     if (!s) {
                       return;
                     }
                     if (result) {
                       NSString *text = result.bestTranscription.formattedString ?: @"";
                       s.latestText = text;
                       if (s.partialCb && text.length > 0) {
                         const char *utf8 = text.UTF8String;
                         if (utf8) {
                           s.partialCb(utf8, s.partialCtx);
                         }
                       }
                       if (result.isFinal) {
                         s.finished = YES;
                         dispatch_semaphore_signal(s.doneSem);
                       }
                       return;
                     }
                     if (error) {
                       // Code 1110 = no speech / canceled mid-stream — treat as soft end.
                       NSInteger code = error.code;
                       if (code == 1110 || code == 216 || code == 301) {
                         s.finished = YES;
                         dispatch_semaphore_signal(s.doneSem);
                         return;
                       }
                       s.finalError =
                           error.localizedDescription ?: @"recognition failed";
                       s.finished = YES;
                       dispatch_semaphore_signal(s.doneSem);
                     }
                   }];

  g_stream = session;
  [g_stream_lock unlock];
  (void)usedLocale;
  return 0;
}

/// Append 16 kHz mono float32 PCM. Returns 0 on success.
int asr_speech_stream_append(const float *samples, size_t count, char *err_buf,
                             size_t err_len) {
  if (err_buf && err_len > 0) {
    err_buf[0] = '\0';
  }
  if (!samples || count == 0) {
    return 0;
  }
  asr_speech_stream_ensure_lock();
  [g_stream_lock lock];
  AsrSpeechStreamSession *session = g_stream;
  if (!session || !session.request || session.finished) {
    [g_stream_lock unlock];
    asr_speech_write_err(err_buf, err_len, @"Apple Speech stream not active");
    return 12;
  }
  SFSpeechAudioBufferRecognitionRequest *request = session.request;
  AVAudioFormat *format = session.format;
  [g_stream_lock unlock];

  AVAudioFrameCount frames = (AVAudioFrameCount)count;
  AVAudioPCMBuffer *buffer =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:frames];
  if (!buffer || !buffer.floatChannelData || !buffer.floatChannelData[0]) {
    asr_speech_write_err(err_buf, err_len, @"failed to allocate AVAudioPCMBuffer");
    return 13;
  }
  buffer.frameLength = frames;
  memcpy(buffer.floatChannelData[0], samples, count * sizeof(float));
  [request appendAudioPCMBuffer:buffer];
  return 0;
}

/// End audio and wait for final result (up to 30s). Returns 0 on success.
int asr_speech_stream_finish(char *out_buf, size_t out_len, char *err_buf,
                             size_t err_len) {
  if (out_buf && out_len > 0) {
    out_buf[0] = '\0';
  }
  if (err_buf && err_len > 0) {
    err_buf[0] = '\0';
  }
  asr_speech_stream_ensure_lock();
  [g_stream_lock lock];
  AsrSpeechStreamSession *session = g_stream;
  g_stream = nil;
  [g_stream_lock unlock];
  if (!session) {
    asr_speech_write_err(err_buf, err_len, @"Apple Speech stream not active");
    return 12;
  }

  [session.request endAudio];

  long wait = dispatch_semaphore_wait(
      session.doneSem,
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)30 * NSEC_PER_SEC));
  if (wait != 0) {
    [session.task cancel];
    // Soft timeout: return last partial if any.
    NSString *partial =
        [session.latestText stringByTrimmingCharactersInSet:
                                [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (partial.length > 0) {
      asr_speech_write_out(out_buf, out_len, partial);
      return 0;
    }
    asr_speech_write_err(err_buf, err_len, @"Apple Speech stream timed out");
    return 6;
  }
  if (session.finalError) {
    NSString *partial =
        [session.latestText stringByTrimmingCharactersInSet:
                                [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (partial.length > 0) {
      asr_speech_write_out(out_buf, out_len, partial);
      return 0;
    }
    asr_speech_write_err(err_buf, err_len, session.finalError);
    return 7;
  }
  NSString *text =
      [session.latestText stringByTrimmingCharactersInSet:
                              [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (text.length == 0) {
    asr_speech_write_err(
        err_buf, err_len,
        @"Apple Speech returned empty transcript (no speech detected)");
    return 8;
  }
  asr_speech_write_out(out_buf, out_len, text);
  return 0;
}

/// Cancel without waiting for a final result.
void asr_speech_stream_cancel(void) {
  asr_speech_stream_ensure_lock();
  [g_stream_lock lock];
  AsrSpeechStreamSession *session = g_stream;
  g_stream = nil;
  [g_stream_lock unlock];
  if (!session) {
    return;
  }
  [session.task cancel];
  [session.request endAudio];
  session.finished = YES;
  dispatch_semaphore_signal(session.doneSem);
}
