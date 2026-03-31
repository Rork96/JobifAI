/**
 * utils/audio.ts — Web Audio API utilities
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides a lightweight "pop" sound for gamified interactions (skill gap
 * check-off, diff accepted, etc.) using only the Web Audio API — no audio
 * files, no network requests, zero bundle overhead.
 *
 * AUTOPLAY POLICY:
 *   Browsers block AudioContext creation before the first user gesture.
 *   We call `initAudioContext()` inside click/touch handlers (not on mount),
 *   which satisfies the user-gesture requirement.  Subsequent calls are no-ops
 *   because `_ctx` is already set.
 *
 * SOUNDS:
 *   playCheckSound()  — Short ascending "pop" (A5→C6) for skill gap check-off
 *   playAcceptSound() — Two-tone "ding" (C5→E5) for diff accepted
 * ─────────────────────────────────────────────────────────────────────────────
 */

let _ctx: AudioContext | null = null;

/** Initialize (or resume) the shared AudioContext.  Call inside a user gesture. */
export function initAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;  // SSR guard

  if (!_ctx) {
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    _ctx = new Ctor();
  }

  // Resume if suspended (happens when the context was created before a gesture)
  if (_ctx.state === 'suspended') {
    _ctx.resume().catch(() => { /* ignore — we'll try again next interaction */ });
  }

  return _ctx;
}

/**
 * Play a short satisfying "pop" — used when a skill gap chip is checked off.
 *
 * Waveform: sine oscillator A5 (880 Hz) → rapid exponential gain decay (0.12 s).
 * The sound is crisp, positive, and non-intrusive.
 */
export function playCheckSound(): void {
  const ctx = _ctx;
  if (!ctx || ctx.state !== 'running') return;

  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, ctx.currentTime);           // A5
  osc.frequency.exponentialRampToValueAtTime(1175, ctx.currentTime + 0.06); // D6

  gain.gain.setValueAtTime(0.18, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.14);
}

/**
 * Play a two-note "ding" — used when a diff is accepted.
 *
 * Two overlapping oscillators: C5 (523 Hz) then E5 (659 Hz), offset by 0.06 s.
 * Conveys "success" / "accepted" — like a notification chime.
 */
export function playAcceptSound(): void {
  const ctx = _ctx;
  if (!ctx || ctx.state !== 'running') return;

  const notes = [523, 659];  // C5, E5

  notes.forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    const t = ctx.currentTime + i * 0.08;
    gain.gain.setValueAtTime(0.14, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + 0.22);
  });
}
