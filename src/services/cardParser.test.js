import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_FIELD_CHARS, batched, parseCards } from './cardParser.js';

describe('parseCards', () => {
  it('reads a simple two-card block', () => {
    const { cards, errors } = parseCards(
      '/q: Capital of France?\n/a: Paris\n\n/q: Capital of Japan?\n/a: Tokyo\n',
    );

    assert.equal(errors.length, 0);
    assert.deepEqual(
      cards.map(({ question, answer }) => [question, answer]),
      [['Capital of France?', 'Paris'], ['Capital of Japan?', 'Tokyo']],
    );
  });

  it('keeps the newlines inside a multi-line field', () => {
    const { cards } = parseCards('/q: List the noble gases\n/a: Helium\nNeon\nArgon');

    assert.equal(cards[0].answer, 'Helium\nNeon\nArgon');
  });

  it('accepts markers inline, so a one-line card works', () => {
    const { cards } = parseCards('/q: 2 + 2? /a: 4');

    assert.deepEqual(cards, [{ question: '2 + 2?', answer: '4', line: 1 }]);
  });

  it('is case-insensitive and tolerates a space before the colon', () => {
    const { cards } = parseCards('/Q : Uno\n/A: One');

    assert.deepEqual(cards.map((c) => c.question), ['Uno']);
  });

  it('ignores a heading before the first marker and reports it', () => {
    const { cards, ignoredPreamble } = parseCards('Chapter 4 — Cells\n\n/q: A?\n/a: B');

    assert.equal(cards.length, 1);
    assert.equal(ignoredPreamble, 'Chapter 4 — Cells');
  });

  it('skips a question with no answer and names its line', () => {
    const { cards, errors } = parseCards('/q: Lonely question\n\n/q: Good?\n/a: Yes');

    assert.deepEqual(cards.map((c) => c.question), ['Good?']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 1);
  });

  it('skips an answer that has no question before it', () => {
    const { cards, errors } = parseCards('/a: orphan\n/q: A?\n/a: B');

    assert.equal(cards.length, 1);
    assert.match(errors[0].message, /no question/);
  });

  it('appends a second answer rather than losing it', () => {
    const { cards, errors } = parseCards('/q: Steps?\n/a: First\n/a: Second');

    assert.equal(errors.length, 0);
    assert.equal(cards[0].answer, 'First\nSecond');
  });

  it('does not read a marker glued to other text as a marker', () => {
    const { cards } = parseCards('/q: See http://x/a: y\n/a: fine');

    assert.equal(cards.length, 1);
    assert.equal(cards[0].question, 'See http://x/a: y');
  });

  it('skips a card too long for the column instead of failing the whole import', () => {
    const runaway = 'x'.repeat(MAX_FIELD_CHARS + 1);
    const { cards, errors } = parseCards(`/q: Fine?
/a: Yes

/q: Big
/a: ${runaway}`);

    assert.deepEqual(cards.map((c) => c.question), ['Fine?']);
    assert.match(errors[0].message, /2000 characters/);
  });

  it('returns nothing at all for text with no markers', () => {
    const { cards, errors } = parseCards('Just some notes, no markers here.');

    assert.deepEqual(cards, []);
    assert.deepEqual(errors, []);
  });

  it('survives empty and non-string input', () => {
    assert.deepEqual(parseCards('').cards, []);
    assert.deepEqual(parseCards(undefined).cards, []);
  });
});

describe('batched', () => {
  it('splits into batches the bulk endpoint will accept', () => {
    const cards = Array.from({ length: 1100 }, (_, i) => i);

    assert.deepEqual(batched(cards).map((b) => b.length), [500, 500, 100]);
  });

  it('leaves a short list as one batch', () => {
    assert.equal(batched([1, 2, 3]).length, 1);
  });
});
