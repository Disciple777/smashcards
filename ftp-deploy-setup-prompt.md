# Reusable prompt — set up FTP deploy + remote verification

Copy everything in the block below into a new Claude Code project to get the same
setup we built for Fitnut: FTPS deploys, migrations over HTTPS, and a backend
self test the agent can actually run and read.

Works for any shared-hosting project (Hostinger, SiteGround, Namecheap, cPanel…)
where there's no SSH. Fill in the four bracketed values at the top; leave the
rest alone.

To have it available in every project, save a copy at
`~/.claude/prompts/ftp-deploy-setup.md` (on Windows:
`C:\Users\<you>\.claude\prompts\ftp-deploy-setup.md`).

---

```
I need you to set up automated deployment and remote verification for this
project. The host is shared hosting with FTP but NO SSH, so you cannot run
commands on the server — everything has to work over FTPS and HTTPS.

Fill these in from the project:
- Live URL of the app:        [e.g. https://example.com/myapp]
- Live URL of the API:        [e.g. https://example.com/myapp/api]
- Local folder to deploy:     [e.g. ./api]
- Server path to deploy to:   [e.g. /myapp/api, relative to the FTP home]

Build these five pieces:

1. CREDENTIALS
   A `.env.deploy.example` committed to the repo, and `.env.deploy` added to
   .gitignore. It holds FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD, FTP_SECURE,
   FTP_REMOTE_ROOT, API_BASE, MIGRATE_KEY, OPS_KEY.

   Rules: I fill in `.env.deploy` myself. Never ask me to paste credentials into
   chat. Your scripts read the file directly and must never print its contents —
   not in logs, not in error messages, not in a caught exception object.

2. DEPLOY SCRIPT (`tools/deploy.mjs`, using the `basic-ftp` npm package)
   - Supports a `--dry-run` that lists exactly what would upload and changes
     nothing.
   - Uses FTPS (`secure: true`) by default.
   - Mirrors a directory upward. It must NOT delete remote files it doesn't know
     about — server-only files have to survive a deploy.
   - CRITICAL GUARD: the server's config file (with live DB credentials) exists
     only on the server. `uploadFromDir` honours no skip list, so the script must
     REFUSE TO RUN if a local copy of that file exists, and say why. Silently
     overwriting live credentials is the worst failure mode here.
   - On error, print the message only — never the credentials object.

3. MIGRATION RUNNER (server-side, reachable over HTTPS)
   A script that applies pending SQL migrations in filename order and records
   applied ones in a `schema_migrations` table so re-running is safe.
   Protected by MIGRATE_KEY, compared with a timing-safe comparison
   (`hash_equals` in PHP). It must REFUSE TO RUN if the key isn't configured —
   never fall open.

4. BACKEND SELF TEST (server-side, reachable over HTTPS)
   This is what replaces SSH. A key-protected endpoint (OPS_KEY) returning
   structured JSON, so you can verify the backend yourself instead of asking me
   to check things by hand. It should assert:
   - every expected table exists, and migrations are applied
   - data integrity invariants specific to this project's domain
   - a full round trip through the main entity: create → read → update →
     confirm derived fields recomputed → delete → confirm cleanup
   It must write ONLY rows for a dedicated test user id, clean up after itself,
   and refuse to run without its key.

5. CHECK SCRIPT (`tools/check.mjs`, run locally)
   Calls the health endpoint, runs the self test, prints one line per assertion,
   and exits non-zero on any failure.

   Set `process.exitCode` instead of calling `process.exit()` — with open fetch
   keep-alive sockets, forcing an exit trips a libuv assertion on Windows.

   Diagnose the common failures in plain language rather than dumping a status
   code. If the API returns HTML instead of JSON, say that the path is probably
   wrong or URL rewriting isn't active.

   IF this project computes the same values in two languages (e.g. a JS engine
   and a server-side mirror of it), add a drift check: have the self test return
   both the raw inputs and the server's computed outputs, recompute them locally
   with the canonical implementation, and fail on any mismatch. Two
   implementations of the same formula will drift eventually; this catches it on
   every deploy.

SECURITY — do this without being asked, and verify it by fetching the URLs:

Deny web access to config files, .env files, migrations, SQL dumps, logs and
backups. Use BROAD PATTERNS, not a list of exact filenames.

Reason from a real incident: a config file uploaded as `config.local` (missing
the `.php` extension) was served as `text/plain` with the live database password
in it, because the deny rule listed exact filenames and matched nothing. Match
anything starting with `config` or `env`, and any `.sql`, `.local`, `.example`,
`.bak`, `.log`, `.old` file — extension present or not. Also disable directory
indexing.

Then actually curl each of those paths and show me the status codes. A rule you
haven't tested is a rule you don't have.

WIRE IT UP
Add npm scripts: `deploy`, `check`, `migrate` (migrate then check).
Write a DEPLOY.md with the one-time setup and the everyday loop.

THEN RUN IT
Once I confirm `.env.deploy` is filled in and the server config exists, run the
deploy, the migrations and the checks yourself, and report what actually passed
and what didn't. If something fails, diagnose it from the response rather than
handing the problem back to me.

Two things I want you to watch for, because both bit us before:
- On Windows, editors silently append `.txt` or `.env` to dotfiles. If a config
  file seems missing, list the directory and look for a near-miss name before
  concluding it wasn't created.
- If a server-side config isn't loading, check the actual filename on the server
  over FTP. A missing extension breaks loading AND exposes the file publicly.
```

---

## Why each guard is in there

Every one came from something that actually went wrong building Fitnut:

| Guard | What happened without it |
|---|---|
| Deploy refuses on local config | `uploadFromDir` ignores skip lists — would have overwritten live DB credentials |
| Broad deny patterns | `config.local` was served as plain text with the DB password in it |
| Curl the deny rules | The original rule listed exact filenames and matched nothing |
| `process.exitCode` | `process.exit()` tripped a libuv assertion on Windows |
| Look for near-miss filenames | `.env.deploy` had been saved as `.env.deploy.env` |
| Two-implementation drift check | Caught nothing yet — which is the point; it runs on every deploy |
| Self test asserts invariants | Caught 4 seeded foods with no default serving |
