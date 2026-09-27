/**
 * Per-deck study preferences, kept on the device.
 *
 * These are UI ergonomics — speech rate, pause length, whether hands-free is on
 * — not data other devices need, so localStorage is the right home for now.
 * Deck *language* is a property of the deck itself and lives in the database.
 *
 * If cross-device sync is wanted later, users.settings_json already exists.
 */

import { SCHEME } from '../scheduling/voiceCommands.js';
import { DEFAULT_NEW_CARD_LIMIT } from '../scheduling/queue.js';

const STORAGE_KEY = 'smashcards.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  speechEnabled: true,
  rate: 1,
  handsFree: false,
  /**
   * Which system voice reads each side, by voiceURI.
   *
   * Stored per side rather than per deck: a language deck's two sides are two
   * different languages, and one voice cannot read both well. null means "the
   * browser's default for that language", which is what most decks want.
   *
   * The URI and not the voice object: SpeechSynthesisVoice cannot be
   * serialised, and the available voices differ per device anyway — so this is
   * resolved back to a real voice at speaking time, falling back to the default
   * when the saved one is not installed here.
   */
  voiceFrontUri: null,
  voiceBackUri: null,
  /**
   * When to read cards with a cloud voice instead of the device's own.
   *
   *   'auto'   — only when this device has no voice for that language
   *   'always' — every card, for consistent quality across devices
   *   'never'  — device voices only
   *
   * 'auto' is the default because the failure it fixes is invisible: a device
   * with no French voice does not say so, it just reads French in an English
   * accent, or stays silent. Costing nothing until it is actually needed makes
   * that the right thing to have on by default.
   */
  cloudSpeech: 'auto',
  /** Which cloud voice, when one is used. */
  cloudVoice: 'alloy',
  /** How many unseen cards a spaced-repetition session may introduce per day. */
  newCardLimit: DEFAULT_NEW_CARD_LIMIT,
  /**
   * The answer is revealed by tapping the screen, never on a timer.
   *
   * It used to listen for a spoken "show", but a recognizer plays a start tone
   * each time it opens, so listening through the thinking phase chimed every
   * second or so — unusable while trying to recall an answer. A tap is silent
   * and needs no aim, so the phone can stay in a pocket.
   */
  /** Short click confirming the tap that reveals the answer. */
  tapSound: true,
  /** Type the answer before it is revealed; the match suggests a rating. */
  typedAnswer: false,
  /** Seconds to wait after the answer before auto-advancing unrated. */
  advanceDelay: 6,
  ratingScheme: SCHEME.TWO,
  voiceRatings: true,
});

/**
 * Whether a given card side should be read by a cloud voice.
 *
 * One rule, consulted by every mode — spaced repetition, random, both read-
 * through modes, hands-free and the card preview in the editor — so "which
 * language can this app speak" never depends on which screen you are on.
 *
 * @param {object} settings  the deck's saved settings
 * @param {string} lang      BCP-47 tag of the side being read
 * @param {boolean} available  whether the server offers cloud speech at all
 * @param {(lang: string) => boolean} deviceCanSpeak
 * @returns {{voice: string}|null} null means "use the device's own voice"
 */
export function cloudSpeechFor(settings, lang, available, deviceCanSpeak) {
  if (!available || settings.cloudSpeech === 'never') return null;

  if (settings.cloudSpeech === 'always' || !deviceCanSpeak(lang)) {
    return { voice: settings.cloudVoice ?? 'alloy' };
  }

  return null;
}

export function loadSettings(deckId) {
  const all = readAll();
  return { ...DEFAULT_SETTINGS, ...(all[String(deckId)] ?? {}) };
}

export function saveSettings(deckId, settings) {
  const all = readAll();
  all[String(deckId)] = { ...(all[String(deckId)] ?? {}), ...settings };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A full or disabled localStorage should not break studying.
  }

  return loadSettings(deckId);
}

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * BCP-47 tags for the deck language pickers, fed straight to the Web Speech API.
 *
 * Regional variants are listed separately only where they genuinely sound
 * different and devices ship distinct voices for them — Mexican and Peninsular
 * Spanish, Brazilian and European Portuguese. Listing every registered locale
 * would be a longer menu that reads no better.
 *
 * Which of these actually *speaks* depends on the device: a language with no
 * installed voice is still a valid deck language (the text is right, the
 * scheduling is right) but nothing will read it aloud, so the picker marks
 * those rather than letting the user discover it mid-session.
 */
export const LANGUAGES = Object.freeze([
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'es-ES', label: 'Spanish (Spain)' },
  { code: 'es-MX', label: 'Spanish (Mexico)' },
  { code: 'es-AR', label: 'Spanish (Argentina)' },
  { code: 'es-US', label: 'Spanish (US)' },
  { code: 'fr-FR', label: 'French' },
  { code: 'fr-CA', label: 'French (Canada)' },
  { code: 'de-DE', label: 'German' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'nl-NL', label: 'Dutch' },
  { code: 'sv-SE', label: 'Swedish' },
  { code: 'da-DK', label: 'Danish' },
  { code: 'nb-NO', label: 'Norwegian' },
  { code: 'fi-FI', label: 'Finnish' },
  { code: 'is-IS', label: 'Icelandic' },
  { code: 'pl-PL', label: 'Polish' },
  { code: 'cs-CZ', label: 'Czech' },
  { code: 'sk-SK', label: 'Slovak' },
  { code: 'hu-HU', label: 'Hungarian' },
  { code: 'ro-RO', label: 'Romanian' },
  { code: 'bg-BG', label: 'Bulgarian' },
  { code: 'hr-HR', label: 'Croatian' },
  { code: 'el-GR', label: 'Greek' },
  { code: 'ru-RU', label: 'Russian' },
  { code: 'uk-UA', label: 'Ukrainian' },
  { code: 'tr-TR', label: 'Turkish' },
  { code: 'he-IL', label: 'Hebrew' },
  { code: 'ar-SA', label: 'Arabic' },
  { code: 'fa-IR', label: 'Persian' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'bn-IN', label: 'Bengali' },
  { code: 'ta-IN', label: 'Tamil' },
  { code: 'th-TH', label: 'Thai' },
  { code: 'vi-VN', label: 'Vietnamese' },
  { code: 'id-ID', label: 'Indonesian' },
  { code: 'ms-MY', label: 'Malay' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ko-KR', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Mandarin, Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Mandarin, Taiwan)' },
  { code: 'zh-HK', label: 'Chinese (Cantonese)' },
  { code: 'ca-ES', label: 'Catalan' },
  { code: 'af-ZA', label: 'Afrikaans' },
  { code: 'sw-KE', label: 'Swahili' },
]);
