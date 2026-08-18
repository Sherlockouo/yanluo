//! Audio capture for ASR.
//!
//! Modes:
//! - `external`: microphone via cpal (default)
//! - `system`: macOS system/speaker audio via ScreenCaptureKit
//! - `both`: mix mic + system
//!
//! All paths deliver 16 kHz mono f32 into shared buffers.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::{Deserialize, Serialize};

/// Target sample rate for ASR.
const TARGET_SR: usize = 16_000;
/// HUD spectrum bands — keep in sync with `HUD_BAND_COUNT` / FE `SPECTRUM_BAR_COUNT`.
pub const METER_BAND_COUNT: usize = 5;
const METER_WINDOW: usize = 1_024; // ~64ms @ 16kHz

/// HUD meter — loudness envelope is lock-free (capture thread);
/// spectrum is computed on the pump thread without holding `recorder`.
///
/// Root invariant: VAD commit / PCM clone must never freeze the meter.
#[derive(Debug)]
pub struct LiveMeter {
    /// Attack/release envelope 0–1 from capture peaks (no locks).
    envelope_bits: AtomicU32,
    bands: Mutex<[f32; METER_BAND_COUNT]>,
    /// Hot PCM buffers for pump-side spectrum (set while recording).
    sources: Mutex<Option<MeterSources>>,
}

#[derive(Clone, Debug)]
struct MeterSources {
    mic: Arc<Mutex<Vec<f32>>>,
    system: Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
}

impl Default for LiveMeter {
    fn default() -> Self {
        Self {
            envelope_bits: AtomicU32::new(0.0_f32.to_bits()),
            bands: Mutex::new([0.0; METER_BAND_COUNT]),
            sources: Mutex::new(None),
        }
    }
}

impl LiveMeter {
    pub fn clear(&self) {
        self.envelope_bits
            .store(0.0_f32.to_bits(), Ordering::Release);
        if let Ok(mut b) = self.bands.lock() {
            *b = [0.0; METER_BAND_COUNT];
        }
        if let Ok(mut s) = self.sources.lock() {
            *s = None;
        }
    }

    pub fn bind_sources(
        &self,
        mic: Arc<Mutex<Vec<f32>>>,
        system: Arc<Mutex<Vec<f32>>>,
        mode: AudioCaptureMode,
    ) {
        if let Ok(mut s) = self.sources.lock() {
            *s = Some(MeterSources { mic, system, mode });
        }
    }

    /// Capture-thread only: update loudness from a chunk peak. No mutex.
    pub fn observe_peak(&self, peak: f32) {
        let level = peak_to_level(peak);
        let old = f32::from_bits(self.envelope_bits.load(Ordering::Acquire));
        // Fast attack / slower release — follows speech, drops on silence.
        let next = if level > old {
            old + (level - old) * 0.65
        } else {
            old + (level - old) * 0.18
        };
        self.envelope_bits
            .store(next.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    }

    fn envelope(&self) -> f32 {
        f32::from_bits(self.envelope_bits.load(Ordering::Acquire)).clamp(0.0, 1.0)
    }

    /// Pump-thread: try spectrum from PCM; if buffers locked (ASR commit),
    /// fall back to envelope so bars keep moving with speech.
    pub fn refresh_for_pump(&self) -> (f32, Vec<f32>) {
        let env = self.envelope();
        let sources = self.sources.lock().ok().and_then(|g| g.clone());
        if let Some(src) = sources {
            if let Some(buf) = mix_buffers_tail_try(&src.mic, &src.system, src.mode, METER_WINDOW)
            {
                if !buf.is_empty() {
                    let rms = meter_from_slice(&buf).max(env);
                    let bands = goertzel_bands(&buf, TARGET_SR as f32, METER_BAND_COUNT);
                    if let Ok(mut slot) = self.bands.lock() {
                        for (i, v) in slot.iter_mut().enumerate() {
                            *v = bands.get(i).copied().unwrap_or(0.0);
                        }
                    }
                    return (rms, bands);
                }
            }
        }
        // Contended or empty hot buffer — envelope still tracks mic peaks.
        let bands = envelope_bands(env);
        (env, bands)
    }
}

fn peak_to_level(peak: f32) -> f32 {
    let raw = peak.max(0.0);
    if raw < 0.000_8 {
        return 0.0;
    }
    let boosted = (raw * 48.0).clamp(0.0, 2.2);
    boosted.powf(0.45).clamp(0.0, 1.0)
}

fn envelope_bands(level: f32) -> Vec<f32> {
    let n = METER_BAND_COUNT;
    (0..n)
        .map(|i| {
            let t = if n == 1 { 0.5 } else { i as f32 / (n - 1) as f32 };
            let shape = 0.4 + 0.6 * (std::f32::consts::PI * t).sin();
            shape * level
        })
        .collect()
}

/// Non-blocking tail copy — returns None if mic/system lock is held by ASR.
fn mix_buffers_tail_try(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    window: usize,
) -> Option<Vec<f32>> {
    let window = window.max(1);
    match mode {
        AudioCaptureMode::External => tail_copy_try(mic, window),
        AudioCaptureMode::System => tail_copy_try(system, window),
        AudioCaptureMode::Both => {
            let mic = mic.try_lock().ok()?;
            let sys = system.try_lock().ok()?;
            let n = mic.len().max(sys.len());
            if n == 0 {
                return Some(Vec::new());
            }
            let start = n.saturating_sub(window);
            let mut out = Vec::with_capacity(n - start);
            for i in start..n {
                let a = mic.get(i).copied().unwrap_or(0.0);
                let b = sys.get(i).copied().unwrap_or(0.0);
                out.push((a + b).clamp(-1.0, 1.0));
            }
            Some(out)
        }
    }
}

fn tail_copy_try(buf: &Arc<Mutex<Vec<f32>>>, window: usize) -> Option<Vec<f32>> {
    let guard = buf.try_lock().ok()?;
    let n = guard.len().min(window);
    if n == 0 {
        return Some(Vec::new());
    }
    Some(guard[guard.len() - n..].to_vec())
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AudioCaptureMode {
    /// Microphone / external input only.
    #[default]
    External,
    /// System playback (what speakers play) only.
    System,
    /// Mix microphone + system playback.
    Both,
}

impl AudioCaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::External => "external",
            Self::System => "system",
            Self::Both => "both",
        }
    }
}

