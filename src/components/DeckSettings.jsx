import { useEffect, useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../services/ApiClient.js';
import { LANGUAGES } from '../services/settings.js';
import { SCHEME, isLanguageSupported, promptFor } from '../scheduling/voiceCommands.js';
import { speech } from '../services/SpeechService.js';
import { feedback } from '../services/feedback.js';

/**
 * Per-deck study settings.
 *
 * Deck languages persist to the API (other devices need them); study
 * ergonomics persist to localStorage via the caller.
 */
export default function DeckSettings({ deck, settings, onDeckChange, onDeckPatch, onSettingsChange }) {
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState(deck.title);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [voices, setVoices] = useState(() => speech.loadVoices());
  const [cloud, setCloud] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api.speechStatus()
      .then((status) => { if (!cancelled) setCloud(status); })
      // An older server has no such route; browser voices still work.
      .catch(() => { if (!cancelled) setCloud({ enabled: false }); });

    return () => { cancelled = true; };
  }, []);

  async function testCloudVoice() {
    setTesting(true);
    try {
      speech.prime();
      await speech.speak('This is how your cards will sound.', {
        lang: deck.language_front,
        rate: settings.rate,
        cloud: { voice: settings.cloudVoice },
      });
    } finally {
      setTesting(false);
    }
  }

  // Most browsers populate the voice list asynchronously and report an empty
  // one on first call, so the picker has to wait to be told they arrived.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth?.addEventListener) return undefined;

    const onChanged = () => setVoices(speech.loadVoices());
    synth.addEventListener('voiceschanged', onChanged);
    return () => synth.removeEventListener('voiceschanged', onChanged);
  }, []);

  // The deck can change under this component (e.g. another field just saved);
  // keep the draft in sync unless the user has an unsaved edit in progress.
  useEffect(() => {
    setTitleDraft((current) => (current === deck.title ? current : deck.title));
  }, [deck.title]);

  async function updateDeckField(field, value) {
    setSaving(true);
    try {
      await onDeckChange({ [field]: value });
    } finally {
      setSaving(false);
    }
  }

  async function handleRenameSubmit(event) {
    event.preventDefault();
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === deck.title) return;
    await updateDeckField('title', trimmed);
  }

  const shareUrl = deck.share_token
    ? `${window.location.origin}${import.meta.env.BASE_URL}shared/${deck.share_token}`
    : null;

  async function handleCreateShareLink() {
    setSharing(true);
    setShareError(null);
    try {
      const token = await api.createShareLink(deck.id);
      onDeckPatch({ share_token: token });
    } catch (err) {
      setShareError(err.message);
    } finally {
      setSharing(false);
    }
  }

  async function handleRevokeShareLink() {
    if (!window.confirm('Stop sharing this deck? The current link will stop working immediately.')) return;
    setSharing(true);
    setShareError(null);
    try {
      await api.revokeShareLink(deck.id);
      onDeckPatch({ share_token: null });
    } catch (err) {
      setShareError(err.message);
    } finally {
      setSharing(false);
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the link is still selectable text.
    }
  }

  return (
    <div className="card stack stack--full">
      <h2 className="section-title">Study settings</h2>

      <form className="field" onSubmit={handleRenameSubmit}>
        <span>Deck name</span>
        <div className="row">
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            disabled={saving}
            aria-label="Deck name"
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || !titleDraft.trim() || titleDraft.trim() === deck.title}
          >
            Save
          </button>
        </div>
      </form>

      <div className="settings-grid">
        <LanguagePicker
          label="Question language"
          value={deck.language_front}
          disabled={saving}
          voices={voices}
          onChange={(code) => updateDeckField('language_front', code)}
        />
        <LanguagePicker
          label="Answer language"
          value={deck.language_back}
          disabled={saving}
          voices={voices}
          onChange={(code) => updateDeckField('language_back', code)}
        />
      </div>

      {!speech.canSpeakLanguage(deck.language_front) && (
        <p className="muted">
          This device has no voice installed for the question language, so cards
          will be shown but not read aloud. Other devices may still read them.
        </p>
      )}

      <label className="choice">
        <input
          type="checkbox"
          checked={deck.is_public}
          disabled={saving}
          onChange={(e) => updateDeckField('is_public', e.target.checked)}
        />
        <span>Make this deck public</span>
      </label>
      <p className="muted">
        Anyone signed in can find it under Browse public decks and copy it to
        their own account. They get a snapshot — their copy does not update
        when you change yours, and your study progress never leaves your account.
      </p>

      <hr className="rule" />

      <h3 className="section-title">Share via link</h3>
      <p className="muted">
        Private by default. A share link works for anyone who has it, without
        listing the deck publicly — turn it off any time to break the link.
      </p>

      {shareError && <p className="alert" role="alert">{shareError}</p>}

      {shareUrl ? (
        <>
          <div className="row">
            <input type="text" value={shareUrl} readOnly aria-label="Share link" onFocus={(e) => e.target.select()} />
            <button className="button" type="button" onClick={handleCopyLink}>
              <Icon name="copy" size={16} /> {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button className="button button--danger" type="button" disabled={sharing} onClick={handleRevokeShareLink}>
            Stop sharing
          </button>
        </>
      ) : (
        <button className="button" type="button" disabled={sharing} onClick={handleCreateShareLink}>
          <Icon name="link" size={16} /> {sharing ? 'Creating…' : 'Create share link'}
        </button>
      )}

      <hr className="rule" />

      <label className="choice">
        <input
          type="checkbox"
          checked={settings.speechEnabled}
          onChange={(e) => onSettingsChange({ speechEnabled: e.target.checked })}
        />
        <span>Read cards aloud</span>
      </label>

      <label className="field">
        <span>Speaking speed — {settings.rate.toFixed(1)}×</span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={settings.rate}
          onChange={(e) => onSettingsChange({ rate: Number(e.target.value) })}
        />
      </label>

      {cloud?.enabled && (
        <>
          <label className="field">
            <span>Who reads the cards</span>
            <select
              value={settings.cloudSpeech}
              onChange={(e) => onSettingsChange({ cloudSpeech: e.target.value })}
            >
              <option value="auto">
                Online voice when this device has none for the language
              </option>
              <option value="always">Always use the online voice</option>
              <option value="never">Only this device's own voices</option>
            </select>
          </label>

          {settings.cloudSpeech !== 'never' && (
            <>
              <label className="field">
                <span>Online voice</span>
                <select
                  value={settings.cloudVoice}
                  onChange={(e) => onSettingsChange({ cloudVoice: e.target.value })}
                >
                  {cloud.voices.map((name) => (
                    <option key={name} value={name}>
                      {name.charAt(0).toUpperCase() + name.slice(1)}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="button"
                disabled={testing}
                onClick={testCloudVoice}
              >
                {testing ? 'Loading…' : 'Test the online voice'}
              </button>

              <p className="muted">
                The online voice speaks every language, so it works no matter what
                your device has installed. Each card is saved after the first
                reading, so re-reading it later is free and instant.
              </p>
            </>
          )}
        </>
      )}

      {voices.length > 0 && (
        <div className="settings-grid">
          <VoicePicker
            label="Question voice"
            lang={deck.language_front}
            value={settings.voiceFrontUri}
            onChange={(uri) => onSettingsChange({ voiceFrontUri: uri })}
          />
          <VoicePicker
            label="Answer voice"
            lang={deck.language_back}
            value={settings.voiceBackUri}
            onChange={(uri) => onSettingsChange({ voiceBackUri: uri })}
          />
        </div>
      )}

      <p className="muted">
        These are this device's own voices, so a choice here may not exist on your
        phone — that side falls back to its default voice there.
      </p>

      <div className="row">
        <button
          type="button"
          className="button"
          onClick={() => {
            speech.prime();
            speech.speak('This is how the question side will sound.', {
              lang: deck.language_front,
              rate: settings.rate,
              voice: speech.voiceByUri(settings.voiceFrontUri),
            });
          }}
        >
          Test question voice
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            speech.prime();
            speech.speak('This is how the answer side will sound.', {
              lang: deck.language_back,
              rate: settings.rate,
              voice: speech.voiceByUri(settings.voiceBackUri),
            });
          }}
        >
          Test answer voice
        </button>
      </div>

      <hr className="rule" />

      <label className="field">
        <span>New cards per session — up to {settings.newCardLimit}</span>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={settings.newCardLimit}
          onChange={(e) => onSettingsChange({ newCardLimit: Number(e.target.value) })}
        />
      </label>

      <p className="muted">
        {settings.newCardLimit === 0
          ? 'No new cards will be introduced — only cards already due for review.'
          : 'How many cards you have never seen before a spaced-repetition session '
            + 'will introduce. Cards already due for review are never capped: '
            + 'clearing the backlog is what keeps the schedule honest.'}
      </p>

      <hr className="rule" />

      {!settings.handsFree && (
        <>
          <label className="choice">
            <input
              type="checkbox"
              checked={settings.typedAnswer}
              onChange={(e) => onSettingsChange({ typedAnswer: e.target.checked })}
            />
            <span>Type your answer before revealing</span>
          </label>

          <p className="muted">
            Type what you recall, then see how close it was next to the real
            answer. You still choose the rating — this only suggests one.
          </p>

          <hr className="rule" />
        </>
      )}

      <label className="choice">
        <input
          type="checkbox"
          checked={settings.handsFree}
          onChange={(e) => onSettingsChange({ handsFree: e.target.checked })}
        />
        <span>Hands-free mode</span>
      </label>

      <p className="muted">
        Cards advance on their own, so you can study while walking or commuting.
      </p>

      {settings.handsFree && (
        <>
          <p className="muted">
            Tap anywhere on the screen when you are ready for the answer — there
            is no timer, and no need to look at the phone.
          </p>

          <label className="choice">
            <input
              type="checkbox"
              checked={settings.tapSound}
              onChange={(e) => {
                onSettingsChange({ tapSound: e.target.checked });
                feedback.setEnabled(e.target.checked);
                // This click is a user gesture, so it can unlock audio and
                // demonstrate the sound in one go.
                if (e.target.checked) { feedback.prime(); feedback.tap(); }
              }}
            />
            <span>Play a click when you tap to reveal</span>
          </label>

          <label className="field">
            <span>Time to say your rating — {settings.advanceDelay}s</span>
            <input
              type="range"
              min="3"
              max="20"
              step="1"
              value={settings.advanceDelay}
              onChange={(e) => onSettingsChange({ advanceDelay: Number(e.target.value) })}
            />
          </label>

          {speech.canListen() ? (
            <>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={settings.voiceRatings}
                  onChange={(e) => onSettingsChange({ voiceRatings: e.target.checked })}
                />
                <span>Rate cards by voice</span>
              </label>

              {settings.voiceRatings && (
                <>
                  <label className="field">
                    <span>What you say</span>
                    <select
                      value={settings.ratingScheme}
                      onChange={(e) => onSettingsChange({ ratingScheme: e.target.value })}
                    >
                      {/* Localised to the answer language, which is what the
                          recognizer listens in — and what the study screen
                          shows. Defaulting these to English made the settings
                          promise words the session would not accept. */}
                      <option value={SCHEME.TWO}>
                        Two answers — {promptFor(SCHEME.TWO, deck.language_back).join(' / ')}
                      </option>
                      <option value={SCHEME.FOUR}>
                        Four answers — {promptFor(SCHEME.FOUR, deck.language_back).join(' / ')}
                      </option>
                    </select>
                  </label>

                  {!isLanguageSupported(deck.language_back) && (
                    <p className="muted">
                      Spoken ratings are not translated for this language yet, so
                      say them in English — {promptFor(settings.ratingScheme, 'en-US').join(' or ')}.
                      Everything else still works in the deck's own language.
                    </p>
                  )}
                </>
              )}

              <p className="muted">
                Two answers is more reliable in a car or on a noisy street. Four gives
                the scheduler more to work with when you are somewhere quiet.
              </p>
            </>
          ) : (
            <p className="muted">
              This browser cannot listen, so cards will advance on the timer alone.
              Chrome and Edge support voice ratings.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A deck language, marked with what this device can actually do with it.
 *
 * Every language here is a valid deck language — the cards, the matching and
 * the scheduling all work regardless. What varies is whether the device can
 * *speak* it, and that is invisible until a session goes silent, so it is
 * labelled up front instead.
 *
 * `voices` is passed in rather than read here so the list re-renders when the
 * browser finishes loading voices asynchronously.
 */
function LanguagePicker({ label, value, disabled, voices, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {LANGUAGES.map((lang) => {
          const speakable = voices.length === 0 || speech.canSpeakLanguage(lang.code);

          return (
            <option key={lang.code} value={lang.code}>
              {lang.label}
              {speakable ? '' : ' — no voice here'}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/**
 * Picks one of the device's installed voices for a language.
 *
 * Only voices matching the language are offered: an English voice reading
 * Spanish is worse than no choice at all, and the list on a typical machine is
 * long enough that filtering is what makes it usable.
 */
function VoicePicker({ label, lang, value, onChange }) {
  const options = speech.voicesFor(lang);

  return (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Default for this language</option>
        {options.map((voice) => (
          <option key={voice.voiceURI} value={voice.voiceURI}>
            {voice.name}{voice.localService ? '' : ' (online)'}
          </option>
        ))}
      </select>
    </label>
  );
}
