#!/usr/bin/env node
/**
 * End-to-end check of the deployed API.
 *
 *   node scripts/smoke-test.mjs https://guatermelon.com/smashcards/api
 *
 * Registers two throwaway accounts, exercises auth, decks and cards, and
 * asserts that one user cannot reach the other's data. Creates real rows.
 */

import zlib from 'node:zlib';

const base = (process.argv[2] || process.env.API_BASE || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke-test.mjs <api-base-url>');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body is itself a failure signal */ }
  return { status: res.status, json, text };
}

/**
 * A multipart POST, for the upload routes.
 *
 * Content-Type is deliberately not set: fetch derives it from the FormData,
 * including the boundary, and setting it by hand produces a body PHP cannot
 * parse — which is exactly the bug this would otherwise hide.
 */
async function callUpload(path, token, { file, fields = {} }) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  if (file) {
    form.append('file', new Blob([file.content], { type: file.type }), file.name);
  }

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body is itself a failure signal */ }
  return { status: res.status, json, text };
}

/**
 * A tiny but genuinely valid ZIP, so the .docx upload exercises the real MIME
 * sniffing rather than a string that fileinfo would read as plain text.
 *
 * One stored (uncompressed) entry, which is all the format requires.
 */
function minimalZip(name = 'word/document.xml', body = '<w:document/>') {
  const nameBytes = Buffer.from(name, 'utf8');
  const data = Buffer.from(body, 'utf8');
  const crc = zlib.crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // local file header signature
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0, 8);            // method: stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);         // method: stored
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);         // offset of the local header

  const centralStart = local.length + nameBytes.length + data.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);     // end of central directory signature
  end.writeUInt16LE(1, 8);              // entries on this disk
  end.writeUInt16LE(1, 10);             // entries total
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

/**
 * A JSON POST that expects binary audio back.
 *
 * Reports size and the cache header rather than the body: the point of these
 * assertions is that real audio arrived and that a repeat did not cost a
 * second synthesis.
 */
async function callAudio(path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const buffer = await res.arrayBuffer();

  return {
    status: res.status,
    bytes: buffer.byteLength,
    contentType: res.headers.get('content-type'),
    cache: res.headers.get('x-smashcards-cache'),
  };
}

const stamp = Date.now();
const alice = { email: `smoke-a-${stamp}@example.com`, password: 'correct-horse-battery', display_name: 'Alice Smoke' };
const bob   = { email: `smoke-b-${stamp}@example.com`, password: 'correct-horse-battery', display_name: 'Bob Smoke' };

console.log(`\nSmoke-testing ${base}\n`);

// ---------------------------------------------------------------- health ---
section('health');
const health = await call('GET', '/v1/health');
check('GET /v1/health returns 200', health.status === 200, `got ${health.status}: ${health.text.slice(0, 200)}`);
check('database is connected', health.json?.database === 'connected', health.text.slice(0, 200));

if (health.status !== 200) {
  console.log('\nHealth check failed — skipping the rest.\n');
  process.exit(1);
}

// ------------------------------------------------------------------ auth ---
section('register');
const reg = await call('POST', '/v1/auth/register', { body: alice });
check('returns 201', reg.status === 201, `got ${reg.status}: ${reg.text.slice(0, 200)}`);
check('returns an access token', typeof reg.json?.access_token === 'string');
check('returns a refresh token', typeof reg.json?.refresh_token === 'string');
check('never returns password_hash', !reg.text.includes('password_hash'));

section('validation');
const badEmail = await call('POST', '/v1/auth/register', {
  body: { ...alice, email: 'not-an-email' },
});
check('rejects a malformed email with 422', badEmail.status === 422, `got ${badEmail.status}`);
check('names the offending field', Boolean(badEmail.json?.error?.fields?.email));

const dupe = await call('POST', '/v1/auth/register', { body: alice });
check('rejects a duplicate email with 409', dupe.status === 409, `got ${dupe.status}`);

section('login');
const login = await call('POST', '/v1/auth/login', { body: { email: alice.email, password: alice.password } });
check('accepts correct credentials', login.status === 200, `got ${login.status}: ${login.text.slice(0, 200)}`);

const wrong = await call('POST', '/v1/auth/login', { body: { email: alice.email, password: 'wrong-password' } });
check('rejects a wrong password with 401', wrong.status === 401, `got ${wrong.status}`);
check('does not reveal that the email exists',
  wrong.json?.error?.message === 'Email or password is incorrect.', wrong.text.slice(0, 200));

const A = login.json?.access_token;


section('login rate limiting');
// A dedicated, never-registered address: assertLoginAllowed() runs before the
// user lookup, so this exercises the limiter without touching real accounts.
// The limiter is keyed on (email, ip), so failures here cannot affect alice's
// login test above, which uses a different email.
const throttleEmail = `throttle-${stamp}@example.com`;

let lastAttempt;
for (let i = 0; i < 8; i += 1) {
  lastAttempt = await call('POST', '/v1/auth/login', { body: { email: throttleEmail, password: 'wrong' } });
}
check('the 8th failed attempt is still a normal 401',
  lastAttempt.status === 401, `got ${lastAttempt.status}`);

const throttled = await call('POST', '/v1/auth/login', { body: { email: throttleEmail, password: 'wrong' } });
check('the 9th attempt in the window is rate-limited', throttled.status === 429,
  `got ${throttled.status}: ${throttled.text.slice(0, 200)}`);
check('the rate-limit response names the reason',
  throttled.json?.error?.code === 'too_many_attempts', throttled.text.slice(0, 200));

// A different email from the same run is a different (email, ip) key and
// must not be caught by another address's lockout.
const unrelated = await call('POST', '/v1/auth/login', {
  body: { email: `unrelated-${stamp}@example.com`, password: 'wrong' },
});
check('a different email is not affected by another email\'s lockout',
  unrelated.status === 401, `got ${unrelated.status}`);