/// How the mic capture is held for a session.
enum MicHandle {
    /// Built by this session; dropped with the recorder.
    Owned(cpal::Stream),
    /// Promoted speculative warm-start; the owner thread stops the stream
    /// when this lease drops (cpal::Stream is !Send — never moved).
    Leased(WarmMicLease),
}

/// Active audio recorder. Drop streams / system capture to stop.
pub struct AudioRecorder {
    /// Mic stream (cpal) — present for External / Both.
    _mic_stream: Option<MicHandle>,
    /// System-audio capture handle — present for System / Both (macOS).
    _system: Option<SystemAudioCapture>,
    mic_samples: Arc<Mutex<Vec<f32>>>,
    system_samples: Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    /// Human-readable reason when system capture was dropped.
    pub fallback_warning: Option<String>,
}

impl AudioRecorder {
    pub fn start(
        mode: AudioCaptureMode,
        live_meter: Arc<LiveMeter>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        live_meter.clear();
        let want_mic = matches!(mode, AudioCaptureMode::External | AudioCaptureMode::Both);
        let want_system = matches!(mode, AudioCaptureMode::System | AudioCaptureMode::Both);

        // Warm path: a speculative capture started on Fn key-down may already
        // be flowing — promote it instead of cold-booting the AudioUnit,
        // keeping speech captured between press and release. External only:
        // Both mixes mic/system by index and must not offset the mic.
        let fresh_mic = Arc::new(Mutex::new(Vec::<f32>::new()));
        let (mut mic_stream, mic_samples) = if want_mic {
            let warm = if mode == AudioCaptureMode::External {
                take_speculative_mic()
            } else {
                discard_speculative_mic();
                None
            };
            match warm {
                Some(lease) => {
                    let buffered = lease.samples.lock().map(|s| s.len()).unwrap_or(0);
                    crate::elog::elog!(
                        "[audio] promoted speculative mic (pre-buffered {:.2}s)",
                        buffered as f64 / 16_000.0
                    );
                    let samples = lease.samples.clone();
                    (Some(MicHandle::Leased(lease)), samples)
                }
                None => (
                    Some(MicHandle::Owned(start_mic_stream(
                        fresh_mic.clone(),
                        live_meter.clone(),
                    )?)),
                    fresh_mic,
                ),
            }
        } else {
            discard_speculative_mic();
            (None, fresh_mic)
        };
        let system_samples = Arc::new(Mutex::new(Vec::<f32>::new()));

        let (system, effective_mode, fallback_warning) = if want_system {
            match SystemAudioCapture::start(
                system_samples.clone(),
                live_meter.clone(),
            ) {
                Ok(cap) => (Some(cap), mode, None),
                Err(err) => {
                    // Screen-recording TCC denied / unavailable: keep going on mic
                    // even when the user picked「只录系统」— better than hard-fail.
                    let msg = format!(
                        "系统音频不可用（{err}），已退回只录麦克风。需要录系统声时请到「设置 → 权限」授予屏幕录制。"
                    );
                    crate::elog::elog!("[audio] {msg}");
                    if mic_stream.is_none() {
                        match start_mic_stream(mic_samples.clone(), live_meter.clone()) {
                            Ok(stream) => mic_stream = Some(MicHandle::Owned(stream)),
                            Err(mic_err) => {
                                return Err(format!(
                                    "系统音频不可用（{err}）；麦克风也启动失败（{mic_err}）"
                                )
                                .into());
                            }
                        }
                    }
                    (None, AudioCaptureMode::External, Some(msg))
                }
            }
        } else {
            (None, mode, None)
        };

        if mic_stream.is_none() && system.is_none() {
            return Err("no audio capture source started".into());
        }

        crate::elog::elog!(
            "[audio] capture mode={} (effective={})",
            mode.as_str(),
            effective_mode.as_str()
        );

        live_meter.bind_sources(
            mic_samples.clone(),
            system_samples.clone(),
            effective_mode,
        );

        Ok(Self {
            _mic_stream: mic_stream,
            _system: system,
            mic_samples,
            system_samples,
            mode: effective_mode,
            fallback_warning,
        })
    }

