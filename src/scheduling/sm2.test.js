import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EASE,
  FIRST_INTERVAL,
  MIN_EASE,
  RATING,
  SECOND_INTERVAL,
  daysUntilDue,
  initialState,
  isDue,
  nextEase,
  nextState,
  normalizeState,
  parseApiDate,
  qualityForRating,
  scoreForRating,
  toApiPayload,
  toMysqlDateTime,
} from './sm2.js';

const NOW = new Date('2026-08-19T10:00:00.000Z');

/** Reviews a fresh card `count` times at one rating, one day apart. */
function study(count, rating, startState = null) {
  let state = startState;
  let at = NOW;
  for (let i = 0; i < count; i += 1) {
    state = nextState(state, rating, at);
    at = new Date(Date.parse(state.dueAt));
  }
  return state;
}

test('a new card starts at the documented defaults', () => {
  const state = initialState();
  assert.equal(state.easeFactor, DEFAULT_EASE);
  assert.equal(state.intervalDays, 0);
  assert.equal(state.repetitions, 0);
  assert.equal(state.dueAt, null);
});

test('first Good review schedules one day out', () => {
  const state = nextState(null, RATING.GOOD, NOW);
  assert.equal(state.repetitions, 1);
  assert.equal(state.intervalDays, FIRST_INTERVAL);
  assert.equal(state.dueAt, '2026-08-20T10:00:00.000Z');
  assert.equal(state.lastReviewedAt, NOW.toISOString());
});

test('second Good review schedules six days out', () => {
  const state = study(2, RATING.GOOD);
  assert.equal(state.repetitions, 2);
  assert.equal(state.intervalDays, SECOND_INTERVAL);
});

test('third and later reviews multiply the interval by ease', () => {
  const second = study(2, RATING.GOOD);
  const third = nextState(second, RATING.GOOD, new Date(Date.parse(second.dueAt)));

  // Good leaves ease at 2.5, so 6 * 2.5 = 15.
  assert.equal(third.easeFactor, 2.5);
  assert.equal(third.intervalDays, Math.round(SECOND_INTERVAL * 2.5));
  assert.equal(third.repetitions, 3);
});

test('intervals grow monotonically under repeated Good', () => {
  let state = null;
  let at = NOW;
  const intervals = [];

  for (let i = 0; i < 8; i += 1) {
    state = nextState(state, RATING.GOOD, at);
    intervals.push(state.intervalDays);
    at = new Date(Date.parse(state.dueAt));
  }

  for (let i = 1; i < intervals.length; i += 1) {
    assert.ok(
      intervals[i] > intervals[i - 1],
      `interval ${intervals[i]} at step ${i} did not exceed ${intervals[i - 1]}`,
    );
  }
});

test('Easy raises ease, Hard lowers it, Good leaves it alone', () => {
  const base = study(1, RATING.GOOD);

  assert.equal(nextState(base, RATING.GOOD, NOW).easeFactor, base.easeFactor);
  assert.ok(nextState(base, RATING.EASY, NOW).easeFactor > base.easeFactor);
  assert.ok(nextState(base, RATING.HARD, NOW).easeFactor < base.easeFactor);
});

test('Again resets repetitions and sends the card to tomorrow', () => {
  const mature = study(4, RATING.GOOD);
  assert.ok(mature.intervalDays > 10, 'precondition: card should be mature');

  const lapsed = nextState(mature, RATING.AGAIN, NOW);

  assert.equal(lapsed.repetitions, 0);
  assert.equal(lapsed.intervalDays, FIRST_INTERVAL);
  assert.equal(lapsed.dueAt, '2026-08-20T10:00:00.000Z');
  assert.ok(lapsed.easeFactor < mature.easeFactor, 'a lapse should cost ease');
});

