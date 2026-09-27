/**
 * Short confirmation sounds, synthesised rather than loaded.
 *
 * A generated tone needs no audio file to ship, upload or cache, works with the
 * app offline, and adds nothing to the bundle. The click is deliberately quiet
 * and brief: it confirms a tap that the user may not be looking at, and it
 * plays immediately before spoken text, so it must not compete with the voice.
 */

class Feedback {
  constructor() {
    this.context = null;
    this.enabled = true;
  }

  isSupported() {
    return typeof window !== 'undefined' && Boolean(window.AudioContext ?? window.webkitAudioContext);
  }

  /**
   * Creates and unlocks the audio context.
   *
   * Must be called from inside a real user gesture: mobile browsers start every
   * context suspended, and a context first created outside a gesture stays
   * silent for the life of the page. The session's Start button is the hook.
   */
  prime() {
    if (!this.isSupported()) return;

    try {
      if (!this.context) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        this.context = new Ctor();
      }
      if (this.context.state === 'suspended') {
        this.context.resume().catch(() => {});
      }
    } catch {
      // No audio: the app is fully usable without it.
      this.context = null;
    }
  }

  /** A soft wooden "tock" confirming a tap. */
  tap() {
    this.play({ from: 660, to: 440, durationMs: 90, peak: 0.16 });
  }

  play({ from, to, durationMs, peak }) {
    if (!this.enabled) return;

    this.prime();
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;

    try {
      const now = ctx.currentTime;
      const seconds = durationMs / 1000;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      // Triangle rather than sine: a touch more body, so it carries through
      // road noise and headphones without needing to be loud.
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(from, now);
      oscillator.frequency.exponentialRampToValueAtTime(to, now + seconds);

      // Fast attack, exponential decay — a click, not a beep. Ramps never reach
      // exactly zero because exponentialRamp cannot target 0.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(now);
      oscillator.stop(now + seconds + 0.02);
    } catch {
      // Never let feedback break a study session.
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }
}

export const feedback = new Feedback();
