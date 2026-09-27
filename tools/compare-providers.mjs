const BASE = 'https://guatermelon.com/smashcards/api';
const email = `provider-test-${Date.now()}@example.com`;
const password = 'correct-horse-battery';

const SOURCE = `The mitochondrion is an organelle found in most eukaryotic cells. It generates
most of the cell's supply of adenosine triphosphate (ATP), used as a source of chemical energy.
Mitochondria have their own genome, inherited maternally in humans, which supports the endosymbiotic
theory: that mitochondria descend from free-living bacteria engulfed by an ancestral cell. The inner
membrane is folded into cristae, which increase the surface area available for the electron transport
chain. Cells with high energy demands, such as muscle cells, contain far more mitochondria than others.`;

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const reg = await call('POST', '/v1/auth/register', { body: { email, password, display_name: 'Provider Test' } });
const token = reg.json.access_token;

const status = await call('GET', '/v1/ai/usage', { token });
console.log(`providers: ${status.json.providers.map((p) => p.label).join('  |  ')}\n`);

for (const p of status.json.providers) {
  const deck = await call('POST', '/v1/decks', { token, body: { title: `Test ${p.name}` } });
  const deckId = deck.json.deck.id;

  const t0 = Date.now();
  const gen = await call('POST', `/v1/decks/${deckId}/ai/extract`, {
    token, body: { text: SOURCE, density: 10, depth: 'mixed', provider: p.name },
  });
  const ms = Date.now() - t0;

  console.log(`── ${p.label}  (${(ms / 1000).toFixed(1)}s)`);
  if (gen.status !== 201) {
    console.log(`   FAILED ${gen.status}: ${gen.json?.error?.message}\n`);
  } else {
    for (const c of gen.json.staged) console.log(`   Q: ${c.question_text}\n   A: ${c.answer_text}`);
    console.log('');
  }
  await call('DELETE', `/v1/decks/${deckId}`, { token });
}
console.log(`(test account: ${email})`);
