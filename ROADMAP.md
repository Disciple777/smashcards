# Smashcards — Roadmap checklist

Living status of the plan in [flashcard-app-roadmap.md](flashcard-app-roadmap.md).
Legend: `[x]` done and verified · `[~]` partly done · `[ ]` not started.

Last updated 2026-09-18.

---

## Phase 1 — Core loop ✅ complete and deployed

- [x] MySQL schema: users, decks, cards, card_states, reviews, sessions
- [x] JWT auth — register, login, refresh, me (no Composer, hand-rolled HS256)
- [x] Deck CRUD
- [x] Card CRUD with typed entry, plus bulk import and reordering
- [x] SM-2 scheduling as pure functions, unit-tested
- [x] Random mode toggle
- [x] Study session with flip-card UI and 1–4 self-rating
- [x] `SpeechService` reading question and answer aloud
- [x] Responsive, mobile-first layout
- [x] Review + session persistence (`/v1/reviews`, `/v1/sessions`, `/v1/decks/{id}/states`)
- [x] Cross-user isolation, verified by 76 assertions against production

**Done when:** create a deck, study it on your phone, come back tomorrow to the
right cards due. ✅ Verified on device.

## Phase 2 — Voice input & hands-free ✅ complete

- [x] Voice card entry with a review-and-confirm step before saving
- [x] Hands-free session mode
- [x] Tap-anywhere reveal *(not timed, and not voice)* — a recognizer chimes
      every time it opens, so listening through the thinking phase was unusable
- [x] Spoken ratings, two-way default (`got it` / `missed it`)
- [x] Voice controls: stop, pause, skip, repeat
- [x] Screen wake lock during hands-free
- [x] Neutral auto-advance when nothing is heard
- [x] Per-deck speech settings — language, rate, timings, rating scheme
- [x] Session summary screen
- [x] Streak and progress stats
- [x] Tap-confirmation sound (synthesised, no audio asset)
- [x] Per-deck voice selection (which system voice, not just which language) —
      one picker per *side*, not one per deck: a language deck's two sides are
      two different languages, and one voice cannot read both. Only voices
      matching that side's language are offered. The voiceURI is stored rather
      than the voice object (it cannot be serialised, and installed voices
      differ per device), so a voice picked on a laptop and missing on a phone
      quietly falls back to that language's default there rather than failing.
- [x] Read the question aloud on every card, not just the first — a real bug,
      only the first card's question was spoken; every card after it was
      silent until reveal. Fixed with a dedicated effect keyed on card id.
