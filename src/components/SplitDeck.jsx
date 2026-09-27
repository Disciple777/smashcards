import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../services/ApiClient.js';
import { batched } from '../services/cardParser.js';
import { describeSplit, importable, inheritedFields, planSplit } from '../services/deckSplit.js';

/**
 * Chops an oversized deck into a numbered series — "Biology 1" through
 * "Biology 4" — at a size the user picks.
 *
 * Two deliberate choices:
 *
 * **The original is kept by default.** A split is several API calls long and
 * cannot be undone by a back button; deleting the source as part of it would
 * make a mistaken chunk size unrecoverable. Removing it afterwards is one
 * checkbox, and it only happens once every part has been created *and*
 * filled.
 *
 * **Progress is reported per part.** With 400 cards and a size of 25 this is
 * sixteen decks and sixteen imports; a single spinner for the whole thing
 * looks hung. If one part fails, the ones already created are listed as
 * links rather than left for the user to find.
 */
export default function SplitDeck({ deck, cards, onChanged }) {
  const suggested = Math.max(1, Math.ceil(cards.length / 4));
  const [size, setSize] = useState(suggested);
  const [deleteOriginal, setDeleteOriginal] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [created, setCreated] = useState([]);
  const [error, setError] = useState(null);
  const [originalDeleted, setOriginalDeleted] = useState(false);

  const parts = useMemo(() => planSplit(cards, size, deck.title), [cards, size, deck.title]);
  const canSplit = cards.length > 1 && parts.length > 1;

  async function handleSplit() {
    if (!window.confirm(
      `Create ${parts.length} new decks from “${deck.title}”?`
      + (deleteOriginal ? ' The original will be deleted once they are all filled.' : ''),
    )) return;

    setBusy(true);
    setError(null);
    setCreated([]);
    const made = [];

    try {
      for (const [index, part] of parts.entries()) {
        setProgress(`Creating “${part.title}” — ${index + 1} of ${parts.length}…`);

        const newDeck = await api.createDeck({ title: part.title, ...inheritedFields(deck) });
        made.push(newDeck);
        setCreated([...made]);

        for (const batch of batched(importable(part.cards))) {
          await api.bulkImport(newDeck.id, batch);
        }
      }

      if (deleteOriginal) {
        setProgress('Deleting the original…');
        await api.deleteDeck(deck.id);
        setOriginalDeleted(true);
      }

      setProgress(null);
      await onChanged?.();
    } catch (err) {
      setError(
        `${err.message} — ${made.length} of ${parts.length} decks were created before this failed.`
        + ' The original deck was not touched.',
      );
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack stack--full">
      <h2 className="section-title">Split this deck</h2>

      <p className="muted">
        Turns one long deck into a numbered series of smaller ones. Cards keep
        their order, and each new deck inherits this deck's languages and folder.
        Study progress stays with the original — the parts start fresh.
      </p>

      {cards.length < 2 ? (
        <p className="muted">This deck is too small to split.</p>
      ) : (
        <>
          <label className="field">
            <span>Cards per deck</span>
            <input
              type="number"
              min="1"
              max={cards.length}
              value={size}
              disabled={busy}
              onChange={(e) => setSize(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>

          <p className="muted">{describeSplit(cards.length, size, deck.title)}</p>

          {parts.length > 1 && (
            <ul className="split-preview">
              {parts.map((part) => (
                <li key={part.title}>
                  <span>{part.title}</span>
                  <span className="muted">{part.cards.length} cards</span>
                </li>
              ))}
            </ul>
          )}

          <label className="choice">
            <input
              type="checkbox"
              checked={deleteOriginal}
              disabled={busy}
              onChange={(e) => setDeleteOriginal(e.target.checked)}
            />
            <span>Delete “{deck.title}” once the parts are created</span>
          </label>

          {error && <p className="alert" role="alert">{error}</p>}
          {progress && <p className="muted" role="status">{progress}</p>}

          {created.length > 0 && !busy && (
            <>
              <h3 className="section-title">
                {created.length} deck{created.length === 1 ? '' : 's'} created
              </h3>
              <ul className="split-preview">
                {created.map((made) => (
                  <li key={made.id}>
                    <Link to={`/decks/${made.id}`}>{made.title}</Link>
                  </li>
                ))}
              </ul>
              {originalDeleted && (
                <p className="muted">
                  The original was deleted. <Link to="/decks">Back to your decks</Link>
                </p>
              )}
            </>
          )}

          <button
            className="button button--primary"
            type="button"
            disabled={busy || !canSplit || originalDeleted}
            onClick={handleSplit}
          >
            {busy ? 'Splitting…' : `Split into ${parts.length} decks`}
          </button>
        </>
      )}
    </section>
  );
}
