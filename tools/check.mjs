#!/usr/bin/env node
/**
 * Verifies the live backend without SSH.
 *
 *   npm run check
 *
 * Calls the health endpoint, runs the server-side self test, prints one line
 * per assertion, and exits non-zero if anything failed.
 *
 * Also runs a DRIFT CHECK. The deck list's due/new counts are computed twice in
 * this project: once in SQL (api/v1/decks.php) and once in JavaScript
 * (src/scheduling/queue.js, used by the study screen). Two implementations of
 * the same rule drift eventually — usually at a boundary like "due exactly
 * now" or "state row exists but due_at is null". This recomputes the server's
 * numbers locally from the same raw rows and fails on any mismatch.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { queueStats } from '../src/scheduling/queue.js';
import { parseApiDate } from '../src/scheduling/sm2.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.deploy');

let passed = 0;
let failed = 0;

function report(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const env = loadEnv();
if (env) await main();

// Never process.exit(): with keep-alive sockets still open, forcing an exit
// trips a libuv assertion on Windows. Setting exitCode lets Node drain first.
process.exitCode = failed > 0 ? 1 : 0;

function loadEnv() {
  if (!existsSync(ENV_FILE)) {
    console.error('\nMissing .env.deploy — copy .env.deploy.example and fill it in.');
    console.error('(On Windows, check the file is not really named ".env.deploy.txt".)\n');
    failed = 1;
    return null;
  }
  const parsed = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

async function main() {
  const base = (env.API_BASE ?? '').replace(/\/$/, '');
  if (!base) {
    console.error('\nAPI_BASE is not set in .env.deploy.\n');
    failed += 1;
    return;
  }
  if (!env.OPS_KEY) {
    console.error('\nOPS_KEY is not set in .env.deploy.\n');
    failed += 1;
    return;
  }

  console.log(`\nChecking ${base}\n`);

  // ------------------------------------------------------------- health --
  console.log('health');
  const health = await fetchJson(`${base}/v1/health`);

  if (health.problem) {
    report('GET /v1/health', false, health.problem);
    console.log(`\n${passed} passed, ${failed} failed\n`);
    return;
  }

  report('API responds with JSON', health.status === 200, `HTTP ${health.status}`);
  report('database is connected', health.json?.database === 'connected');

  // ---------------------------------------------------------- self test --
  console.log('\nbackend self test');
  const selftest = await fetchJson(`${base}/ops/selftest.php`, { 'X-Ops-Key': env.OPS_KEY });

  if (selftest.problem) {
    report('self test reachable', false, selftest.problem);
  } else if (selftest.status === 403) {
    report('self test key accepted', false,
      'The server rejected OPS_KEY. It must match ops.selftest_key in api/config.php.');
  } else if (selftest.status === 503) {
    report('self test enabled', false,
      "The server has no ops key configured, so the endpoint refuses to run. Add 'ops' to api/config.php.");
  } else if (!selftest.json) {
    report('self test returns JSON', false, selftest.problem ?? `HTTP ${selftest.status}`);
  } else {
    for (const check of selftest.json.checks ?? []) {
      report(check.name, check.passed, check.detail);
    }

    // -------------------------------------------------------- drift --
    console.log('\ndrift: server SQL counts vs. client scheduling');
    const drift = selftest.json.drift;

    if (!drift) {
      report('drift data returned', false, 'the self test returned no drift payload');
    } else {
      const statesByCardId = {};
      for (const state of drift.states ?? []) {
        statesByCardId[String(state.card_id)] = state;
      }

      const now = parseApiDate(drift.now);
      const local = queueStats(drift.cards ?? [], statesByCardId, now);
      const server = drift.server_counts ?? {};

      report('card_count agrees', local.total === server.card_count,
        `client ${local.total} vs server ${server.card_count}`);
      report('due_count agrees', local.dueCount === server.due_count,
        `client ${local.dueCount} vs server ${server.due_count}`);
      report('new_count agrees', local.newCount === server.new_count,
        `client ${local.newCount} vs server ${server.new_count}`);
    }

    if (selftest.json.server) {
      console.log(`\n  server: PHP ${selftest.json.server.php}, ${selftest.json.server.time_utc}`);
      console.log(`  migrations applied: ${(selftest.json.server.migrations ?? []).join(', ') || 'none'}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

/**
 * Fetches JSON and turns the usual failures into plain language rather than
 * leaving a bare status code to be interpreted.
 */
async function fetchJson(url, headers = {}) {
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    return { problem: `Could not reach ${url} — ${error?.message ?? 'network error'}` };
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (text.trimStart().startsWith('<')) {
    return {
      status: response.status,
      problem: `${url} returned HTML, not JSON (HTTP ${response.status}). `
        + 'Either the path is wrong, the file is not on the server yet, or mod_rewrite '
        + 'is not active for that directory.',
    };
  }

  if (!text.trim()) {
    return {
      status: response.status,
      problem: `${url} returned an empty body (HTTP ${response.status}). `
        + 'That usually means a PHP fatal error — check the server error log.',
    };
  }

  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return {
      status: response.status,
      problem: `${url} returned unparseable content (${contentType || 'no content-type'}): `
        + text.slice(0, 160),
    };
  }
}
