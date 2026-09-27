import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import SessionSummary from './SessionSummary.jsx';
import { api } from '../services/ApiClient.js';
import { cloudSpeechFor, loadSettings, saveSettings } from '../services/settings.js';
import { speech } from '../services/SpeechService.js';
import { feedback } from '../services/feedback.js';
import { MODE, buildQueue, isReadMode } from '../scheduling/queue.js';
import { RATING, nextState, scoreForRating, toApiPayload } from '../scheduling/sm2.js';
import { CONTROL, parseVoiceCommand, promptFor } from '../scheduling/voiceCommands.js';
import { ratingForScore, scoreFor } from '../scheduling/answerMatch.js';
import { enqueueReview, flushReviewQueue } from '../services/reviewQueue.js';

// Labels only — the underlying value is still SM-2's RATING.AGAIN/HARD/GOOD/EASY
// (see src/scheduling/sm2.js), so renaming a button here never touches
// scheduling. "Wrong" reads as the miss button more plainly than "Again" did;
// "Partial" replaces "Hard" for the same reason — both still map to the same
// rating and the same effect on the schedule as before the rename.
const RATING_BUTTONS = [
  { rating: RATING.AGAIN, label: 'Wrong', sub: "Didn't know it" },
  { rating: RATING.HARD, label: 'Partial', sub: 'Knew it, struggled' },
  { rating: RATING.GOOD, label: 'Good', sub: 'Knew it' },
  { rating: RATING.EASY, label: 'Easy', sub: 'Instant, trivial' },
];

/**
 * When hands-free hears nothing at all, the card is still rescheduled — but
 * with a neutral rating rather than a guess in either direction. Silence most
 * often means the user is driving and simply did not speak.
 */
const NEUTRAL_RATING = RATING.GOOD;

/**
 * The study loop, in two flavours.
 *
 * Manual: question → tap to reveal → tap a rating.
 * Hands-free: question spoken → tap anywhere when ready → answer spoken →
 * listen once for a spoken rating → advance. No reading and no aiming: the
 * tap lands anywhere on the screen, so the phone can stay in a pocket or mount.
 *
 * The queue is built once at start, so cards rescheduled mid-session do not
 * reshuffle under the user.
 */
