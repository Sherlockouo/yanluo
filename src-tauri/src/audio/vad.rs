//! Streaming VAD + segment clock for long-session ASR.
//!
//! Engine keeps incremental KV *within* a segment; this module decides when to
//! commit/reset so RoPE / KV stay bounded (see doc/design-streaming-asr-vad.md,
//! doc/ROADMAP-streaming-asr-vad.md).

/// 16 kHz mono PCM sample rate used by the recorder / ASR pipeline.
pub(crate) const SAMPLE_RATE: usize = 16_000;

#[derive(Clone, Debug)]
pub(crate) struct SegmentConfig {
    /// Frame size for energy VAD (samples). Default 20 ms.
    pub frame_samples: usize,
    /// RMS to *enter* speech (Silence → Speech). Higher = harder to open.
    pub energy_enter: f32,
    /// RMS to *leave* speech (Speech → Silence). Must be < enter (hysteresis).
    /// Lower exit = stay in-speech through quiet syllables / short breaths.
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
}

impl Default for SegmentConfig {
    fn default() -> Self {
        // Conservative defaults (S1.1): prefer longer segments over early cuts.
        // Early VAD commits destroy context and drop accuracy.
        Self {
            frame_samples: SAMPLE_RATE / 50,           // 20 ms
            energy_enter: 0.010,
            energy_exit: 0.004,
            min_silence_samples: SAMPLE_RATE * 9 / 10, // 900 ms
            commit_hold_samples: SAMPLE_RATE / 2,      // 500 ms → ~1.4s quiet to commit
            min_segment_samples: SAMPLE_RATE * 5 / 2,  // 2.5 s
            max_segment_samples: SAMPLE_RATE * 90,     // 90 s hard cap
            overlap_samples: SAMPLE_RATE / 2,          // 500 ms
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
        // Floor persisted aggressive config (S1.1 quality).
        let min_silence_ms = min_silence_ms.max(700);
        let commit_hold_ms = commit_hold_ms.max(400);
        let min_segment_ms = min_segment_ms.max(2000);
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
        }
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

    pub(crate) fn frame_samples(&self) -> usize {
        self.frame_samples
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

    /// Update latch; returns whether this frame counts as speech for SegmentClock.
    pub(crate) fn is_speech(&mut self, frame: &[f32]) -> bool {
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
                let start = abs_start.max(self.cursor);
                self.seg_start = Some(start);
                self.silence_run = 0;
                self.speech_in_seg = frame_len;
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
    }

    pub(crate) fn force_open(&mut self, start: usize) {
        let start = start.max(self.cursor);
        self.seg_start = Some(start);
        self.silence_run = 0;
        self.speech_in_seg = 0;
    }

    pub(crate) fn next_start_after_cut(&self, end: usize) -> usize {
        end.saturating_sub(self.cfg.overlap_samples)
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
    if !committed.ends_with([' ', '\n', '。', '！', '？', '.', '!', '?'])
        && !piece.starts_with(['。', '！', '？', '.', ',', '!', '?'])
    {
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
    fn hard_cut_without_silence() {
        let cfg = SegmentConfig {
            frame_samples: 320,
            energy_enter: 0.01,
            energy_exit: 0.004,
            min_silence_samples: 10_000,
            commit_hold_samples: 0,
            min_segment_samples: 320,
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
}