    /// Snapshot of currently accumulated samples (16kHz mono f32).
    pub fn get_samples(&self) -> Vec<f32> {
        mix_buffers(&self.mic_samples, &self.system_samples, self.mode)
    }

    /// Mixed sample count without cloning the buffer.
    #[allow(dead_code)]
    pub fn sample_len(&self) -> usize {
        mix_len(&self.mic_samples, &self.system_samples, self.mode)
    }

    /// Copy samples from absolute index `from` to end (hot-path; avoids full-buffer clone).
    /// Returns `(from_clamped, samples[from..])`.
    pub fn get_samples_from(&self, from: usize) -> (usize, Vec<f32>) {
        mix_buffers_from(&self.mic_samples, &self.system_samples, self.mode, from)
    }

    /// Drain samples strictly before `keep_from` (absolute). Returns drained prefix
    /// for cold archive (final align / export). Hot buffers keep `[keep_from..]`
    /// so the next segment's overlap remains available.
    pub fn drain_before(&self, keep_from: usize) -> Vec<f32> {
        drain_buffers_before(&self.mic_samples, &self.system_samples, self.mode, keep_from)
    }

    /// Live meter 0–1 from recent samples (tail only — never clones the full buffer).
    pub fn recent_rms(&self, window: usize) -> f32 {
        let buf = mix_buffers_tail(&self.mic_samples, &self.system_samples, self.mode, window);
        if buf.is_empty() {
            return 0.0;
        }
        meter_from_slice(&buf)
    }

    /// Log-spaced speech bands via Goertzel (~80Hz–4kHz).
    /// Copies only the last `window` samples so the HUD pump cannot freeze the app
    /// as the recording buffer grows (system audio especially).
    pub fn recent_bands(&self, band_count: usize, window: usize) -> (f32, Vec<f32>) {
        let buf = mix_buffers_tail(&self.mic_samples, &self.system_samples, self.mode, window);
        if buf.is_empty() {
            return (0.0, vec![0.0; band_count]);
        }
        let rms = meter_from_slice(&buf);
        let bands = goertzel_bands(&buf, TARGET_SR as f32, band_count);
        (rms, bands)
    }

    /// Stop recording and return all captured samples (16kHz mono f32).
    pub fn stop(self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let samples = mix_buffers(&self.mic_samples, &self.system_samples, self.mode);
        drop(self._mic_stream);
        drop(self._system);
        Ok(samples)
    }
}

// ---------------------------------------------------------------------------
// Speculative mic warm-start
//
// Fn commits on *release* (chord support). That press→release gap is dead time
// the mic used to spend cold-booting only after the release (device
// enumeration + AudioUnit init ≈ 30-80ms, after the HUD is already visible).
// Instead: Fn key-down starts a discard buffer; a committed release promotes
// it — speech captured between press and release (the user's first words) is
// kept — while cancelled chords drop it. A reaper bounds leaks to ~10s
// (~640KB mono 16kHz). External mode only: Both must keep mic/system
// index-aligned for mix_buffers.
//
// Threading: cpal::Stream is !Send (raw AudioUnit handles), so the stream is
// created AND dropped on a dedicated owner thread. The global slot and the
// session lease only ever hold Send handles (buffer Arc + command Sender).
// ---------------------------------------------------------------------------

enum SpecCmd {
    /// Stop capture and drop the stream on its owning thread.
    Stop,
}

struct SpeculativeMic {
    samples: Arc<Mutex<Vec<f32>>>,
    cmd: std::sync::mpsc::Sender<SpecCmd>,
    started_at: std::time::Instant,
}

fn speculative_slot() -> &'static Mutex<Option<SpeculativeMic>> {
    static SLOT: std::sync::OnceLock<Mutex<Option<SpeculativeMic>>> =
        std::sync::OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

const SPECULATIVE_REAP_AFTER: std::time::Duration =
    std::time::Duration::from_secs(10);

