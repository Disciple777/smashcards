/**
 * A durability net for review submissions.
 *
 * The study loop must never stall on the network — submitRating() in
 * StudySession advances to the next card immediately, regardless of whether
 * the server accepted the review. That is correct for the session itself
 * (which runs off its own local copy of the schedule), but a review that
 * fails to reach the server must not simply vanish: without it, the server's
 * card_states row never updates, and the next session's queue is built from
 * that stale state — silently re-serving a card the user already reviewed,
 * or dropping a lapse that should have reset it.
 *
 * The fix: a failed submission is queued here and retried — on the next app
 * load, when the browser regains connectivity, and after every later
 * successful submission in the same session — until it lands.
 */

const STORAGE_KEY = 'smashcards.pendingReviews';

function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // A full or disabled localStorage means this review can't be queued
    // either; the caller already surfaced the original failure to the user.
  }
}

export function enqueueReview(review) {
  const queue = readQueue();
  queue.push({ ...review, queuedAt: new Date().toISOString() });
  writeQueue(queue);
}

export function pendingReviewCount() {
  return readQueue().length;
}

let flushing = false;

/**
 * Retries queued reviews oldest-first, stopping at the first failure so
 * reviews are never applied out of order. Safe to call opportunistically and
 * often — a second call while one is already running is a no-op.
 */
export async function flushReviewQueue(api) {
  if (flushing) return { flushed: 0, remaining: pendingReviewCount() };
  flushing = true;

  try {
    const queue = readQueue();
    let flushed = 0;

    while (flushed < queue.length) {
      const { queuedAt, ...review } = queue[flushed];
      try {
        await api.submitReview(review);
        flushed += 1;
      } catch {
        break; // still failing; leave this and everything after it queued
      }
    }

    const remaining = queue.slice(flushed);
    writeQueue(remaining);
    return { flushed, remaining: remaining.length };
  } finally {
    flushing = false;
  }
}