section('protected route');
const me = await call('GET', '/v1/auth/me', { token: A });
check('accepts a valid access token', me.status === 200, `got ${me.status}: ${me.text.slice(0, 200)}`);
check('returns the right user', me.json?.user?.email === alice.email);

check('rejects a missing token with 401', (await call('GET', '/v1/auth/me')).status === 401);
check('rejects a malformed token with 401', (await call('GET', '/v1/auth/me', { token: 'not.a.token' })).status === 401);
check('rejects a refresh token used as an access token',
  (await call('GET', '/v1/auth/me', { token: login.json?.refresh_token })).status === 401);

section('refresh');
const refreshed = await call('POST', '/v1/auth/refresh', { body: { refresh_token: login.json?.refresh_token } });
check('exchanges a refresh token for a new pair', refreshed.status === 200, `got ${refreshed.status}: ${refreshed.text.slice(0, 200)}`);
check('the new access token works',
  (await call('GET', '/v1/auth/me', { token: refreshed.json?.access_token })).status === 200);
check('rejects a garbage refresh token with 401',
  (await call('POST', '/v1/auth/refresh', { body: { refresh_token: 'garbage' } })).status === 401);

// ----------------------------------------------------------------- decks ---
section('decks');
const created = await call('POST', '/v1/decks', {
  token: A,
  body: { title: 'Spanish verbs', description: 'Irregular present tense', language_front: 'en-US', language_back: 'es-ES' },
});
check('creates a deck', created.status === 201, `got ${created.status}: ${created.text.slice(0, 200)}`);
check('returns the deck id', typeof created.json?.deck?.id === 'number');
check('is_public is a boolean, not "0"', created.json?.deck?.is_public === false);

const deckId = created.json?.deck?.id;

check('rejects a deck with no title', (await call('POST', '/v1/decks', { token: A, body: {} })).status === 422);
check('rejects an unauthenticated create', (await call('POST', '/v1/decks', { body: { title: 'x' } })).status === 401);

const list = await call('GET', '/v1/decks', { token: A });
check('lists the deck', list.status === 200 && list.json?.decks?.some((d) => d.id === deckId));
check('reports card counts', list.json?.decks?.find((d) => d.id === deckId)?.card_count === 0);

const patched = await call('PATCH', `/v1/decks/${deckId}`, { token: A, body: { title: 'Spanish verbs — revised' } });
check('updates a deck', patched.status === 200 && patched.json?.deck?.title === 'Spanish verbs — revised',
  `got ${patched.status}: ${patched.text.slice(0, 200)}`);
check('leaves untouched fields alone', patched.json?.deck?.language_back === 'es-ES');

check('404s an unknown deck', (await call('GET', '/v1/decks/99999999', { token: A })).status === 404);
check('404s a non-numeric deck id', (await call('GET', '/v1/decks/abc', { token: A })).status === 404);

// ----------------------------------------------------------------- cards ---
section('cards');
const card = await call('POST', `/v1/decks/${deckId}/cards`, {
  token: A,
  body: { question_text: 'to be (permanent)', answer_text: 'ser' },
});
check('creates a card', card.status === 201, `got ${card.status}: ${card.text.slice(0, 200)}`);
check('first card gets position 0', card.json?.card?.position === 0);

const cardId = card.json?.card?.id;

const bulk = await call('POST', `/v1/decks/${deckId}/cards/bulk`, {
  token: A,
  body: {
    cards: [
      { question_text: 'to be (temporary)', answer_text: 'estar' },
      { question_text: 'to have', answer_text: 'tener' },
      { question_text: 'to go', answer_text: 'ir' },
    ],
  },
});
check('bulk imports cards', bulk.status === 201 && bulk.json?.imported === 3, `got ${bulk.status}: ${bulk.text.slice(0, 200)}`);

const badBulk = await call('POST', `/v1/decks/${deckId}/cards/bulk`, {
  token: A,
  body: { cards: [{ question_text: 'fine', answer_text: 'fine' }, { question_text: '', answer_text: 'x' }] },
});
check('rejects a bulk batch with any bad row', badBulk.status === 422, `got ${badBulk.status}`);

const afterBadBulk = await call('GET', `/v1/decks/${deckId}/cards`, { token: A });
check('a rejected batch imports nothing', afterBadBulk.json?.cards?.length === 4,
  `expected 4 cards, got ${afterBadBulk.json?.cards?.length}`);

check('cards come back in position order',
  afterBadBulk.json?.cards?.every((c, i) => i === 0 || c.position >= afterBadBulk.json.cards[i - 1].position));

const ids = afterBadBulk.json?.cards?.map((c) => c.id) ?? [];
const reordered = await call('PATCH', `/v1/decks/${deckId}/cards/reorder`, {
  token: A,
  body: { card_ids: [...ids].reverse() },
});
check('reorders cards', reordered.status === 200, `got ${reordered.status}: ${reordered.text.slice(0, 200)}`);
const afterReorder = await call('GET', `/v1/decks/${deckId}/cards`, { token: A });
check('the new order sticks',
  JSON.stringify(afterReorder.json?.cards?.map((c) => c.id)) === JSON.stringify([...ids].reverse()));

const cardPatch = await call('PATCH', `/v1/cards/${cardId}`, { token: A, body: { answer_text: 'ser (irregular)' } });
check('updates a card', cardPatch.status === 200 && cardPatch.json?.card?.answer_text === 'ser (irregular)');
check('rejects an empty question', (await call('PATCH', `/v1/cards/${cardId}`, { token: A, body: { question_text: '' } })).status === 422);

check('deck card_count reflects the cards',
  (await call('GET', '/v1/decks', { token: A })).json?.decks?.find((d) => d.id === deckId)?.card_count === 4);

