#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>
#import <stdbool.h>

// In-process TCC probes/requests so *this* binary appears in
// System Settings → Privacy → Microphone / Speech Recognition.
//
// IMPORTANT: SFSpeechRecognizer.requestAuthorization MUST run on the main
// thread. Never block the main thread waiting for the dialog (deadlock/crash).

bool asr_tcc_mic_authorized(void) {
  return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] ==
         AVAuthorizationStatusAuthorized;
}

bool asr_tcc_speech_authorized(void) {
  return [SFSpeechRecognizer authorizationStatus] ==
         SFSpeechRecognizerAuthorizationStatusAuthorized;
}

/// Fire-and-forget mic prompt on a background-safe path (completion on arbitrary queue).
void asr_tcc_request_mic_async(void) {
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
                             (void)granted;
                           }];
}

/// Fire-and-forget speech prompt — always dispatched to the main queue.
void asr_tcc_request_speech_async(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [SFSpeechRecognizer
        requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
          (void)status;
        }];
  });
}
