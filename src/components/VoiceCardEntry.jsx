import { useRef, useState } from 'react';

import { speech } from '../services/SpeechService.js';

/**
 * Dictating a card.
 *
 * Transcription is never accurate enough to save blind, so this fills the two
 * text fields and hands control back — the user always sees and edits the text
 * before it is saved. That review step is deliberate, not a placeholder.
 */
export default function VoiceCardEntry({ deck, onQuestion, onAnswer }) {
  const [listeningFor, setListeningFor] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  if (!speech.canListen()) {
    return (
      <p className="muted voice-entry__unsupported">
        Voice entry needs Chrome, Edge, or Android Chrome. Type your cards here instead.
      </p>
    );
  }

  async function dictate(field) {
    setError(null);

    // A second tap on the active button cancels rather than stacking recognizers.
    if (listeningFor) {
      abortRef.current?.abort();
      speech.stopListening();
      setListeningFor(null);
      if (listeningFor === field) return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setListeningFor(field);

    const lang = field === 'question' ? deck.language_front : deck.language_back;
    const result = await speech.listen({ lang, signal: controller.signal });

    setListeningFor(null);

    if (!result?.transcript) {
      setError('Nothing was heard. Try again, or type it in.');
      return;
    }

    if (field === 'question') {
      onQuestion(result.transcript);
    } else {
      onAnswer(result.transcript);
    }
  }

  return (
    <div className="voice-entry">
      <div className="voice-entry__buttons">
        <button
          type="button"
          className={`button ${listeningFor === 'question' ? 'button--listening' : ''}`}
          onClick={() => dictate('question')}
        >
          {listeningFor === 'question' ? '● Listening…' : '🎤 Question'}
        </button>
        <button
          type="button"
          className={`button ${listeningFor === 'answer' ? 'button--listening' : ''}`}
          onClick={() => dictate('answer')}
        >
          {listeningFor === 'answer' ? '● Listening…' : '🎤 Answer'}
        </button>
      </div>

      <p className="muted voice-entry__hint">
        Dictated text lands in the fields above — check it before saving.
      </p>

      {error && <p className="alert" role="alert">{error}</p>}
    </div>
  );
}
