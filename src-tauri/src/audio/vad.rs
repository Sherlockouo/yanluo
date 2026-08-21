//! Streaming VAD + segment clock for long-session ASR.
//!
//! Engine keeps incremental KV *within* a segment; this module decides when to
//! commit/reset so RoPE / KV stay bounded (see doc/design-streaming-asr-vad.md,
//! doc/ROADMAP-streaming-asr-vad.md).
//!
//! S3: `VadBackend` trait — default WebRTC, Energy fallback. SegmentClock
//! consumes per-frame speech bools only (contract unchanged).

use webrtc_vad::{SampleRate, Vad, VadMode};

/// 16 kHz mono PCM sample rate used by the recorder / ASR pipeline.
pub(crate) const SAMPLE_RATE: usize = 16_000;

/// Hangover after last WebRTC speech frame (~240 ms), scaled to frame length.
fn webrtc_hangover_frames(frame_samples: usize) -> usize {
    let frame_ms = (frame_samples * 1000) / SAMPLE_RATE;
    if frame_ms == 0 {
        return 12;
    }
    (240usize).div_ceil(frame_ms).max(1)
}

#[derive(Clone, Debug)]
pub(crate) struct SegmentConfig {
    /// Frame size for VAD (samples). Default 20 ms — valid for WebRTC.
    pub frame_samples: usize,
    /// RMS to *enter* speech (Silence → Speech). Higher = harder to open.
    pub energy_enter: f32,
    /// RMS to *leave* speech (Speech → Silence). Must be < enter (hysteresis).
    pub energy_exit: f32,
    /// Silence must last this long before a commit candidate.
    pub min_silence_samples: usize,
    /// Extra silence hold after candidate before commit.
    pub commit_hold_samples: usize,
    /// Do not commit segments shorter than this.
    pub min_segment_samples: usize,
    /// Force cut even without silence (RoPE / memory guard).
    pub max_segment_samples: usize,
    /// Overlap into the next segment after a cut.
    pub overlap_samples: usize,
    /// Audio kept *before* the detected speech onset when opening a segment.
    /// Plosive onsets (声母爆破音 / word-initial plosives) ramp up over tens
    /// of ms, so VAD triggers 1-3 frames late and clips the first consonant —
    /// the classic "first word misrecognized" cause. Backing the open point
    /// off keeps the attack transient in the decode window; the extra lead-in
    /// silence is harmless to the encoder.
    pub pre_roll_samples: usize,
}

impl Default for SegmentConfig {
    fn default() -> Self {
        // Responsive dictation defaults: a finished sentence + natural pause
        // commits in ~0.9s (650ms silence + 250ms hold); min_segment counts
        // speech only, so short sentences settle too. See config defaults —
        // keep the two in sync.
        Self {
            frame_samples: SAMPLE_RATE / 50,              // 20 ms
            energy_enter: 0.010,
            energy_exit: 0.004,
            min_silence_samples: SAMPLE_RATE * 65 / 100,  // 650 ms
            commit_hold_samples: SAMPLE_RATE / 4,         // 250 ms → ~0.9s quiet to commit
            min_segment_samples: SAMPLE_RATE * 12 / 10,   // 1.2 s of speech
            max_segment_samples: SAMPLE_RATE * 90,        // 90 s hard cap
            overlap_samples: SAMPLE_RATE / 2,             // 500 ms
            pre_roll_samples: SAMPLE_RATE * 16 / 100,     // 160 ms onset guard
        }
    }
}