/// Begin warming the mic. Called from the hotkey tap thread — never blocks:
/// stream construction runs on the owner thread.
pub fn begin_speculative_mic(live_meter: Arc<LiveMeter>) {
    // Replace any stale capture (also reaps leftovers from an aborted press).
    discard_speculative_mic();

    let (tx, rx) = std::sync::mpsc::channel::<SpecCmd>();
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let samples_owner = samples.clone();
    std::thread::spawn(move || {
        // Owner thread — the only place this stream is created or dropped.
        let stream = match start_mic_stream(samples_owner.clone(), live_meter) {
            Ok(s) => s,
            Err(e) => {
                // TCC first-run / device gone — release path falls back to a
                // regular cold start, so this is strictly a lost optimization.
                crate::elog::elog!("[audio] speculative mic start failed: {e}");
                return;
            }
        };
        crate::elog::elog!("[audio] speculative mic warm-started");
        if let Ok(mut slot) = speculative_slot().lock() {
            *slot = Some(SpeculativeMic {
                samples: samples_owner,
                cmd: tx,
                started_at: std::time::Instant::now(),
            });
        }
        // Serve until told to stop (or every sender handle is gone).
        for cmd in rx {
            match cmd {
                SpecCmd::Stop => break,
            }
        }
        drop(stream); // Stop the AudioUnit on the owning thread.
    });

    // Reaper: if the release never commits (chord cancelled, HUD stole the
    // key…), stop the stream so the mic indicator doesn't stay lit.
    std::thread::spawn(|| {
        std::thread::sleep(SPECULATIVE_REAP_AFTER);
        if let Ok(mut slot) = speculative_slot().lock() {
            let stale = slot
                .as_ref()
                .map(|s| s.started_at.elapsed() >= SPECULATIVE_REAP_AFTER)
                .unwrap_or(false);
            if stale {
                crate::elog::elog!("[audio] reaped stale speculative mic");
                if let Some(spec) = slot.take() {
                    let _ = spec.cmd.send(SpecCmd::Stop);
                }
            }
        }
    });
}

/// Live handle onto a speculative capture. Promote via
/// [`AudioRecorder::start`]; dropping the lease stops the stream.
pub struct WarmMicLease {
    pub samples: Arc<Mutex<Vec<f32>>>,
    cmd: Option<std::sync::mpsc::Sender<SpecCmd>>,
}

impl Drop for WarmMicLease {
    fn drop(&mut self) {
        if let Some(tx) = self.cmd.take() {
            let _ = tx.send(SpecCmd::Stop);
        }
    }
}

/// Promote a live speculative capture into a session. None when nothing is
/// warm (regular cold start follows).
pub fn take_speculative_mic() -> Option<WarmMicLease> {
    let mut slot = speculative_slot().lock().ok()?;
    slot.take()
        .map(|spec| WarmMicLease {
            samples: spec.samples,
            cmd: Some(spec.cmd),
        })
}

/// Drop the speculative capture without using it (cancelled chord / error).
pub fn discard_speculative_mic() {
    if let Ok(mut slot) = speculative_slot().lock() {
        if let Some(spec) = slot.take() {
            crate::elog::elog!("[audio] speculative mic discarded");
            let _ = spec.cmd.send(SpecCmd::Stop);
        }
    }
}

fn mix_buffers(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
) -> Vec<f32> {
    let mic = mic.lock().map(|s| s.clone()).unwrap_or_default();
    let sys = system.lock().map(|s| s.clone()).unwrap_or_default();
    match mode {
        AudioCaptureMode::External => mic,
        AudioCaptureMode::System => sys,
        AudioCaptureMode::Both => mix_aligned(&mic, &sys),
    }
}

fn mix_len(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
) -> usize {
    match mode {
        AudioCaptureMode::External => mic.lock().map(|s| s.len()).unwrap_or(0),
        AudioCaptureMode::System => system.lock().map(|s| s.len()).unwrap_or(0),
        AudioCaptureMode::Both => {
            let m = mic.lock().map(|s| s.len()).unwrap_or(0);
            let s = system.lock().map(|s| s.len()).unwrap_or(0);
            m.max(s)
        }
    }
}

/// Copy mixed samples from `from` (clamped) to end.
fn mix_buffers_from(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    from: usize,
) -> (usize, Vec<f32>) {
    match mode {
        AudioCaptureMode::External => {
            let Ok(buf) = mic.lock() else {
                return (0, Vec::new());
            };
            let from = from.min(buf.len());
            (from, buf[from..].to_vec())
        }
        AudioCaptureMode::System => {
            let Ok(buf) = system.lock() else {
                return (0, Vec::new());
            };
            let from = from.min(buf.len());
            (from, buf[from..].to_vec())
        }
        AudioCaptureMode::Both => {
            let Ok(mic) = mic.lock() else {
                return (0, Vec::new());
            };
            let Ok(sys) = system.lock() else {
                return (0, Vec::new());
            };
            let n = mic.len().max(sys.len());
            let from = from.min(n);
            if from >= n {
                return (from, Vec::new());
            }
            let mut out = Vec::with_capacity(n - from);
            for i in from..n {
                let a = mic.get(i).copied().unwrap_or(0.0);
                let b = sys.get(i).copied().unwrap_or(0.0);
                out.push((a + b).clamp(-1.0, 1.0));
            }
            (from, out)
        }
    }
}

