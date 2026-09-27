/**
 * Session queue construction — pure, deterministic, clock-injected.
 *
 * `buildQueue` decides which cards a session shows and in what order.
 * It never mutates its inputs and never reads the clock or Math.random
 * on its own, so a session is fully reproducible from its arguments.
 */

import { isDue, normalizeState } from './sm2.js';

export const MODE = Object.freeze({
  SPACED: 'spaced',
  RANDOM: 'random',
  // Read-through modes: every active card, question then answer, no rating
  // and no scoring — a way to get a first look at a deck before studying it.
  READ_ORDER: 'read_order',
  READ_RANDOM: 'read_random',
});

export function isReadMode(mode) {
  return mode === MODE.READ_ORDER || mode === MODE.READ_RANDOM;
}

/** Anki's default. Configurable per deck later; see roadmap §7. */
export const DEFAULT_NEW_CARD_LIMIT = 20;

/**
 * @param {Array<object>} cards        cards from GET /v1/decks/{id}/cards
 * @param {object} statesByCardId      { [cardId]: card_states row }
 * @param {object} options
 * @param {string} options.mode        'spaced' | 'random'
 * @param {Date|string} options.now
 * @param {number} options.newCardLimit  max unseen cards to introduce
 * @param {() => number} options.random  injectable RNG, defaults to Math.random
 * @returns {Array<object>} the cards to study, in order
 */
export function buildQueue(cards, statesByCardId = {}, options = {}) {
  const {
    mode = MODE.SPACED,
    now = new Date(),
    newCardLimit = DEFAULT_NEW_CARD_LIMIT,
    random = Math.random,
  } = options;

  const studiable = (cards ?? []).filter((card) => (card.status ?? 'active') === 'active');

  if (mode === MODE.RANDOM || mode === MODE.READ_RANDOM) {
    // Random mode still writes reviews, so a user who switches to spaced
    // repetition later arrives with real history instead of a cold start.
    return shuffle(studiable, random);
  }

  if (mode === MODE.READ_ORDER) {
    // Every active card in authored order — not filtered to due/fresh, since
    // this mode is a preview pass, not a review.
    return studiable.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  const due = [];
  const fresh = [];

  for (const card of studiable) {
    const state = statesByCardId[card.id] ?? statesByCardId[String(card.id)] ?? null;

    if (!state || !normalizeState(state).dueAt) {
      fresh.push(card);
    } else if (isDue(state, now)) {
      due.push({ card, dueAt: normalizeState(state).dueAt });
    }
    // Cards due in the future are simply not in this session.
  }

  // Most overdue first. Ties break on position, so a deck studied in one sitting
  // still reads in its authored order rather than an arbitrary one.
  due.sort((a, b) => {
    const byDue = Date.parse(a.dueAt) - Date.parse(b.dueAt);
    return byDue !== 0 ? byDue : (a.card.position ?? 0) - (b.card.position ?? 0);
  });

  const introduced = fresh
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .slice(0, Math.max(0, newCardLimit));

  // Reviews before new material: clearing the backlog is what keeps the
  // schedule honest, and new cards are the part worth dropping when time runs out.
  return [...due.map((entry) => entry.card), ...introduced];
}

/** Counts for the deck list and the session summary, without building a queue. */
export function queueStats(cards, statesByCardId = {}, now = new Date()) {
  const studiable = (cards ?? []).filter((card) => (card.status ?? 'active') === 'active');

  let dueCount = 0;
  let newCount = 0;

  for (const card of studiable) {
    const state = statesByCardId[card.id] ?? statesByCardId[String(card.id)] ?? null;

    if (!state || !normalizeState(state).dueAt) {
      newCount += 1;
    } else if (isDue(state, now)) {
      dueCount += 1;
    }
  }

  return { total: studiable.length, dueCount, newCount };
}

/** Fisher–Yates on a copy. RNG is injected so tests are deterministic. */
export function shuffle(items, random = Math.random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