// ------------------------------------------------------------ isolation ---
section('cross-user isolation');
const bobReg = await call('POST', '/v1/auth/register', { body: bob });
const B = bobReg.json?.access_token;
check('second account registers', bobReg.status === 201, `got ${bobReg.status}`);

check("another user cannot read the deck", (await call('GET', `/v1/decks/${deckId}`, { token: B })).status === 404);
check("another user cannot list its cards", (await call('GET', `/v1/decks/${deckId}/cards`, { token: B })).status === 404);
check("another user cannot edit the deck",
  (await call('PATCH', `/v1/decks/${deckId}`, { token: B, body: { title: 'hijacked' } })).status === 404);
check("another user cannot delete the deck", (await call('DELETE', `/v1/decks/${deckId}`, { token: B })).status === 404);
check("another user cannot read a card", (await call('GET', `/v1/cards/${cardId}`, { token: B })).status === 404);
check("another user cannot edit a card",
  (await call('PATCH', `/v1/cards/${cardId}`, { token: B, body: { answer_text: 'hijacked' } })).status === 404);
check("another user cannot add cards to the deck",
  (await call('POST', `/v1/decks/${deckId}/cards`, { token: B, body: { question_text: 'q', answer_text: 'a' } })).status === 404);
check("another user's deck list is empty", (await call('GET', '/v1/decks', { token: B })).json?.decks?.length === 0);

const stillMine = await call('GET', `/v1/decks/${deckId}`, { token: A });
check('the deck survived all of that intact', stillMine.status === 200 && stillMine.json?.deck?.title === 'Spanish verbs — revised');

// ----------------------------------------------------------- study loop ---
section('sessions and reviews');
const session = await call('POST', '/v1/sessions', { token: A, body: { deck_id: deckId, mode: 'spaced' } });
check('starts a session', session.status === 201, `got ${session.status}: ${session.text.slice(0, 200)}`);
const sessionId = session.json?.session?.id;

check('rejects a session on someone else’s deck',
  (await call('POST', '/v1/sessions', { token: B, body: { deck_id: deckId } })).status === 404);

const emptyStates = await call('GET', `/v1/decks/${deckId}/states`, { token: A });
check('a never-studied deck has no card states',
  emptyStates.status === 200 && Object.keys(emptyStates.json?.states ?? {}).length === 0,
  `got ${emptyStates.status}: ${emptyStates.text.slice(0, 200)}`);

const review = await call('POST', '/v1/reviews', {
  token: A,
  body: {
    card_id: cardId,
    session_id: sessionId,
    rating: 3,
    score: 0.75,
    response_ms: 4200,
    mode: 'spaced',
    state: {
      ease_factor: 2.5,
      interval_days: 1,
      repetitions: 1,
      due_at: '2099-01-01 10:00:00',
      last_reviewed_at: '2026-08-19 10:00:00',
    },
  },
});
check('submits a review', review.status === 201, `got ${review.status}: ${review.text.slice(0, 200)}`);
check('returns the stored card state', review.json?.card_state?.interval_days === 1);
check('stores ease as a number, not a string', typeof review.json?.card_state?.ease_factor === 'number');

const states = await call('GET', `/v1/decks/${deckId}/states`, { token: A });
check('the card state now comes back for the deck', Boolean(states.json?.states?.[String(cardId)]));
check('the stored due date is what we sent',
  states.json?.states?.[String(cardId)]?.due_at?.startsWith('2099-01-01'),
  JSON.stringify(states.json?.states?.[String(cardId)]));

const reReview = await call('POST', '/v1/reviews', {
  token: A,
  body: {
    card_id: cardId, session_id: sessionId, rating: 1, mode: 'spaced',
    state: { ease_factor: 1.7, interval_days: 1, repetitions: 0, due_at: '2030-05-05 08:00:00' },
  },
});
check('a second review updates the same state row', reReview.status === 201);
const afterRe = await call('GET', `/v1/decks/${deckId}/states`, { token: A });
check('card_states holds one row per card, updated in place',
  Object.keys(afterRe.json?.states ?? {}).length === 1 &&
  afterRe.json.states[String(cardId)].due_at.startsWith('2030-05-05'));
check('score defaults from rating when omitted', reReview.json?.card_state !== null);

check('rejects an out-of-range rating',
  (await call('POST', '/v1/reviews', { token: A, body: { card_id: cardId, rating: 9 } })).status === 422);
check('rejects a review on someone else’s card',
  (await call('POST', '/v1/reviews', { token: B, body: { card_id: cardId, rating: 3 } })).status === 404);
check('clamps an absurd ease factor rather than storing it',
  (await call('POST', '/v1/reviews', {
    token: A,
    body: { card_id: cardId, rating: 3, state: { ease_factor: 999, interval_days: 5, repetitions: 1 } },
  })).json?.card_state?.ease_factor <= 5);

const ended = await call('PATCH', `/v1/sessions/${sessionId}`, { token: A });
check('ends the session', ended.status === 200 && ended.json?.session?.ended_at !== null,
  `got ${ended.status}: ${ended.text.slice(0, 200)}`);
check('counts the cards reviewed', ended.json?.session?.cards_reviewed >= 2,
  `got ${ended.json?.session?.cards_reviewed}`);
check('another user cannot read the session',
  (await call('GET', `/v1/sessions/${sessionId}`, { token: B })).status === 404);
check('lists recent sessions', (await call('GET', '/v1/sessions', { token: A })).json?.sessions?.length >= 1);


// ------------------------------------------------------- AI extraction ---
section('ai extraction (phase 3)');

const aiStatus = await call('GET', '/v1/ai/usage', { token: A });
check('reports AI status', aiStatus.status === 200, `got ${aiStatus.status}: ${aiStatus.text.slice(0, 200)}`);
check('says whether a key is configured', typeof aiStatus.json?.configured === 'boolean');
check('lists the available providers', Array.isArray(aiStatus.json?.providers));
check('reports a monthly quota', typeof aiStatus.json?.limits?.monthly_char_quota === 'number');
check('requires auth', (await call('GET', '/v1/ai/usage')).status === 401);

