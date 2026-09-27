import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeSplit, importable, inheritedFields, partCount, planSplit } from './deckSplit.js';

const cards = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  question_text: `q${i + 1}`,
  answer_text: `a${i + 1}`,
}));

describe('planSplit', () => {
  it('divides evenly and numbers the parts from one', () => {
    const parts = planSplit(cards(100), 25, 'Biology');

    assert.deepEqual(parts.map((p) => p.title), ['Biology 1', 'Biology 2', 'Biology 3', 'Biology 4']);
    assert.deepEqual(parts.map((p) => p.cards.length), [25, 25, 25, 25]);
  });

  it('puts the remainder in a final, shorter part', () => {
    const parts = planSplit(cards(10), 4, 'Deck');

    assert.deepEqual(parts.map((p) => p.cards.length), [4, 4, 2]);
  });

  it('preserves card order across the parts', () => {
    const parts = planSplit(cards(6), 2, 'D');

    assert.deepEqual(
      parts.flatMap((p) => p.cards.map((c) => c.id)),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it('returns one part when the size covers the whole deck', () => {
    assert.equal(planSplit(cards(5), 10, 'D').length, 1);
  });

  it('returns nothing for an empty deck', () => {
    assert.deepEqual(planSplit([], 10, 'D'), []);
  });

  it('floors a nonsense size to one card per part rather than looping forever', () => {
    assert.equal(planSplit(cards(3), 0, 'D').length, 3);
    assert.equal(planSplit(cards(3), -5, 'D').length, 3);
  });

  it('falls back to a usable name when the deck has none', () => {
    assert.equal(planSplit(cards(2), 1, '   ')[0].title, 'Deck 1');
  });
});

describe('partCount', () => {
  it('rounds up, because the remainder is still a deck', () => {
    assert.equal(partCount(100, 30), 4);
    assert.equal(partCount(100, 25), 4);
    assert.equal(partCount(0, 25), 0);
  });
});

describe('describeSplit', () => {
  it('spells out an uneven split', () => {
    assert.match(describeSplit(100, 30, 'Biology'), /4 decks/);
    assert.match(describeSplit(100, 30, 'Biology'), /last one with 10/);
  });

  it('says so when the size would not split anything', () => {
    assert.match(describeSplit(20, 50, 'Biology'), /whole deck/);
    assert.match(describeSplit(0, 10, 'Biology'), /Nothing to split/);
  });
});

describe('inheritedFields', () => {
  it('carries language and folder but never publishes the parts', () => {
    const fields = inheritedFields({
      folder_id: 7,
      language_front: 'es-ES',
      language_back: 'en-US',
      description: 'notes',
      is_public: true,
      share_token: 'abc',
    });

    assert.deepEqual(fields, {
      folder_id: 7,
      language_front: 'es-ES',
      language_back: 'en-US',
      description: 'notes',
    });
  });
});

describe('importable', () => {
  it('keeps only the card text, not the scheduling state', () => {
    assert.deepEqual(
      importable([{ id: 3, question_text: 'q', answer_text: 'a', position: 9, due_at: 'x' }]),
      [{ question_text: 'q', answer_text: 'a', source_type: 'manual' }],
    );
  });
});
