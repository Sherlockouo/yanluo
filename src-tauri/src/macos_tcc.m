#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <stdbool.h>

// In-process TCC probes/requests so *this* binary appears in
// System Settings → Privacy → Microphone / Speech Recognition.
//
// IMPORTANT: SFSpeechRecognizer.requestAuthorization MUST run on the main
// thread. Never block the main thread waiting for the dialog (deadlock/crash).
//
// Without NS*UsageDescription in the process Info.plist, macOS aborts with
// TCC SIGABRT. `tauri dev` runs a naked binary without Info.plist — guard
// and refuse rather than crash. Packaged .app merges src-tauri/Info.plist.

static bool asr_tcc_has_usage_description(NSString *key) {
  id value = [[NSBundle mainBundle] objectForInfoDictionaryKey:key];
  return [value isKindOfClass:[NSString class]] &&
         [(NSString *)value length] > 0;
}

bool asr_tcc_mic_authorized(void) {
  return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] ==
         AVAuthorizationStatusAuthorized;
}

bool asr_tcc_speech_authorized(void) {
  return [SFSpeechRecognizer authorizationStatus] ==
         SFSpeechRecognizerAuthorizationStatusAuthorized;
}

/// Returns false if Info.plist lacks NSMicrophoneUsageDescription (would crash).
bool asr_tcc_request_mic_async(void) {
  if (!asr_tcc_has_usage_description(@"NSMicrophoneUsageDescription")) {
    return false;
  }
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
                             (void)granted;
                           }];
  return true;
}

/// Returns false if Info.plist lacks NSSpeechRecognitionUsageDescription.
bool asr_tcc_request_speech_async(void) {
  if (!asr_tcc_has_usage_description(@"NSSpeechRecognitionUsageDescription")) {
    return false;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [SFSpeechRecognizer
        requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
          (void)status;
        }];
  });
  return true;
}
