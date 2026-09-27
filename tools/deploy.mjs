#!/usr/bin/env node
/**
 * Uploads the built app and the API over FTPS.
 *
 *   npm run deploy -- --dry-run     list what would upload, change nothing
 *   npm run deploy                  actually upload
 *   npm run deploy -- --only=api    upload just one target
 *
 * Reads .env.deploy. That file's contents are never printed — not in logs, not
 * in error messages, not by dumping a caught exception (basic-ftp errors can
 * carry the connection options, so errors are reported by message only).
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'basic-ftp';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.deploy');

/**
 * Files that exist only on the server and must never be overwritten.
 *
 * basic-ftp's uploadFromDir has no skip list — it mirrors whatever is in the
 * local directory. So rather than trying to exclude these during upload, the
 * script refuses to run at all while a local copy exists. Overwriting the live
 * config would replace the database password and API key with placeholders and
 * take the whole API down; that is the worst outcome here, so it gets a hard
 * stop rather than a warning.
 */
const SERVER_ONLY = [
  { local: 'api/config.php', why: 'live database credentials and the Anthropic API key' },
];

const TARGETS = {
  api: { local: 'api', remote: '/smashcards/api', label: 'PHP API' },
  app: { local: 'dist', remote: '/smashcards', label: 'built React app' },
};

// ------------------------------------------------------------------- setup --

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;

if (only && !TARGETS[only]) {
  console.error(`Unknown target "${only}". Valid: ${Object.keys(TARGETS).join(', ')}`);
  process.exitCode = 2;
}

const env = loadEnv();

function loadEnv() {
  if (!existsSync(ENV_FILE)) {
    // A Windows editor saving ".env.deploy" can silently produce
    // ".env.deploy.txt" — worth naming, because the file then "does not exist".
    console.error('\nMissing .env.deploy\n');
    console.error('  1. Copy .env.deploy.example to .env.deploy');
    console.error('  2. Fill in your FTP details and the two ops keys');
    console.error('  3. Check the name is exactly ".env.deploy" — Windows editors');
    console.error('     often append .txt, which makes the file look absent.\n');
    process.exitCode = 2;
    return null;
  }

  const parsed = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

if (!env) {
  // exitCode already set; nothing further to do.
} else {
  await main();
}

// -------------------------------------------------------------------- main --

async function main() {
  const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD'].filter((key) => !env[key]);
  if (missing.length) {
    // Names only — never values.
    console.error(`\n.env.deploy is missing values for: ${missing.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }

  // ---- the guard, before any connection is opened ----
  const present = SERVER_ONLY.filter((entry) => existsSync(path.join(ROOT, entry.local)));
  if (present.length) {
    console.error('\nDeploy refused.\n');
    for (const entry of present) {
      console.error(`  ${entry.local} exists locally.`);
      console.error(`  On the server that file holds ${entry.why}.`);
    }
    console.error('\n  This upload mirrors a whole directory and cannot skip files, so');
    console.error('  deploying now would overwrite the live config with your local copy');
    console.error('  and break the API.\n');
    console.error('  Move it outside the project, for example:');
    console.error(`    mv api/config.php ../smashcards-config-backup.php\n`);
    process.exitCode = 1;
    return;
  }

  const selected = only ? [only] : Object.keys(TARGETS);

  for (const name of selected) {
    const target = TARGETS[name];
    const localPath = path.join(ROOT, target.local);

    if (!existsSync(localPath)) {
      console.error(`\nSkipping ${name}: ${target.local}/ does not exist.`);
      if (name === 'app') console.error('  Run "npm run build" first.\n');
      process.exitCode = 1;
      return;
    }
  }

  const remoteRoot = (env.FTP_REMOTE_ROOT ?? '').replace(/\/$/, '');

  if (dryRun) {
    console.log('\nDRY RUN — nothing will be uploaded.\n');
    for (const name of selected) {
      const target = TARGETS[name];
      const files = listFiles(path.join(ROOT, target.local));
      console.log(`${target.label}: ${target.local}/ -> ${remoteRoot}${target.remote}`);
      for (const file of files) console.log(`   ${file.rel}  (${file.size} bytes)`);
      console.log(`   ${files.length} files\n`);
    }
    console.log('Run without --dry-run to upload.\n');
    return;
  }

  const client = new Client(30_000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: env.FTP_HOST,
      port: Number(env.FTP_PORT || 21),
      user: env.FTP_USER,
      password: env.FTP_PASSWORD,
      // Explicit FTPS. Plain FTP would put the password on the wire in clear.
      secure: (env.FTP_SECURE ?? 'true') !== 'false',
      secureOptions: { rejectUnauthorized: false },
    });

    const home = await client.pwd();
    console.log(`\nConnected to ${env.FTP_HOST}`);
    console.log(`Login home: ${home}\n`);

    // The trap this catches: if the FTP account already lands in the web root
    // and FTP_REMOTE_ROOT repeats it, the upload creates a nested copy of the
    // site inside itself and deploys to a directory nobody is serving. The
    // deploy reports success and nothing changes on the live site.
    const tail = home.replace(/\/$/, '').split('/').filter(Boolean).pop();
    if (remoteRoot && tail && remoteRoot.replace(/\//g, '') === tail) {
      console.error(`Refusing to deploy: the login already lands in "${home}",`);
      console.error(`but FTP_REMOTE_ROOT is "${remoteRoot}", which would create`);
      console.error(`a nested ${tail}/ inside it and deploy to a copy nobody serves.`);
      console.error('\nSet FTP_REMOTE_ROOT= (empty) in .env.deploy.\n');
      process.exitCode = 1;
      return;
    }

    for (const name of selected) {
      const target = TARGETS[name];
      const remote = `${remoteRoot}${target.remote}`;

      console.log(`${target.label} -> ${remote}`);
      await client.ensureDir(remote);
      // uploadFromDir adds and overwrites, but never removes remote files it
      // does not know about, so server-only files survive a deploy.
      await client.uploadFromDir(path.join(ROOT, target.local), remote);
      console.log(`  done\n`);
    }

    console.log('Deploy complete.\n');
  } catch (error) {
    // Message only. A basic-ftp error object can carry the access options,
    // which include the password — never log the object itself.
    console.error(`\nDeploy failed: ${error?.message ?? 'unknown error'}\n`);

    const message = String(error?.message ?? '');
    if (/530|login|authentication/i.test(message)) {
      console.error('  The server rejected the login. Check FTP_USER and FTP_PASSWORD.');
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      console.error('  The FTP host could not be resolved. Check FTP_HOST.');
    } else if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(message)) {
      console.error('  No answer on that port. Antivirus or a firewall may be blocking');
      console.error('  outbound FTP, or FTP_PORT is wrong.');
    } else if (/certificate|SSL|TLS/i.test(message)) {
      console.error('  TLS negotiation failed. If the host does not support FTPS,');
      console.error('  set FTP_SECURE=false — but understand the password then');
      console.error('  travels in cleartext.');
    }
    console.error('');
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

/** Every file under a directory, relative paths, for the dry-run listing. */
function listFiles(dir, base = dir) {
  const out = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else {
      out.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: statSync(full).size });
    }
  }
  return out;
}