impl SegmentConfig {
    pub(crate) fn from_app_ms(
        energy_threshold: f32,
        min_silence_ms: u64,
        commit_hold_ms: u64,
        min_segment_ms: u64,
        max_segment_sec: f64,
        overlap_ms: u64,
    ) -> Self {
        let ms = |ms: u64| (SAMPLE_RATE as u64 * ms / 1000) as usize;
        // Floor persisted aggressive config (S1.1 quality): below these the
        // clock commits inside natural speech pauses / mid-word and the
        // rollback window can't stabilize a hypothesis.
        let min_silence_ms = min_silence_ms.max(500);
        let commit_hold_ms = commit_hold_ms.max(150);
        let min_segment_ms = min_segment_ms.max(800);
        let overlap_ms = overlap_ms.max(400);
        let enter = energy_threshold.clamp(1e-6, 0.02);
        Self {
            frame_samples: SAMPLE_RATE / 50,
            energy_enter: enter,
            energy_exit: (enter * 0.4).max(1e-6),
            min_silence_samples: ms(min_silence_ms).max(1),
            commit_hold_samples: ms(commit_hold_ms),
            min_segment_samples: ms(min_segment_ms).max(1),
            max_segment_samples: ((max_segment_sec.max(5.0)) * SAMPLE_RATE as f64) as usize,
            overlap_samples: ms(overlap_ms),
            pre_roll_samples: SAMPLE_RATE * 16 / 100,
        }
    }

    /// Apply speed preset overrides (called after from_app_ms).
    /// "fast" preset: silence=450ms, hold=150ms → ~0.6s to settle (rapid
    /// dictation; trades a slightly higher chance of cutting at brief
    /// breath pauses for snappier finalization).
    pub(crate) fn apply_speed_preset(mut self, preset: &str) -> Self {
        match preset {
            "fast" => {
                let ms = |ms: u64| (SAMPLE_RATE as u64 * ms / 1000) as usize;
                self.min_silence_samples = ms(450).max(1);
                self.commit_hold_samples = ms(150);
            }
            _ => {} // "default" — keep configured values
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SegmentEvent {
    /// Open a new active segment at `start_sample` (absolute in the session buffer).
    Open { start_sample: usize },
    /// Commit the active segment ending at `end_sample` (exclusive).
    Commit { end_sample: usize },
    /// Forced cut at `end_sample` (exclusive) because max_segment was hit.
    HardCut { end_sample: usize },
}

/// Per-frame speech gate for [`SegmentClock`]. S3: WebRTC or Energy.
///
/// Not `Send`: `webrtc-vad`'s `Vad` holds a raw `*mut Fvad`. Created and used
/// only on the mlx-worker thread.
pub(crate) trait VadBackend {
    fn frame_samples(&self) -> usize;
    fn is_speech(&mut self, frame: &[f32]) -> bool;
    fn name(&self) -> &'static str;
}

fn parse_backend_kind(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "webrtc" | "web-rtc" => Some("webrtc"),
        "energy" | "rms" => Some("energy"),
        "silero" => Some("silero"),
        _ => None,
    }
}

fn aggression_to_mode(aggression: u8) -> VadMode {
    match aggression.min(3) {
        0 => VadMode::Quality,
        1 => VadMode::LowBitrate,
        2 => VadMode::Aggressive,
        _ => VadMode::VeryAggressive,
    }
}

fn f32_frame_to_i16(frame: &[f32], out: &mut [i16]) {
    let n = frame.len().min(out.len());
    for i in 0..n {
        let s = frame[i].clamp(-1.0, 1.0);
        out[i] = (s * 32767.0).round() as i16;
    }
}

/// Energy-gate VAD with hysteresis (reduces false silence mid-phrase).
#[derive(Debug)]
pub(crate) struct EnergyVad {
    enter: f32,
    exit: f32,
    frame_samples: usize,
    in_speech: bool,
}

impl EnergyVad {
    pub(crate) fn new(enter: f32, exit: f32, frame_samples: usize) -> Self {
        let enter = enter.max(1e-6);
        let exit = exit.clamp(1e-6, enter);
        Self {
            enter,
            exit,
            frame_samples: frame_samples.max(1),
            in_speech: false,
        }
    }

    pub(crate) fn from_config(cfg: &SegmentConfig) -> Self {
        Self::new(cfg.energy_enter, cfg.energy_exit, cfg.frame_samples)
    }

    fn frame_rms(frame: &[f32]) -> f32 {
        if frame.is_empty() {
            return 0.0;
        }
        let mut sum = 0.0f32;
        for &s in frame {
            sum += s * s;
        }
        (sum / frame.len() as f32).sqrt()
    }
}

impl VadBackend for EnergyVad {
    fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    fn is_speech(&mut self, frame: &[f32]) -> bool {
        let rms = Self::frame_rms(frame);
        if self.in_speech {
            if rms < self.exit {
                self.in_speech = false;
            }
        } else if rms >= self.enter {
            self.in_speech = true;
        }
        self.in_speech
    }

    fn name(&self) -> &'static str {
        "energy"
    }
}

/// WebRTC VAD (libfvad) with short hangover so breath gaps don't look like silence.
pub(crate) struct WebRtcVad {
    inner: Vad,
    frame_samples: usize,
    hangover_left: usize,
    hangover_max: usize,
    i16_buf: Vec<i16>,
}

impl WebRtcVad {
    pub(crate) fn try_new(frame_samples: usize, aggression: u8) -> Result<Self, String> {
        let frame_samples = frame_samples.max(1);
        // WebRTC only accepts 10/20/30 ms at 16 kHz → 160/320/480.
        if !matches!(frame_samples, 160 | 320 | 480) {
            return Err(format!(
                "webrtc frame_samples={frame_samples} invalid (need 160/320/480 @ 16kHz)"
            ));
        }
        let mode = aggression_to_mode(aggression);
        let inner = Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, mode);
        Ok(Self {
            inner,
            frame_samples,
            hangover_left: 0,
            hangover_max: webrtc_hangover_frames(frame_samples),
            i16_buf: vec![0i16; frame_samples],
        })
    }
}

