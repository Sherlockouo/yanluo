# Architecture invariants

- MLX is thread-bound: initialize MLX, load/warm the model, and run every inference on the same owner thread. Never put `AsrInference` behind a cross-thread mutex.
- Native audio handles are thread-bound: CPAL and ScreenCaptureKit handles are created and dropped by `audio-capture-owner`; shared app state only holds the Send-safe PCM/control facade.
- Agent stdout is an incremental stream: emit `agent-job-stream` deltas, checkpoint at most every 2 seconds, and emit/persist the full job only at lifecycle boundaries.
- Persistent JSON is written as a compact atomic snapshot (temp file → flush/sync → replace), and serialization/I/O must happen outside state mutexes.
- Frontend config auto-save stays disabled until `get_app_config` hydrates successfully. Treat `config-updated` as a persisted snapshot/ack; never feed it back into another save or let a stale ack overwrite pending local edits.
- Tauri windows share `index.html` but React entry modules are lazy. Create `floating-lang` and `floating-agent-menu` only when first used.
- HUD paste runs native `orderOut` and Cmd+V in one main-thread callback. Do not insert fades, window-message dispatch, persistence, or frontend acknowledgements between them; queued show/fade callbacks must respect dismissal.
- Fn text pipeline is ordered `ASR → refine → optional organize → edit/paste`. A quick second Fn requests auto-paste after enabled LLM stages; it must not cancel or bypass them. Organize depends on refine being enabled, while refine never depends on organize.
- Errors on model warmup, persistence, stream reads, and worker ownership are observable; do not silently replace failures with empty state.
