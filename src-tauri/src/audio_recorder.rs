//! Audio capture via cpal. Records from the default input device at 16kHz mono.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Active audio recorder. Drop to stop recording.
pub struct AudioRecorder {
    /// Join handle for the capture thread. Dropping will not join — use stop().
    _stream: cpal::Stream,
    /// Receives samples from the callback.
    rx: mpsc::Receiver<f32>,
    /// Tracks whether recording is active.
    active: Arc<Mutex<bool>>,
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

        // Fallback to default config if 16kHz not supported
        let config = config.unwrap_or_else(|| device.default_input_config().unwrap());

        let (tx, rx) = mpsc::channel::<f32>();
        let active = Arc::new(Mutex::new(true));
        let active_clone = active.clone();

        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                for &sample in data {
                    if tx.send(sample).is_err() {
                        break;
                    }
                }
            },
            move |err| {
                eprintln!("Audio capture error: {}", err);
                *active_clone.lock().unwrap() = false;
            },
            None,
        )?;

        stream.play()?;

        Ok(Self {
            _stream: stream,
            rx,
            active,
        })
    }

    /// Stop recording and return all captured samples.
    pub fn stop(self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        *self.active.lock().unwrap() = false;
        drop(self._stream); // stop the stream

        let mut samples = Vec::new();
        while let Ok(s) = self.rx.try_recv() {
            samples.push(s);
        }
        Ok(samples)
    }
}