impl VadBackend for WebRtcVad {
    fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    fn is_speech(&mut self, frame: &[f32]) -> bool {
        if frame.len() < self.frame_samples {
            // Incomplete frame: treat as silence and burn hangover (no sticky forever).
            if self.hangover_left > 0 {
                self.hangover_left -= 1;
                return true;
            }
            return false;
        }
        f32_frame_to_i16(&frame[..self.frame_samples], &mut self.i16_buf);
        let raw = self
            .inner
            .is_voice_segment(&self.i16_buf)
            .unwrap_or(false);
        if raw {
            self.hangover_left = self.hangover_max;
            true
        } else if self.hangover_left > 0 {
            self.hangover_left -= 1;
            true
        } else {
            false
        }
    }

    fn name(&self) -> &'static str {
        "webrtc"
    }
}

/// Silero VAD (ONNX) — feature `silero-vad`. 512-sample frames @ 16 kHz.
#[cfg(feature = "silero-vad")]
pub(crate) struct SileroVad {
    inner: voice_activity_detector::VoiceActivityDetector,
    frame_samples: usize,
    threshold: f32,
    hangover_left: usize,
    hangover_max: usize,
}

#[cfg(feature = "silero-vad")]
impl SileroVad {
    pub(crate) fn try_new(threshold: f32) -> Result<Self, String> {
        let frame_samples = 512usize; // Silero V5 @ 16 kHz fixed window
        let inner = voice_activity_detector::VoiceActivityDetector::builder()
            .sample_rate(16_000)
            .chunk_size(frame_samples)
            .build()
            .map_err(|e| format!("silero init: {e}"))?;
        Ok(Self {
            inner,
            frame_samples,
            threshold: threshold.clamp(0.15, 0.85),
            hangover_left: 0,
            hangover_max: webrtc_hangover_frames(frame_samples),
        })
    }
}

#[cfg(feature = "silero-vad")]
impl VadBackend for SileroVad {
    fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    fn is_speech(&mut self, frame: &[f32]) -> bool {
        if frame.len() < self.frame_samples {
            if self.hangover_left > 0 {
                self.hangover_left -= 1;
                return true;
            }
            return false;
        }
        let prob = self.inner.predict(frame[..self.frame_samples].iter().copied());
        let raw = prob >= self.threshold;
        if raw {
            self.hangover_left = self.hangover_max;
            true
        } else if self.hangover_left > 0 {
            self.hangover_left -= 1;
            true
        } else {
            false
        }
    }

    fn name(&self) -> &'static str {
        "silero"
    }
}