/// Drain and return mixed samples `[0..keep_from)`, leaving `[keep_from..]` in buffers.
fn drain_buffers_before(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    keep_from: usize,
) -> Vec<f32> {
    if keep_from == 0 {
        return Vec::new();
    }
    match mode {
        AudioCaptureMode::External => {
            let Ok(mut buf) = mic.lock() else {
                return Vec::new();
            };
            let n = keep_from.min(buf.len());
            buf.drain(..n).collect()
        }
        AudioCaptureMode::System => {
            let Ok(mut buf) = system.lock() else {
                return Vec::new();
            };
            let n = keep_from.min(buf.len());
            buf.drain(..n).collect()
        }
        AudioCaptureMode::Both => {
            let Ok(mut mic) = mic.lock() else {
                return Vec::new();
            };
            let Ok(mut sys) = system.lock() else {
                return Vec::new();
            };
            // Drain the shared prefix only — keep buffers length-aligned.
            let n = keep_from.min(mic.len().min(sys.len()));
            if n == 0 {
                return Vec::new();
            }
            let mut drained = Vec::with_capacity(n);
            for i in 0..n {
                let a = mic[i];
                let b = sys[i];
                drained.push((a + b).clamp(-1.0, 1.0));
            }
            mic.drain(..n);
            sys.drain(..n);
            drained
        }
    }
}

/// Copy only the last `window` mixed samples — used by the HUD meter (~60 Hz).
fn mix_buffers_tail(
    mic: &Arc<Mutex<Vec<f32>>>,
    system: &Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    window: usize,
) -> Vec<f32> {
    let window = window.max(1);
    match mode {
        AudioCaptureMode::External => tail_copy(mic, window),
        AudioCaptureMode::System => tail_copy(system, window),
        AudioCaptureMode::Both => {
            let Ok(mic) = mic.lock() else {
                return Vec::new();
            };
            let Ok(sys) = system.lock() else {
                return Vec::new();
            };
            let n = mic.len().max(sys.len());
            if n == 0 {
                return Vec::new();
            }
            let start = n.saturating_sub(window);
            let mut out = Vec::with_capacity(n - start);
            for i in start..n {
                let a = mic.get(i).copied().unwrap_or(0.0);
                let b = sys.get(i).copied().unwrap_or(0.0);
                out.push((a + b).clamp(-1.0, 1.0));
            }
            out
        }
    }
}

fn tail_copy(buf: &Arc<Mutex<Vec<f32>>>, window: usize) -> Vec<f32> {
    let Ok(guard) = buf.lock() else {
        return Vec::new();
    };
    let n = guard.len().min(window);
    if n == 0 {
        return Vec::new();
    }
    guard[guard.len() - n..].to_vec()
}

fn mix_aligned(mic: &[f32], sys: &[f32]) -> Vec<f32> {
    let n = mic.len().max(sys.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = mic.get(i).copied().unwrap_or(0.0);
        let b = sys.get(i).copied().unwrap_or(0.0);
        out.push((a + b).clamp(-1.0, 1.0));
    }
    out
}

fn start_mic_stream(
    samples: Arc<Mutex<Vec<f32>>>,
    live_meter: Arc<LiveMeter>,
) -> Result<cpal::Stream, Box<dyn std::error::Error>> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No input device found")?;

    let supported_configs = device.supported_input_configs()?;
    let mut best: Option<(cpal::SupportedStreamConfig, SampleFormat)> = None;

    for sc in supported_configs {
        let fmt = sc.sample_format();
        let score = match fmt {
            SampleFormat::F32 => 3,
            SampleFormat::I16 => 2,
            SampleFormat::U16 => 1,
            _ => continue,
        };
        let chan_score = if sc.channels() == 1 { 2 } else { 0 };
        let total = score + chan_score;

        let is_better = best.as_ref().map_or(true, |(_, prev_fmt)| {
            let prev_score = match prev_fmt {
                SampleFormat::F32 => 3,
                SampleFormat::I16 => 2,
                SampleFormat::U16 => 1,
                _ => 0,
            };
            total > prev_score
        });

        if is_better {
            let cfg = sc.with_max_sample_rate();
            best = Some((cfg, fmt));
        }
    }

    let (config, sample_format) =
        best.ok_or("No supported input stream configuration found")?;

    let actual_sr = config.sample_rate().0 as usize;
    let actual_channels = config.channels() as usize;
    crate::elog::elog!(
        "[audio] mic device: {:?}, format: {:?}, sample_rate: {}Hz, channels: {}",
        device.name().unwrap_or_default(),
        sample_format,
        actual_sr,
        actual_channels,
    );

    let stream = match sample_format {
        SampleFormat::F32 => {
            let samples_cb = samples.clone();
            let meter_cb = live_meter.clone();
            let mut downsampler: Option<Downsampler> = None;
            device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    process_chunk(
                        data,
                        actual_sr,
                        actual_channels,
                        &mut downsampler,
                        &samples_cb,
                        &meter_cb,
                    );
                },
                |err| crate::elog::elog!("[audio] mic capture error: {}", err),
                None,
            )?
        }
        SampleFormat::I16 => {
            let samples_cb = samples.clone();
            let meter_cb = live_meter.clone();
            let mut downsampler: Option<Downsampler> = None;
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    process_chunk(
                        &f32_data,
                        actual_sr,
                        actual_channels,
                        &mut downsampler,
                        &samples_cb,
                        &meter_cb,
                    );
                },
                |err| crate::elog::elog!("[audio] mic capture error: {}", err),
                None,
            )?
        }
        SampleFormat::U16 => {
            let samples_cb = samples.clone();
            let meter_cb = live_meter.clone();
            let mut downsampler: Option<Downsampler> = None;
            device.build_input_stream(
                &config.into(),
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let f32_data: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .collect();
                    process_chunk(
                        &f32_data,
                        actual_sr,
                        actual_channels,
                        &mut downsampler,
                        &samples_cb,
                        &meter_cb,
                    );
                },
                |err| crate::elog::elog!("[audio] mic capture error: {}", err),
                None,
            )?
        }
        _ => return Err("Unsupported sample format".into()),
    };

    stream.play()?;
    Ok(stream)
}

