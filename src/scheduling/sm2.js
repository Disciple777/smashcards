/**
 * SM-2 spaced repetition, as pure functions.
 *
 * Nothing here reads the clock, touches the network, or mutates its input.
 * `now` is always passed in, so every schedule is reproducible in a test.
 *
 * The canonical reference is Wozniak's SM-2 (1987), which Anki descends from.
 * Deviations from the paper are marked DEVIATION and explained.
 */

/** Ease never drops below this, or a lapsing card collapses to daily forever. */
export const MIN_EASE = 1.3;

/** A card's ease before it has ever been reviewed. */
export const DEFAULT_EASE = 2.5;

/** Interval in days awarded on the first and second successful review. */
export const FIRST_INTERVAL = 1;
export const SECOND_INTERVAL = 6;

export const RATING = Object.freeze({
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4,
});

/**
 * The UI collects 1–4; SM-2's formula wants a 0–5 quality.
 * Again maps to 0 rather than 2 so a lapse takes the full ease penalty.
 */
const QUALITY_BY_RATING = Object.freeze({
  [RATING.AGAIN]: 0,
  [RATING.HARD]: 3,
  [RATING.GOOD]: 4,
  [RATING.EASY]: 5,
});

/**
 * The 0–1 value written to `reviews.score`.
 *
 * Phase 4's automated answer evaluation writes a fuzzy confidence to the same
 * column, so self-ratings have to land on a comparable scale now.
 */