/// Build VAD from config. Default `webrtc`; unknown / init failure → Energy + log.
pub(crate) fn make_vad(
    backend: &str,
    cfg: &SegmentConfig,
    aggression: u8,
) -> Box<dyn VadBackend> {
    let kind = parse_backend_kind(backend).unwrap_or_else(|| {
        crate::elog::elog!(
            "[vad] unknown backend {:?}, falling back to energy",
            backend
        );
        "energy"
    });
    match kind {
        "webrtc" => match WebRtcVad::try_new(cfg.frame_samples, aggression) {
            Ok(v) => Box::new(v),
            Err(e) => {
                crate::elog::elog!("[vad] webrtc init failed ({e}), falling back to energy");
                Box::new(EnergyVad::from_config(cfg))
            }
        },
        "silero" => {
            #[cfg(feature = "silero-vad")]
            {
                // Map aggression 0..=3 → threshold 0.35..=0.65 (higher = stricter).
                let thr = 0.35 + (aggression.min(3) as f32) * 0.10;
                match SileroVad::try_new(thr) {
                    Ok(v) => Box::new(v),
                    Err(e) => {
                        crate::elog::elog!("[vad] silero init failed ({e}), falling back to energy");
                        Box::new(EnergyVad::from_config(cfg))
                    }
                }
            }
            #[cfg(not(feature = "silero-vad"))]
            {
                crate::elog::elog!(
                    "[vad] silero requested but built without `silero-vad` feature; using energy"
                );
                Box::new(EnergyVad::from_config(cfg))
            }
        }
        _ => Box::new(EnergyVad::from_config(cfg)),
    }
}

/// Consumes per-frame speech labels and emits open / commit / hard-cut events.
#[derive(Debug)]
pub(crate) struct SegmentClock {
    cfg: SegmentConfig,
    /// Absolute sample index of the active segment start, if any.
    seg_start: Option<usize>,
    /// Samples of continuous silence since last speech inside an active segment.
    silence_run: usize,
    /// Samples classified as speech since segment open (for min_segment).
    speech_in_seg: usize,
    /// Absolute end of the last speech frame inside the active segment —
    /// where trailing silence starts. Lets callers trim the silence tail
    /// before a final decode (decoding trailing silence makes Qwen3-ASR
    /// hallucinate fillers/junk after the last word).
    speech_end: usize,
    /// Absolute end of last committed/hard-cut segment (exclusive).
    cursor: usize,
}

