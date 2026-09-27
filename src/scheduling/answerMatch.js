/**
 * Typed-answer evaluation: how close is what the user typed to the stored
 * answer? Pure and synchronous, so it is testable without a DOM and reusable
 * for a future spoken-answer path (the transcript is just another string).
 *
 * Deliberately not accent-stripping: "esta" and "está" are different Spanish
 * words, not a typo of one another, so folding them together would let a
 * wrong answer read as correct. Case, punctuation and surrounding whitespace
 * are normalized — those never change meaning — but letters themselves are
 * compared as typed.
 */

import { RATING } from './sm2.js';

/**
 * Score-to-rating thresholds. A card marked "correct enough" still lands the
 * user on a real SM-2 rating, because scheduling operates on those four
 * buckets — this just chooses one from the match quality instead of a tap.
 */
const THRESHOLDS = Object.freeze({
  EASY: 0.97,  // effectively exact
  GOOD: 0.8,
  HARD: 0.55,
  // anything below HARD is AGAIN
});

/**
 * 0–1 similarity between two strings, length-normalized Levenshtein.
 * 1 means identical after normalization; 0 means nothing in common.
 */
export function similarity(typed, expected) {
  const a = normalize(typed);
  const b = normalize(expected);

  if (a === '' && b === '') return 1;
  if (a === '' || b === '') return 0;
  if (a === b) return 1;

  const distance = levenshtein(a, b);
  const longest = Math.max(a.length, b.length);
  return Math.max(0, 1 - distance / longest);
}

/** Rounds to 2 decimals — reviews.score is DECIMAL(3,2); match the server's grain. */
export function scoreFor(typed, expected) {
  return Math.round(similarity(typed, expected) * 100) / 100;
}

/** Maps a 0–1 score onto the same four ratings the tap buttons produce. */
export function ratingForScore(score) {
  if (score >= THRESHOLDS.EASY) return RATING.EASY;
  if (score >= THRESHOLDS.GOOD) return RATING.GOOD;
  if (score >= THRESHOLDS.HARD) return RATING.HARD;
  return RATING.AGAIN;
}

/** Case, punctuation and whitespace only — never touches the letters themselves. */
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    // Apostrophes drop out entirely first — "it's" must fold to "its", not
    // split into "it s" the way replacing them with a space would.
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classic dynamic-programming edit distance, single-row rolling buffer.
 * Fine for flashcard-length strings; not intended for paragraphs.
 */
function levenshtein(a, b) {
  const prevRow = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let previousDiagonal = prevRow[0];
    prevRow[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = prevRow[j];
      if (a[i - 1] === b[j - 1]) {
        prevRow[j] = previousDiagonal;
      } else {
        prevRow[j] = 1 + Math.min(previousDiagonal, prevRow[j], prevRow[j - 1]);
      }
      previousDiagonal = temp;
    }
  }

  return prevRow[b.length];
}
