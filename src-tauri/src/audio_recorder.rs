//! Audio capture via cpal. Records from the default input device at 16kHz mono.
//!
//! Samples are accumulated in a shared `Arc<Mutex<Vec<f32>>>` so that a
//! background thread can read periodic snapshots for streaming ASR while the
//! cpal callback keeps appending data.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Active audio recorder. Drop the stream to stop recording.
pub struct AudioRecorder {
    /// Owned cpal stream — dropped in `stop()`.
    _stream: cpal::Stream,
    /// Shared sample buffer written by the cpal callback.
    samples: Arc<Mutex<Vec<f32>>>,
}

impl AudioRecorder {
    /// Start recording from the default input device. Target: 16kHz, mono, f32.
    pub fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("No input device found")?;

        let supported_configs = device.supported_input_configs()?;
        let mut config = None;

        for sc in supported_configs {
            if sc.channels() == 1
                && sc.min_sample_rate() <= cpal::SampleRate(16000)
                && sc.max_sample_rate() >= cpal::SampleRate(16000)
            {
                config = Some(sc.with_sample_rate(cpal::SampleRate(16000)));
                break;
            }
        }

        // Fallback to default config if 16kHz mono not directly supported.
        let config = config.unwrap_or_else(|| device.default_input_config().unwrap());

        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let samples_cb = samples.clone();

        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut buf) = samples_cb.lock() {
                    buf.extend_from_slice(data);
                }
            },
            |err| {
                eprintln!("Audio capture error: {}", err);
            },
            None,
        )?;

        stream.play()?;

        Ok(Self {
            _stream: stream,
            samples,
        })
    }

    /// Snapshot of currently accumulated samples (non-blocking clone).
    pub fn get_samples(&self) -> Vec<f32> {
        self.samples.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Stop recording and return all captured samples.
    pub fn stop(self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        drop(self._stream); // stop the stream first
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        Ok(samples)
    }
}