impl SegmentClock {
    pub(crate) fn new(cfg: SegmentConfig) -> Self {
        Self {
            cfg,
            seg_start: None,
            silence_run: 0,
            speech_in_seg: 0,
            speech_end: 0,
            cursor: 0,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn config(&self) -> &SegmentConfig {
        &self.cfg
    }

    pub(crate) fn active_start(&self) -> Option<usize> {
        self.seg_start
    }

    /// End of the last speech frame inside the active segment (absolute),
    /// i.e. where the trailing silence starts. None when no segment is open.
    /// For a force-opened segment with no speech yet this equals the start.
    pub(crate) fn active_speech_end(&self) -> Option<usize> {
        self.seg_start.map(|start| self.speech_end.max(start))
    }

    /// Feed one frame starting at `abs_start` with length `frame_len`.
    pub(crate) fn on_frame(
        &mut self,
        abs_start: usize,
        frame_len: usize,
        speech: bool,
    ) -> Vec<SegmentEvent> {
        let mut out = Vec::new();
        let abs_end = abs_start + frame_len;

        if self.seg_start.is_none() {
            if speech {
                // Pre-roll: keep the onset attack (plosives ramp over tens of
                // ms before VAD fires) inside the segment window. Clamped to
                // the cursor — can't reach before un-drained audio.
                let start = abs_start
                    .saturating_sub(self.cfg.pre_roll_samples)
                    .max(self.cursor);
                self.seg_start = Some(start);
                self.silence_run = 0;
                self.speech_in_seg = frame_len;
                self.speech_end = abs_end;
                out.push(SegmentEvent::Open {
                    start_sample: start,
                });
            }
            return out;
        }

        let seg_start = self.seg_start.unwrap();
        let seg_len = abs_end.saturating_sub(seg_start);

        if speech {
            self.silence_run = 0;
            self.speech_in_seg = self.speech_in_seg.saturating_add(frame_len);
            self.speech_end = abs_end;
        } else {
            self.silence_run = self.silence_run.saturating_add(frame_len);
        }

        if seg_len >= self.cfg.max_segment_samples {
            let end = seg_start + self.cfg.max_segment_samples;
            out.push(SegmentEvent::HardCut { end_sample: end });
            self.after_cut(end);
            return out;
        }

        let need_silence = self
            .cfg
            .min_silence_samples
            .saturating_add(self.cfg.commit_hold_samples);
        if !speech
            && self.silence_run >= need_silence
            && self.speech_in_seg >= self.cfg.min_segment_samples
        {
            let end = abs_end.saturating_sub(self.silence_run).max(seg_start + 1);
            if end > seg_start && end.saturating_sub(seg_start) >= self.cfg.min_segment_samples {
                out.push(SegmentEvent::Commit { end_sample: end });
                self.after_cut(end);
            }
        }

        out
    }

    fn after_cut(&mut self, end: usize) {
        self.cursor = end.saturating_sub(self.cfg.overlap_samples);
        self.seg_start = None;
        self.silence_run = 0;
        self.speech_in_seg = 0;
        self.speech_end = 0;
    }

    pub(crate) fn force_open(&mut self, start: usize) -> usize {
        // Same onset pre-roll as a natural Open (clamped to undrained audio —
        // post-commit the region before `start` may already be drained, in
        // which case this degrades gracefully to no pre-roll).
        let start = start
            .saturating_sub(self.cfg.pre_roll_samples)
            .max(self.cursor);
        self.seg_start = Some(start);
        self.silence_run = 0;
        self.speech_in_seg = 0;
        self.speech_end = start;
        start
    }

    pub(crate) fn next_start_after_cut(&self, end: usize) -> usize {
        end.saturating_sub(self.cfg.overlap_samples)
    }

    /// After draining recorder samples `[0..dropped)`, subtract from absolute indices.
    pub(crate) fn rebase(&mut self, dropped: usize) {
        if dropped == 0 {
            return;
        }
        self.cursor = self.cursor.saturating_sub(dropped);
        self.speech_end = self.speech_end.saturating_sub(dropped);
        if let Some(s) = self.seg_start.as_mut() {
            *s = s.saturating_sub(dropped);
        }
    }
}

pub(crate) fn append_segment_text(committed: &mut String, piece: &str) {
    let piece = piece.trim();
    if piece.is_empty() {
        return;
    }
    if committed.is_empty() {
        *committed = piece.to_string();
        return;
    }

    // Longest Unicode-char suffix/prefix overlap (N >= 2). Also match against
    // committed with trailing punct stripped so "你好。" + "你好世界" finds "你好".
    let piece_chars: Vec<char> = piece.chars().collect();
    let mut overlap = 0usize;
    for base in [
        committed.as_str(),
        committed.trim_end_matches([' ', '\n', '。', '！', '？', '.', '!', '?', ',', '、']),
    ] {
        if base.is_empty() {
            continue;
        }
        let base_chars: Vec<char> = base.chars().collect();
        let max_n = base_chars.len().min(piece_chars.len());
        for n in (2..=max_n).rev() {
            if n <= overlap {
                break;
            }
            if base_chars[base_chars.len() - n..] == piece_chars[..n] {
                overlap = n;
                break;
            }
        }
    }

    let piece = if overlap >= 2 {
        let byte_idx = piece
            .char_indices()
            .nth(overlap)
            .map(|(i, _)| i)
            .unwrap_or(piece.len());
        &piece[byte_idx..]
    } else {
        piece
    };
    if piece.is_empty() {
        return;
    }

    // After overlap strip: English alnum abutting needs a space; CJK stays tight.
    let left_ascii = committed
        .chars()
        .rev()
        .find(|c| !c.is_whitespace())
        .map(|c| c.is_ascii_alphanumeric() || c == '\'')
        .unwrap_or(false);
    let right_ascii = piece
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric() || matches!(c, '\'' | '"' | '('))
        .unwrap_or(false);
    let needs_space = (overlap < 2 || (left_ascii && right_ascii))
        && !committed.ends_with([' ', '\n', '。', '！', '？', '.', '!', '?'])
        && !piece.starts_with([' ', '。', '！', '？', '.', ',', '!', '?']);
    if needs_space {
        committed.push(' ');
    }
    committed.push_str(piece);
}

pub(crate) fn display_text(committed: &str, active: &str) -> String {
    let c = committed.trim();
    let a = active.trim();
    if c.is_empty() {
        return a.to_string();
    }
    if a.is_empty() {
        return c.to_string();
    }
    format!("{c} {a}")
}

/// Cross-segment decode prefix for the next streaming segment.
///
/// Context is injected in the same slot as in-segment rollback text ("already
/// said about *this* audio"). A finished sentence there makes Qwen predict
/// EOS immediately → empty active forever while VAD keeps the segment open.
///
/// Rules:
/// - empty / sentence-final punct → no prefix
/// - otherwise trailing `max_chars` (rough token budget stand-in)
pub(crate) fn cross_seg_decode_prefix(committed: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let t = committed.trim();
    if t.is_empty() {
        return String::new();
    }
    const FINAL: &[char] = &['。', '！', '？', '.', '!', '?', '…', '；', ';'];
    if t.chars().last().is_some_and(|c| FINAL.contains(&c)) {
        return String::new();
    }
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= max_chars {
        return t.to_string();
    }
    chars[chars.len() - max_chars..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_on_speech_and_commits_after_silence() {
        let cfg = SegmentConfig {
            frame_samples: 320,
            energy_enter: 0.01,
            energy_exit: 0.004,
            min_silence_samples: 640,
            commit_hold_samples: 0,
            min_segment_samples: 320,
            pre_roll_samples: 0,
            max_segment_samples: 16000 * 90,
            overlap_samples: 0,
        };
        let mut clock = SegmentClock::new(cfg);
        let mut events = Vec::new();

        events.extend(clock.on_frame(0, 320, true));
        events.extend(clock.on_frame(320, 320, true));
        events.extend(clock.on_frame(640, 320, false));
        events.extend(clock.on_frame(960, 320, false));

        assert!(matches!(events[0], SegmentEvent::Open { start_sample: 0 }));
        assert!(matches!(
            events.last(),
            Some(SegmentEvent::Commit { end_sample: 640 })
        ));
    }

    #[test]
    fn active_speech_end_tracks_last_speech_frame() {
        let cfg = SegmentConfig {
            frame_samples: 320,
            energy_enter: 0.01,
            energy_exit: 0.004,
            min_silence_samples: 10_000, // no commit during the test
            commit_hold_samples: 0,
            min_segment_samples: 320,
            pre_roll_samples: 0,
            max_segment_samples: 16000 * 90,
            overlap_samples: 0,
        };
        let mut clock = SegmentClock::new(cfg);
        assert_eq!(clock.active_speech_end(), None);

        // speech [0, 960), silence [960, 1920): speech end = 960.
        clock.on_frame(0, 320, true);
        clock.on_frame(320, 320, true);
        clock.on_frame(640, 320, true);
        clock.on_frame(960, 320, false);
        clock.on_frame(1280, 320, false);
        assert_eq!(clock.active_speech_end(), Some(960));

        // Speech resumes → end moves.
        clock.on_frame(1600, 320, true);
        assert_eq!(clock.active_speech_end(), Some(1920));

        // Rebase after draining [0..1000): indices shift down by 1000.
        clock.rebase(1000);
        assert_eq!(clock.active_speech_end(), Some(920));
    }

    #[test]
    fn hard_cut_without_silence() {
        let cfg = SegmentConfig {
            frame_samples: 320,
            energy_enter: 0.01,
            energy_exit: 0.004,
            min_silence_samples: 10_000,
            commit_hold_samples: 0,
            min_segment_samples: 320,
            pre_roll_samples: 0,
            max_segment_samples: 960,
            overlap_samples: 0,
        };
        let mut clock = SegmentClock::new(cfg);
        let mut events = Vec::new();
        events.extend(clock.on_frame(0, 320, true));
        events.extend(clock.on_frame(320, 320, true));
        events.extend(clock.on_frame(640, 320, true));
        assert!(events.iter().any(|e| matches!(
            e,
            SegmentEvent::HardCut { end_sample: 960 }
        )));
    }

    #[test]
    fn energy_vad_hysteresis_holds_through_quiet() {
        let mut vad = EnergyVad::new(0.01, 0.004, 320);
        let silence = vec![0.0f32; 320];
        let mut loud = vec![0.0f32; 320];
        let mut quiet = vec![0.0f32; 320];
        for (i, s) in loud.iter_mut().enumerate() {
            *s = 0.2 * (i as f32 * 0.1).sin();
        }
        for (i, s) in quiet.iter_mut().enumerate() {
            *s = 0.006 * (i as f32 * 0.1).sin();
        }
        assert!(!vad.is_speech(&silence));
        assert!(vad.is_speech(&loud));
        assert!(vad.is_speech(&quiet));
        assert!(!vad.is_speech(&silence));
    }

    #[test]
    fn make_vad_unknown_falls_back_to_energy() {
        let cfg = SegmentConfig::default();
        let vad = make_vad("not-a-backend", &cfg, 2);
        assert_eq!(vad.name(), "energy");
    }

    #[test]
    fn make_vad_webrtc_default_name() {
        let cfg = SegmentConfig::default();
        let vad = make_vad("webrtc", &cfg, 2);
        assert_eq!(vad.name(), "webrtc");
    }

    #[test]
    fn webrtc_silence_is_not_speech() {
        let mut vad = WebRtcVad::try_new(320, 2).expect("webrtc init");
        let silence = vec![0.0f32; 320];
        // First frames should be silence (no hangover yet).
        assert!(!vad.is_speech(&silence));
        assert!(!vad.is_speech(&silence));
    }

    #[test]
    fn webrtc_hangover_holds_after_forced_speech() {
        let mut vad = WebRtcVad::try_new(320, 0).expect("webrtc init");
        let silence = vec![0.0f32; 320];
        // Inject hangover without relying on tone classification.
        vad.hangover_left = vad.hangover_max;
        assert!(vad.is_speech(&silence));
        // Burn remaining hangover frames, then silence.
        for _ in 0..vad.hangover_max {
            let _ = vad.is_speech(&silence);
        }
        assert!(!vad.is_speech(&silence));
    }

    #[test]
    fn webrtc_invalid_frame_samples_falls_back_via_make_vad() {
        let mut cfg = SegmentConfig::default();
        cfg.frame_samples = 100; // illegal for WebRTC
        let vad = make_vad("webrtc", &cfg, 2);
        assert_eq!(vad.name(), "energy");
    }

    #[test]
    fn make_vad_energy_explicit() {
        let cfg = SegmentConfig::default();
        let vad = make_vad("energy", &cfg, 2);
        assert_eq!(vad.name(), "energy");
    }

    #[test]
    fn append_segment_text_strips_english_overlap() {
        let mut s = String::from("hello world");
        append_segment_text(&mut s, "world again");
        assert_eq!(s, "hello world again");
    }

    #[test]
    fn append_segment_text_strips_cjk_overlap() {
        let mut s = String::from("今天天气");
        append_segment_text(&mut s, "天气很好");
        assert_eq!(s, "今天天气很好");
    }

    #[test]
    fn append_segment_text_no_false_merge() {
        let mut s = String::from("abc");
        append_segment_text(&mut s, "xyz");
        assert_eq!(s, "abc xyz");
    }

    #[test]
    fn append_segment_text_empty_piece_noop() {
        let mut s = String::from("hello");
        append_segment_text(&mut s, "   ");
        assert_eq!(s, "hello");
    }

    #[test]
    fn append_segment_text_overlap_after_cjk_punct() {
        let mut s = String::from("你好。");
        append_segment_text(&mut s, "你好世界");
        assert_eq!(s, "你好。世界");
    }

    #[test]
    fn cross_seg_skips_finished_sentence() {
        assert!(cross_seg_decode_prefix("能听到吗？", 64).is_empty());
        assert!(cross_seg_decode_prefix("Hello world.", 64).is_empty());
        assert!(cross_seg_decode_prefix("完了。", 64).is_empty());
    }

    #[test]
    fn cross_seg_keeps_open_clause() {
        assert_eq!(cross_seg_decode_prefix("他说", 64), "他说");
        assert_eq!(cross_seg_decode_prefix("一二三四五六七八", 4), "五六七八");
    }

    #[test]
    fn cross_seg_disabled_when_max_zero() {
        assert!(cross_seg_decode_prefix("他说", 0).is_empty());
    }
}