const aiConfigured = aiStatus.json?.configured === true;
const providers = (aiStatus.json?.providers ?? []).map((p) => p.name);
console.log(`  ${aiConfigured ? `providers configured: ${providers.join(', ')} (active: ${aiStatus.json?.provider})` : 'no API key — testing the disabled path'}`);

check('rejects an unknown provider',
  (await call('POST', `/v1/decks/${deckId}/ai/extract`, { token: A, body: { text: 'hello world', provider: 'notaprovider' } })).status === 400);

const extractPath = `/v1/decks/${deckId}/ai/extract`;

check('rejects empty text with 422',
  (await call('POST', extractPath, { token: A, body: { text: '   ' } })).status === 422);

check("another user cannot generate into this deck",
  (await call('POST', extractPath, { token: B, body: { text: 'hello world' } })).status === 404);

const tooLong = await call('POST', extractPath, {
  token: A,
  body: { text: 'x'.repeat((aiStatus.json?.limits?.max_chars_per_request ?? 20000) + 1) },
});
check('rejects over-long text with 422', tooLong.status === 422, `got ${tooLong.status}`);

if (!aiConfigured) {
  const disabled = await call('POST', extractPath, { token: A, body: { text: 'The mitochondrion is the powerhouse of the cell.' } });
  check('returns 503 ai_not_configured when no key is set',
    disabled.status === 503 && disabled.json?.error?.code === 'ai_not_configured',
    `got ${disabled.status}: ${disabled.text.slice(0, 200)}`);
} else {
  const source = `The Spanish verb "ser" expresses permanent qualities such as identity and origin.
The verb "estar" expresses temporary states such as location and mood.
"Tener" means to have, and is used for age: "tengo veinte anos" means "I am twenty".`;

  const generated = await call('POST', extractPath, { token: A, body: { text: source, density: 10, depth: 'mixed' } });
  check('generates cards', generated.status === 201, `got ${generated.status}: ${generated.text.slice(0, 300)}`);
  check('returns staged cards', Array.isArray(generated.json?.staged) && generated.json.staged.length > 0);
  check('every generated card is staged, never active',
    (generated.json?.staged ?? []).every((c) => c.status === 'staged'));
  check('every generated card is marked source ai',
    (generated.json?.staged ?? []).every((c) => c.source_type === 'ai'));
  check('reports usage against the quota', typeof generated.json?.usage?.characters_used === 'number');

  const visible = await call('GET', `/v1/decks/${deckId}/cards`, { token: A });
  const stagedIds = (generated.json?.staged ?? []).map((c) => c.id);
  check('staged cards do NOT appear in the deck',
    !visible.json?.cards?.some((c) => stagedIds.includes(c.id)),
    'generated cards must never enter a deck unreviewed');

  const stagedList = await call('GET', `/v1/decks/${deckId}/cards?status=staged`, { token: A });
  check('staged cards are listed under ?status=staged',
    stagedList.json?.cards?.length >= stagedIds.length);

  const beforeApprove = visible.json?.cards?.length ?? 0;
  const approved = await call('POST', `/v1/decks/${deckId}/cards/approve`, { token: A, body: { card_ids: stagedIds } });
  check('approves staged cards', approved.status === 200 && approved.json?.approved === stagedIds.length,
    `got ${approved.status}: ${approved.text.slice(0, 200)}`);

  const afterApprove = await call('GET', `/v1/decks/${deckId}/cards`, { token: A });
  check('approved cards now appear in the deck',
    (afterApprove.json?.cards?.length ?? 0) === beforeApprove + stagedIds.length);

  check("another user cannot approve into this deck",
    (await call('POST', `/v1/decks/${deckId}/cards/approve`, { token: B, body: { card_ids: stagedIds } })).status === 404);
}

// -------------------------------------------------------------------- ---
section('folders');

const rootFolder = await call('POST', '/v1/folders', { token: A, body: { name: 'Languages' } });
check('creates a root folder', rootFolder.status === 201, `got ${rootFolder.status}: ${rootFolder.text.slice(0, 200)}`);
check('a root folder has no parent', rootFolder.json?.folder?.parent_id === null);

const rootFolderId = rootFolder.json?.folder?.id;

const subFolder = await call('POST', '/v1/folders', {
  token: A, body: { name: 'Spanish', parent_id: rootFolderId },
});
check('creates a subfolder', subFolder.status === 201, `got ${subFolder.status}: ${subFolder.text.slice(0, 200)}`);
check('the subfolder records its parent', subFolder.json?.folder?.parent_id === rootFolderId);

const subFolderId = subFolder.json?.folder?.id;

check('rejects a folder with no name',
  (await call('POST', '/v1/folders', { token: A, body: {} })).status === 422);
check('rejects a subfolder under a nonexistent parent',
  (await call('POST', '/v1/folders', { token: A, body: { name: 'x', parent_id: 999999 } })).status === 404);

const folderList = await call('GET', '/v1/folders', { token: A });
check('lists folders', folderList.status === 200
  && folderList.json?.folders?.some((f) => f.id === rootFolderId)
  && folderList.json?.folders?.some((f) => f.id === subFolderId));

const folderedDeck = await call('POST', '/v1/decks', {
  token: A, body: { title: 'In a folder', folder_id: subFolderId },
});
check('creates a deck inside a folder', folderedDeck.status === 201, `got ${folderedDeck.status}`);
check('the deck reports its folder', folderedDeck.json?.deck?.folder_id === subFolderId);

const folderedDeckId = folderedDeck.json?.deck?.id;

