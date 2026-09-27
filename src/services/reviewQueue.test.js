import test from 'node:test';
import assert from 'node:assert/strict';

import { enqueueReview, flushReviewQueue, pendingReviewCount } from './reviewQueue.js';

/** Node has no localStorage; a plain in-memory Map is enough for these tests. */
function installFakeLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

/** A fake ApiClient.submitReview: succeeds, fails, or fails-then-succeeds. */
function fakeApi(behavior) {
  const calls = [];
  return {
    calls,
    async submitReview(review) {
      calls.push(review);
      const outcome = behavior(calls.length, review);
      if (outcome === 'fail') throw new Error('network error');
      return { ok: true };
    },
  };
}

test.beforeEach(() => {
  installFakeLocalStorage();
});

test('a fresh queue is empty', () => {
  assert.equal(pendingReviewCount(), 0);
});

test('enqueueReview persists across calls', () => {
  enqueueReview({ card_id: 1, rating: 3 });
  enqueueReview({ card_id: 2, rating: 4 });
  assert.equal(pendingReviewCount(), 2);
});

test('flushReviewQueue submits every queued review and empties the queue on success', async () => {
  enqueueReview({ card_id: 1, rating: 3 });
  enqueueReview({ card_id: 2, rating: 4 });

  const api = fakeApi(() => 'ok');
  const result = await flushReviewQueue(api);

  assert.deepEqual(result, { flushed: 2, remaining: 0 });
  assert.equal(pendingReviewCount(), 0);
  assert.deepEqual(api.calls.map((c) => c.card_id), [1, 2]);
});

test('queued reviews flush in the order they were queued', async () => {
  enqueueReview({ card_id: 'first', rating: 1 });
  enqueueReview({ card_id: 'second', rating: 2 });
  enqueueReview({ card_id: 'third', rating: 3 });

  const api = fakeApi(() => 'ok');
  await flushReviewQueue(api);

  assert.deepEqual(api.calls.map((c) => c.card_id), ['first', 'second', 'third']);
});

test('a still-failing server leaves every queued review in place', async () => {
  enqueueReview({ card_id: 1, rating: 3 });
  enqueueReview({ card_id: 2, rating: 4 });

  const api = fakeApi(() => 'fail');
  const result = await flushReviewQueue(api);

  assert.deepEqual(result, { flushed: 0, remaining: 2 });
  assert.equal(pendingReviewCount(), 2);
});

test('a failure partway through preserves order: earlier ones flush, the rest stay queued', async () => {
  enqueueReview({ card_id: 1, rating: 3 });
  enqueueReview({ card_id: 2, rating: 4 });
  enqueueReview({ card_id: 3, rating: 2 });

  // The 2nd submission fails; a naive implementation might skip it and send
  // the 3rd anyway, applying reviews out of order.
  const api = fakeApi((callNumber) => (callNumber === 2 ? 'fail' : 'ok'));
  const result = await flushReviewQueue(api);

  assert.deepEqual(result, { flushed: 1, remaining: 2 });
  assert.equal(api.calls.length, 2, 'must not attempt review 3 while review 2 is still stuck');

  // What remains is still in its original order for the next attempt.
  const secondAttempt = fakeApi(() => 'ok');
  const secondResult = await flushReviewQueue(secondAttempt);
  assert.deepEqual(secondResult, { flushed: 2, remaining: 0 });
  assert.deepEqual(secondAttempt.calls.map((c) => c.card_id), [2, 3]);
});

test('flushing an empty queue is a harmless no-op', async () => {
  const api = fakeApi(() => 'ok');
  const result = await flushReviewQueue(api);

  assert.deepEqual(result, { flushed: 0, remaining: 0 });
  assert.equal(api.calls.length, 0);
});

test('the queued payload sent to the server does not carry the internal queuedAt marker', async () => {
  enqueueReview({ card_id: 1, rating: 3, score: 0.75 });

  const api = fakeApi(() => 'ok');
  await flushReviewQueue(api);

  assert.deepEqual(api.calls[0], { card_id: 1, rating: 3, score: 0.75 });
});

test('a corrupted queue in storage is treated as empty rather than throwing', () => {
  globalThis.localStorage.setItem('smashcards.pendingReviews', '{not valid json');
  assert.equal(pendingReviewCount(), 0);
});

test('localStorage throwing on write does not crash enqueueReview', () => {
  globalThis.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  assert.doesNotThrow(() => enqueueReview({ card_id: 1, rating: 3 }));
});
