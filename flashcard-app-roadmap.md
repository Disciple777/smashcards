# Flashcard Study App — Technical Roadmap

## 1. Overview

A multi-user, web-based flashcard study application. Users create questionnaires (decks) of question/answer pairs, then study them in a flip-card loop. Questions and answers are read aloud. Cards can be entered by typing or by voice. Scheduling defaults to spaced repetition, with a random mode available.

**Primary audience:** students, worldwide.
**Key differentiator:** hands-free study — a user can run a full session while commuting, driving, or walking, using audio only.

---

## 2. Architecture

**Front end:** React (SPA), responsive down to mobile. No native app in v1 — a responsive web app reaches every platform from one codebase.

**Back end:** PHP REST API + MySQL. The API is stateless and returns JSON only; it renders no HTML.

**Division of responsibility:** the back end stores and serves data. All scheduling math, session sequencing, and timing logic lives in React. This keeps the algorithm testable in isolation and lets you iterate on scheduling without redeploying the API.

**Auth:** JWT. The React app holds a token, sends it as a `Bearer` header, and PHP validates per request. Avoids PHP session state and works cleanly if a native app is ever added.

### Suggested project structure

```
/api                 PHP REST API
  /v1
    /auth            login, register, refresh
    /decks           CRUD
    /cards           CRUD, bulk import
    /sessions        session start, review submission
    /ai              text → card extraction (phase 3)
  /lib               db, auth middleware, validation
/src                 React app
  /components
  /services          SpeechService, ApiClient
  /scheduling        SM-2 implementation, random mode
  /hooks
  /styles
```

---

## 3. Data model

```sql
users
  id, email, password_hash, display_name,
  created_at, settings_json

decks
  id, user_id, title, description,
  language_front, language_back,
  is_public, created_at, updated_at

cards
  id, deck_id, question_text, answer_text,
  question_audio_url, answer_audio_url,   -- nullable, phase 2
  source_type,        -- 'manual' | 'voice' | 'ai'
  position, created_at, updated_at

card_states                                -- one row per user per card
  id, user_id, card_id,
  ease_factor        DECIMAL(4,2) DEFAULT 2.50,
  interval_days      INT DEFAULT 0,
  repetitions        INT DEFAULT 0,
  due_at             DATETIME,
  last_reviewed_at   DATETIME

reviews                                    -- immutable log, one row per answer
  id, user_id, card_id, session_id,
  score              DECIMAL(3,2),   -- 0.00–1.00 confidence
  response_ms        INT,
  mode               ENUM('spaced','random'),
  reviewed_at        DATETIME

sessions
  id, user_id, deck_id, mode,
  started_at, ended_at, cards_reviewed
```

### Notes on two deliberate choices

**`reviews.score` is numeric, not a boolean.** Today the UI collects a 1–4 self-rating and maps it to a 0–1 value. When automated answer evaluation lands in phase 4, a fuzzy match score writes to the same column with no migration and no backfill.

**`card_states` is separate from `cards`.** Cards belong to a deck; scheduling belongs to a user. Separating them means public/shared decks work for free later — two users studying the same deck each carry their own state.

**Random mode still writes `reviews` rows.** A user who studies randomly for a month and then enables spaced repetition arrives with real history instead of a cold start.

---

## 4. Speech layer

Both TTS (read-aloud) and STT (voice entry) go behind a single `SpeechService` module in React. Nothing else in the app calls a speech API directly.

```
SpeechService
  .speak(text, { lang, rate, voice }) → Promise
  .cancel()
  .listen({ lang }) → Promise<transcript>
  .isAvailable()
```

**v1 implementation:** Web Speech API (`SpeechSynthesis` + `SpeechRecognition`). Free, no network, no per-character cost. Voice quality is device-dependent and mediocre on some Android builds.

**Later implementation:** a cloud provider (ElevenLabs, Google Cloud TTS, OpenAI) swapped in behind the same interface, cached as audio files on `cards.question_audio_url` / `answer_audio_url` so a given card is synthesized once, not per playback. This is a natural premium tier.