test('ease floors at 1.3 however often the card is failed', () => {
  let state = null;
  for (let i = 0; i < 20; i += 1) {
    state = nextState(state, RATING.AGAIN, NOW);
  }
  assert.equal(state.easeFactor, MIN_EASE);
});

test('ease never floors below 1.3 from a single catastrophic rating', () => {
  assert.equal(nextEase(1.3, 0), MIN_EASE);
  assert.equal(nextEase(2.5, 0), 1.7);
  assert.equal(nextEase(2.5, 5), 2.6);
  assert.equal(nextEase(2.5, 4), 2.5);
});

test('ease is rounded to two decimals to match DECIMAL(4,2)', () => {
  for (let q = 0; q <= 5; q += 1) {
    const value = nextEase(2.5, q);
    assert.equal(value, Math.round(value * 100) / 100, `q=${q} produced ${value}`);
  }
});

test('a recovered card climbs from the short interval again', () => {
  const lapsed = nextState(study(4, RATING.GOOD), RATING.AGAIN, NOW);
  const recovering = nextState(lapsed, RATING.GOOD, NOW);

  assert.equal(recovering.repetitions, 1);
  assert.equal(recovering.intervalDays, FIRST_INTERVAL);
});

test('nextState does not mutate the state it is given', () => {
  const before = study(3, RATING.GOOD);
  const snapshot = structuredClone(before);

  nextState(before, RATING.AGAIN, NOW);

  assert.deepEqual(before, snapshot);
});

test('an invalid rating throws rather than silently scheduling', () => {
  for (const bad of [0, 5, -1, 2.5, null, undefined, '3', NaN]) {
    assert.throws(() => nextState(null, bad, NOW), RangeError, `rating ${String(bad)}`);
  }
});

test('an invalid date throws rather than producing an Invalid Date due_at', () => {
  assert.throws(() => nextState(null, RATING.GOOD, 'not-a-date'), TypeError);
});

test('ratings map to the documented quality and score scales', () => {
  assert.equal(qualityForRating(RATING.AGAIN), 0);
  assert.equal(qualityForRating(RATING.EASY), 5);

  assert.equal(scoreForRating(RATING.AGAIN), 0);
  assert.equal(scoreForRating(RATING.EASY), 1);

  // Every score must fit reviews.score DECIMAL(3,2) in 0.00–1.00.
  for (const rating of Object.values(RATING)) {
    const score = scoreForRating(rating);
    assert.ok(score >= 0 && score <= 1, `score ${score} out of range`);
  }
});

test('scores increase with rating', () => {
  const scores = [RATING.AGAIN, RATING.HARD, RATING.GOOD, RATING.EASY].map(scoreForRating);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] > scores[i - 1]);
  }
});

test('normalizeState accepts snake_case rows straight from the API', () => {
  const state = normalizeState({
    ease_factor: '2.36',
    interval_days: '15',
    repetitions: '4',
    due_at: '2026-08-25T10:00:00.000Z',
    last_reviewed_at: '2026-08-10T10:00:00.000Z',
  });

  assert.equal(state.easeFactor, 2.36);
  assert.equal(state.intervalDays, 15);
  assert.equal(state.repetitions, 4);
  assert.equal(state.dueAt, '2026-08-25T10:00:00.000Z');
});

test('normalizeState repairs corrupt or missing values', () => {
  assert.deepEqual(normalizeState(null), initialState());
  assert.equal(normalizeState({ ease_factor: '0.1' }).easeFactor, MIN_EASE);
  assert.equal(normalizeState({ interval_days: '-5' }).intervalDays, 0);
  assert.equal(normalizeState({ ease_factor: 'banana' }).easeFactor, DEFAULT_EASE);
});

test('isDue is false for unseen cards and true once the due date passes', () => {
  assert.equal(isDue(null, NOW), false);
  assert.equal(isDue(initialState(), NOW), false);
  assert.equal(isDue({ dueAt: '2026-08-19T09:59:59.000Z' }, NOW), true);
  assert.equal(isDue({ dueAt: '2026-08-19T10:00:00.000Z' }, NOW), true, 'exactly due counts as due');
  assert.equal(isDue({ dueAt: '2026-08-19T10:00:01.000Z' }, NOW), false);
});

