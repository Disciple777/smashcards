import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_NEW_CARD_LIMIT, MODE, buildQueue, queueStats, shuffle } from './queue.js';

const NOW = new Date('2026-08-19T10:00:00.000Z');

const card = (id, position = id, status = 'active') => ({
  id,
  position,
  status,
  question_text: `q${id}`,
  answer_text: `a${id}`,
});

const dueAt = (iso) => ({ due_at: iso, ease_factor: '2.50', interval_days: '3', repetitions: '2' });

/** Deterministic RNG so shuffles are reproducible in tests. */
function seededRandom(seed = 1) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

test('spaced mode returns only cards that are due', () => {
  const cards = [card(1), card(2), card(3)];
  const states = {
    1: dueAt('2026-08-18T10:00:00.000Z'), // overdue
    2: dueAt('2026-08-25T10:00:00.000Z'), // future
    3: dueAt('2026-08-19T10:00:00.000Z'), // exactly due
  };

  const queue = buildQueue(cards, states, { mode: MODE.SPACED, now: NOW, newCardLimit: 0 });

  assert.deepEqual(queue.map((c) => c.id), [1, 3]);
});

test('due cards come back most-overdue first', () => {
  const cards = [card(1), card(2), card(3)];
  const states = {
    1: dueAt('2026-08-18T10:00:00.000Z'),
    2: dueAt('2026-08-10T10:00:00.000Z'),
    3: dueAt('2026-08-15T10:00:00.000Z'),
  };

  const queue = buildQueue(cards, states, { now: NOW, newCardLimit: 0 });

  assert.deepEqual(queue.map((c) => c.id), [2, 3, 1]);
});

test('cards due at the same moment fall back to deck order', () => {
  const cards = [card(3, 30), card(1, 10), card(2, 20)];
  const sameMoment = dueAt('2026-08-18T10:00:00.000Z');
  const states = { 1: sameMoment, 2: sameMoment, 3: sameMoment };

  const queue = buildQueue(cards, states, { now: NOW, newCardLimit: 0 });

  assert.deepEqual(queue.map((c) => c.id), [1, 2, 3]);
});

test('unseen cards are introduced after the due backlog', () => {
  const cards = [card(1), card(2), card(3)];
  const states = { 2: dueAt('2026-08-18T10:00:00.000Z') };

  const queue = buildQueue(cards, states, { now: NOW });

  assert.equal(queue[0].id, 2, 'the due card leads');
  assert.deepEqual(queue.slice(1).map((c) => c.id), [1, 3]);
});

test('the new-card limit caps how many unseen cards appear', () => {
  const cards = Array.from({ length: 50 }, (_, i) => card(i + 1));

  const queue = buildQueue(cards, {}, { now: NOW, newCardLimit: 5 });

  assert.equal(queue.length, 5);
  assert.deepEqual(queue.map((c) => c.id), [1, 2, 3, 4, 5], 'introduced in deck order');
});

test('the new-card limit defaults to 20', () => {
  const cards = Array.from({ length: 50 }, (_, i) => card(i + 1));
  assert.equal(buildQueue(cards, {}, { now: NOW }).length, DEFAULT_NEW_CARD_LIMIT);
});

test('a new-card limit of zero yields a review-only session', () => {
  const cards = [card(1), card(2)];
  assert.deepEqual(buildQueue(cards, {}, { now: NOW, newCardLimit: 0 }), []);
});

test('a negative new-card limit is treated as zero, not as a slice from the end', () => {
  const cards = [card(1), card(2), card(3)];
  assert.deepEqual(buildQueue(cards, {}, { now: NOW, newCardLimit: -5 }), []);
});

test('random mode returns every card regardless of due date', () => {
  const cards = [card(1), card(2), card(3)];
  const states = { 1: dueAt('2099-01-01T00:00:00.000Z') };

  const queue = buildQueue(cards, states, { mode: MODE.RANDOM, now: NOW, random: seededRandom() });

  assert.equal(queue.length, 3);
  assert.deepEqual(queue.map((c) => c.id).sort(), [1, 2, 3]);
});

test('random mode ignores the new-card limit', () => {
  const cards = Array.from({ length: 50 }, (_, i) => card(i + 1));

  const queue = buildQueue(cards, {}, { mode: MODE.RANDOM, now: NOW, newCardLimit: 5, random: seededRandom() });

  assert.equal(queue.length, 50);
});

test('staged cards are never studied', () => {
  const cards = [card(1), card(2, 2, 'staged'), card(3)];

  const spaced = buildQueue(cards, {}, { now: NOW });
  const random = buildQueue(cards, {}, { mode: MODE.RANDOM, now: NOW, random: seededRandom() });

  assert.deepEqual(spaced.map((c) => c.id), [1, 3]);
  assert.deepEqual(random.map((c) => c.id).sort(), [1, 3]);
});

test('state keys work whether card ids are numbers or strings', () => {
  const cards = [card(1)];
  const queue = buildQueue(cards, { '1': dueAt('2026-08-18T10:00:00.000Z') }, { now: NOW, newCardLimit: 0 });

  assert.deepEqual(queue.map((c) => c.id), [1]);
});

test('a state row with no due_at counts as a new card, not a due one', () => {
  const cards = [card(1)];
  const states = { 1: { ease_factor: '2.50', interval_days: '0', repetitions: '0', due_at: null } };

  const queue = buildQueue(cards, states, { now: NOW, newCardLimit: 1 });

  assert.deepEqual(queue.map((c) => c.id), [1]);
});

test('buildQueue does not mutate the cards it is given', () => {
  const cards = [card(3, 30), card(1, 10), card(2, 20)];
  const snapshot = structuredClone(cards);

  buildQueue(cards, {}, { now: NOW });
  buildQueue(cards, {}, { mode: MODE.RANDOM, now: NOW, random: seededRandom() });

  assert.deepEqual(cards, snapshot);
});

test('an empty or missing deck yields an empty queue rather than throwing', () => {
  assert.deepEqual(buildQueue([], {}, { now: NOW }), []);
  assert.deepEqual(buildQueue(undefined, {}, { now: NOW }), []);
  assert.deepEqual(buildQueue(null, undefined, { now: NOW }), []);
});

test('queueStats matches what buildQueue would return', () => {
  const cards = [card(1), card(2), card(3), card(4, 4, 'staged')];
  const states = {
    1: dueAt('2026-08-18T10:00:00.000Z'),
    2: dueAt('2026-08-25T10:00:00.000Z'),
  };

  const stats = queueStats(cards, states, NOW);

  assert.deepEqual(stats, { total: 3, dueCount: 1, newCount: 1 });

  const queue = buildQueue(cards, states, { now: NOW, newCardLimit: 100 });
  assert.equal(queue.length, stats.dueCount + stats.newCount);
});

test('shuffle keeps every element and leaves the original alone', () => {
  const input = Array.from({ length: 100 }, (_, i) => i);
  const output = shuffle(input, seededRandom(42));

  assert.equal(output.length, input.length);
  assert.deepEqual(output.slice().sort((a, b) => a - b), input);
  assert.deepEqual(input, Array.from({ length: 100 }, (_, i) => i));
  assert.notDeepEqual(output, input, 'a 100-element shuffle should reorder something');
});

test('shuffle is deterministic given the same seed', () => {
  const input = Array.from({ length: 20 }, (_, i) => i);

  assert.deepEqual(shuffle(input, seededRandom(7)), shuffle(input, seededRandom(7)));
});
