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
//
// Auth status codes (shared with permissions/mod.rs):
//   0 = notDetermined  → show OS dialog
//   1 = denied         → only System Settings can flip
//   2 = authorized
//   3 = restricted
//   4 = unknown / unavailable

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

int asr_tcc_mic_status(void) {
  switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
  case AVAuthorizationStatusNotDetermined:
    return 0;
  case AVAuthorizationStatusDenied:
    return 1;
  case AVAuthorizationStatusAuthorized:
    return 2;
  case AVAuthorizationStatusRestricted:
    return 3;
  default:
    return 4;
  }
}

int asr_tcc_speech_status(void) {
  switch ([SFSpeechRecognizer authorizationStatus]) {
  case SFSpeechRecognizerAuthorizationStatusNotDetermined:
    return 0;
  case SFSpeechRecognizerAuthorizationStatusDenied:
    return 1;
  case SFSpeechRecognizerAuthorizationStatusAuthorized:
    return 2;
  case SFSpeechRecognizerAuthorizationStatusRestricted:
    return 3;
  default:
    return 4;
  }
}

/// Returns false if Info.plist lacks NSMicrophoneUsageDescription (would crash).
bool asr_tcc_request_mic_async(void) {
  if (!asr_tcc_has_usage_description(@"NSMicrophoneUsageDescription")) {
    return false;
  }
  // Already decided — requesting again does nothing useful and confuses UX.
  if (asr_tcc_mic_status() != 0) {
    return true;
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
  if (asr_tcc_speech_status() != 0) {
    return true;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [SFSpeechRecognizer
        requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
          (void)status;
        }];
  });
  return true;
}
