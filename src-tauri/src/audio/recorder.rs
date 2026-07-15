//! Audio capture for ASR.
//!
//! Modes:
//! - `external`: microphone via cpal (default)
//! - `system`: macOS system/speaker audio via ScreenCaptureKit
//! - `both`: mix mic + system
//!
//! All paths deliver 16 kHz mono f32 into shared buffers.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::{Deserialize, Serialize};

/// Target sample rate for ASR.
const TARGET_SR: usize = 16_000;

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

/// Active audio recorder. Drop streams / system capture to stop.
pub struct AudioRecorder {
    /// Mic stream (cpal) — present for External / Both.
    _mic_stream: Option<cpal::Stream>,
    /// System-audio capture handle — present for System / Both (macOS).
    _system: Option<SystemAudioCapture>,
    mic_samples: Arc<Mutex<Vec<f32>>>,
    system_samples: Arc<Mutex<Vec<f32>>>,
    mode: AudioCaptureMode,
    /// Human-readable reason when system capture was dropped.
    pub fallback_warning: Option<String>,
}

impl AudioRecorder {
    pub fn start(mode: AudioCaptureMode) -> Result<Self, Box<dyn std::error::Error>> {
        let mic_samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let system_samples = Arc::new(Mutex::new(Vec::<f32>::new()));

        let want_mic = matches!(mode, AudioCaptureMode::External | AudioCaptureMode::Both);
        let want_system = matches!(mode, AudioCaptureMode::System | AudioCaptureMode::Both);

        let mut mic_stream = if want_mic {
            Some(start_mic_stream(mic_samples.clone())?)
        } else {
            None
        };

        let (system, effective_mode, fallback_warning) = if want_system {
            match SystemAudioCapture::start(system_samples.clone()) {
                Ok(cap) => (Some(cap), mode, None),
                Err(err) => {
                    // Screen-recording TCC denied / unavailable: keep going on mic
                    // even when the user picked「只录系统」— better than hard-fail.
                    let msg = format!(
                        "系统音频不可用（{err}），已退回只录麦克风。需要录系统声时请到「设置 → 权限」授予屏幕录制。"
                    );
                    eprintln!("[audio] {msg}");
                    if mic_stream.is_none() {
                        match start_mic_stream(mic_samples.clone()) {
                            Ok(stream) => mic_stream = Some(stream),
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

        eprintln!(
            "[audio] capture mode={} (effective={})",
            mode.as_str(),
            effective_mode.as_str()
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
    eprintln!(
        "[audio] mic device: {:?}, format: {:?}, sample_rate: {}Hz, channels: {}",
        device.name().unwrap_or_default(),
        sample_format,
        actual_sr,
        actual_channels,
    );

    let samples_cb = samples.clone();
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                process_chunk(data, actual_sr, actual_channels, &samples_cb);
            },
            |err| eprintln!("[audio] mic capture error: {}", err),
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                process_chunk(&f32_data, actual_sr, actual_channels, &samples_cb);
            },
            |err| eprintln!("[audio] mic capture error: {}", err),
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                let f32_data: Vec<f32> = data
                    .iter()
                    .map(|&s| (s as f32 - 32768.0) / 32768.0)
                    .collect();
                process_chunk(&f32_data, actual_sr, actual_channels, &samples_cb);
            },
            |err| eprintln!("[audio] mic capture error: {}", err),
            None,
        )?,
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

unsafe impl Send for SystemAudioCapture {}

impl SystemAudioCapture {
    fn start(samples: Arc<Mutex<Vec<f32>>>) -> Result<Self, Box<dyn std::error::Error>> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = samples;
            Err("system audio capture is macOS-only".into())
        }
        #[cfg(target_os = "macos")]
        {
            start_system_audio_macos(samples)
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
                    drop(Box::from_raw(self.ctx as *mut Arc<Mutex<Vec<f32>>>));
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
    let arc = &*(ctx as *const Arc<Mutex<Vec<f32>>>);
    let slice = std::slice::from_raw_parts(samples, count);
    if let Ok(mut buf) = arc.lock() {
        buf.extend_from_slice(slice);
    }
}

#[cfg(target_os = "macos")]
fn start_system_audio_macos(
    samples: Arc<Mutex<Vec<f32>>>,
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

    let boxed = Box::new(samples);
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
                    drop(Box::from_raw(ctx as *mut Arc<Mutex<Vec<f32>>>));
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
    out: &Arc<Mutex<Vec<f32>>>,
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
        linear_resample(&mono, source_sr, TARGET_SR)
    };

    if let Ok(mut buf) = out.lock() {
        buf.extend_from_slice(&resampled);
    }
}

fn linear_resample(input: &[f32], from_sr: usize, to_sr: usize) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    let ratio = to_sr as f64 / from_sr as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;
        let s0 = input[idx];
        let s1 = if idx + 1 < input.len() {
            input[idx + 1]
        } else {
            input[idx]
        };
        out.push(s0 * (1.0 - frac as f32) + s1 * frac as f32);
    }

    out
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
