/**
 * The single seam between the app and any speech engine.
 *
 * Nothing else may call SpeechSynthesis or SpeechRecognition directly. When a
 * cloud voice (ElevenLabs, Google, OpenAI) replaces the browser engine in a
 * later phase, only this file changes.
 *
 * Browser realities this works around, all noted in the roadmap:
 *  - iOS Safari refuses to speak unless the first utterance follows a user
 *    gesture. `prime()` must be called from a tap handler before any session.
 *  - SpeechRecognition is Chrome-family only. `canListen()` reports honestly so
 *    the UI can offer typed entry instead of hiding the feature.
 *  - iOS silences audio when the screen locks, which breaks the driving case.
 */

import { api } from './ApiClient.js';

/**
 * Resolved on each use rather than captured at module load: some browsers
 * define the constructor late, and looking it up lazily also lets tests
 * substitute a fake recognizer without a microphone.
 */
function recognitionImpl() {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

export class SpeechService {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    this.primed = false;
    this.recognition = null;
    this.voices = [];

    /** The <audio> element cloud playback runs through, created on first use. */
    this.audio = null;
    /** Object URLs for audio already fetched this session, keyed by request. */
    this.cloudCache = new Map();

    // Voices load asynchronously in most browsers, and are simply empty on the
    // first call. Re-read them whenever the browser says the list changed.
    if (this.synth) {
      this.loadVoices();
      this.synth.addEventListener?.('voiceschanged', () => this.loadVoices());
    }
  }

  canSpeak() {
    return Boolean(this.synth);
  }

  canListen() {
    return Boolean(recognitionImpl());
  }

  isAvailable() {
    return this.canSpeak();
  }

  loadVoices() {
    this.voices = this.synth?.getVoices?.() ?? [];
    return this.voices;
  }

  /**
   * Voices whose language matches a BCP-47 tag, best match first.
   *
   * "Best" means the exact region wins: an es-MX deck read by a Castilian voice
   * is understandable but wrong, and devices very often carry both. Falling
   * back to the base language is still right — a Mexican deck on a device with
   * only Peninsular Spanish should be read in Spanish, not in English.
   */
  voicesFor(lang) {
    if (!lang) return this.voices;

    const wanted = lang.toLowerCase().replace('_', '-');
    const base = wanted.split('-')[0];

    return this.voices
      .filter((voice) => voice.lang?.toLowerCase().replace('_', '-').startsWith(base))
      .sort((a, b) => regionScore(b, wanted) - regionScore(a, wanted));
  }

  /** True when this device can actually read the language aloud. */
  canSpeakLanguage(lang) {
    if (this.voices.length === 0) this.loadVoices();
    return this.voicesFor(lang).length > 0;
  }

  /**
   * Resolves a stored voiceURI back to a voice.
   *
   * Returns undefined when the voice is not installed on this device, which is
   * normal rather than exceptional: settings sync by deck, voices do not, and a
   * voice chosen on a Mac simply will not exist on an Android phone. The caller
   * then falls back to the language default, so a missing voice is silent in
   * the good sense — it changes which voice speaks, never whether one does.
   */
  voiceByUri(uri) {
    if (!uri) return undefined;

    // Voices can still be loading on the first render after a reload.
    if (this.voices.length === 0) this.loadVoices();

    return this.voices.find((voice) => voice.voiceURI === uri);
  }

  /**
   * Unlocks audio on iOS. Must be called synchronously inside a real user
   * gesture — a click handler, not a useEffect. Speaking an empty utterance is
   * the standard trick: it satisfies the gesture requirement inaudibly.
   */
  prime() {
    if (this.primed) return;

    try {
      const utterance = new SpeechSynthesisUtterance('');
      utterance.volume = 0;
      this.synth?.speak(utterance);
      this.synth?.cancel();
    } catch {
      // A browser that throws here simply will not speak; the UI degrades to text.
    }

    try {
      // Cloud playback goes through an <audio> element, which needs the same
      // gesture unlock as the synthesiser on iOS — and it has to happen on the
      // element that will actually play, not a throwaway one.
      const audio = this.audioElement();
      audio.muted = true;
      audio.play().then(
        () => { audio.pause(); audio.muted = false; },
        () => { audio.muted = false; },
      );
    } catch {
      // Same as above: the page still works, it just may not make noise.
    }

    this.primed = true;
  }

  /**
   * Speaks text and resolves when the utterance finishes.
   *
   * Resolves rather than rejects when speech is unavailable or interrupted, so
   * a study loop awaiting it never stalls on a silent device.
   *
   * @returns {Promise<{ spoken: boolean, reason?: string }>}
   */
  speak(text, { lang = 'en-US', rate = 1, pitch = 1, voice = null, signal, cloud = null } = {}) {
    if (!text?.trim()) {
      return Promise.resolve({ spoken: false, reason: 'unavailable' });
    }

    // Cloud first when asked for: it is the only path that can read a language
    // this device has no voice installed for, which is most of them.
    if (cloud) {
      return this.speakViaCloud(text, { rate, signal, voice: cloud.voice })
        // A network hiccup should not silence a study session. The browser
        // voice is worse for this language — that is why cloud was chosen —
        // but worse is better than nothing.
        .catch(() => this.speakLocally(text, { lang, rate, pitch, voice, signal }));
    }

    return this.speakLocally(text, { lang, rate, pitch, voice, signal });
  }

  speakLocally(text, { lang = 'en-US', rate = 1, pitch = 1, voice = null, signal } = {}) {
    if (!this.synth) {
      return Promise.resolve({ spoken: false, reason: 'unavailable' });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = clamp(rate, 0.1, 10);
      utterance.pitch = clamp(pitch, 0, 2);

      const chosen = voice ?? this.voicesFor(lang)[0];
      if (chosen) utterance.voice = chosen;

      utterance.onend = () => finish({ spoken: true });
      utterance.onerror = (event) =>
        // 'interrupted' and 'canceled' are what cancel() produces; not failures.
        finish({ spoken: false, reason: event?.error ?? 'error' });

      if (signal) {
        if (signal.aborted) {
          finish({ spoken: false, reason: 'aborted' });
          return;
        }
        signal.addEventListener('abort', () => {
          this.cancel();
          finish({ spoken: false, reason: 'aborted' });
        }, { once: true });
      }

      // Chrome drops utterances queued while a previous one is still speaking.
      this.synth.cancel();
      this.synth.speak(utterance);
    });
  }

  /**
   * Plays server-synthesised audio and resolves when it finishes.
   *
   * One shared <audio> element rather than one per utterance: browsers limit
   * how many media elements can play, and reusing one means the previous
   * utterance is replaced rather than layered when a session moves on quickly.
   */
  async speakViaCloud(text, { rate = 1, voice = null, signal } = {}) {
    const url = await this.cloudAudioUrl(text, rate, voice);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const audio = this.audioElement();
      const onEnded = () => finish({ spoken: true });
      const onError = () => finish({ spoken: false, reason: 'error' });
      const onAbort = () => { this.cancel(); finish({ spoken: false, reason: 'aborted' }); };

      function cleanup() {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      }

      if (signal?.aborted) {
        finish({ spoken: false, reason: 'aborted' });
        return;
      }

      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });

      audio.src = url;
      audio.playbackRate = 1; // the speed is baked into the synthesis
      audio.play().catch(() => finish({ spoken: false, reason: 'blocked' }));
    });
  }

  /** Warms the cache for text that is about to be needed, without playing it. */
  prefetch(text, { rate = 1, voice = null } = {}) {
    if (!text?.trim()) return Promise.resolve();

    // Failures are irrelevant here: the real request will surface them.
    return this.cloudAudioUrl(text, rate, voice).catch(() => {});
  }

  async cloudAudioUrl(text, rate, voice) {
    const key = `${voice ?? ''}|${rate}|${text}`;
    const cached = this.cloudCache.get(key);
    if (cached) return cached;

    const blob = await api.synthesiseSpeech({ text, voice, speed: rate });
    const url = URL.createObjectURL(blob);

    // Cards repeat constantly within a session; this keeps the second reading
    // instant and costs one blob per distinct utterance.
    this.cloudCache.set(key, url);

    return url;
  }

  audioElement() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  cancel() {
    try {
      this.synth?.cancel();
    } catch {
      // Nothing to cancel.
    }

    try {
      if (this.audio && !this.audio.paused) {
        this.audio.pause();
        this.audio.currentTime = 0;
      }
    } catch {
      // Nothing playing.
    }
  }

  /** Frees the object URLs held for this session. */
  releaseCloudCache() {
    for (const url of this.cloudCache.values()) URL.revokeObjectURL(url);
    this.cloudCache.clear();
  }

  /**
   * Listens for one utterance and resolves with the transcript.
   *
   * @returns {Promise<{ transcript: string, confidence: number } | null>}
   *          null when recognition is unavailable, aborted, or heard nothing.
   */
  listen({ lang = 'en-US', interimResults = false, timeoutMs = 8000, signal } = {}) {
    const Recognition = recognitionImpl();
    if (!Recognition) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.interimResults = interimResults;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;

      this.recognition = recognition;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { recognition.stop(); } catch { /* already stopped */ }
        this.recognition = null;
        resolve(result);
      };

      // Some browsers never fire onend if nothing is ever heard.
      const timer = setTimeout(() => finish(null), timeoutMs);

      recognition.onresult = (event) => {
        const result = event.results?.[0]?.[0];
        finish(result ? { transcript: result.transcript.trim(), confidence: result.confidence ?? 0 } : null);
      };
      recognition.onerror = () => finish(null);
      recognition.onend = () => finish(null);

      signal?.addEventListener('abort', () => finish(null), { once: true });

      try {
        recognition.start();
      } catch {
        finish(null);
      }
    });
  }

  stopListening() {
    try {
      this.recognition?.abort();
    } catch {
      // Already stopped.
    }
    this.recognition = null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 2 for an exact regional match, 1 for a local voice, 0 otherwise. */
function regionScore(voice, wanted) {
  const tag = voice.lang?.toLowerCase().replace('_', '-') ?? '';

  // A local voice beats a network one when neither matches the region: it
  // works offline and starts speaking without a round trip.
  return (tag === wanted ? 2 : 0) + (voice.localService ? 1 : 0);
}

export const speech = new SpeechService();
