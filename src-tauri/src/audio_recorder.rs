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
