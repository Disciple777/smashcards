/**
 * Chopping one oversized deck into a numbered series of smaller ones.
 *
 * The plan is computed as pure data before anything is created, because the
 * operation is several API calls long and partly irreversible: the user sees
 * exactly which cards land in "Biology 3" *before* any deck exists, and the
 * component can report progress against a plan it already holds.
 *
 * Card order is preserved. A deck's cards are ordered by `position`, and a
 * chapter split that shuffled them would destroy the only structure the
 * material had.
 */

/** Below this there is nothing to split; above it the UI stops offering. */
export const MIN_PART_SIZE = 1;

/**
 * @param {object[]} cards      in deck order
 * @param {number} size         cards per part
 * @param {string} title        the original deck's title
 * @returns {{title: string, cards: object[]}[]}
 */
export function planSplit(cards, size, title) {
  const perPart = Math.max(MIN_PART_SIZE, Math.floor(Number(size) || 0));
  const base = String(title ?? '').trim() || 'Deck';
  const parts = [];

  for (let i = 0; i < cards.length; i += perPart) {
    parts.push({
      title: `${base} ${parts.length + 1}`,
      cards: cards.slice(i, i + perPart),
    });
  }

  return parts;
}

/**
 * How many parts a size would produce, without building them.
 *
 * Used for the live "→ 4 decks of 25" line under the size input, which is
 * what makes the control understandable without pressing it.
 */
export function partCount(total, size) {
  const perPart = Math.max(MIN_PART_SIZE, Math.floor(Number(size) || 0));
  return Math.ceil(total / perPart) || 0;
}

/**
 * A one-line description of what the split will do.
 *
 * The remainder is called out separately because an uneven split is the case
 * people get wrong in their heads: 100 cards by 30 is four decks, not three,
 * and the fourth has ten cards in it.
 */
export function describeSplit(total, size, title) {
  const count = partCount(total, size);
  if (count === 0) return 'Nothing to split — this deck has no cards.';
  if (count === 1) return 'That is the whole deck — choose a smaller size to split it.';

  const perPart = Math.max(MIN_PART_SIZE, Math.floor(Number(size) || 0));
  const remainder = total % perPart;
  const base = String(title ?? '').trim() || 'Deck';
  const tail = remainder === 0
    ? `each with ${perPart} cards`
    : `${count - 1} with ${perPart} cards and a last one with ${remainder}`;

  return `${count} decks — “${base} 1” through “${base} ${count}”, ${tail}.`;
}

/**
 * The fields a new part inherits from the deck it came from.
 *
 * Languages especially: a Spanish deck split into four must not produce four
 * decks that silently read themselves in English. Sharing and visibility are
 * deliberately *not* inherited — a public deck's parts start private, since
 * publishing four new decks is not something a split should decide.
 */
export function inheritedFields(deck) {
  return {
    folder_id: deck.folder_id ?? null,
    language_front: deck.language_front,
    language_back: deck.language_back,
    description: deck.description || null,
  };
}

/** The card fields that travel to the new deck. Progress does not: a part is a new deck. */
export function importable(cards) {
  return cards.map((card) => ({
    question_text: card.question_text,
    answer_text: card.answer_text,
    source_type: card.source_type ?? 'manual',
  }));
}