**Browser caveats to plan around now:**
- Safari/iOS requires speech to be triggered by a user gesture. The session's first "Start" tap must prime the synthesizer, or nothing plays afterwards.
- `SpeechRecognition` is Chrome-family only. Detect and fall back to typed entry rather than hiding the feature.
- iOS Safari silences audio when the screen locks. This directly affects the driving use case — flag it in the UI and test early.

---

## 5. Study session logic

A session is a sequence produced by a strategy, then played through a fixed card loop.

```
StudySession
  ├── buildQueue(deckId, mode)
  │     spaced → cards where due_at <= now, ordered by due_at
  │               + new cards up to a daily cap
  │     random → all cards, shuffled
  └── loop per card:
        show question → speak question
        wait for reveal (tap, voice command, or auto-timer)
        show answer → speak answer
        collect rating → write review + update card_state
```

**SM-2 (spaced mode).** Standard Anki-lineage algorithm:
- Ratings 1–4 (Again / Hard / Good / Easy), mapped to a 0–1 score.
- Rating 1 resets `repetitions` to 0 and `interval_days` to 1.
- Otherwise `interval` grows by `ease_factor`; `ease_factor` adjusts by rating and floors at 1.3.

Implement as pure functions — `nextState(currentState, rating) → newState`. No side effects, trivially unit-testable, and swappable for FSRS later if you want a more modern scheduler.

**Hands-free mode.** The differentiating path. Question is spoken, a configurable pause follows (default ~5s), the answer is spoken, then the app listens for a spoken rating ("again", "hard", "good", "easy") or falls back to auto-advancing with a neutral score. Screen-off operation, large touch targets as backup, no reading required.

---

## 6. Build phases

### Phase 1 — Core loop
The smallest thing that is genuinely useful.
- Auth: register, login, JWT issue/validate.
- Deck CRUD; card CRUD with typed entry.
- Study session, flip-card UI, 1–4 self-rating.
- SM-2 scheduling + random toggle.
- `SpeechService` with Web Speech TTS reading question and answer.
- Responsive layout, mobile-first.

**Done when:** you can create a deck, study it on your phone, and come back tomorrow to the right cards due.

### Phase 2 — Voice input & hands-free
- Voice card entry via `SpeechRecognition`, with a review-and-confirm step before saving (transcription is never accurate enough to save blind).
- Hands-free session mode: auto-advance timing, spoken ratings, screen-off handling.
- Per-deck speech settings: language, rate, voice.
- Session summary screen and basic streak/progress stats.

### Phase 3 — AI extraction
- Paste or upload text → API generates candidate Q/A pairs.
- Granularity control exposed as a numeric density parameter (roughly cards per 1000 words) plus a depth setting — recall facts vs. conceptual questions.
- **Mandatory review screen**: generated cards land in a staging state where the user edits, deletes, and approves before anything enters the deck. Never auto-commit AI output.
- Cost control: character caps per request, per-user monthly quota.

### Phase 4 — Evaluation & sharing
- Spoken or typed answer evaluated against the stored answer, writing a fuzzy confidence value to `reviews.score`.
- Public decks, browse, clone-to-my-account.
- Cloud TTS tier with cached audio.
- Import/export (Anki `.apkg` compatibility is a strong acquisition lever).

---

## 7. Decisions to make before phase 1

1. **Daily new-card cap** — Anki defaults to 20/day. Configurable per deck, or global?
2. **Deck size limits** — free tier ceiling, if any.
3. **Rating input in hands-free mode** — 4 spoken options, or simplify to 2 ("got it" / "missed it") since voice recognition of "hard" vs. "again" while driving will be error-prone?
4. **Offline** — full offline study is a large lift (service worker + local queue + sync conflict handling). Worth deciding now whether it's ever in scope, because it affects how much state you're willing to keep client-side.

---

## 8. Notes for Claude Code

When handing this off, work phase by phase rather than pasting the whole document. Suggested first prompt:

> Build phase 1 of this project: PHP REST API (`/api/v1`) with JWT auth, MySQL schema as specified, and a React front end. Start with the schema and auth endpoints only — I'll review before we move to decks and cards.

Ask for the scheduling module as standalone pure functions with unit tests before it is wired into any UI. It's the one piece where a subtle bug is invisible for weeks and then corrupts every user's review history.