- [x] Clarified rating buttons — each now carries a sublabel ("Didn't know
      it" / "Knew it, struggled" / "Knew it" / "Instant, trivial") since
      "Again" being the wrong-answer button, and Hard vs Easy, were not
      obvious from the words alone
- [x] Edit an existing card from the deck list, inline, not just add/delete
- [x] Rating button labels: Wrong / Partial / Good / Easy (renamed from
      Again/Hard/Good/Easy at Oscar's request — display strings only, the
      underlying SM-2 values and hands-free voice recognition are unchanged)
- [x] **Fixed: a review that failed to reach the server was silently lost.**
      submitRating() updated the local session and moved on (by design — the
      study loop must never stall on the network) but simply discarded the
      review on failure, so the server's card_states row never updated and a
      later session could re-serve or mis-schedule that card. Now queued in
      localStorage (src/services/reviewQueue.js) and retried on the next app
      load, on reconnect, and after each later successful submission, until
      it lands. Covered by 10 unit tests including out-of-order-failure and
      corrupted-storage cases; verified live by blocking the network mid-
      session and confirming the review reached the server after reload.

## Phase 3 — AI extraction ✅ complete, deployed and verified

- [x] Paste text → `POST /v1/decks/{id}/ai/extract` generates candidate Q/A pairs
- [x] Density parameter (roughly cards per 1000 words)
- [x] Depth setting — facts / mixed / concepts
- [x] **Mandatory review screen** — generated cards are written `status='staged'`,
      are invisible to the deck and to study sessions, and are editable and
      discardable before an explicit Add
- [x] Cost control: per-request character cap, per-user monthly quota, both
      configurable in `api/config.php`
- [x] `ai_usage` table (`db/migrations/002_ai_usage.sql`)
- [x] Clean disabled state — with no key the endpoint answers 503
      `ai_not_configured` and the UI hides itself
- [x] **Verified against the live API** — 95/95 smoke assertions, real cards
      generated through OpenAI and DeepSeek
- [x] Upload from a file, rather than pasting text → *see Study sources below*

- [x] **Three interchangeable providers** — Claude, OpenAI and DeepSeek, chosen
      in config and overridable per request so the same passage can be compared
      across models
- [x] Per-provider usage recorded in `ai_usage.last_provider`

*Implementation notes:* every provider receives an identical system prompt and
is asked for the same JSON shape, so switching changes cost and quality but
never the contract. Claude uses `output_config.format` for schema-guaranteed
output; OpenAI uses `response_format: json_schema`; DeepSeek speaks the same
chat-completions protocol but has no schema mode, so it gets `json_object` with
the schema in the prompt and a tolerant parser behind it. All raw cURL, because
the SDKs need Composer and this API is deliberately dependency-free.

**Live providers:** OpenAI (`gpt-4o-mini`) and DeepSeek (`deepseek-chat`);
DeepSeek is the default. Claude is implemented and selectable the moment
Anthropic API credit exists — a Claude.ai subscription does **not** include it.

## Deck folders (added at Oscar's request, not in the original plan) ✅

- [x] Folders with nested subfolders — `folders` table, self-referencing
      `parent_id`, no depth limit beyond a generous defensive cap
- [x] Not present by default — a user who creates zero folders sees exactly
      the flat deck list the app always had; folder UI only appears once one exists
- [x] Deleting a folder cascades to its subfolders (FK), but decks inside are
      never deleted — they move to root (`ON DELETE SET NULL`)
- [x] Cycle prevention on move (can't drag a folder into its own subtree),
      enforced server-side and mirrored client-side for immediate UI feedback
- [x] Move a deck or a folder between folders from the deck list, no separate screen
- [x] Route-based navigation (`/folders/:id`) — shareable URLs, working back button
- [x] Verified: 51/51 self-test (incl. cascade + cycle checks), 119/119 smoke
      test, 17 new unit tests over the pure tree-assembly logic, and a full
      manual pass in a live browser against production (nested create, move,
      cascade delete, confirmed server-side after each step)

### Folder UI polish (round two, at Oscar's request)

- [x] **Collapsed folder rows.** A folder shows just its icon, name, count
      and one "Edit" button; clicking it reveals the move picker, Rename and
      Delete — no dropdown cluttering the default view. Same collapse-behind-
      "Move" pattern applied to deck rows.
- [x] **Drag-and-drop**, desktop only. A grip handle drags a deck or folder
      onto a folder row or a breadcrumb (including "All decks" for root) to
      move it; the Edit-picker stays as the accessible fallback since native
      HTML5 drag-and-drop mostly does not work on touch. A folder and its own
      descendants can never appear as sibling rows, so the UI structurally
      cannot attempt a cycle by dragging — the picker's `excludeSubtreeOf` is
      where cycle prevention actually has to do its job, and does.
- [x] **A small hand-authored icon set** (`Icon.jsx`) — no new npm dependency,
      inline SVG keyed by name, `currentColor` throughout so it themes for
      free. Folders get a real folder icon instead of an emoji; edit/trash/
      link/copy icons used across the new controls. Written as a flat
      registry specifically so a future per-folder or per-deck icon picker
      is "add an entry", not a redesign.
- [x] Verified live: dragged a deck into a folder, dragged a folder into
      another folder, dragged a deck back out via the root breadcrumb, and
      confirmed each move server-side.

## Deck editor fixes (at Oscar's request)

- [x] **Width consistency.** The "Add a card" section (and AI-generate,
      staged-cards review, and settings panels) were capped at 28rem by a
      shared `.stack` rule meant for centered dialogs, while the card list
      below filled the full 42rem content column — visibly narrower, not
      intentional. New `.stack--full` opts out where the section should
      match the list. Verified: both measured 640px wide in the same view.
- [x] **Rename a deck.** There was no way to change a deck's title after
      creation — only its language, its public flag, and its cards. A "Deck
      name" field now lives at the top of Study settings.
- [x] **Rename a deck from the list too**, at Oscar's request. Folders have
      always been renameable from the deck list; decks being the exception
      meant opening a deck and hunting through Study settings to fix a typo.
      Optimistic, with the old title restored if the server refuses.

## Deck sharing via link (at Oscar's request, complements public decks) ✅

- [x] Private by default — a share link is opt-in per deck, independent of
      "Make this deck public": a shared deck is never listed under Browse
      public decks, only reachable by whoever has the exact link.
- [x] `decks.share_token` (unique, 40-hex, 160 bits of randomness) — creating
      a link is idempotent (repeat calls return the same token, so opening
      settings again never silently breaks a link already sent to someone);
      `{"regenerate":true}` deliberately issues a new one, killing the old
      link. Revoking clears the token and the link stops working immediately.
      Guarded so the token is only ever visible to the deck's owner — reading
      a public deck as someone else, or browsing public decks, never leaks
      another user's private link.
    - [x] `GET /shared/:token` — a landing page showing title, description,
      owner, card count, and a clone button. Gated on being signed in (same
      as public decks), not on ownership — holding the link is the access
      control, the same principle applied one level down.
- [x] Cloning via a share link reuses the exact same copy logic as cloning a
      public deck (`respondWithClone()`), so the "independent snapshot, no
      live link back to the original" guarantee already proven for public
      decks holds here for free.
- [x] Verified: 17 new smoke assertions (idempotent creation, regeneration
      invalidating the old token, revoke killing the link, cross-user view
      and clone, token-visibility guards) — plus a real bug caught in
      verification: the shared-deck view initially omitted `card_count`
      entirely (a missing subquery), rendering as "cards" with no number.
      Fixed, redeployed, and reverified live before shipping.

## Study sources — documents, audio, and keeping the material ✅

*Added at Oscar's request.* Before this, material was a one-way trip: a pasted
passage became cards and was then gone, with no way to go back and read what a
card came from. Every generation input is now a **source** row that outlives the
cards made from it.

- [x] **`sources` table** (`007_sources.sql`) — one shape for three kinds:
      `text` (pasted, no file), `document` (PDF/TXT/MD) and `audio`. Holds the
      original filename, size, MIME type, an unguessable storage key, and
      `content_text`: the passage, the PDF's text, or the transcript.
- [x] **Pasted text is saved too** — and saved *before* the model is called, so
      a provider timeout or refusal no longer costs the user their chapter.
- [x] **`cards.source_id`**, `ON DELETE SET NULL` — a card can be traced back to
      the material that produced it, and deleting reference material never
      deletes cards someone has been studying.
- [x] **PDF text extracted in the browser** (pdf.js, lazily imported — it adds
      nothing to the main bundle for people who only paste text). Deliberately
      not server-side: a dependency-free PHP PDF parser would be a bad
      reimplementation of font decoding, this costs no server CPU, and it works
      with *every* AI provider rather than only the ones accepting PDF uploads.
      A scanned PDF has no text layer, which the client detects and explains
      rather than storing an empty source.
- [x] **Audio transcribed server-side** (OpenAI Whisper) — the recording *and*
      its transcript are both kept, so the two never drift apart. Gated on a key
      exactly like card generation: no key, and the Audio tab hides itself.
      Neither DeepSeek nor Anthropic accepts audio, but the transcript is then
      handed to whichever provider the user picked, so model choice stays free.
- [x] **Files are never web-readable.** They live outside the routed tree with a
      deny-all `.htaccess` written on creation, `api/.htaccess` 404s the path,
      and the only way in is `GET /v1/sources/{id}/file`, which checks ownership
      first. Owner-only even for public decks: a public deck shares its cards,
      not the private material behind them.
- [x] **Long material is sliced, not rejected.** A response reports where it
      reached, so a lecture transcript gets a "generate more" button instead of
      "too long, split it up yourself".
- [x] **Server-reported limits.** `upload_max_filesize` / `post_max_size` cannot
      be read from a browser, so the API reports the effective ceiling and the
      UI refuses an oversized file *before* the upload rather than after it.
- [x] **Deleting a deck now clears its files from disk** — the rows cascade by
      foreign key, but nothing reaches the filesystem unless the delete does it
      explicitly. Without this, every PDF and recording leaked permanently.
- [x] Verified: 29 new smoke assertions (upload, read-back, download, type and
      size refusal, cross-user isolation, delete, deck-delete cleanup) plus a
      full manual pass in a real browser against production — a .txt and a PDF
      uploaded through the live UI, text confirmed, original re-opened.

### Bugs this work surfaced (all pre-existing, all fixed)

- [x] **`ai/extract` 500'd whenever `depth` was omitted.** `in_array($body['depth']
      ?? 'mixed', …) ? $body['depth'] : 'mixed'` read the key twice: the test
      passed on the default while the value came back `null`, and `null` met a
      `string` parameter under `strict_types` — a TypeError, outside any try,
      surfacing as a blank 500. Invisible until now only because the old UI
      always sent `depth`.
- [x] **A provider error body shaped `{"error": "string"}` crashed the handler.**
      `$decoded['error']['message']` throws a TypeError on a string, and
      TypeError is an `Error`, not an `Exception` — so it slipped past every
      `catch (RuntimeException)` and became a blank 500 instead of the honest
      "the provider rejected its key". Error extraction now only indexes into
      arrays, and the provider call catches `Throwable`.
- [x] **`.mjs` was served as `text/plain`**, so pdf.js's worker was rejected by
      strict MIME checking — and so was its own fallback, which imports the same
      file. PDF extraction worked in dev (Vite sets the type) and was dead in
      production. Fixed with `AddType` in the app's `.htaccess`.

### Round two — Word documents, OCR, and a front door ✅

*Added at Oscar's request.*

- [x] **A main menu.** The deck list used to be the landing screen, so arriving
      meant a create form, every folder and every deck at once. Those are two
      different intentions, so they are now two: "Open a deck" (`/decks` — the
      folders, the new-folder button and the decks) and "New deck" (`/new`).
      Creating inside a folder still works: the list's "+ New deck" carries
      `?folder=`, so the placement survives the move to its own screen.
- [x] **Word documents (.docx).** A .docx is a ZIP of XML, and the platform can
      already do both halves — `DecompressionStream` inflates the entry,
      `DOMParser` reads it — so this needs no library, the same way PDFs need no
      server-side parser. `<w:p>`, `<w:tab/>` and `<w:br/>` all survive the trip.
      The legacy binary .doc is refused with an explanation rather than
      half-read into mojibake.
- [x] **OCR for scanned PDFs.** When a PDF turns out to have no text layer, the
      browser renders its pages to JPEGs and a vision model reads them back as
      text. Opt-in per upload ("Read scanned pages"), because it costs AI credit
      and a normal PDF never needs it, and capped at `ai.ocr.max_pages` since
      each page is one request. A vision model rather than a bundled OCR engine:
      tesseract.js would mean megabytes of WebAssembly downloaded before the
      first page, and it copes badly with the columns and tables that scanned
      study material is full of. One request per page, so a document that fails
      on page 14 still returns thirteen usable pages instead of nothing.
- [x] Verified live: a Word document uploaded through the real UI (text, tab and
      line break all intact, 5 cards generated), and a genuinely image-only PDF
      — text drawn to a canvas, embedded as DCTDecode, no text layer at all —
      correctly refused with OCR off, then read verbatim with it on.

### `npm run lint:php` — catching what no local PHP could

There is no PHP on the dev machine and no SSH on the host, so an API mistake
used to surface only as an empty 500 from production, with no message. A parser
now checks every file before a deploy, for syntax **and for redeclarations** —
two methods with the same name in one class, or one class in two files. PHP
treats those as *compile-time* fatals: uncatchable, blank 500, and invisible to
a syntax-only check because the code parses perfectly. This shipped precisely
because a duplicate `SourcesController::store()` took down the whole route and
cost a deploy cycle to find.

## Phase 4 — Evaluation & sharing 🔶 in progress

- [x] **Typed-answer evaluation.** Opt-in per deck (off by default, and
      unavailable alongside hands-free — typing implies looking at the
      screen). Type your recall, get a length-normalized similarity score
      against the stored answer (`src/scheduling/answerMatch.js`, pure,
      21 unit tests), which suggests a rating — the user still taps to
      confirm, never auto-applied. **No schema change**: `reviews.score` was
      already a free-form 0–1 decimal from phase 1 for exactly this, so the
      precise match score (e.g. 0.75) is sent as-is instead of the coarser
      four-bucket value a tap alone would produce. Deliberately does not
      strip accents — "esta" vs "está" must not read as a perfect match in
      Spanish. Verified live: typed a near-miss, watched the exact 0.4 score
      (not a bucketed 0.5) land in the real network request.
- [x] **Public decks: browse, search, clone-to-my-account.** `is_public` has
      existed since phase 1; this is the first thing to use it. A "Make this
      deck public" toggle in deck settings; a Browse screen listing other
      users' public decks with owner name, card count, and title search;
      "Copy to my decks" clones the deck and every active card into new
      rows under the caller — a snapshot, not a live link: editing or
      deleting the original never touches a clone, verified by editing the
      original mid-test and confirming the clone was unaffected. A private
      deck 404s if someone else tries to clone it, same as reading one.
      Verified: 18 new smoke assertions against production, plus a full
      manual pass (made a deck public, browsed as a second real account,
      cloned it, confirmed both cards arrived).
- [ ] Spoken-answer evaluation — the same `answerMatch.js` scoring extended
      to a hands-free transcript. Deferred rather than bolted on: hands-free
      already works well and was praised as-is, and folding "did the answer
      match" into the reveal-then-rate flow changes its shape in a way that
      deserves its own pass rather than a rushed addition here.
- [x] **Cloud TTS with cached audio.** Both reasons for deferring this expired:
      the sources work built a writable, non-web-readable storage path, and the
      OpenAI key that arrived for card generation covers speech too. The
      concrete reason also arrived — Oscar's machine turned out to have exactly
      three voices installed, all Spanish, so every other language was being
      read in the wrong accent or not at all. No amount of picker polish fixes
      that: the voices simply are not on the device.

      `POST /v1/speech` returns MP3 bytes, cached on disk under a hash of
      everything that affects the audio (model, voice, speed, text). Flashcards
      are re-read constantly, so a deck costs something once and is then free
      and instant — verified: a repeat came back from cache in 151ms.

      Default is `auto`: the cloud voice is used **only** when the device has no
      voice for that language, so nobody pays for speech their laptop already
      does well. `always` and `never` are both available.

      Audio is returned rather than a URL: the cache lives outside the web root,
      a URL would need its own signed-access story, and a blob plays just as
      well. Scoped per user rather than shared — identical text would produce
      identical audio, but a shared cache makes "has anyone else synthesised
      this sentence" observable through timing, and the files are small.

      The answer is prefetched while the question is still playing, since the
      round trip is most noticeable exactly at the reveal.

      `cards.question_audio_url` / `answer_audio_url` stay unused: a content
      hash needs no column, and it survives editing a card.
- [ ] Anki `.apkg` import/export — **deliberately deferred**. `.apkg` is a
      zipped SQLite database with its own schema and versioning; correct
      support means either an SQLite reader in dependency-free PHP (a real
      undertaking) or a client-side approach. A real feature, not a quick add.

*Groundwork already in place:* `card_states` is separate from `cards`, so
shared/cloned decks work without schema changes.

---

## Added along the way (not in the original plan)

- [x] **Multi-language voice commands.** Ratings and controls are per-language
      tables in `voiceCommands.js`; English and Spanish ship today. Adding a
      language means adding one entry.
- [ ] **Full app localisation.** Interface text (buttons, labels, summary) is
      still English-only. Deck content and voice commands already localise.
      → *see Language support below*
- [x] Dev proxy so local development does not depend on CORS
- [x] UTC-safe date handling across the API/client boundary
- [x] **FTPS deploy pipeline** — `npm run deploy` with a dry run and a guard
      that refuses to overwrite the server-only config
- [x] **Ops endpoints replacing SSH** — key-protected migration runner and
      backend self test, both fail-closed
- [x] **Drift check** — server SQL counts vs. client `queueStats()`, on every check
- [x] Sensitive files denied by pattern, verified by fetching them

## Language support 🔶

- [x] **Six voice-command locales** — English, Spanish, French, German, Italian
      and Portuguese. Adding one is still adding a single entry to `LOCALES`.
      Each table is hand-written rather than translated word-for-word, because
      the risky phrases are language-specific:
      - *A negation must never score as its positive.* "non lo so", "não sei",
        "nicht gewusst" and "je ne sais pas" all contain the phrase for knowing
        it. Longest-match-wins handles this, and a test now pins it in every
        locale — getting it wrong would silently corrupt the schedule by
        recording misses as hits.
      - *Article-like number words are left out.* French "un" and Portuguese
        "um" are indefinite articles and would fire on ordinary speech; the
        digits still work, and the prompt never asks for numbers anyway.
      - *Portuguese drops bare "para".* Spanish ships it as a stop command, but
        in Portuguese it is also the preposition "for", and a false stop ends
        the session — the most expensive mistake this parser can make.
- [x] **A test that every locale can answer its own prompts.** The on-screen
      prompt tells the user exactly what to say, so each word it suggests is
      parsed back and asserted to mean what it was offered for. A locale cannot
      ship advice the session would then reject.
- [x] **49 deck languages for reading aloud**, up from 16 — regional variants
      only where devices really ship distinct voices (Mexican vs Peninsular
      Spanish, Brazilian vs European Portuguese).
- [x] **The picker says what this device can actually speak.** Whether a voice
      exists is a property of the device, not the deck, and it was invisible
      until a session went silent. Unsupported languages are now marked in the
      list, and a deck whose question language has no voice says so up front.
- [x] **Region-aware voice choice.** `voicesFor()` now prefers an exact regional
      match and then a local voice, so an es-MX deck stops being read by a
      Castilian voice on a device that has both.
- [x] **Fixed: the settings screen promised English words the session would not
      accept.** The spoken-rating prompts there called `promptFor()` without a
      language, so a Spanish deck was told to say "got it" while the recognizer
      was listening for "bien". Now localised, and a language with no command
      locale says plainly that ratings must be spoken in English.
- [ ] UI string extraction and a locale file per language — the interface
      itself is still English-only
- [ ] Language picker for the *interface* (deck content already localises)
- [ ] Locale-aware number and date formatting in stats

## Open decisions (roadmap §7)

- [x] **Daily new-card cap** — 20 per session by default, now a slider in Study
      settings (0–100; 0 means "review only, introduce nothing new"). It caps
      only *unseen* cards: due reviews are never limited, because clearing the
      backlog is what keeps the schedule honest.
- [ ] **Deck size limits / free-tier ceiling** — undecided. Only becomes real
      with AI generation costs in phase 3.
- [x] **Hands-free rating input** — two spoken options by default, four opt-in.
- [ ] **Offline support** — still undecided, and the decision gets more
      expensive the longer it waits, since it shapes how much state lives
      client-side.

## Known gaps

- [x] **Login rate limiting.** 8 failed attempts per (email, ip) pair in a
      15-minute rolling window, then 429. Keyed on the pair rather than either
      alone, so one attacker can't dodge it by rotating the email, and one
      attacker distributed across IPs can't keep hammering a single account.
      Verified the CDN forwards the real client IP before building this — a
      CDN edge address would have made per-IP limiting lock out everyone at once.
- [x] **Refresh tokens are now revocable, and theft is detectable.** They were
      stateless: signed, valid for thirty days, impossible to withdraw. Logging
      out discarded the token on the device while the token itself kept working,
      so any copy taken beforehand stayed good for a month.

      Each issued refresh token now has a row (`refresh_tokens`, migration 008)
      and may be exchanged **exactly once**. That one rule is what makes theft
      detectable: a stolen token is a *copy*, so it eventually gets exchanged
      twice — once by the thief and once by the real client, in either order.
      The second exchange finds a row already marked used, which cannot happen
      in honest operation, so the whole *family* (one login, followed through
      every rotation) is revoked and both parties are signed out. By then the
      session really is compromised, so that is the correct outcome.

      `POST /v1/auth/logout` ends one session — deliberately unauthenticated,
      since the worst a stranger can do with a stolen refresh token is end the
      session it belongs to, and requiring a live access token would make it
      impossible to log out after one expired. `POST /v1/auth/logout-all` ends
      every session and *does* require authentication, because it signs out the
      user's other devices; it is wired to "Sign out on all devices" on the menu.

      Access tokens stay stateless and live out their fifteen minutes — a
      database round trip on every request to close that window is not a trade
      worth making on shared hosting. Tokens issued before this shipped are
      adopted on first use rather than rejected, so nobody was signed out by the
      deploy, and that window closes by itself as they expire.

      Covered by 11 smoke assertions, including the reuse case burning the
      replacement token too.
- [ ] No settings menu — study settings live per-deck under "Study settings".
- [ ] `SpeechRecognition` is Chrome-family only; iOS Safari falls back to
      timer-based advance and typed entry.
- [ ] iOS silences audio when the screen locks, which limits the driving case.