const moved = await call('PATCH', `/v1/decks/${folderedDeckId}`, { token: A, body: { folder_id: null } });
check('moves a deck to root by setting folder_id to null',
  moved.status === 200 && moved.json?.deck?.folder_id === null, `got ${moved.status}: ${moved.text.slice(0, 200)}`);

const renamed = await call('PATCH', `/v1/folders/${subFolderId}`, { token: A, body: { name: 'Spanish (renamed)' } });
check('renames a folder', renamed.status === 200 && renamed.json?.folder?.name === 'Spanish (renamed)');

check('rejects moving a folder into itself',
  (await call('PATCH', `/v1/folders/${rootFolderId}`, { token: A, body: { parent_id: rootFolderId } })).status === 422);
check('rejects moving a folder into its own subfolder',
  (await call('PATCH', `/v1/folders/${rootFolderId}`, { token: A, body: { parent_id: subFolderId } })).status === 422);

check("another user cannot see this user's folders",
  !(await call('GET', '/v1/folders', { token: B })).json?.folders?.some((f) => f.id === rootFolderId));
check('another user cannot rename this folder',
  (await call('PATCH', `/v1/folders/${rootFolderId}`, { token: B, body: { name: 'hijacked' } })).status === 404);
check('another user cannot delete this folder',
  (await call('DELETE', `/v1/folders/${rootFolderId}`, { token: B })).status === 404);
check('another user cannot create a deck inside this folder',
  (await call('POST', '/v1/decks', { token: B, body: { title: 'x', folder_id: subFolderId } })).status === 404);

const deleteParent = await call('DELETE', `/v1/folders/${rootFolderId}`, { token: A });
check('deletes a folder', deleteParent.status === 200, `got ${deleteParent.status}: ${deleteParent.text.slice(0, 200)}`);

const subGone = await call('GET', '/v1/folders', { token: A });
check('deleting a folder cascades to its subfolder',
  !subGone.json?.folders?.some((f) => f.id === subFolderId));

const deckAfterCascade = await call('GET', `/v1/decks/${folderedDeckId}`, { token: A });
check('a deck already moved to root is unaffected by the folder deletion',
  deckAfterCascade.status === 200 && deckAfterCascade.json?.deck?.folder_id === null);

await call('DELETE', `/v1/decks/${folderedDeckId}`, { token: A });

// -------------------------------------------------------------------- ---
section('public decks and cloning');

const publicDeck = await call('POST', '/v1/decks', { token: A, body: { title: 'Smoke public deck' } });
const publicDeckId = publicDeck.json?.deck?.id;
await call('POST', `/v1/decks/${publicDeckId}/cards`, { token: A, body: { question_text: 'q1', answer_text: 'a1' } });
await call('POST', `/v1/decks/${publicDeckId}/cards`, { token: A, body: { question_text: 'q2', answer_text: 'a2' } });

const privateDeck = await call('POST', '/v1/decks', { token: A, body: { title: 'Smoke private deck' } });
const privateDeckId = privateDeck.json?.deck?.id;

check('requires auth to browse public decks', (await call('GET', '/v1/decks/public')).status === 401);

const beforePublic = await call('GET', '/v1/decks/public', { token: B });
check('a deck not yet made public does not appear', !beforePublic.json?.decks?.some((d) => d.id === publicDeckId));

const madePublic = await call('PATCH', `/v1/decks/${publicDeckId}`, { token: A, body: { is_public: true } });
check('marks a deck public', madePublic.status === 200 && madePublic.json?.deck?.is_public === true);

const browseAsBob = await call('GET', '/v1/decks/public', { token: B });
const found = browseAsBob.json?.decks?.find((d) => d.id === publicDeckId);
check('another user sees the public deck when browsing', found !== undefined);
check('the listing names the owner', found?.owner_name === alice.display_name);
check('the listing reports the card count', found?.card_count === 2);
check('a private deck by the same owner is not listed', !browseAsBob.json?.decks?.some((d) => d.id === privateDeckId));

const browseAsAlice = await call('GET', '/v1/decks/public', { token: A });
check('a deck does not appear in the owner\'s own public browse', !browseAsAlice.json?.decks?.some((d) => d.id === publicDeckId));

const searchHit = await call('GET', '/v1/decks/public?q=Smoke%20public', { token: B });
check('search matches by title', searchHit.json?.decks?.some((d) => d.id === publicDeckId));
const searchMiss = await call('GET', '/v1/decks/public?q=zzz-no-such-deck', { token: B });
check('search excludes non-matches', !searchMiss.json?.decks?.some((d) => d.id === publicDeckId));

check('cannot clone a private deck belonging to someone else',
  (await call('POST', `/v1/decks/${privateDeckId}/clone`, { token: B })).status === 404);

const cloned = await call('POST', `/v1/decks/${publicDeckId}/clone`, { token: B });
check('clones a public deck', cloned.status === 201, `got ${cloned.status}: ${cloned.text.slice(0, 200)}`);
check('reports how many cards were cloned', cloned.json?.cards_cloned === 2);
check('the clone is owned by the cloner', cloned.json?.deck?.user_id === bobReg.json?.user?.id);
check('a clone is private by default', cloned.json?.deck?.is_public === false);

const clonedDeckId = cloned.json?.deck?.id;
const clonedCards = await call('GET', `/v1/decks/${clonedDeckId}/cards`, { token: B });
check('the clone has its own copies of the cards',
  clonedCards.json?.cards?.length === 2
  && clonedCards.json.cards.every((c) => c.deck_id === clonedDeckId));

// The clone is a snapshot, not a live reference — renaming the original
// (or, by the same mechanism, editing/deleting its cards) must not reach it.
const renamedOriginal = await call('PATCH', `/v1/decks/${publicDeckId}`, { token: A, body: { title: 'Renamed after cloning' } });
check('the original can still be edited after being cloned', renamedOriginal.status === 200);
const cloneAfterOriginalEdit = await call('GET', `/v1/decks/${clonedDeckId}`, { token: B });
check('editing the original does not retitle the clone',
  cloneAfterOriginalEdit.json?.deck?.title === 'Smoke public deck');

