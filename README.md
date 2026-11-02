# Smashcards

Multi-user flashcard study app with hands-free audio study.
React SPA + PHP REST API + MySQL. See [flashcard-app-roadmap.md](flashcard-app-roadmap.md).

**Status:** phases 1 and 2 complete and deployed. Phase 3 (AI card generation)
is built but not yet live — it needs the new API files uploaded and a key for
one of the three providers (Claude, OpenAI, DeepSeek). See [ROADMAP.md](ROADMAP.md) for the full checklist.

## Layout

```
/api                 PHP REST API (no Composer, no dependencies)
  index.php          front controller / router
  .htaccess          rewrite + Authorization header forwarding
  config.php         secrets — gitignored, create from config.example.php
  /lib               config, db, jwt, auth middleware, validation, responses
  /lib/router.php    pattern router, subdirectory-aware
  /v1/auth.php       register, login, refresh, me
  /v1/decks.php      deck CRUD
  /v1/cards.php      card CRUD, bulk import, reorder
  /v1/ai.php         card generation, staging, quota (phase 3)
  /lib/ai/           Claude, OpenAI and DeepSeek providers (cURL, no Composer)
  /ops/              migrate + selftest, key-protected (they replace SSH)
/public              copied verbatim into the build: .htaccess, app icons,
                     web manifest (icons are generated — see below)
/db/schema.sql       MySQL schema
/scripts             smoke test (Node)
/src                 React app
  main.jsx           entry; BrowserRouter basename=/smashcards
  App.jsx            routes
  /components        AuthScreen, MainMenu, Settings, DeckList, DeckEditor,
                     DeckSettings, VoiceCardEntry, StudySession,
                     SessionSummary, TextImport, SplitDeck, ThemePicker,
                     BrandHeader, UserMenu, Icon
  /hooks             useAuth
  /services          ApiClient (tokens + silent refresh), SpeechService,
                     settings, theme, cardParser, deckSplit
  /scheduling        SM-2, queue building, voice commands, stats — all pure
                     functions with unit tests (78 of them)
  /styles            app.css — mobile-first
/dist                build output, upload to public_html/smashcards/
```

## Deploying to Hostinger

**1. Create the database** — hPanel → Databases → MySQL Databases. Note the
database name, user, and password.

**2. Import the schema** — hPanel → phpMyAdmin → select the database → Import →
upload `db/schema.sql` → Go.

**3. Upload the API** — put the contents of `api/` into
`public_html/api/` (File Manager or SFTP). Keep the directory structure.

**4. Create `config.php`** on the server from `config.example.php`. It needs a
JWT secret. Generate one and paste it in — never commit it anywhere:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `cors.allowed_origins` to include your Vite dev origin
(`http://localhost:5173`) so this machine can call production during development.

**5. Confirm PHP 8.1+** — hPanel → Advanced → PHP Configuration. The code uses
`never` return types and `readonly`-era syntax; 8.0 will fatal.

**6. Verify:**

```bash
node scripts/smoke-test.mjs https://guatermelon.com/smashcards/api
```

Expect `58 passed, 0 failed`. It registers two throwaway accounts per run.

## API

| Method | Path                              | Auth   | Purpose                            |
|--------|-----------------------------------|--------|------------------------------------|
| GET    | /v1/health                        | —      | liveness + database connectivity    |
| POST   | /v1/auth/register                 | —      | create account, returns tokens      |
| POST   | /v1/auth/login                    | —      | returns tokens                      |
| POST   | /v1/auth/refresh                  | —      | exchange refresh token for a pair   |
| GET    | /v1/auth/me                       | Bearer | current user                        |
| GET    | /v1/decks                         | Bearer | own decks + card/due/new counts     |
| POST   | /v1/decks                         | Bearer | create deck                         |
| GET    | /v1/decks/{id}                    | Bearer | one deck (public decks readable)    |
| PATCH  | /v1/decks/{id}                    | Bearer | partial update                      |
| DELETE | /v1/decks/{id}                    | Bearer | delete deck and its cards           |
| GET    | /v1/decks/{id}/cards              | Bearer | cards in order (`?status=staged`)   |
| POST   | /v1/decks/{id}/cards              | Bearer | add card                            |
| POST   | /v1/decks/{id}/cards/bulk         | Bearer | import up to 500, all-or-nothing    |
| PATCH  | /v1/decks/{id}/cards/reorder      | Bearer | set card order                      |
| GET    | /v1/cards/{id}                    | Bearer | one card                            |
| PATCH  | /v1/cards/{id}                    | Bearer | partial update                      |
| DELETE | /v1/cards/{id}                    | Bearer | delete card                         |
| GET    | /v1/decks/{id}/states             | Bearer | caller's scheduling state, by card  |
| POST   | /v1/reviews                       | Bearer | log a review + upsert card state    |
| GET    | /v1/sessions                      | Bearer | recent sessions                     |
| POST   | /v1/sessions                      | Bearer | start a session                     |
| GET    | /v1/sessions/{id}                 | Bearer | one session                         |
| PATCH  | /v1/sessions/{id}                 | Bearer | end a session                       |

