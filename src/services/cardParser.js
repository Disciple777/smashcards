/**
 * Turns a block of marked-up text into cards. No AI, no network — pure string
 * work, so a paste of notes typed on a phone becomes a deck instantly and
 * offline, and the same input always produces the same cards.
 *
 * The syntax is two markers:
 *
 *     /q: What is the powerhouse of the cell?
 *     /a: The mitochondrion.
 *
 * Everything after a marker belongs to it until the next marker, so either
 * side may run over as many lines as it likes. Markers are case-insensitive
 * (`/Q:` works), tolerate a space before the colon (`/q :`), and may sit
 * inline rather than at the start of a line — `/q: 2+2? /a: 4` is one card —
 * which is what makes pasting a single-line list work.
 *
 * Deliberately forgiving in three places, because the input is hand-typed:
 *
 *   - text before the first marker is ignored rather than failing the parse
 *     (it is usually a heading or a chapter title);
 *   - a second `/a:` for the same question appends to the answer instead of
 *     erroring, since that is what a wrapped multi-part answer looks like;
 *   - a question with no answer is reported with its line number and skipped,
 *     never silently dropped and never turned into a half card.
 */

/**
 * A marker is `/q:` or `/a:` preceded by the start of the text or whitespace.
 * Requiring the boundary is what stops a URL ("http://q: …" is not a thing,
 * but "and/or a: b" nearly is) or a path fragment from being read as a marker.
 */
const MARKER = /(^|\s)\/([qa])\s*:/gi;

/** The bulk import endpoint accepts 500 cards per request. */
export const MAX_CARDS_PER_IMPORT = 500;

/**
 * The column, and the API's validator, stop at 2000 characters a side.
 *
 * Checked here rather than left to the server because bulk import is
 * all-or-nothing: one runaway field — usually a missing `/q:` that swallowed
 * the rest of the document — would otherwise reject the other 300 good cards
 * with a field error naming an index nobody can map back to a line.
 */
export const MAX_FIELD_CHARS = 2000;

/**
 * @param {string} text
 * @returns {{
 *   cards: {question: string, answer: string, line: number}[],
 *   errors: {line: number, message: string}[],
 *   ignoredPreamble: string,
 * }}
 */
export function parseCards(text) {
  const source = typeof text === 'string' ? text : '';
  const tokens = [];

  MARKER.lastIndex = 0;
  let match;
  let lastEnd = 0;
  let preambleEnd = null;

  while ((match = MARKER.exec(source)) !== null) {
    // match[1] is the boundary character, which belongs to the previous field.
    const markerStart = match.index + match[1].length;
    const contentStart = match.index + match[0].length;

    if (tokens.length === 0) {
      preambleEnd = markerStart;
    } else {
      tokens[tokens.length - 1].text = source.slice(lastEnd, markerStart);
    }

    tokens.push({
      kind: match[2].toLowerCase(),
      line: lineOf(source, markerStart),
      text: '',
    });
    lastEnd = contentStart;
  }

  if (tokens.length > 0) {
    tokens[tokens.length - 1].text = source.slice(lastEnd);
  }

  const cards = [];
  const errors = [];
  let pending = null;

  function closePending() {
    if (!pending) return;

    const question = tidy(pending.question);
    const answer = tidy(pending.answer);

    if (!answer) {
      errors.push({ line: pending.line, message: 'Question with no answer — skipped.' });
    } else if (question.length > MAX_FIELD_CHARS || answer.length > MAX_FIELD_CHARS) {
      errors.push({
        line: pending.line,
        message: `Longer than ${MAX_FIELD_CHARS} characters a side — skipped. A missing marker usually causes this.`,
      });
    } else {
      cards.push({ question, answer, line: pending.line });
    }
    pending = null;
  }

  for (const token of tokens) {
    if (token.kind === 'q') {
      closePending();
      pending = { question: token.text, answer: '', line: token.line };
      if (!token.text.trim()) {
        errors.push({ line: token.line, message: 'Empty question — skipped.' });
        pending = null;
      }
      continue;
    }

    // An answer with no question ahead of it has nothing to attach to.
    if (!pending) {
      errors.push({ line: token.line, message: 'Answer with no question before it — skipped.' });
      continue;
    }

    // Each part is tidied before joining, or the newline the boundary left on
    // the end of the first part would show up as a blank line in the answer.
    pending.answer = pending.answer.trim()
      ? `${tidy(pending.answer)}\n${tidy(token.text)}`
      : token.text;
  }

  closePending();

  return {
    cards,
    errors,
    ignoredPreamble: preambleEnd === null ? '' : source.slice(0, preambleEnd).trim(),
  };
}

/** Splits into batches the bulk endpoint will accept in one request. */
export function batched(cards, size = MAX_CARDS_PER_IMPORT) {
  const batches = [];
  for (let i = 0; i < cards.length; i += size) batches.push(cards.slice(i, i + size));
  return batches;
}

/** 1-based line number of a character offset. */
function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/**
 * Trims the field without flattening it: internal newlines are what makes a
 * multi-line answer readable on the card, so only the edges and trailing
 * spaces on each line go.
 */
function tidy(value) {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/** The example shown in the UI, so the syntax is visible before it is typed. */
export const PARSER_EXAMPLE = [
  '/q: What is the capital of France?',
  '/a: Paris',
  '',
  '/q: Name the three branches of government',
  '/a: Legislative, executive and judicial',
].join('\n');
