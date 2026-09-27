import { useMemo, useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../services/ApiClient.js';
import { MAX_CARDS_PER_IMPORT, PARSER_EXAMPLE, batched, parseCards } from '../services/cardParser.js';

/**
 * Paste a marked-up block of text, get cards. No AI, no quota, no network
 * until the moment of import.
 *
 * The parse runs on every keystroke and shows its result immediately, which
 * is the whole design: a format you cannot see the effect of is a format
 * people get wrong once and never use again. What is about to be created is
 * on screen before anything is created, including the lines that will *not*
 * become cards and why.
 *
 * Unlike the AI importer, these cards go straight into the deck rather than
 * into staging — the user wrote them, so there is nothing to review.
 */
export default function TextImport({ deckId, onImported }) {
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const { cards, errors, ignoredPreamble } = useMemo(() => parseCards(text), [text]);

  const preview = showAll ? cards : cards.slice(0, 5);

  async function handleImport() {
    setImporting(true);
    setError(null);
    setDone(null);

    try {
      const payload = cards.map((card) => ({
        question_text: card.question,
        answer_text: card.answer,
        source_type: 'manual',
      }));

      // The endpoint takes 500 per request and is all-or-nothing within one,
      // so a long paste goes up in batches, in order.
      for (const batch of batched(payload, MAX_CARDS_PER_IMPORT)) {
        await api.bulkImport(deckId, batch);
      }

      setDone(payload.length);
      setText('');
      await onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="card stack stack--full">
      <h2 className="section-title">Paste a list of cards</h2>

      <p className="muted">
        Mark each side with <code>/q:</code> and <code>/a:</code>. Either side
        may run over several lines — the next marker ends it. Anything before
        the first marker is ignored, so a heading can stay.
      </p>

      <pre className="parser-example">{PARSER_EXAMPLE}</pre>

      <label className="field">
        <span>Your text</span>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setDone(null); }}
          rows={10}
          placeholder={PARSER_EXAMPLE}
          spellCheck="false"
        />
      </label>

      {ignoredPreamble && (
        <p className="muted">
          Ignored before the first marker: “{ignoredPreamble.slice(0, 80)}
          {ignoredPreamble.length > 80 ? '…' : ''}”
        </p>
      )}

      {errors.length > 0 && (
        <ul className="parser-errors">
          {errors.map((problem, i) => (
            <li key={`${problem.line}-${i}`}>
              Line {problem.line}: {problem.message}
            </li>
          ))}
        </ul>
      )}

      {cards.length > 0 && (
        <>
          <h3 className="section-title">
            {cards.length} card{cards.length === 1 ? '' : 's'} ready
          </h3>

          <ul className="parser-preview">
            {preview.map((card, i) => (
              <li key={i} className="parser-preview__card">
                <strong>{card.question}</strong>
                <span className="muted">{card.answer}</span>
              </li>
            ))}
          </ul>

          {cards.length > 5 && (
            <button className="button button--link" type="button" onClick={() => setShowAll((open) => !open)}>
              {showAll ? 'Show fewer' : `Show all ${cards.length}`}
            </button>
          )}
        </>
      )}

      {error && <p className="alert" role="alert">{error}</p>}

      {done !== null && (
        <p className="muted" role="status">
          <Icon name="check" size={16} /> Added {done} card{done === 1 ? '' : 's'} to the deck.
        </p>
      )}

      <button
        className="button button--primary"
        type="button"
        disabled={importing || cards.length === 0}
        onClick={handleImport}
      >
        {importing
          ? 'Adding…'
          : `Add ${cards.length || ''} card${cards.length === 1 ? '' : 's'}`.replace('  ', ' ')}
      </button>
    </section>
  );
}