const SCORE_BY_RATING = Object.freeze({
  [RATING.AGAIN]: 0,
  [RATING.HARD]: 0.4,
  [RATING.GOOD]: 0.75,
  [RATING.EASY]: 1,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidRating(rating) {
  return Object.values(RATING).includes(rating);
}

export function qualityForRating(rating) {
  assertRating(rating);
  return QUALITY_BY_RATING[rating];
}

export function scoreForRating(rating) {
  assertRating(rating);
  return SCORE_BY_RATING[rating];
}

/** The state of a card the user has never seen. */
export function initialState() {
  return {
    easeFactor: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    dueAt: null,
    lastReviewedAt: null,
  };
}

/**
 * The heart of the scheduler.
 *
 * @param {object|null} state  current card_states row, or null/undefined for a new card
 * @param {number} rating      1–4 (see RATING)
 * @param {Date|string} now    review time; the caller owns the clock
 * @returns {object} a new state object — the input is never modified
 */
export function nextState(state, rating, now = new Date()) {
  assertRating(rating);

  const current = normalizeState(state);
  const at = toDate(now);
  const quality = QUALITY_BY_RATING[rating];

  const easeFactor = nextEase(current.easeFactor, quality);

  let repetitions;
  let intervalDays;

  if (quality < 3) {
    // Lapse: the card re-enters the rotation tomorrow and must climb again.
    repetitions = 0;
    intervalDays = FIRST_INTERVAL;
  } else {
    repetitions = current.repetitions + 1;

    if (repetitions === 1) {
      intervalDays = FIRST_INTERVAL;
    } else if (repetitions === 2) {
      intervalDays = SECOND_INTERVAL;
    } else {
      // DEVIATION: the paper multiplies by the *updated* ease. Anki multiplies
      // by the updated ease too, so we follow Anki for familiarity.
      // Math.max guards a card whose stored interval is 0 from sticking there.
      intervalDays = Math.round(Math.max(current.intervalDays, 1) * easeFactor);
    }
  }

  return {
    easeFactor,
    intervalDays,
    repetitions,
    dueAt: addDays(at, intervalDays),
    lastReviewedAt: at.toISOString(),
  };
}

/**
 * SM-2's ease update:  EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
 *
 * q=5 → +0.10   q=4 → +0.00   q=3 → -0.14   q=0 → -0.80
 *
 * DEVIATION: the paper leaves EF untouched when q < 3. We apply the penalty,
 * because the roadmap specifies ease adjusts by rating, and a card failed
 * repeatedly should get easier to trigger, not hold a 2.5 ease forever.
 */
export function nextEase(easeFactor, quality) {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const updated = easeFactor + delta;

  // Two decimal places: card_states.ease_factor is DECIMAL(4,2), and rounding
  // here rather than in MySQL keeps JS and the database in agreement.
  return round2(Math.max(MIN_EASE, updated));
}

/**
 * True when a card is due at `now`. New cards (no due date) are not "due".
 * Normalizes first, so snake_case rows straight from the API work too.
 */
export function isDue(state, now = new Date()) {
  const { dueAt } = normalizeState(state);
  if (!dueAt) return false;
  return toDate(dueAt).getTime() <= toDate(now).getTime();
}

/** Whole days until due; negative means overdue. Null for unseen cards. */
export function daysUntilDue(state, now = new Date()) {
  const { dueAt } = normalizeState(state);
  if (!dueAt) return null;
  return Math.ceil((toDate(dueAt).getTime() - toDate(now).getTime()) / DAY_MS);
}

/**
 * Accepts a card_states row from the API (snake_case, strings from MySQL) or a
 * camelCase state, and returns a clean camelCase state.
 */
export function normalizeState(state) {
  if (!state) return initialState();

  const easeFactor = Number(state.easeFactor ?? state.ease_factor ?? DEFAULT_EASE);
  const intervalDays = Number(state.intervalDays ?? state.interval_days ?? 0);
  const repetitions = Number(state.repetitions ?? 0);
  const dueAt = state.dueAt ?? state.due_at ?? null;
  const lastReviewedAt = state.lastReviewedAt ?? state.last_reviewed_at ?? null;

  return {
    easeFactor: Number.isFinite(easeFactor) ? Math.max(MIN_EASE, easeFactor) : DEFAULT_EASE,
    intervalDays: Number.isFinite(intervalDays) ? Math.max(0, intervalDays) : 0,
    repetitions: Number.isFinite(repetitions) ? Math.max(0, repetitions) : 0,
    dueAt: dueAt ? toDate(dueAt).toISOString() : null,
    lastReviewedAt: lastReviewedAt ? toDate(lastReviewedAt).toISOString() : null,
  };
}

/** Shapes a state for the API, which speaks snake_case and MySQL DATETIME. */
export function toApiPayload(state) {
  return {
    ease_factor: state.easeFactor,
    interval_days: state.intervalDays,
    repetitions: state.repetitions,
    due_at: state.dueAt ? toMysqlDateTime(state.dueAt) : null,
    last_reviewed_at: state.lastReviewedAt ? toMysqlDateTime(state.lastReviewedAt) : null,
  };
}

/** '2026-08-19T12:34:56.000Z' → '2026-08-19 12:34:56' (UTC, as the API stores). */
export function toMysqlDateTime(value) {
  return toDate(value).toISOString().slice(0, 19).replace('T', ' ');
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS).toISOString();
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** MySQL DATETIME as the API returns it: '2026-08-25 10:00:00', no zone. */
const MYSQL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

/**
 * Parses a date, treating bare MySQL DATETIME strings as UTC.
 *
 * `new Date('2026-08-25 10:00:00')` is interpreted in the *local* zone, so a
 * due date read back from the API lands hours away from where it was written —
 * six hours off in UTC-6, and a day adrift near the date line. The API stores
 * UTC (the PDO connection pins +00:00), so the string is UTC and must say so.
 */
export function parseApiDate(value) {
  if (value instanceof Date) return validate(value, value);
  if (typeof value === 'string' && MYSQL_DATETIME.test(value.trim())) {
    const iso = `${value.trim().replace(' ', 'T')}Z`;
    return validate(new Date(iso), value);
  }
  return validate(new Date(value), value);
}

function validate(date, original) {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${String(original)}`);
  }
  return date;
}

function toDate(value) {
  return parseApiDate(value);
}

function assertRating(rating) {
  if (!isValidRating(rating)) {
    throw new RangeError(`Rating must be 1–4, got ${String(rating)}`);
  }
}
