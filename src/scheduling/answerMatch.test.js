import test from 'node:test';
import assert from 'node:assert/strict';

import { RATING } from './sm2.js';
import { ratingForScore, scoreFor, similarity } from './answerMatch.js';

test('an exact match scores 1', () => {
  assert.equal(similarity('ser', 'ser'), 1);
});

test('matching is case-insensitive', () => {
  assert.equal(similarity('SER', 'ser'), 1);
  assert.equal(similarity('Ser', 'sER'), 1);
});

test('surrounding whitespace and internal spacing do not affect the score', () => {
  assert.equal(similarity('  ser  ', 'ser'), 1);
  assert.equal(similarity('to be', '  to   be  '), 1);
});

test('punctuation is ignored, letters are not', () => {
  assert.equal(similarity('ser.', 'ser'), 1);
  assert.equal(similarity("it's", 'its'), 1);
});

test('a small typo scores high but not perfect', () => {
  const score = similarity('estr', 'ester'); // one edit away
  assert.ok(score > 0.6 && score < 1, `expected a high but imperfect score, got ${score}`);
});

test('completely different strings score low', () => {
  const score = similarity('ser', 'xyz');
  assert.ok(score < 0.4, `expected a low score, got ${score}`);
});

test('both empty is a perfect match; one empty is a total miss', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('', 'ser'), 0);
  assert.equal(similarity('ser', ''), 0);
});

test('non-string input does not throw', () => {
  assert.doesNotThrow(() => similarity(null, 'ser'));
  assert.doesNotThrow(() => similarity(undefined, undefined));
  assert.equal(similarity(null, null), 1); // both normalize to ''
});

test('accents are NOT stripped — "esta" and "está" are different words', () => {
  const score = similarity('esta', 'está');
  assert.ok(score < 1, 'a missing accent must not read as a perfect match');
});

test('scoreFor rounds to two decimal places, matching DECIMAL(3,2)', () => {
  const score = scoreFor('estr', 'ester');
  assert.equal(score, Math.round(score * 100) / 100);
});

test('ratingForScore maps the top of the range to Easy', () => {
  assert.equal(ratingForScore(1), RATING.EASY);
  assert.equal(ratingForScore(0.97), RATING.EASY);
});

test('ratingForScore maps a solid match to Good', () => {
  assert.equal(ratingForScore(0.9), RATING.GOOD);
  assert.equal(ratingForScore(0.8), RATING.GOOD);
});

test('ratingForScore maps a rough match to Hard', () => {
  assert.equal(ratingForScore(0.7), RATING.HARD);
  assert.equal(ratingForScore(0.55), RATING.HARD);
});

test('ratingForScore maps a poor match to Wrong (Again)', () => {
  assert.equal(ratingForScore(0.3), RATING.AGAIN);
  assert.equal(ratingForScore(0), RATING.AGAIN);
});

test('ratingForScore never returns a value outside the four SM-2 ratings', () => {
  const valid = Object.values(RATING);
  for (let score = 0; score <= 1; score += 0.05) {
    assert.ok(valid.includes(ratingForScore(score)), `score ${score} produced an invalid rating`);
  }
});

test('scoreFor and ratingForScore agree with each other for an exact typed answer', () => {
  const score = scoreFor('tener', 'tener');
  assert.equal(score, 1);
  assert.equal(ratingForScore(score), RATING.EASY);
});
