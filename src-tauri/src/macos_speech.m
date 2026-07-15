#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <stdbool.h>
#import <string.h>

// In-process SFSpeechRecognizer — same TCC identity as the app.
// NEVER spawn /usr/bin/swift for recognition: that binary has no
// NSSpeechRecognitionUsageDescription and TCC aborts (SIGABRT / exit 137).

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
             @"ASR Workshop";
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
  // Dedupe while preserving order.
  NSOrderedSet *unique = [NSOrderedSet orderedSetWithArray:candidates];
  candidates = [[unique array] mutableCopy];

  SFSpeechRecognizer *recognizer = nil;
  NSString *usedLocale = nil;
  for (NSString *localeId in candidates) {
    SFSpeechRecognizer *r =
        [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:localeId]];
    if (r && r.isAvailable) {
      recognizer = r;
      usedLocale = localeId;
      break;
    }
  }
  if (!recognizer) {
    asr_speech_write_err(
        err_buf, err_len,
        [NSString
            stringWithFormat:@"Speech recognizer unavailable for locales: %@",
                             [candidates componentsJoinedByString:@", "]]);
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
  request.shouldReportPartialResults = NO;
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
