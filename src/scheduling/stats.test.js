import test from 'node:test';
import assert from 'node:assert/strict';

import { computeStats, localDayKey } from './stats.js';

/** A session on a given local day. Local, because streaks are local-day based. */
function session(localDate, cardsReviewed = 5) {
  const [year, month, day] = localDate.split('-').map(Number);
  const at = new Date(year, month - 1, day, 12, 0, 0);
  return {
    id: Math.random(),
    started_at: at.toISOString(),
    cards_reviewed: cardsReviewed,
  };
}

/** Local noon on a day offset from today, so tests never depend on the date. */
function daysAgo(count) {
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - count, 12);
  return localDayKey(at);
}

const NOW = new Date();

test('no sessions means every statistic is zero', () => {
  assert.deepEqual(computeStats([], NOW), {
    sessionCount: 0,
    totalReviewed: 0,
    daysStudied: 0,
    studiedToday: false,
    currentStreak: 0,
    longestStreak: 0,
  });
});

test('missing or malformed input does not throw', () => {
  assert.equal(computeStats(null, NOW).sessionCount, 0);
  assert.equal(computeStats(undefined, NOW).sessionCount, 0);
  assert.equal(computeStats([{}, { started_at: null }], NOW).sessionCount, 0);
});

test('cards reviewed are summed across sessions', () => {
  const stats = computeStats([session(daysAgo(0), 3), session(daysAgo(0), 7)], NOW);
  assert.equal(stats.totalReviewed, 10);
  assert.equal(stats.sessionCount, 2);
});

test('several sessions in one day count as one studied day', () => {
  const stats = computeStats([session(daysAgo(0)), session(daysAgo(0)), session(daysAgo(0))], NOW);
  assert.equal(stats.daysStudied, 1);
  assert.equal(stats.currentStreak, 1);
});

test('studying today gives a streak of one', () => {
  const stats = computeStats([session(daysAgo(0))], NOW);
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.studiedToday, true);
});

test('consecutive days accumulate', () => {
  const stats = computeStats([session(daysAgo(0)), session(daysAgo(1)), session(daysAgo(2))], NOW);
  assert.equal(stats.currentStreak, 3);
});

test('a streak ending yesterday is still alive, because today is not over', () => {
  const stats = computeStats([session(daysAgo(1)), session(daysAgo(2))], NOW);
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.studiedToday, false);
});

test('a gap breaks the current streak', () => {
  // Studied 2 and 3 days ago, nothing since.
  const stats = computeStats([session(daysAgo(2)), session(daysAgo(3))], NOW);
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.longestStreak, 2);
});

test('the longest streak survives a later gap', () => {
  const stats = computeStats(
    [
      session(daysAgo(0)),
      session(daysAgo(10)), session(daysAgo(11)), session(daysAgo(12)), session(daysAgo(13)),
    ],
    NOW,
  );

  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.longestStreak, 4);
});

test('a session that reviewed nothing does not count toward a streak', () => {
  // Opening a deck and backing out is not studying.
  const stats = computeStats([session(daysAgo(0), 0)], NOW);

  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.daysStudied, 0);
  assert.equal(stats.studiedToday, false);
  assert.equal(stats.sessionCount, 1, 'the session still happened');
});

test('an empty session does not break a streak built by real ones', () => {
  const stats = computeStats([session(daysAgo(0), 0), session(daysAgo(1), 5)], NOW);
  assert.equal(stats.currentStreak, 1, 'yesterday still counts');
});

test('out-of-order sessions are handled', () => {
  const shuffled = [session(daysAgo(2)), session(daysAgo(0)), session(daysAgo(1))];
  assert.equal(computeStats(shuffled, NOW).currentStreak, 3);
});

test('a long unbroken run is counted correctly', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => session(daysAgo(i)));
  const stats = computeStats(sessions, NOW);

  assert.equal(stats.currentStreak, 30);
  assert.equal(stats.longestStreak, 30);
  assert.equal(stats.daysStudied, 30);
});

test('a late-evening session counts as today, not tomorrow', () => {
  // 23:30 local. In UTC-6 this is already tomorrow in UTC, but the user has
  // plainly studied today.
  const now = new Date();
  const lateToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30);

  const stats = computeStats(
    [{ started_at: lateToday.toISOString(), cards_reviewed: 4 }],
    lateToday,
  );

  assert.equal(stats.studiedToday, true);
  assert.equal(stats.currentStreak, 1);
});

test('MySQL-formatted timestamps from the API are accepted', () => {
  const stats = computeStats(
    [{ started_at: '2026-08-19 10:00:00', cards_reviewed: 3 }],
    new Date('2026-08-19T23:00:00Z'),
  );

  assert.equal(stats.daysStudied, 1);
  assert.equal(stats.totalReviewed, 3);
});

test('localDayKey formats a sortable YYYY-MM-DD', () => {
  const key = localDayKey(new Date(2026, 0, 5, 12));
  assert.equal(key, '2026-01-05');
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});
