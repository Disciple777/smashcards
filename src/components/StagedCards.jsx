import { useState } from 'react';

import { api } from '../services/ApiClient.js';

/**
 * The mandatory review screen for generated cards.
 *
 * Every card here is editable, discardable, and unapproved. Nothing reaches the
 * deck — or a study session — until the user presses Add. This gate is the
 * whole reason generated cards are written with status='staged' rather than
 * straight into the deck.
 */
export default function StagedCards({ deckId, cards, onChange, onApproved }) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (cards.length === 0) return null;

  function edit(cardId, field, value) {
    setDrafts((current) => ({
      ...current,
      [cardId]: { ...(current[cardId] ?? {}), [field]: value },
    }));
  }

  function valueOf(card, field) {
    return drafts[card.id]?.[field] ?? card[field];
  }

  function isEdited(card) {
    const draft = drafts[card.id];
    if (!draft) return false;
    return Object.entries(draft).some(([field, value]) => value !== card[field]);
  }

  async function discard(cardId) {
    const previous = cards;
    onChange(cards.filter((card) => card.id !== cardId));
    try {
      await api.deleteCard(cardId);
    } catch (err) {
      onChange(previous);
      setError(err.message);
    }
  }

  async function approveAll() {
    setBusy(true);
    setError(null);

    try {
      // Save any edits before approving, so what is added is what is on screen.
      const edited = cards.filter(isEdited);
      await Promise.all(edited.map((card) => api.updateCard(card.id, {
        question_text: valueOf(card, 'question_text'),
        answer_text: valueOf(card, 'answer_text'),
      })));

      await api.approveCards(deckId, cards.map((card) => card.id));

      setDrafts({});
      onChange([]);
      onApproved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function discardAll() {
    if (!window.confirm(`Discard all ${cards.length} suggested cards?`)) return;

    setBusy(true);
    const previous = cards;
    try {
      await Promise.all(cards.map((card) => api.deleteCard(card.id)));
      onChange([]);
    } catch (err) {
      onChange(previous);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack stack--full staged">
      <h2 className="section-title">
        {cards.length} suggested card{cards.length === 1 ? '' : 's'}
      </h2>
      <p className="muted">
        Edit anything that is wrong, discard what you do not want, then add the rest.
        These are not in your deck yet.
      </p>

      {error && <p className="alert" role="alert">{error}</p>}

      <ul className="card-list">
        {cards.map((card) => (
          <li key={card.id} className="staged__card">
            <label className="field">
              <span>Question</span>
              <textarea
                rows={2}
                value={valueOf(card, 'question_text')}
                onChange={(e) => edit(card.id, 'question_text', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Answer</span>
              <textarea
                rows={2}
                value={valueOf(card, 'answer_text')}
                onChange={(e) => edit(card.id, 'answer_text', e.target.value)}
              />
            </label>
            <button
              className="button button--link button--danger"
              type="button"
              onClick={() => discard(card.id)}
              disabled={busy}
            >
              Discard
            </button>
          </li>
        ))}
      </ul>

      <div className="staged__actions">
        <button className="button button--primary" type="button" onClick={approveAll} disabled={busy}>
          {busy ? 'Adding…' : `Add ${cards.length} card${cards.length === 1 ? '' : 's'} to deck`}
        </button>
        <button className="button button--danger" type="button" onClick={discardAll} disabled={busy}>
          Discard all
        </button>
      </div>
    </div>
  );
}
