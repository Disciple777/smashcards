/**
 * Study statistics: streaks and totals, derived from the session log.
 *
 * Pure, with the clock injected. Streaks are counted in the user's *local*
 * calendar days, not UTC ones — someone studying at 11pm in UTC-6 has plainly
 * studied "today", even though it is already tomorrow in UTC.
 */

import { parseApiDate } from './sm2.js';

/**
 * @param {Array<object>} sessions rows from GET /v1/sessions
 * @param {Date} now
 * @returns {{ currentStreak: number, longestStreak: number, daysStudied: number,
 *             totalReviewed: number, studiedToday: boolean, sessionCount: number }}
 */
export function computeStats(sessions, now = new Date()) {
  const rows = (sessions ?? []).filter((session) => session?.started_at);

  const totalReviewed = rows.reduce(
    (sum, session) => sum + (Number(session.cards_reviewed) || 0),
    0,
  );

  // A session only counts toward a streak if a card was actually reviewed;
  // opening a deck and backing out is not studying.
  const studiedDays = new Set(
    rows
      .filter((session) => (Number(session.cards_reviewed) || 0) > 0)
      .map((session) => localDayKey(parseApiDate(session.started_at))),
  );

  return {
    sessionCount: rows.length,
    totalReviewed,
    daysStudied: studiedDays.size,
    studiedToday: studiedDays.has(localDayKey(now)),
    currentStreak: currentStreak(studiedDays, now),
    longestStreak: longestStreak(studiedDays),
  };
}

/**
 * Consecutive days up to today.
 *
 * Yesterday still counts as an unbroken streak: the day is not over, so a user
 * who has not studied yet today has not lost anything. Anything older is broken.
 */
function currentStreak(studiedDays, now) {
  if (studiedDays.size === 0) return 0;

  const today = startOfLocalDay(now);
  let cursor = today;

  if (!studiedDays.has(localDayKey(cursor))) {
    cursor = addDays(today, -1);
    if (!studiedDays.has(localDayKey(cursor))) return 0;
  }

  let streak = 0;
  while (studiedDays.has(localDayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function longestStreak(studiedDays) {
  if (studiedDays.size === 0) return 0;

  const days = [...studiedDays].sort();
  let longest = 1;
  let run = 1;

  for (let i = 1; i < days.length; i += 1) {
    const previous = addDays(fromDayKey(days[i - 1]), 1);
    run = localDayKey(previous) === days[i] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  return longest;
}

/** 'YYYY-MM-DD' in the local zone. Sortable, and comparable as a plain string. */
export function localDayKey(date) {
  const local = date instanceof Date ? date : parseApiDate(date);
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, '0'),
    String(local.getDate()).padStart(2, '0'),
  ].join('-');
}

function startOfLocalDay(date) {
  const local = date instanceof Date ? date : parseApiDate(date);
  return new Date(local.getFullYear(), local.getMonth(), local.getDate());
}

function fromDayKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Calendar-day arithmetic, so DST transitions do not drop or double a day. */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