export default function StudySession() {
  const { deckId } = useParams();

  const [phase, setPhase] = useState('loading');
  const [deck, setDeck] = useState(null);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState(MODE.SPACED);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [reviewed, setReviewed] = useState(0);
  const [settings, setSettings] = useState(() => loadSettings(deckId));
  const [listening, setListening] = useState(false);
  const [waitingForReveal, setWaitingForReveal] = useState(false);
  const [heard, setHeard] = useState(null);
  const [typedAnswer, setTypedAnswer] = useState('');
  /** Set once per card, when Check is pressed; null means "not typed this card". */
  const [matchScore, setMatchScore] = useState(null);
  /** Whether the server can read cards aloud for languages this device cannot. */
  const [cloudReady, setCloudReady] = useState(false);

  // Loaded once, then advanced locally as reviews are submitted.
  const cardsRef = useRef([]);
  const statesRef = useRef({});
  const shownAtRef = useRef(Date.now());
  const wakeLockRef = useRef(null);
  /** Set while hands-free waits to reveal; calling it reveals immediately. */
  const manualRevealRef = useRef(null);
  /**
   * Only the newest hands-free run may act. React re-runs effects (twice on
   * mount in StrictMode), and a superseded run sharing the singleton recognizer
   * would otherwise swallow the utterance meant for the live one.
   */
  const runTokenRef = useRef(0);

  const card = queue[index] ?? null;
  const remaining = Math.max(0, queue.length - index);
  const readMode = isReadMode(mode);
  // Read modes never rate a card, so the voice-rating machinery hands-free
  // relies on has nothing to do — force it off regardless of the saved setting.
  const handsFree = settings.handsFree && !readMode;

  // ---------------------------------------------------------------- load --

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [loadedDeck, loadedCards, loadedStates] = await Promise.all([
          api.getDeck(deckId),
          api.listCards(deckId),
          api.getStates(deckId),
        ]);
        if (cancelled) return;

        cardsRef.current = loadedCards;
        statesRef.current = loadedStates ?? {};
        setDeck(loadedDeck);
        setPhase('idle');
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setPhase('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [deckId]);

  // Never leave a session dangling if the user closes the tab mid-study.
  useEffect(() => {
    if (!session) return undefined;
    const end = () => { api.endSession(session.id).catch(() => {}); };
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    // A server without cloud speech configured simply answers that it is off,
    // and everything falls back to the device's own voices.
    api.speechStatus()
      .then((status) => { if (!cancelled) setCloudReady(Boolean(status?.enabled)); })
      .catch(() => { if (!cancelled) setCloudReady(false); });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    speech.cancel();
    speech.stopListening();
    speech.releaseCloudCache();
  }, []);

  /**
   * Hands-free is meant for a pocket or a car mount, so keep the screen awake
   * while it runs. iOS releases the lock when the screen locks anyway and
   * silences audio with it — a documented limitation, not something we can fix.
   */
  useEffect(() => {
    if (phase !== 'running' || !handsFree) return undefined;

    let released = false;
    navigator.wakeLock?.request('screen')
      .then((lock) => {
        if (released) lock.release().catch(() => {});
        else wakeLockRef.current = lock;
      })
      .catch(() => { /* unsupported or denied; studying still works */ });

    return () => {
      released = true;
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [phase, handsFree]);

  /**
   * Reads one side of a card aloud.
   *
   * Every mode goes through here — spaced repetition, random, both read-through
   * modes and hands-free — so the language behaviour is identical in all of
   * them, including the decision to fall back to a cloud voice when this device
   * has none for the language.
   *
   * @param {'front'|'back'} side  which of the deck's two voices to use
   */
  const speakCard = useCallback((text, lang, side = 'front') => {
    if (!settings.speechEnabled) return Promise.resolve({ spoken: false });

    return speech.speak(text, {
      lang,
      rate: settings.rate,
      // undefined when nothing is chosen, or when the chosen voice is not
      // installed here — speak() then picks the default for the language.
      voice: speech.voiceByUri(side === 'back' ? settings.voiceBackUri : settings.voiceFrontUri),
      cloud: cloudSpeechFor(settings, lang, cloudReady, (l) => speech.canSpeakLanguage(l)),
    });
  }, [settings, cloudReady]);

  // --------------------------------------------------------------- start --

  async function handleStart() {
    // Must happen inside this tap handler, or iOS stays silent all session.
    // The audio context needs the same gesture, for the same reason.
    speech.prime();
    feedback.setEnabled(settings.tapSound);
    feedback.prime();

    const built = buildQueue(cardsRef.current, statesRef.current, {
      mode,
      now: new Date(),
      newCardLimit: settings.newCardLimit,
    });

    if (built.length === 0) {
      setPhase('empty');
      return;
    }

    // Read modes never score or rate a card, so there is nothing for a
    // session row to record — the backend's mode column only knows
    // 'spaced'/'random' anyway.
    if (!readMode) {
      try {
        setSession(await api.startSession(Number(deckId), mode));
      } catch (err) {
        // A session row is bookkeeping; losing it should not block studying.
        setError(`Session not recorded: ${err.message}`);
      }
    }

    setQueue(built);
    setIndex(0);
    setRevealed(false);
    setReviewed(0);
    setHeard(null);
    setPhase('running');
    shownAtRef.current = Date.now();
  }

  function handleReveal() {
    setRevealed(true);
    speakCard(card.answer_text, deck?.language_back, 'back');
  }

  /** Typed-answer mode: score what was typed, then reveal as usual. */
  function handleCheckAnswer(event) {
    event.preventDefault();
    setMatchScore(scoreFor(typedAnswer, card.answer_text));
    handleReveal();
  }

  // Speaks each card's question exactly once, the moment it becomes current.
  // Previously this only happened for the first card (a one-off call in
  // handleStart); every card after it was silent until revealed, so only the
  // answer was ever heard. Keyed on card id, not the full card object, so a
  // re-render never re-triggers it mid-card. Hands-free speaks its own
  // question inside its own effect and must not also fire this one.
  useEffect(() => {
    if (phase !== 'running' || handsFree || !card) return undefined;

    speakCard(card.question_text, deck?.language_front, 'front');
    prefetchAnswer(card);

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, handsFree, card?.id]);

  /**
   * Fetches the answer's audio while the question is still being read.
   *
   * Cloud speech costs a round trip, and without this the pause between
   * tapping reveal and hearing anything is exactly where it is most noticeable.
   * Local voices need none of this, so it only runs when cloud will be used.
   */
  function prefetchAnswer(current) {
    if (!settings.speechEnabled || !current) return;

    const cloud = cloudSpeechFor(
      settings,
      deck?.language_back,
      cloudReady,
      (l) => speech.canSpeakLanguage(l),
    );

    if (cloud) speech.prefetch(current.answer_text, { rate: settings.rate, voice: cloud.voice });
  }

  // -------------------------------------------------------------- rating --

  const submitRating = useCallback(async (ratedCard, rating, explicitScore = null) => {
    const responseMs = Date.now() - shownAtRef.current;
    const previous = statesRef.current[String(ratedCard.id)] ?? null;
    const updated = nextState(previous, rating, new Date());

    statesRef.current = { ...statesRef.current, [String(ratedCard.id)]: toApiPayload(updated) };
    setReviewed((count) => count + 1);

    const review = {
      card_id: ratedCard.id,
      session_id: session?.id ?? null,
      rating,
      // A typed-answer match is a more precise confidence than the four rating
      // buckets can express — 0.83 says more than "Good" does — so it is used
      // verbatim when available, and only falls back to the bucketed value
      // when the card was rated by tap or by voice.
      score: explicitScore ?? scoreForRating(rating),
      response_ms: responseMs,
      mode,
      state: toApiPayload(updated),
    };

    try {
      await api.submitReview(review);
      // Opportunistic: if an earlier review in this session got stuck behind
      // a blip that has since cleared, this is where it catches up.
      flushReviewQueue(api).catch(() => {});
    } catch (err) {
      // The session keeps moving either way — queue it rather than lose it.
      // It will retry on the next app load, on reconnect, or after the next
      // review that does succeed.
      enqueueReview(review);
      setError('No connection — this review will sync automatically once you are back online.');
    }
  }, [session, mode]);

  const advance = useCallback(() => {
    speech.cancel();
    setHeard(null);
    setTypedAnswer('');
    setMatchScore(null);

    setIndex((current) => {
      const next = current + 1;

      if (next >= queue.length) {
        setPhase('finished');
        if (session) api.endSession(session.id).catch(() => {});
        return current;
      }

      setRevealed(false);
      shownAtRef.current = Date.now();
      return next;
    });
  }, [queue.length, session]);

  const handleRate = useCallback((rating) => {
    if (!card) return;
    // Advance first: a study loop must never stall on the network.
    submitRating(card, rating, matchScore);
    advance();
  }, [card, submitRating, advance, matchScore]);

  /** Read modes: move on without rating or scoring the card. */
  const handleNext = useCallback(() => {
    setReviewed((count) => count + 1);
    advance();
  }, [advance]);

  // ----------------------------------------------------------- hands-free --

  useEffect(() => {
    if (phase !== 'running' || !handsFree || !card) return undefined;

    const controller = new AbortController();
    const { signal } = controller;

    runTokenRef.current += 1;
    const token = runTokenRef.current;
    const stale = () => signal.aborted || runTokenRef.current !== token;

    /** Applies a spoken control. Returns true when it ended the card. */
    function applyControl(action) {
      if (action === CONTROL.STOP) {
        setPhase('finished');
        if (session) api.endSession(session.id).catch(() => {});
        return true;
      }
      if (action === CONTROL.PAUSE) {
        setPhase('paused');
        return true;
      }
      if (action === CONTROL.SKIP) {
        advance();
        return true;
      }
      return false;
    }

    async function run() {
      setRevealed(false);
      prefetchAnswer(card);
      await speakCard(card.question_text, deck?.language_front, 'front');
      if (stale()) return;

      /**
       * Wait for a tap anywhere on the screen.
       *
       * Deliberately *not* a voice command: a recognizer plays a start tone
       * every time it opens, and listening through the thinking phase meant a
       * chime every second or so — impossible to think over. A tap needs no
       * chime and no looking at the screen, which is the point of hands-free.
       *
       * No timeout either. The user decides when they have thought long enough.
       */
      setWaitingForReveal(true);

      await new Promise((resolve) => {
        // Card tap, background tap, the button and the space bar all call this,
        // so the confirmation sound only needs wiring in one place. Aborting
        // resolves silently — no tap happened.
        manualRevealRef.current = () => {
          feedback.tap();
          resolve();
        };
        signal.addEventListener('abort', resolve, { once: true });
      });

      manualRevealRef.current = null;
      setWaitingForReveal(false);
      if (stale()) return;

      setRevealed(true);
      await speakCard(card.answer_text, deck?.language_back, 'back');
      if (stale()) return;

      // No recognizer, or the user turned voice ratings off: wait, then move on.
      if (!settings.voiceRatings || !speech.canListen()) {
        await wait(settings.advanceDelay * 1000, signal);
        if (stale()) return;
        handleRate(NEUTRAL_RATING);
        return;
      }

      setListening(true);
      const result = await speech.listen({
        lang: deck?.language_back,
        timeoutMs: settings.advanceDelay * 1000,
        signal,
      });
      setListening(false);
      if (stale()) return;

      const command = parseVoiceCommand(result?.transcript ?? '', {
        scheme: settings.ratingScheme,
        lang: deck?.language_back,
      });

      if (command?.type === 'control') {
        if (applyControl(command.action)) return;

        if (command.action === CONTROL.REPEAT) {
          await speakCard(card.answer_text, deck?.language_back, 'back');
          if (!signal.aborted) handleRate(NEUTRAL_RATING);
          return;
        }
      }

      if (command?.type === 'rating') {
        setHeard(command.matched);
        handleRate(command.rating);
        return;
      }

      // Heard nothing usable. Reschedule neutrally rather than stalling.
      handleRate(NEUTRAL_RATING);
    }

    run();

    return () => {
      controller.abort();
      speech.cancel();
      speech.stopListening();
      setListening(false);
    };
    // card.id rather than card: a re-render must not restart the sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, handsFree, card?.id]);

  // Space reveals, 1–4 rate. Keyboard is faster than tapping on desktop.
  useEffect(() => {
    if (phase !== 'running') return undefined;

    function onKeyDown(event) {
      if (handsFree) {
        // Only the reveal is keyboard-driven here; ratings are spoken.
        if (waitingForReveal && (event.code === 'Space' || event.code === 'Enter')) {
          event.preventDefault();
          manualRevealRef.current?.();
        }
        return;
      }
      if (event.target.matches?.('input, textarea, select')) return;

      if (!revealed && (event.code === 'Space' || event.code === 'Enter')) {
        event.preventDefault();
        handleReveal();
        return;
      }
      if (revealed && readMode && (event.code === 'Space' || event.code === 'Enter')) {
        event.preventDefault();
        handleNext();
        return;
      }
      if (revealed && !readMode && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        handleRate(Number(event.key));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function stopSession() {
    speech.cancel();
    speech.stopListening();
    setPhase('finished');
    if (session) api.endSession(session.id).catch(() => {});
  }

  // --------------------------------------------------------------- views --

  if (phase === 'loading') {
    return <div className="screen screen--centered"><p className="muted">Loading…</p></div>;
  }

  if (phase === 'error') {
    return (
      <div className="screen screen--centered">
        <p className="alert">{error}</p>
        <Link className="button" to="/decks">Back to decks</Link>
      </div>
    );
  }

  if (phase === 'idle' || phase === 'empty') {
    return (
      <div className="screen screen--centered">
        <div className="card stack">
          <h1>{deck?.title}</h1>

          {phase === 'empty' && (
            <p className="alert">
              {mode === MODE.SPACED
                ? 'Nothing is due right now. Try random mode to review anyway.'
                : 'This deck has no cards yet.'}
            </p>
          )}

          <fieldset className="field">
            <legend>Mode</legend>
            <label className="choice">
              <input type="radio" checked={mode === MODE.SPACED} onChange={() => setMode(MODE.SPACED)} />
              <span>Spaced repetition</span>
            </label>
            <label className="choice">
              <input type="radio" checked={mode === MODE.RANDOM} onChange={() => setMode(MODE.RANDOM)} />
              <span>Random</span>
            </label>
            <label className="choice">
              <input type="radio" checked={mode === MODE.READ_ORDER} onChange={() => setMode(MODE.READ_ORDER)} />
              <span>Read in order</span>
            </label>
            <label className="choice">
              <input type="radio" checked={mode === MODE.READ_RANDOM} onChange={() => setMode(MODE.READ_RANDOM)} />
              <span>Read randomly</span>
            </label>
          </fieldset>

          {readMode && (
            <p className="muted">
              Just reads through every card, question then answer — no rating, nothing scored.
              Good for a first pass before studying for real.
            </p>
          )}

          <label className="choice">
            <input
              type="checkbox"
              checked={settings.speechEnabled}
              onChange={(e) => setSettings(saveSettings(deckId, { speechEnabled: e.target.checked }))}
            />
            <span>Read cards aloud</span>
          </label>

          {!readMode && (
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.handsFree}
                onChange={(e) => setSettings(saveSettings(deckId, { handsFree: e.target.checked }))}
              />
              <span>Hands-free</span>
            </label>
          )}

          {handsFree && (
            <p className="muted">
              Tap anywhere to hear the answer
              {settings.voiceRatings && speech.canListen()
                ? `, then say “${promptFor(settings.ratingScheme, deck?.language_back).join('” or “')}” to rate it.`
                : '. Cards then advance on a timer.'}
            </p>
          )}

          {!speech.canSpeak() && (
            <p className="muted">This browser cannot speak; cards will be text only.</p>
          )}

          <button className="button button--primary button--large" type="button" onClick={handleStart}>
            Start studying
          </button>
          <Link className="button button--link" to={`/decks/${deckId}`}>Edit deck</Link>
        </div>
      </div>
    );
  }

  if (phase === 'paused') {
    return (
      <div className="screen screen--centered">
        <div className="card stack">
          <h1>Paused</h1>
          <p className="muted">{remaining} card{remaining === 1 ? '' : 's'} left.</p>
          <button
            className="button button--primary button--large"
            type="button"
            onClick={() => { speech.prime(); setPhase('running'); }}
          >
            Resume
          </button>
          <button className="button" type="button" onClick={stopSession}>End session</button>
        </div>
      </div>
    );
  }

  if (phase === 'finished') {
    return (
      <SessionSummary
        deckId={deckId}
        reviewed={reviewed}
        readMode={readMode}
        error={error}
        onStudyAgain={() => { setError(null); setPhase('idle'); }}
      />
    );
  }

  /**
   * A tap anywhere reveals. Buttons keep their own behaviour, so Exit and
   * Pause still work without the tap swallowing them.
   */
  function handleScreenTap(event) {
    if (event.target.closest('button, a')) return;
    manualRevealRef.current?.();
  }

  return (
    <div
      className="screen study"
      onClick={handsFree && waitingForReveal ? handleScreenTap : undefined}
    >
      <header className="study__bar">
        <button className="button button--link" type="button" onClick={stopSession}>Exit</button>
        <span className="muted">{remaining} left</span>
        <button
          className="button button--link"
          type="button"
          title="Repeat"
          onClick={() => speakCard(
            revealed ? card.answer_text : card.question_text,
            revealed ? deck?.language_back : deck?.language_front,
            revealed ? 'back' : 'front',
          )}
        >
          🔊
        </button>
      </header>

      <button
        className="study__card"
        type="button"
        onClick={
          handsFree
            // The card is the largest target on screen; in hands-free a tap on
            // it is the reveal. It is a <button>, so the screen-level handler
            // deliberately skips it and it handles itself here.
            ? (waitingForReveal ? () => manualRevealRef.current?.() : undefined)
            : (revealed ? undefined : handleReveal)
        }
        aria-live="polite"
      >
        <p className="study__question">{card.question_text}</p>
        {revealed && <p className="study__answer">{card.answer_text}</p>}
      </button>

      {handsFree ? (
        <div className="study__handsfree">
          {waitingForReveal ? (
            <>
              <p className="muted">Tap anywhere when you are ready</p>
              <button
                className="button button--primary button--large"
                type="button"
                onClick={() => manualRevealRef.current?.()}
              >
                Show answer
              </button>
            </>
          ) : listening ? (
            <p className="study__listening">
              ● Listening — say “{promptFor(settings.ratingScheme, deck?.language_back).join('” or “')}”
            </p>
          ) : (
            <p className="muted">{heard ? `Heard “${heard}”` : revealed ? 'Answer' : 'Question'}</p>
          )}
          <button className="button" type="button" onClick={() => setPhase('paused')}>Pause</button>
        </div>
      ) : readMode ? (
        revealed ? (
          <button className="button button--primary button--large" type="button" onClick={handleNext}>
            Next card
          </button>
        ) : (
          <button className="button button--primary button--large" type="button" onClick={handleReveal}>
            Show answer
          </button>
        )
      ) : revealed ? (
        <>
          {matchScore !== null && (
            <div className="study__match">
              <p className="muted">
                You typed: <strong>{typedAnswer || '(nothing)'}</strong>
              </p>
              <p className={`study__match-score study__match-score--${ratingForScore(matchScore)}`}>
                {Math.round(matchScore * 100)}% match
              </p>
            </div>
          )}
          <div className="study__ratings">
            {RATING_BUTTONS.map(({ rating, label, sub }) => (
              <button
                key={rating}
                className={`button button--rating button--rating-${rating}`
                  + (matchScore !== null && ratingForScore(matchScore) === rating ? ' button--rating-suggested' : '')}
                type="button"
                onClick={() => handleRate(rating)}
              >
                <span className="button--rating__label">{label}</span>
                <span className="button--rating__sub">{sub}</span>
              </button>
            ))}
          </div>
        </>
      ) : settings.typedAnswer ? (
        <form className="study__type-answer" onSubmit={handleCheckAnswer}>
          <input
            type="text"
            value={typedAnswer}
            onChange={(e) => setTypedAnswer(e.target.value)}
            placeholder="Type your answer…"
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Your answer"
          />
          <div className="study__type-answer__actions">
            <button className="button button--primary button--large" type="submit">
              Check answer
            </button>
            <button className="button button--link" type="button" onClick={handleReveal}>
              I don't know — show it
            </button>
          </div>
        </form>
      ) : (
        <button className="button button--primary button--large" type="button" onClick={handleReveal}>
          Show answer
        </button>
      )}
    </div>
  );
}

/** A cancellable sleep. Resolves early (not rejects) when aborted. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
