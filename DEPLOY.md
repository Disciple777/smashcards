# Deploying Smashcards

The host is Hostinger shared hosting: **FTP but no SSH**. Nothing can run
commands on the server, so deployment happens over FTPS and everything that
would normally need a shell — migrations, database inspection — happens through
two key-protected HTTPS endpoints instead.

| | |
|---|---|
| App | https://guatermelon.com/smashcards |
| API | https://guatermelon.com/smashcards/api |
| Deployed from | `dist/` → `/smashcards`, `api/` → `/smashcards/api` |

---

## One-time setup

**1. Credentials.** Copy `.env.deploy.example` to `.env.deploy` and fill it in.
That file is gitignored and must stay that way. The scripts read it directly and
never print its contents.

FTP details come from hPanel → Files → FTP Accounts.

**2. Generate the two ops keys.**

```bash
node -e "console.log('MIGRATE_KEY=' + require('crypto').randomBytes(24).toString('hex')); console.log('OPS_KEY=' + require('crypto').randomBytes(24).toString('hex'))"
```

Put them in `.env.deploy`, and **the same values** in `api/config.php` on the
server under `ops.migrate_key` and `ops.selftest_key`. If they are blank on the
server the endpoints refuse to run — they fail closed, never open.

**2b. Pick an AI provider.** `api/config.php` supports three under `ai.providers`:
`anthropic`, `openai` and `deepseek`. Fill in whichever you have credit for and
set `ai.provider` to it. Any provider with an empty key is simply unavailable,
and if the chosen one is unconfigured the API falls back to one that is.

A Claude.ai subscription does **not** include API access — the `anthropic`
provider needs separate credit from console.anthropic.com and returns 401
without it.

**3. Move the local config out of the way.**

`api/config.php` exists only on the server. If a local copy is present the
deploy **refuses to run**, because the upload mirrors a whole directory and
cannot skip files — it would overwrite your live database password with a
placeholder.

```bash
mv api/config.php ../smashcards-config-backup.php
```

**4. Check `FTP_REMOTE_ROOT`.** Run a dry run and confirm the remote paths look
right before uploading anything.

---

## The everyday loop

```bash
npm run lint:php
npm run build
npm run deploy -- --dry-run
npm run deploy
npm run migrate
npm run check
```

| Command | What it does |
|---|---|
| `npm run lint:php` | Parses every PHP file for syntax errors and redeclarations. |
| `npm run deploy -- --dry-run` | Lists every file that would upload. Changes nothing. |
| `npm run deploy` | Uploads over FTPS. Adds and overwrites; never deletes server-only files. |
| `npm run deploy -- --only=api` | Just the PHP, or `--only=app` for just the built front end. |
| `npm run migrate` | Applies pending SQL migrations, then runs the checks. |
| `npm run check` | Health, backend self test, and the drift check. |
| `npm run smoke -- <api-url>` | Full black-box API test through real HTTP. |

**Always run `npm run lint:php` before deploying the API.** There is no PHP on
the dev machine, so a mistake otherwise surfaces only as an empty 500 from
production with no message in the body. It catches two things:

* **Syntax errors** — what `php -l` would catch.
* **Redeclarations** — two methods with the same name in one class, or one class
  declared in two files. PHP treats these as *compile-time* fatals: not
  catchable, no JSON error, just a blank 500. A syntax-only check cannot see
  them, because the code parses perfectly. A duplicate method name has already
  taken down a whole route here once.

It is not a type checker. It catches the failures that take out an entire route.

---

## How verification works without SSH

`npm run check` calls two endpoints:

**`/api/v1/health`** — liveness and database connectivity, public.

**`/api/ops/selftest.php`** — key-protected, and the real replacement for a
shell. It asserts that every expected table and column exists, that all
migrations are applied, that the connection is on UTC, and that the domain's
invariants hold (no orphaned rows, no ease factor below the 1.3 floor, no review
score outside 0–1, one `card_states` row per user-card pair). Then it runs a
full round trip — create a deck, cards, states, a review and a session; confirm
the derived due/new counts recompute correctly; delete; confirm the cascade
cleaned up and that session history survived.

Every row it writes belongs to one dedicated test user
(`selftest@smashcards.invalid` — `.invalid` is reserved by RFC 6761, so no real
person can ever hold that address). It cleans up in a `finally` block, so even a
crashed run leaves nothing behind.

### The drift check

The deck list's due/new counts are computed **twice** in this project: in SQL in
`api/v1/decks.php`, and in JavaScript in `src/scheduling/queue.js`. Two
implementations of one rule drift eventually, usually at a boundary — a card due
exactly now, or a state row whose `due_at` is null.

So the self test returns the raw cards and states alongside the numbers the
server computed, and `npm run check` recomputes them locally with `queueStats()`
— the canonical implementation — and fails on any mismatch. It runs on every
check, so drift is caught the deploy it appears.

---

## Security

Sensitive files are denied by **pattern**, not by filename, in `api/.htaccess`.

The reason is a real failure mode: a config uploaded as `config.local` — missing
the `.php` extension — is not executed by PHP, so Apache serves it as
`text/plain` with the live database password in it. A deny list of exact
filenames matches nothing in that case. The rules therefore match anything whose
name starts with or contains `config`, `env`, `secret`, `credential` or
`password`, plus any `.sql`, `.local`, `.example`, `.bak`, `.log`, `.old`,
`.yml` or `.md` file — extension present or not. Directory indexing is off.

Both ops endpoints compare their key with `hash_equals` (constant time) and
return 503 rather than running when no key is configured.

---

## Troubleshooting

**"Deploy refused"** — a local `api/config.php` exists. Move it out of the
project. This is working as intended.

**`check` says the API returned HTML** — the file is not on the server yet, the
path is wrong, or `mod_rewrite` is not active in that directory.

**`check` says the body was empty** — a PHP fatal error. Run `npm run lint:php`
first: it catches syntax errors and redeclarations, which are the usual causes.
If it passes and the body is still empty, the fatal is something only the
runtime sees (a missing extension, say) — check the server error log in hPanel.

**An endpoint returns 500 with a JSON `server_error` body** — that is an
*uncaught throwable*, not a fatal, and the front controller hides the detail in
production. Remember `Error` (including `TypeError`) does not extend
`Exception`, so a `catch (RuntimeException)` will not see it. With no SSH, the
quickest way to the message is a temporary key-protected endpoint under
`api/ops/` that runs the failing call inside `catch (Throwable $e)` and returns
`$e::class`, its message and its line — then delete it from the server when
done. `npm run deploy` never removes files, so deleting it locally is not
enough; remove it over FTP.

**Connection times out** — AVG or Windows Firewall may block outbound FTP.
AVG already intercepts TLS on this machine, so it is a live suspect.

**A file "was not created"** — on Windows, editors silently append `.txt` to
dotfiles. List the directory and look for `.env.deploy.txt` before concluding
the file is missing. The same trap applies on the server: a config uploaded
without its `.php` extension both fails to load *and* becomes publicly readable.