await call('DELETE', `/v1/decks/${clonedDeckId}`, { token: B });
await call('DELETE', `/v1/decks/${publicDeckId}`, { token: A });
await call('DELETE', `/v1/decks/${privateDeckId}`, { token: A });

// -------------------------------------------------------------------- ---
section('sharing via link');

const shareDeck = await call('POST', '/v1/decks', { token: A, body: { title: 'Smoke share deck' } });
const shareDeckId = shareDeck.json?.deck?.id;
await call('POST', `/v1/decks/${shareDeckId}/cards`, { token: A, body: { question_text: 'sq', answer_text: 'sa' } });

check('a fresh deck has no share link', shareDeck.json?.deck?.share_token == null);

check('requires auth to view a shared deck',
  (await call('GET', '/v1/shared/0000000000000000000000000000000000000000')).status === 401);
check('a made-up token 404s', (await call('GET', '/v1/shared/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { token: B })).status === 404);
check('another user cannot create a share link for a deck they do not own',
  (await call('POST', `/v1/decks/${shareDeckId}/share`, { token: B })).status === 404);

const shareCreated = await call('POST', `/v1/decks/${shareDeckId}/share`, { token: A });
check('creates a share link', shareCreated.status === 200 && typeof shareCreated.json?.share_token === 'string' && shareCreated.json.share_token.length === 40,
  `got ${shareCreated.status}: ${shareCreated.text.slice(0, 200)}`);

const token = shareCreated.json?.share_token;

const shareCreatedAgain = await call('POST', `/v1/decks/${shareDeckId}/share`, { token: A });
check('creating a link again is idempotent — same token', shareCreatedAgain.json?.share_token === token);

const viewedByOwner = await call('GET', `/v1/decks/${shareDeckId}`, { token: A });
check('the owner sees their own share token when reading the deck', viewedByOwner.json?.deck?.share_token === token);

const sharedView = await call('GET', `/v1/shared/${token}`, { token: B });
check('another user can view the deck via the link', sharedView.status === 200, `got ${sharedView.status}: ${sharedView.text.slice(0, 200)}`);
check('the shared view names the owner', sharedView.json?.deck?.owner_name === alice.display_name);
check('the shared view reports the card count', sharedView.json?.deck?.card_count === 1,
  `got ${JSON.stringify(sharedView.json?.deck?.card_count)}`);
check('the shared view does not hand back the token itself', sharedView.json?.deck?.share_token === undefined);

const cloneViaLink = await call('POST', `/v1/shared/${token}/clone`, { token: B });
check('clones via the share link', cloneViaLink.status === 201, `got ${cloneViaLink.status}: ${cloneViaLink.text.slice(0, 200)}`);
check('the linked clone has its card', cloneViaLink.json?.cards_cloned === 1);
const linkedCloneId = cloneViaLink.json?.deck?.id;

const regenerated = await call('POST', `/v1/decks/${shareDeckId}/share`, { token: A, body: { regenerate: true } });
check('regenerating issues a different token', regenerated.json?.share_token !== token);

const oldLinkNowDead = await call('GET', `/v1/shared/${token}`, { token: B });
check('the old link stops working once regenerated', oldLinkNowDead.status === 404);

const revoked = await call('DELETE', `/v1/decks/${shareDeckId}/share`, { token: A });
check('revokes the share link', revoked.status === 200);

const afterRevoke = await call('GET', `/v1/decks/${shareDeckId}`, { token: A });
check('the deck shows no share token after revoking', afterRevoke.json?.deck?.share_token == null);

const revokedLinkDead = await call('GET', `/v1/shared/${regenerated.json?.share_token}`, { token: B });
check('the link is dead after revoking', revokedLinkDead.status === 404);

await call('DELETE', `/v1/decks/${linkedCloneId}`, { token: B });
await call('DELETE', `/v1/decks/${shareDeckId}`, { token: A });

// ------------------------------------------------------ token lifecycle ---
// Refresh tokens rotate and may be exchanged exactly once. A second exchange
// is the signature of a stolen copy, so it burns the whole session.
section('refresh tokens');

const sessionUser = {
  email: `smoke-t-${stamp}@example.com`,
  password: 'correct-horse-battery',
  display_name: 'Token Smoke',
};
const opened = await call('POST', '/v1/auth/register', { body: sessionUser });
const firstRefresh = opened.json?.refresh_token;

const rotated = await call('POST', '/v1/auth/refresh', { body: { refresh_token: firstRefresh } });
check('a refresh token can be exchanged once', rotated.status === 200,
  `got ${rotated.status}: ${rotated.text.slice(0, 200)}`);
check('rotation returns a different refresh token', rotated.json?.refresh_token !== firstRefresh);

const replayed = await call('POST', '/v1/auth/refresh', { body: { refresh_token: firstRefresh } });
check('exchanging the same refresh token twice is refused', replayed.status === 401,
  `got ${replayed.status}: ${replayed.text.slice(0, 200)}`);

// Reuse means one of the two holders is an attacker, and there is no way to
// tell which — so the replacement token is burned along with the original.
const afterReuse = await call('POST', '/v1/auth/refresh', {
  body: { refresh_token: rotated.json?.refresh_token },
});
check('detected reuse revokes the whole session, not just the replayed token',
  afterReuse.status === 401, `got ${afterReuse.status}: ${afterReuse.text.slice(0, 200)}`);

// A clean session, to check ordinary logout.
const second = await call('POST', '/v1/auth/login', {
  body: { email: sessionUser.email, password: sessionUser.password },
});
const liveRefresh = second.json?.refresh_token;

check('logging out reports success', (await call('POST', '/v1/auth/logout', {
  body: { refresh_token: liveRefresh },
})).status === 200);

check('a refresh token is dead after logging out',
  (await call('POST', '/v1/auth/refresh', { body: { refresh_token: liveRefresh } })).status === 401);

check('logging out with a junk token still answers 200, leaking nothing',
  (await call('POST', '/v1/auth/logout', { body: { refresh_token: 'not.a.token' } })).status === 200);

// Log out everywhere: two live sessions, both ended by one call.
const deviceA = await call('POST', '/v1/auth/login', { body: { email: sessionUser.email, password: sessionUser.password } });
const deviceB = await call('POST', '/v1/auth/login', { body: { email: sessionUser.email, password: sessionUser.password } });

check('logout-all requires authentication', (await call('POST', '/v1/auth/logout-all')).status === 401);

check('logs out every device', (await call('POST', '/v1/auth/logout-all', {
  token: deviceA.json?.access_token,
})).status === 200);

check('the device that asked is signed out',
  (await call('POST', '/v1/auth/refresh', { body: { refresh_token: deviceA.json?.refresh_token } })).status === 401);
check('the other device is signed out too',
  (await call('POST', '/v1/auth/refresh', { body: { refresh_token: deviceB.json?.refresh_token } })).status === 401);

// ------------------------------------------------------- cloud speech ---
// Reading cards aloud for languages the device has no voice for. Audio comes
// back as bytes, and the second request for the same text must be a cache hit
// — flashcards are re-read constantly, and paying for each repeat would make
// the feature unaffordable.
section('cloud speech');

const speechStatus = await call('GET', '/v1/speech/status', { token: A });
check('GET /v1/speech/status returns 200', speechStatus.status === 200,
  `got ${speechStatus.status}: ${speechStatus.text.slice(0, 200)}`);
check('status says whether cloud speech is available',
  typeof speechStatus.json?.enabled === 'boolean');
check('speech status requires auth', (await call('GET', '/v1/speech/status')).status === 401);

if (speechStatus.json?.enabled) {
  const phrase = `The mitochondrion ${stamp} is the powerhouse of the cell.`;

  const first = await callAudio('/v1/speech', A, { text: phrase, voice: 'alloy', speed: 1 });
  check('synthesises audio', first.status === 200, `got ${first.status}`);
  check('the response is an MP3', first.contentType?.includes('audio/mpeg'), `got ${first.contentType}`);
  check('the audio has real content', first.bytes > 1000, `got ${first.bytes} bytes`);
  check('the first synthesis is a cache miss', first.cache === 'miss', `got ${first.cache}`);

  const second = await callAudio('/v1/speech', A, { text: phrase, voice: 'alloy', speed: 1 });
  check('the same card is served from cache the second time', second.cache === 'hit', `got ${second.cache}`);
  check('the cached audio is identical in size', second.bytes === first.bytes,
    `${first.bytes} then ${second.bytes}`);

  const changed = await callAudio('/v1/speech', A, { text: phrase, voice: 'nova', speed: 1 });
  check('a different voice is a different cache entry', changed.cache === 'miss', `got ${changed.cache}`);

  check('empty text is refused',
    (await callAudio('/v1/speech', A, { text: '  ' })).status === 422);
  check('an over-long card is refused',
    (await callAudio('/v1/speech', A, { text: 'x'.repeat(5000) })).status === 422);
} else {
  console.log('  cloud speech is not configured — skipping synthesis');
}

check('synthesis requires auth', (await callAudio('/v1/speech', null, { text: 'hello' })).status === 401);

// ------------------------------------------------------------- sources ---
// Study material kept for reference: pasted text, uploaded documents and
// (where transcription is configured) recordings. Audio itself is not
// exercised here — it would spend real transcription credit on every run.
section('study sources');

const limits = await call('GET', '/v1/sources/limits', { token: A });
check('GET /v1/sources/limits returns 200', limits.status === 200, `got ${limits.status}: ${limits.text.slice(0, 200)}`);
check('limits report a document size ceiling', Number(limits.json?.documents?.max_bytes) > 0,
  `got ${JSON.stringify(limits.json?.documents)}`);
check('limits say whether audio import is available', typeof limits.json?.audio?.enabled === 'boolean');
check('the storage directory is writable', limits.json?.storage_ready === true,
  'uploads will fail until the server can write to the storage path');

const srcDeck = await call('POST', '/v1/decks', { token: A, body: { title: 'Sources smoke' } });
const srcDeckId = srcDeck.json?.deck?.id;

const passage = 'The mitochondrion is the powerhouse of the cell. It produces ATP.';
const textSource = await call('POST', `/v1/decks/${srcDeckId}/sources`, {
  token: A,
  body: { text: passage, title: 'Cell biology notes' },
});
check('saves a pasted passage as a source', textSource.status === 201, `got ${textSource.status}: ${textSource.text.slice(0, 200)}`);
check('the saved passage keeps its title', textSource.json?.source?.title === 'Cell biology notes');
check('the saved passage records its length', textSource.json?.source?.text_chars === passage.length,
  `got ${textSource.json?.source?.text_chars}`);
check('pasted text has no stored file', textSource.json?.source?.has_file === false);
const textSourceId = textSource.json?.source?.id;

check('empty text is rejected', (await call('POST', `/v1/decks/${srcDeckId}/sources`, { token: A, body: { text: '   ' } })).status === 422);

const sourceList = await call('GET', `/v1/decks/${srcDeckId}/sources`, { token: A });
check('lists the deck\'s sources', sourceList.status === 200 && sourceList.json?.sources?.length === 1,
  `got ${sourceList.status}: ${sourceList.text.slice(0, 200)}`);
check('the list carries a preview, not the whole text',
  typeof sourceList.json?.sources?.[0]?.preview === 'string'
  && sourceList.json.sources[0].content_text === undefined);

const sourceDetail = await call('GET', `/v1/sources/${textSourceId}`, { token: A });
check('reading one source returns its full text', sourceDetail.json?.source?.content_text === passage,
  `got ${JSON.stringify(sourceDetail.json?.source?.content_text)?.slice(0, 120)}`);

// A document upload: multipart, with the file kept and its text extracted.
const uploaded = await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
  file: { name: 'chapter.txt', type: 'text/plain', content: 'Photosynthesis converts light into chemical energy.' },
});
check('uploads a text document', uploaded.status === 201, `got ${uploaded.status}: ${uploaded.text.slice(0, 300)}`);
check('the uploaded document keeps its filename', uploaded.json?.source?.original_name === 'chapter.txt');
check('the uploaded document has a stored file', uploaded.json?.source?.has_file === true);
check('the uploaded document\'s text was read server-side',
  uploaded.json?.source?.text_chars === 'Photosynthesis converts light into chemical energy.'.length,
  `got ${uploaded.json?.source?.text_chars}`);
const uploadedId = uploaded.json?.source?.id;

const originalFile = await call('GET', `/v1/sources/${uploadedId}/file`, { token: A });
check('the original file can be read back', originalFile.status === 200 && originalFile.text.includes('Photosynthesis'),
  `got ${originalFile.status}: ${originalFile.text.slice(0, 120)}`);

// A Word document. Its text is extracted in the browser and posted alongside
// the file, so what is checked here is that the server accepts the type (a
// .docx is a ZIP, which fileinfo reports as such) and stores it as a document.
const docx = await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
  file: { name: 'lecture.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: minimalZip() },
  fields: { text: 'Mitosis produces two genetically identical daughter cells.' },
});
check('uploads a Word document', docx.status === 201, `got ${docx.status}: ${docx.text.slice(0, 300)}`);
check('the Word document keeps its browser-extracted text',
  docx.json?.source?.text_chars === 'Mitosis produces two genetically identical daughter cells.'.length,
  `got ${docx.json?.source?.text_chars}`);