A deck or card belonging to someone else answers **404, not 403** — 403 would
confirm the id exists and let anyone enumerate the deck space.

Errors are uniform:

```json
{ "error": { "code": "validation_failed", "message": "...", "fields": { "email": "..." } } }
```

Access tokens last 15 minutes, refresh tokens 30 days. Both are HS256 and carry
a `typ` claim, so a refresh token is rejected where an access token is expected.

## Screens

The main menu is the app's identity and three doors — open a deck, new deck,
browse public decks — and nothing else. Everything about *you* rather than
your cards lives behind the cog beside your name in the top bar: `/settings`
holds the theme picker, your account details, and both ways to sign out. The
login screen wears the same mark and wordmark, so the first screen and the
home screen are recognisably one app.

## Themes

Twelve palettes — four light, seven dark, plus "match my device" — chosen in
Settings and kept per device in localStorage.

Each palette is one block of the same ten CSS variables in `app.css`, and
nothing else in the stylesheet knows which is on. The selector is
`[data-theme="…"]`, not `:root[data-theme="…"]`, so the picker's swatches carry
the attribute themselves and render in the palette's real colours — a preview
built from a second copy of the hex codes would drift, this one cannot.

No attribute at all means "follow the device", which is what keeps the
`prefers-color-scheme` block meaningful; its `:not([data-theme])` guard stops a
phone in dark mode from overriding a light theme the user picked. `theme.js`
also rewrites the `theme-color` meta at boot, which is the one part of the UI
CSS cannot reach — without it a light theme gets a black status bar above it.

## The app icon

```bash
npm run icons     # -> public/icon-{192,512}.png, apple-touch-icon.png,
                  #    favicon-32.png, favicon.ico, icon.svg
```

`tools/make-icons.mjs` draws the artwork — a card with a bolt through it — from
a list of polygons, fills them with a scanline rasteriser at 3x, downsamples
for anti-aliasing and assembles the PNG from zlib-deflated scanlines. No canvas
library, no native dependency to build on Windows, and no binary blob in the
repo: change a number in `SHAPES`, re-run, and every size including the SVG
regenerates consistently.

Re-run it only when the artwork changes; the outputs are committed.

## Importing cards from text

`src/services/cardParser.js` turns a marked-up paste into cards with no AI and
no network:

```
/q: What is the powerhouse of the cell?
/a: The mitochondrion.
```

Everything after a marker belongs to it until the next one, so either side may
run over several lines. Markers are case-insensitive and may sit inline
(`/q: 2+2? /a: 4` is one card). It is deliberately forgiving: text before the
first marker is ignored (it is usually a heading), a second `/a:` appends
rather than erroring, and a question with no answer is reported with its line
number rather than silently dropped. Fields over 2000 characters are rejected
here, not at the server, because bulk import is all-or-nothing.

## Splitting a deck

`src/services/deckSplit.js` plans the split as pure data before anything is
created — the user sees which cards land in "Biology 3" before that deck
exists. Card order is preserved, each part inherits the original's languages
and folder, and the original is kept unless the user opts into deleting it,
which happens only after every part is created *and* filled.

## Conventions

- **All datetimes are UTC.** The PDO connection pins `time_zone = "+00:00"`, so
  `CURRENT_TIMESTAMP` and `UTC_TIMESTAMP()` agree. Format for display in React.
