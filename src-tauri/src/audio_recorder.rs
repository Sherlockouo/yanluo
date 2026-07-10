//! Audio capture via cpal. Records from the default input device.
//!
//! Strategy: capture at whatever sample rate / format the device supports
//! (macOS CoreAudio typically gives 48kHz f32 stereo), then convert to
//! 16kHz mono f32 inside the callback. This avoids relying on the device
//! supporting 16kHz natively (which it usually doesn't on macOS).

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

/// Target sample rate for ASR.
const TARGET_SR: usize = 16_000;

/// Active audio recorder. Drop the stream to stop recording.
pub struct AudioRecorder {
    /// Owned cpal stream — dropped in `stop()`.
    _stream: cpal::Stream,
    /// Shared sample buffer (16kHz mono f32) written by the cpal callback.
    samples: Arc<Mutex<Vec<f32>>>,
}

impl AudioRecorder {
    /// Start recording from the default input device.
    /// Audio is resampled to 16kHz mono f32 regardless of device format.
    pub fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("No input device found")?;

        // Pick the best supported config: prefer f32, prefer mono, any sample rate.
        let supported_configs = device.supported_input_configs()?;
        let mut best: Option<(cpal::SupportedStreamConfig, SampleFormat)> = None;

        for sc in supported_configs {
            let fmt = sc.sample_format();
            // Prefer f32, then i16, then u16.
            let score = match fmt {
                SampleFormat::F32 => 3,
                SampleFormat::I16 => 2,
                SampleFormat::U16 => 1,
                _ => continue,
            };
            // Prefer mono.
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
                // Use the default sample rate of this config range.
                let cfg = sc.with_max_sample_rate();
                best = Some((cfg, fmt));
            }
        }

        let (config, sample_format) =
            best.ok_or("No supported input stream configuration found")?;

        let actual_sr = config.sample_rate().0 as usize;
        let actual_channels = config.channels() as usize;
        eprintln!(
            "[audio] device: {:?}, format: {:?}, sample_rate: {}Hz, channels: {}",
            device.name().unwrap_or_default(),
            sample_format,
            actual_sr,
            actual_channels,
        );

        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let samples_cb = samples.clone();

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    process_chunk(data, actual_sr, actual_channels, &samples_cb);
                },
                |err| eprintln!("[audio] capture error: {}", err),
                None,
            )?,
            SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    process_chunk(&f32_data, actual_sr, actual_channels, &samples_cb);
                },
                |err| eprintln!("[audio] capture error: {}", err),
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
                |err| eprintln!("[audio] capture error: {}", err),
                None,
            )?,
            _ => return Err("Unsupported sample format".into()),
        };

        stream.play()?;

        Ok(Self {
            _stream: stream,
            samples,
        })
    }

    /// Snapshot of currently accumulated samples (16kHz mono f32, non-blocking clone).
    pub fn get_samples(&self) -> Vec<f32> {
        self.samples.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Live meter 0–1 from recent samples. Aggressive curve so quiet speech still moves HUD bars.
    pub fn recent_rms(&self, window: usize) -> f32 {
        let Ok(buf) = self.samples.lock() else {
            return 0.0;
        };
        let n = buf.len().min(window.max(1));
        if n == 0 {
            return 0.0;
        }
        let start = buf.len() - n;
        meter_from_slice(&buf[start..])
    }

    /// Log-spaced speech bands via Goertzel (Apple Music–style spectrum, ~80Hz–4kHz).
    pub fn recent_bands(&self, band_count: usize, window: usize) -> (f32, Vec<f32>) {
        let Ok(buf) = self.samples.lock() else {
            return (0.0, vec![0.0; band_count]);
        };
        let n = buf.len().min(window.max(1));
        if n == 0 {
            return (0.0, vec![0.0; band_count]);
        }
        let start = buf.len() - n;
        let slice = &buf[start..];
        let rms = meter_from_slice(slice);
        let bands = goertzel_bands(slice, TARGET_SR as f32, band_count);
        (rms, bands)
    }

    /// Stop recording and return all captured samples (16kHz mono f32).
    pub fn stop(self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        drop(self._stream); // stop the stream first
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        Ok(samples)
    }
}

/// Convert a chunk of interleaved f32 samples to 16kHz mono and append to buffer.
fn process_chunk(
    data: &[f32],
    source_sr: usize,
    source_channels: usize,
    out: &Arc<Mutex<Vec<f32>>>,
) {
    // 1. Downmix to mono (average all channels).
    let mono: Vec<f32> = if source_channels == 1 {
        data.to_vec()
    } else {
        data.chunks_exact(source_channels)
            .map(|frame| frame.iter().sum::<f32>() / source_channels as f32)
            .collect()
    };

    // 2. Resample to 16kHz via linear interpolation.
    let resampled = if source_sr == TARGET_SR {
        mono
    } else {
        linear_resample(&mono, source_sr, TARGET_SR)
    };

    // 3. Append to shared buffer.
    if let Ok(mut buf) = out.lock() {
        buf.extend_from_slice(&resampled);
    }
}

/// Simple linear interpolation resampler. Good enough for speech —
/// the mel spectrogram is robust to minor interpolation artifacts.
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

/// Goertzel magnitude at one frequency (normalized roughly to 0–1 for speech).
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

/// Log-spaced bands across speech range (bass → presence), soft-knee to 0–1.
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
    // Light neighbor blur so the spectrum feels continuous (Music-like).
    if n >= 3 {
        let mut blurred = out.clone();
        for i in 1..n - 1 {
            blurred[i] = out[i - 1] * 0.18 + out[i] * 0.64 + out[i + 1] * 0.18;
        }
        out = blurred;
    }
    out
}
