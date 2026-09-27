#!/usr/bin/env node
/**
 * Triggers the server-side migration runner over HTTPS.
 *
 *   npm run migrate      applies pending migrations, then runs the checks
 *
 * The runner is idempotent: already-applied files are skipped, so running this
 * repeatedly is safe.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.deploy');

if (!existsSync(ENV_FILE)) {
  console.error('\nMissing .env.deploy — copy .env.deploy.example and fill it in.\n');
  process.exitCode = 2;
} else {
  const env = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  await run(env);
}

async function run(env) {
  const base = (env.API_BASE ?? '').replace(/\/$/, '');

  if (!base || !env.MIGRATE_KEY) {
    console.error('\nAPI_BASE and MIGRATE_KEY must both be set in .env.deploy.\n');
    process.exitCode = 2;
    return;
  }

  console.log(`\nApplying migrations on ${base}\n`);

  let response;
  try {
    response = await fetch(`${base}/ops/migrate.php`, {
      method: 'POST',
      headers: { 'X-Ops-Key': env.MIGRATE_KEY },
    });
  } catch (error) {
    console.error(`Could not reach the migration endpoint — ${error?.message ?? 'network error'}\n`);
    process.exitCode = 1;
    return;
  }

  const text = await response.text();

  if (text.trimStart().startsWith('<')) {
    console.error(`The migration endpoint returned HTML, not JSON (HTTP ${response.status}).`);
    console.error('api/ops/migrate.php is probably not uploaded yet, or the path is wrong.\n');
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`Unparseable response (HTTP ${response.status}): ${text.slice(0, 200)}\n`);
    process.exitCode = 1;
    return;
  }

  if (response.status === 403) {
    console.error('The server rejected MIGRATE_KEY.');
    console.error('It must match ops.migrate_key in api/config.php.\n');
    process.exitCode = 1;
    return;
  }

  if (response.status === 503) {
    console.error('The migration endpoint is disabled because no key is configured on the server.');
    console.error("Add an 'ops' section to api/config.php.\n");
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`Migration failed: ${payload?.error?.message ?? `HTTP ${response.status}`}`);
    if (payload?.error?.detail) console.error(`  ${payload.error.detail}`);
    if (payload?.ran?.length) console.error(`  applied before failing: ${payload.ran.join(', ')}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  if (payload.ran?.length) {
    for (const name of payload.ran) console.log(`  applied  ${name}`);
  } else {
    console.log('  nothing pending');
  }
  if (payload.skipped?.length) {
    console.log(`  already applied: ${payload.skipped.length}`);
  }
  console.log('');
}