// ---------------------------------------------------------------------------
// System audio (ScreenCaptureKit) — macOS only
// ---------------------------------------------------------------------------

struct SystemAudioCapture {
    handle: *mut std::ffi::c_void,
    ctx: *mut std::ffi::c_void,
}

/// Shared with ScreenCaptureKit callback — append + peak envelope.
struct SystemAudioCtx {
    samples: Arc<Mutex<Vec<f32>>>,
    live_meter: Arc<LiveMeter>,
}

unsafe impl Send for SystemAudioCapture {}

impl SystemAudioCapture {
    fn start(
        samples: Arc<Mutex<Vec<f32>>>,
        live_meter: Arc<LiveMeter>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (samples, live_meter);
            Err("system audio capture is macOS-only".into())
        }
        #[cfg(target_os = "macos")]
        {
            start_system_audio_macos(samples, live_meter)
        }
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            if !self.handle.is_null() {
                unsafe { asr_system_audio_stop(self.handle as *mut AsrSystemAudioHandle) };
                self.handle = std::ptr::null_mut();
            }
            if !self.ctx.is_null() {
                unsafe {
                    drop(Box::from_raw(self.ctx as *mut SystemAudioCtx));
                }
                self.ctx = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct AsrSystemAudioHandle {
    _private: [u8; 0],
}

#[cfg(target_os = "macos")]
type AsrSystemAudioCallback =
    Option<unsafe extern "C" fn(samples: *const f32, count: usize, ctx: *mut std::ffi::c_void)>;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn asr_system_audio_start(
        callback: AsrSystemAudioCallback,
        ctx: *mut std::ffi::c_void,
        err_buf: *mut std::os::raw::c_char,
        err_buf_len: usize,
    ) -> *mut AsrSystemAudioHandle;

    fn asr_system_audio_stop(handle: *mut AsrSystemAudioHandle);
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn system_audio_callback(
    samples: *const f32,
    count: usize,
    ctx: *mut std::ffi::c_void,
) {
    if samples.is_null() || count == 0 || ctx.is_null() {
        return;
    }
    let ctx = &*(ctx as *const SystemAudioCtx);
    let slice = std::slice::from_raw_parts(samples, count);
    let peak = slice.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
    if let Ok(mut buf) = ctx.samples.lock() {
        buf.extend_from_slice(slice);
    }
    ctx.live_meter.observe_peak(peak);
}

#[cfg(target_os = "macos")]
fn start_system_audio_macos(
    samples: Arc<Mutex<Vec<f32>>>,
    live_meter: Arc<LiveMeter>,
) -> Result<SystemAudioCapture, Box<dyn std::error::Error>> {
    // Avoid TCC abort on `tauri dev` naked binary (no Info.plist merge).
    unsafe extern "C" {
        fn asr_tcc_has_screen_capture_usage_description() -> bool;
    }
    if !unsafe { asr_tcc_has_screen_capture_usage_description() } {
        return Err(
            "系统音频需要打包后的 .app（含 NSScreenCaptureUsageDescription）。\
             tauri dev 裸二进制会闪退；请改用「只录外部」，或 `tauri build` 后用 .app 测试系统音频。"
                .into(),
        );
    }

    let boxed = Box::new(SystemAudioCtx {
        samples,
        live_meter,
    });
    let ctx = Box::into_raw(boxed) as *mut std::ffi::c_void;
    let ctx_addr = ctx as usize;

    let result = std::thread::Builder::new()
        .name("system-audio-start".into())
        .spawn(move || {
            let ctx = ctx_addr as *mut std::ffi::c_void;
            let mut err = vec![0i8; 512];
            let handle = unsafe {
                asr_system_audio_start(
                    Some(system_audio_callback),
                    ctx,
                    err.as_mut_ptr(),
                    err.len(),
                )
            };
            if handle.is_null() {
                unsafe {
                    drop(Box::from_raw(ctx as *mut SystemAudioCtx));
                }
                let msg = unsafe { std::ffi::CStr::from_ptr(err.as_ptr()) }
                    .to_string_lossy()
                    .into_owned();
                return Err(msg);
            }
            Ok(SystemAudioCapture {
                handle: handle as *mut std::ffi::c_void,
                ctx,
            })
        })?
        .join()
        .map_err(|_| "system audio start thread panicked".to_string())??;

    Ok(result)
}

/// Convert a chunk of interleaved f32 samples to 16kHz mono and append to buffer.
fn process_chunk(
    data: &[f32],
    source_sr: usize,
    source_channels: usize,
    downsampler: &mut Option<Downsampler>,
    out: &Arc<Mutex<Vec<f32>>>,
    meter: &LiveMeter,
) {
    let mono: Vec<f32> = if source_channels == 1 {
        data.to_vec()
    } else {
        data.chunks_exact(source_channels)
            .map(|frame| frame.iter().sum::<f32>() / source_channels as f32)
            .collect()
    };

    let resampled = if source_sr == TARGET_SR {
        mono
    } else {
        // Lazily build the anti-aliased downsampler per stream (carries
        // filter state across chunks); see Downsampler for why linear
        // interpolation was not good enough.
        let ds = downsampler.get_or_insert_with(|| Downsampler::new(source_sr, TARGET_SR));
        ds.process(&mono)
    };

    let peak = resampled
        .iter()
        .map(|s| s.abs())
        .fold(0.0_f32, f32::max);
    if let Ok(mut buf) = out.lock() {
        buf.extend_from_slice(&resampled);
    }
    // Lock-free envelope — never waits on ASR PCM clones.
    meter.observe_peak(peak);

    // Wake mlx-worker if waiting for new audio data.
    let (lock, cvar) = &**super::audio_chunk_notify();
    if let Ok(mut ready) = lock.lock() {
        *ready = true;
    }
    cvar.notify_one();
}

/// Anti-aliased arbitrary-ratio downsampler (windowed-sinc FIR).
///
/// The previous plain linear interpolation has zero attenuation at the
/// Nyquist of the *output* rate: decimating 48k→16k folds everything above
/// 8kHz (sibilants s/sh, plosive attacks) straight back into the speech band
/// as aliasing noise — measurable recognition damage on exactly the
/// consonants ASR confuses. A 33-tap Blackman-windowed sinc low-pass at
/// ~0.9× output Nyquist lands ~-60dB in the stopband; nearest-tap sampling
/// of the kernel is ≈-40dB accurate, far past what matters for ASR.
/// Filter state carries across chunks, so output is seamless.
struct Downsampler {
    step: f64, // input samples per output sample
    taps: Vec<f32>,
    half: usize,
    history: Vec<f32>, // last 2*half input samples
    src_pos: f64,      // absolute input index of next output sample
    in_total: usize,   // total input samples seen
}

impl Downsampler {
    fn new(from_sr: usize, to_sr: usize) -> Self {
        // 63-tap kernel: the extra length halves the transition band so the
        // speech band (≤4kHz) stays flat while the passband edge sits at
        // 0.9× output Nyquist. ~2M MAC/s at 16k out — trivial even on the
        // capture callback thread.
        let half = 32;
        let cutoff = 0.9 * to_sr as f64 / from_sr as f64; // norm. to input Nyquist
        let mut taps: Vec<f32> = (0..=2 * half)
            .map(|k| {
                let t = k as f64 - half as f64;
                // Low-pass sinc (Nyquist-normalised cutoff), DC gain ~1:
                // h(t) = fc·sinc(fc·t), h(0) = fc.
                let sinc = if t.abs() < 1e-9 {
                    cutoff
                } else {
                    (std::f64::consts::PI * cutoff * t).sin() / (std::f64::consts::PI * t)
                };
                // Blackman window
                let w = 0.42
                    - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (2.0 * half as f64)).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * k as f64 / (2.0 * half as f64)).cos();
                (sinc * w) as f32
            })
            .collect();
        // Normalise DC gain to exactly 1.
        let sum: f32 = taps.iter().sum();
        if sum.abs() > 1e-6 {
            for t in taps.iter_mut() {
                *t /= sum;
            }
        }
        Self {
            step: from_sr as f64 / to_sr as f64,
            taps,
            half,
            history: Vec::new(),
            src_pos: half as f64, // start centred: group delay aligned
            in_total: 0,
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        let hist_len = self.history.len();
        // Absolute input index of combined[0] (history precedes input).
        let base = (self.in_total - hist_len) as f64;
        let last_abs = (self.in_total + input.len() - 1) as f64;
        let half = self.half as f64;
        let mut out =
            Vec::with_capacity((input.len() as f64 / self.step).ceil() as usize + 4);
        let mut guard = 0usize;
        while self.src_pos + half <= last_abs && guard < input.len() + 8 {
            let mut acc = 0.0f32;
            for (k, tap) in self.taps.iter().enumerate() {
                let abs = self.src_pos - half + k as f64;
                acc += tap * combined_sample(&self.history, input, base, abs);
            }
            out.push(acc);
            self.src_pos += self.step;
            guard += 1;
        }
        self.in_total += input.len();
        // Carry the tail the next chunk's kernel window will need.
        let keep = 2 * self.half;
        let combined_len = hist_len + input.len();
        if combined_len >= keep {
            let start = combined_len - keep;
            let mut tail = Vec::with_capacity(keep);
            if start < hist_len {
                tail.extend_from_slice(&self.history[start..]);
                tail.extend_from_slice(input);
            } else {
                tail.extend_from_slice(&input[start - hist_len..]);
            }
            self.history = tail;
        } else {
            self.history.extend_from_slice(input);
        }
        out
    }
}

/// Sample lookup across the history+input boundary at absolute index `abs`.
fn combined_sample(history: &[f32], input: &[f32], base: f64, abs: f64) -> f32 {
    let idx = (abs - base).round() as isize;
    if idx < 0 {
        return history.first().copied().unwrap_or(0.0);
    }
    let idx = idx as usize;
    if idx < history.len() {
        history[idx]
    } else {
        input.get(idx - history.len()).copied().unwrap_or(0.0)
    }
}

fn meter_from_slice(slice: &[f32]) -> f32 {
    if slice.is_empty() {
        return 0.0;
    }
    let peak = slice.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
    let energy = slice.iter().map(|s| s * s).sum::<f32>() / slice.len() as f32;
    let rms = energy.sqrt();
    let raw = peak.max(rms * 1.6);
    if raw < 0.000_8 {
        return 0.0;
    }
    let boosted = (raw * 48.0).clamp(0.0, 2.2);
    boosted.powf(0.45).clamp(0.0, 1.0)
}

fn goertzel_mag(samples: &[f32], freq_hz: f32, sample_rate: f32) -> f32 {
    if samples.is_empty() || freq_hz <= 0.0 || freq_hz >= sample_rate * 0.5 {
        return 0.0;
    }
    let w = std::f32::consts::TAU * (freq_hz / sample_rate);
    let coeff = 2.0 * w.cos();
    let mut s0 = 0.0_f32;
    let mut s1 = 0.0_f32;
    let mut s2 = 0.0_f32;
    for &x in samples {
        s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    (power.max(0.0).sqrt() / samples.len() as f32) * 18.0
}

fn goertzel_bands(samples: &[f32], sample_rate: f32, band_count: usize) -> Vec<f32> {
    let n = band_count.max(1);
    let f_lo = 80.0_f32;
    let f_hi = 3800.0_f32;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = if n == 1 {
            0.0
        } else {
            i as f32 / (n - 1) as f32
        };
        let freq = f_lo * (f_hi / f_lo).powf(t);
        let mag = goertzel_mag(samples, freq, sample_rate);
        out.push(mag.powf(0.55).clamp(0.0, 1.0));
    }
    if n >= 3 {
        let mut blurred = out.clone();
        for i in 1..n - 1 {
            blurred[i] = out[i - 1] * 0.18 + out[i] * 0.64 + out[i + 1] * 0.18;
        }
        out = blurred;
    }
    out
}

#[cfg(test)]
mod downsample_tests {
    use super::*;

