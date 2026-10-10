# Architecture invariants

- MLX is thread-bound: initialize MLX, load/warm the model, and run every inference on the same owner thread. Never put `AsrInference` behind a cross-thread mutex.
- Native audio handles are thread-bound: CPAL and ScreenCaptureKit handles are created and dropped by `audio-capture-owner`; shared app state only holds the Send-safe PCM/control facade.
- Agent stdout is an incremental stream: emit `agent-job-stream` deltas, checkpoint at most every 2 seconds, and emit/persist the full job only at lifecycle boundaries.
- Persistent JSON is written as a compact atomic snapshot (temp file → flush/sync → replace), and serialization/I/O must happen outside state mutexes.
- Frontend config auto-save stays disabled until `get_app_config` hydrates successfully. Treat `config-updated` as a persisted snapshot/ack; never feed it back into another save or let a stale ack overwrite pending local edits.
- Tauri windows share `index.html` but React entry modules are lazy. Create `floating-lang` and `floating-agent-menu` only when first used.
- HUD paste runs native `orderOut` and Cmd+V in one main-thread callback. Do not insert fades, window-message dispatch, persistence, or frontend acknowledgements between them; queued show/fade callbacks must respect dismissal.
- Fn counting starts after the HUD appears: first Fn stops recording and runs `ASR → refine → optional organize → edit`; the second Fn immediately accepts the available text, closing HUD natively before paste. Summoning HUD is not one of these two presses. Confirmation must not wait for LLM completion; invalidate late finalization so it cannot repaste or reopen HUD. Organize depends on refine; refine never depends on organize.
- Errors on model warmup, persistence, stream reads, and worker ownership are observable; do not silently replace failures with empty state.
- Works（作品）folders are the source of truth: `transcript.json` is written once and never edited by AI paths. Artifacts (`notes/*.md`) and research (`research/<job>.md`) are derived from it. `work.json` is only an index; read-modify-write it outside state mutexes, using the atomic snapshot.
- Cloud ASR (`transcription/cloud.rs`) is a network call on the command thread (`spawn_blocking`), never on mlx-worker. Every provider normalizes to `TranscriptionResult`, so downstream works/pipeline code stays provider-agnostic.
- Works research runs through `dispatch_agent_impl(navigate=false, remember_cwd=false)` with cwd `research/`. The agent thread calls `works::research::on_job_finished` after each terminal job update, and `start` re-checks the job. That hook must stay idempotent.
- Timestamp anchors in AI output (`[mm:ss]`) are rendered as seek links (`linkifyTimestamps` → `#t=` hrefs) and only work inside `TranscriptViewer.Root`. Keep work panes rendered inside that root so the media column stays in view.