test('daysUntilDue counts forward and back', () => {
  assert.equal(daysUntilDue(null, NOW), null);
  assert.equal(daysUntilDue({ dueAt: '2026-08-22T10:00:00.000Z' }, NOW), 3);
  assert.equal(daysUntilDue({ dueAt: '2026-08-16T10:00:00.000Z' }, NOW), -3);
});

test('toApiPayload emits MySQL DATETIME in UTC', () => {
  const payload = toApiPayload(nextState(null, RATING.GOOD, NOW));

  assert.equal(payload.due_at, '2026-08-20 10:00:00');
  assert.equal(payload.last_reviewed_at, '2026-08-19 10:00:00');
  assert.equal(payload.ease_factor, 2.5);
  assert.equal(payload.interval_days, 1);
});

test('toMysqlDateTime never emits a T or a timezone suffix', () => {
  const formatted = toMysqlDateTime('2026-12-31T23:59:59.999Z');
  assert.equal(formatted, '2026-12-31 23:59:59');
  assert.ok(!formatted.includes('T'));
  assert.ok(!formatted.includes('Z'));
});

test('scheduling is independent of the local timezone', () => {
  // The same instant expressed three ways must schedule identically.
  const utc = nextState(null, RATING.GOOD, new Date('2026-08-19T10:00:00.000Z'));
  const offset = nextState(null, RATING.GOOD, new Date('2026-08-19T12:00:00.000+02:00'));
  const epoch = nextState(null, RATING.GOOD, new Date(Date.parse('2026-08-19T10:00:00Z')));

  assert.equal(utc.dueAt, offset.dueAt);
  assert.equal(utc.dueAt, epoch.dueAt);
});

test('a year of Good reviews stays within a sane interval range', () => {
  let state = null;
  let at = NOW;

  for (let i = 0; i < 12; i += 1) {
    state = nextState(state, RATING.GOOD, at);
    at = new Date(Date.parse(state.dueAt));
    assert.ok(Number.isInteger(state.intervalDays), 'intervals must stay whole days');
    assert.ok(state.intervalDays > 0, 'intervals must stay positive');
  }
});

test('bare MySQL datetimes from the API are read as UTC, not local time', () => {
  // The API stores UTC and returns '2026-08-25 10:00:00' with no zone marker.
  // Parsed naively this shifts by the local offset, moving every due date.
  assert.equal(parseApiDate('2026-08-25 10:00:00').toISOString(), '2026-08-25T10:00:00.000Z');
  assert.equal(parseApiDate('2026-08-25T10:00:00').toISOString(), '2026-08-25T10:00:00.000Z');
});

test('explicit ISO strings keep their own zone', () => {
  assert.equal(parseApiDate('2026-08-25T10:00:00Z').toISOString(), '2026-08-25T10:00:00.000Z');
  assert.equal(parseApiDate('2026-08-25T12:00:00+02:00').toISOString(), '2026-08-25T10:00:00.000Z');
});

test('a due date survives a round trip through the API format', () => {
  const scheduled = nextState(null, RATING.GOOD, NOW);
  const asStored = toApiPayload(scheduled).due_at;      // '2026-08-20 10:00:00'
  const readBack = parseApiDate(asStored).toISOString();

  assert.equal(readBack, scheduled.dueAt, 'a round trip must not move the due date');
});

test('isDue agrees with the API format regardless of local zone', () => {
  // Exactly due, expressed the way the API returns it.
  assert.equal(isDue({ due_at: '2026-08-19 10:00:00' }, NOW), true);
  assert.equal(isDue({ due_at: '2026-08-19 10:00:01' }, NOW), false);
});