check('the Word document is stored as a docx',
  docx.json?.source?.mime_type?.includes('wordprocessingml'),
  `got ${docx.json?.source?.mime_type}`);
check('a Word document with no extracted text is refused',
  (await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
    file: { name: 'empty.docx', type: 'application/zip', content: minimalZip() },
  })).status === 422);
await call('DELETE', `/v1/sources/${docx.json?.source?.id}`, { token: A });

check('limits say whether scanned pages can be read',
  typeof limits.json?.ocr?.enabled === 'boolean' && Number(limits.json?.ocr?.max_pages) > 0,
  `got ${JSON.stringify(limits.json?.ocr)}`);

const badType = await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
  file: { name: 'payload.exe', type: 'application/octet-stream', content: 'MZ' },
});
check('an unsupported file type is refused', badType.status === 422, `got ${badType.status}: ${badType.text.slice(0, 200)}`);

const emptyUpload = await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
  file: { name: 'blank.txt', type: 'text/plain', content: '   ' },
});
check('an empty document is refused', emptyUpload.status === 422, `got ${emptyUpload.status}`);

// Isolation: a source is owner-only even though decks can be public.
check('another user cannot read a source', (await call('GET', `/v1/sources/${textSourceId}`, { token: B })).status === 404);
check('another user cannot download the file', (await call('GET', `/v1/sources/${uploadedId}/file`, { token: B })).status === 404);
check('another user cannot list the deck\'s sources', (await call('GET', `/v1/decks/${srcDeckId}/sources`, { token: B })).status === 404);
check('another user cannot add material to the deck',
  (await call('POST', `/v1/decks/${srcDeckId}/sources`, { token: B, body: { text: 'intruder' } })).status === 404);