- **Ownership failures return 404, not 403**, so ids cannot be enumerated.
- **PATCH is partial**: keys absent from the body are left untouched.

## Scheduling

`src/scheduling/` holds the algorithm as pure functions with no React, no API and
no clock of their own — `now` is always a parameter, so every schedule is
reproducible in a test.

```bash
npm test
```

- `sm2.js` — `nextState(state, rating, now)` returns a new state; ease floors at
  1.3, ratings 1–4 map to SM-2 qualities and to the 0–1 `reviews.score` scale.
- `queue.js` — `buildQueue(cards, states, { mode, now, newCardLimit })` returns the
  session order: most-overdue reviews first, then up to 20 new cards.

Two deliberate departures from Wozniak's 1987 paper, both marked DEVIATION in the
source: intervals multiply by the *updated* ease (as Anki does), and a lapse does
adjust ease rather than leaving it untouched.

## Front end

```bash
npm install
npm run dev      # http://localhost:5173/smashcards/
npm run build    # -> dist/
```

The dev server proxies `/smashcards/api` to production (see `vite.config.js`),
so the browser makes same-origin requests exactly as it does in production.
Local dev therefore does not depend on the dev port being in the API's CORS
list, and works on whatever port Vite picks.

`npm run dev` runs Vite through `node --use-system-ca` so the proxy trusts roots
in the Windows certificate store. Antivirus TLS scanning (AVG, Kaspersky, ESET)
and corporate proxies re-sign HTTPS with a locally-installed root that Node's
bundled CA list does not contain; without the flag the proxy fails with
`unable to verify the first certificate`.

**Deploying the UI:** run `npm run build`, then upload the *contents* of `dist/`
into `public_html/smashcards/` (alongside the existing `api/` directory).

Client-side routing needs an `.htaccess` in `public_html/smashcards/` so that a
deep link like `/smashcards/decks/4/study` serves `index.html` instead of 404ing.
One is generated at `public/.htaccess` and copied into the build.

### Speech

`SpeechService` is the only module that touches the Web Speech API. Two browser
realities are handled explicitly:

- **iOS requires a user gesture** before it will speak. `speech.prime()` is called
  from the Start button's own tap handler; without that, the whole session is silent.
- **`SpeechRecognition` is Chrome-only.** `canListen()` reports honestly so phase 2
  can fall back to typed entry rather than hiding voice input.

## Hands-free study

The roadmap's differentiator: a full session by ear, no reading and no tapping.

Per card: the question is spoken, a configurable pause follows, the answer is
spoken, then the app listens for a spoken rating and moves on.

- **The reveal is a tap anywhere on the screen, not a timer and not a voice
  command.** Chrome plays a start tone every time the recognizer opens, so
  listening throughout the thinking phase chimed roughly once a second and made
  it impossible to concentrate. A tap is silent and needs no aim, so the phone
  can stay in a pocket. There is no time limit: the card waits.
  The recognizer now opens exactly once per card, for the rating.
- **Spoken ratings and controls** are parsed by `src/scheduling/voiceCommands.js`,
  a pure function over the transcript — so the behaviour is unit-tested without
  a microphone. It understands `stop`, `pause`, `skip`, `repeat` and `reveal`.
- **Commands are per-language.** English and Spanish ship today, keyed off the
  deck's language. Adding a language means adding one entry to `LOCALES`.
- **Two-way rating is the default** (`got it` / `missed it`). Roadmap §7.3 asks
  whether four spoken options are realistic while driving; distinguishing "hard"
  from "again" by voice at speed is not, so four-way is opt-in for quiet settings.
- **Silence advances the card** with a neutral rating rather than stalling —
  the common cause of silence is that the user is driving.
- **A screen wake lock** is held during hands-free sessions. iOS still silences
  audio when the screen locks; that is a platform limitation, flagged in the UI.

## Known gaps

- **No login rate limiting.** Nothing throttles password guessing yet.
- **Refresh tokens cannot be revoked** before they expire; they are stateless.
- **`SpeechRecognition` is Chrome-family only.** Voice entry and voice ratings
  degrade to typed entry and timer-based advance elsewhere, including iOS Safari.
