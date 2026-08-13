/**
 * Quiet UI sound design — Arc-adjacent warmth, original synthesis (no asset files).
 * Opacity of presence: soft, short, interruptible. Never gamey.
 */

export type SfxId =
  | "boot"
  | "hudShow"
  | "hudHide"
  | "uiTap"
  | "success"
  | "tourStep";

const SFX_STORAGE_KEY = "yanluo-sfx";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function prefersQuietVisual(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function readSfxEnabled(): boolean {
  try {
    const v = localStorage.getItem(SFX_STORAGE_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

export function setSfxEnabled(on: boolean) {
  try {
    localStorage.setItem(SFX_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(
    new CustomEvent("yanluo:sfx-enabled", { detail: { enabled: on } }),
  );
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

/** Unlock audio on first pointer (needed in some WebViews). */
export function unlockSfx() {
  const c = ensureCtx();
  if (!c) return;
  void c.resume().catch(() => {});
}

/** Pre-create the AudioContext (module load) so the first hudShow doesn't pay
 * construction + WKWebView warmup inside the show critical path. May stay
 * suspended until a gesture — that's fine, only the object cost is front-loaded. */
export function warmSfx() {
  ensureCtx();
}

function envGain(
  c: AudioContext,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

function tone(
  c: AudioContext,
  dest: AudioNode,
  opts: {
    freq: number;
    t0: number;
    dur: number;
    peak: number;
    type?: OscillatorType;
    attack?: number;
  },
) {
  const osc = c.createOscillator();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, opts.t0);
  const attack = opts.attack ?? 0.012;
  const g = envGain(c, opts.t0, opts.peak, attack, opts.dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(opts.t0);
  osc.stop(opts.t0 + attack + opts.dur + 0.05);
}

function softNoiseWhoosh(c: AudioContext, dest: AudioNode, t0: number) {
  const seconds = 0.55;
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.4;
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(420, t0);
  filter.frequency.exponentialRampToValueAtTime(1800, t0 + 0.35);
  filter.Q.value = 0.7;
  const g = envGain(c, t0, 0.045, 0.04, 0.45);
  src.connect(filter);
  filter.connect(g);
  g.connect(dest);
  src.start(t0);
  src.stop(t0 + seconds);
}

function playBoot(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime + 0.02;
  softNoiseWhoosh(c, dest, t0);
  // Warm rising chime — original, Arc-adjacent softness.
  tone(c, dest, { freq: 392, t0: t0 + 0.08, dur: 0.9, peak: 0.09, type: "sine" });
  tone(c, dest, { freq: 523.25, t0: t0 + 0.18, dur: 1.0, peak: 0.11, type: "triangle", attack: 0.02 });
  tone(c, dest, { freq: 659.25, t0: t0 + 0.32, dur: 1.15, peak: 0.07, type: "sine", attack: 0.03 });
  tone(c, dest, { freq: 783.99, t0: t0 + 0.48, dur: 1.3, peak: 0.035, type: "sine", attack: 0.04 });
}

function playHudShow(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime;
  tone(c, dest, { freq: 660, t0, dur: 0.18, peak: 0.05, type: "sine" });
  tone(c, dest, { freq: 880, t0: t0 + 0.04, dur: 0.22, peak: 0.035, type: "triangle" });
}

function playHudHide(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime;
  tone(c, dest, { freq: 720, t0, dur: 0.14, peak: 0.035, type: "sine" });
  tone(c, dest, { freq: 480, t0: t0 + 0.03, dur: 0.18, peak: 0.028, type: "triangle" });
}

function playUiTap(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime;
  tone(c, dest, { freq: 920, t0, dur: 0.06, peak: 0.025, type: "sine", attack: 0.004 });
}

function playSuccess(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime;
  tone(c, dest, { freq: 523.25, t0, dur: 0.35, peak: 0.06, type: "sine" });
  tone(c, dest, { freq: 659.25, t0: t0 + 0.06, dur: 0.4, peak: 0.05, type: "triangle" });
  tone(c, dest, { freq: 783.99, t0: t0 + 0.12, dur: 0.5, peak: 0.04, type: "sine" });
}

function playTourStep(c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime;
  tone(c, dest, { freq: 740, t0, dur: 0.12, peak: 0.03, type: "sine", attack: 0.006 });
}

export function playSfx(id: SfxId) {
  if (!readSfxEnabled()) return;
  if (id === "boot" && prefersQuietVisual()) {
    // Still allow a quieter boot under reduced motion.
  }
  const c = ensureCtx();
  if (!c || !master) return;
  const dest = master;
  switch (id) {
    case "boot":
      playBoot(c, dest);
      break;
    case "hudShow":
      playHudShow(c, dest);
      break;
    case "hudHide":
      playHudHide(c, dest);
      break;
    case "uiTap":
      playUiTap(c, dest);
      break;
    case "success":
      playSuccess(c, dest);
      break;
    case "tourStep":
      playTourStep(c, dest);
      break;
  }
}