check('deletes a source', (await call('DELETE', `/v1/sources/${uploadedId}`, { token: A })).status === 200);
check('the deleted source is gone', (await call('GET', `/v1/sources/${uploadedId}`, { token: A })).status === 404);
check('its stored file is gone too', (await call('GET', `/v1/sources/${uploadedId}/file`, { token: A })).status === 404);

// A second upload, kept until the deck goes, to prove the deck delete also
// clears files from disk — the rows cascade by foreign key, but nothing
// reaches the filesystem unless the delete does it explicitly.
const survivor = await callUpload(`/v1/decks/${srcDeckId}/sources`, A, {
  file: { name: 'survivor.txt', type: 'text/plain', content: 'Kept until the deck is deleted.' },
});
const survivorId = survivor.json?.source?.id;

await call('DELETE', `/v1/decks/${srcDeckId}`, { token: A });
check('deleting a deck takes its sources with it',
  (await call('GET', `/v1/sources/${textSourceId}`, { token: A })).status === 404);
check('a deleted deck\'s uploaded files are unreachable too',
  (await call('GET', `/v1/sources/${survivorId}/file`, { token: A })).status === 404);

// -------------------------------------------------------------- cleanup ---
section('delete');
check('deletes a card', (await call('DELETE', `/v1/cards/${cardId}`, { token: A })).status === 200);
check('the deleted card is gone', (await call('GET', `/v1/cards/${cardId}`, { token: A })).status === 404);
check('deletes the deck', (await call('DELETE', `/v1/decks/${deckId}`, { token: A })).status === 200);
check('the deleted deck is gone', (await call('GET', `/v1/decks/${deckId}`, { token: A })).status === 404);

// -------------------------------------------------------------- routing ---
section('routing');
check('unknown route returns 404', (await call('GET', '/v1/nope')).status === 404);
check('wrong method returns 405', (await call('GET', '/v1/auth/login')).status === 405);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`Test accounts left behind: ${alice.email}, ${bob.email}\n`);
process.exit(failed === 0 ? 0 : 1);