    fn sine(f: f64, sr: usize, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / sr as f64).sin() as f32)
            .collect()
    }

    fn rms(v: &[f32]) -> f32 {
        if v.is_empty() {
            return 0.0;
        }
        (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt()
    }

    /// 48k→16k: speech-band (1kHz) passes near unity; above output Nyquist
    /// (12kHz) must be strongly suppressed — the aliasing the old linear
    /// interpolator folded straight into the band.
    #[test]
    fn antialias_passband_and_stopband() {
        let mut ds = Downsampler::new(48_000, 16_000);
        // Warm-up block to fill history; measure on the second block.
        let _ = ds.process(&sine(1000.0, 48_000, 4800));
        let speech = ds.process(&sine(1000.0, 48_000, 4800));
        // Unit-amplitude sine has rms 1/√2 ≈ 0.707 — allow a little passband droop.
        assert!(
            rms(&speech) > 0.66,
            "1kHz should pass ~unity, got {}",
            rms(&speech)
        );

        let mut ds2 = Downsampler::new(48_000, 16_000);
        let _ = ds2.process(&sine(12_000.0, 48_000, 4800));
        let hiss = ds2.process(&sine(12_000.0, 48_000, 4800));
        assert!(rms(&hiss) < 0.05, "12kHz should be suppressed, got {}", rms(&hiss));
    }

    /// Chunk-streaming continuity: splitting the input must produce the same
    /// output as one block (filter state carries across process() calls).
    #[test]
    fn chunked_equals_whole() {
        let input = sine(700.0, 48_000, 9600);
        let mut whole = Downsampler::new(48_000, 16_000);
        let a = whole.process(&input);

        let mut split = Downsampler::new(48_000, 16_000);
        let mut b = split.process(&input[..4000]).to_vec();
        b.extend(split.process(&input[4000..8000]));
        b.extend(split.process(&input[8000..]));

        // Compare the overlapping region (whole may emit one extra warm-up sample).
        let n = a.len().min(b.len());
        let diff: f32 = (0..n).map(|i| (a[i] - b[i]).abs()).fold(0.0, f32::max);
        assert!(diff < 1e-4, "chunked vs whole diverged: {diff}");
    }
}
