import test from 'node:test';
import assert from 'node:assert/strict';

import { RATING } from './sm2.js';
import {
  CONTROL,
  LOCALES,
  SCHEME,
  isLanguageSupported,
  localeFor,
  parseRating,
  parseVoiceCommand,
  promptFor,
  revealPromptFor,
} from './voiceCommands.js';

const four = { scheme: SCHEME.FOUR };

test('the four-way scheme recognises each rating word', () => {
  assert.equal(parseRating('again', four), RATING.AGAIN);
  assert.equal(parseRating('hard', four), RATING.HARD);
  assert.equal(parseRating('good', four), RATING.GOOD);
  assert.equal(parseRating('easy', four), RATING.EASY);
});

test('spoken digits work as ratings', () => {
  assert.equal(parseRating('one', four), RATING.AGAIN);
  assert.equal(parseRating('two', four), RATING.HARD);
  assert.equal(parseRating('three', four), RATING.GOOD);
  assert.equal(parseRating('four', four), RATING.EASY);
});

test('the two-way scheme collapses four ratings onto two', () => {
  assert.equal(parseRating('again'), RATING.AGAIN);
  assert.equal(parseRating('hard'), RATING.AGAIN, 'hard counts as missed when driving');
  assert.equal(parseRating('good'), RATING.GOOD);
  assert.equal(parseRating('easy'), RATING.GOOD);
});

test('the natural two-way phrases are recognised', () => {
  assert.equal(parseRating('got it'), RATING.GOOD);
  assert.equal(parseRating('missed it'), RATING.AGAIN);
  assert.equal(parseRating('I got it'), RATING.GOOD);
  assert.equal(parseRating('yes'), RATING.GOOD);
  assert.equal(parseRating('nope'), RATING.AGAIN);
});

test('casing, punctuation and padding are ignored', () => {
  for (const input of ['Again.', '  AGAIN  ', 'again!', 'Again?']) {
    assert.equal(parseRating(input, four), RATING.AGAIN, `failed on ${JSON.stringify(input)}`);
  }
});

test('a rating buried in a sentence is still found', () => {
  assert.equal(parseRating('um I think that was easy', four), RATING.EASY);
  assert.equal(parseRating('yeah I got it', four), RATING.GOOD);
});

test('longer phrases win over the short ones they contain', () => {
  assert.equal(parseVoiceCommand('very easy', four).matched, 'very easy');
  assert.equal(parseRating('no idea', four), RATING.AGAIN);
  assert.equal(parseVoiceCommand('no idea', four).matched, 'no idea');
});

test('a rating word is not matched inside a larger word', () => {
  // "know" contains "no"; "knew it" must not be read as "no".
  assert.equal(parseRating('I know this one', four), RATING.AGAIN, 'matches "one", not "no"');
  assert.equal(parseRating('knew it'), RATING.GOOD);
});

test('control commands are recognised', () => {
  assert.deepEqual(
    { type: parseVoiceCommand('stop').type, action: parseVoiceCommand('stop').action },
    { type: 'control', action: 'stop' },
  );
  assert.equal(parseVoiceCommand('skip').action, 'skip');
  assert.equal(parseVoiceCommand('repeat').action, 'repeat');
  assert.equal(parseVoiceCommand('pause').action, 'pause');
});

test('controls take priority over ratings', () => {
  // "next" must end the card, not be mistaken for anything else.
  assert.equal(parseVoiceCommand('next').type, 'control');
  assert.equal(parseVoiceCommand("I'm done").action, 'stop');
});

test('unrecognised speech returns null rather than guessing', () => {
  for (const input of ['banana', 'the quick brown fox', 'hmmmm', '...']) {
    assert.equal(parseVoiceCommand(input), null, `should not match ${JSON.stringify(input)}`);
  }
});

test('empty and non-string input is handled without throwing', () => {
  for (const input of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(parseVoiceCommand(input), null, `failed on ${JSON.stringify(input)}`);
  }
});

test('parseRating returns null for a control command', () => {
  assert.equal(parseRating('stop'), null);
  assert.equal(parseRating('skip'), null);
});

test('every rating a scheme can return is a valid SM-2 rating', () => {
  const valid = Object.values(RATING);
  const phrases = ['again', 'hard', 'good', 'easy', 'got it', 'missed it', 'one', 'four'];

  for (const scheme of [SCHEME.TWO, SCHEME.FOUR]) {
    for (const phrase of phrases) {
      const rating = parseRating(phrase, { scheme });
      if (rating !== null) {
        assert.ok(valid.includes(rating), `${phrase} in ${scheme} gave ${rating}`);
      }
    }
  }
});

test('the two-way scheme never returns Hard or Easy', () => {
  const phrases = ['again', 'hard', 'good', 'easy', 'got it', 'missed it', 'barely', 'too easy'];

  for (const phrase of phrases) {
    const rating = parseRating(phrase);
    assert.ok(
      rating === null || rating === RATING.AGAIN || rating === RATING.GOOD,
      `${phrase} gave ${rating}`,
    );
  }
});

test('promptFor describes what the user should say', () => {
  assert.deepEqual(promptFor(SCHEME.TWO), ['got it', 'missed it']);
  assert.deepEqual(promptFor(SCHEME.FOUR), ['again', 'hard', 'good', 'easy']);
});

// --------------------------------------------------------------- reveal ---

test('the reveal command is recognised in English', () => {
  for (const phrase of ['show', 'answer', 'reveal', 'show me', 'show the answer', 'flip']) {
    const command = parseVoiceCommand(phrase);
    assert.equal(command?.type, 'control', `"${phrase}" should be a control`);
    assert.equal(command.action, CONTROL.REVEAL, `"${phrase}" should reveal`);
  }
});

test('only:[reveal] refuses to read a rating as an answer', () => {
  // While waiting to reveal, "good" must not be taken as a rating.
  assert.equal(parseVoiceCommand('good', { only: [CONTROL.REVEAL] }), null);
  assert.equal(parseVoiceCommand('show', { only: [CONTROL.REVEAL] })?.action, CONTROL.REVEAL);
});

test('only:[...] still allows the controls it lists', () => {
  const only = [CONTROL.REVEAL, CONTROL.STOP];
  assert.equal(parseVoiceCommand('stop', { only })?.action, CONTROL.STOP);
  assert.equal(parseVoiceCommand('skip', { only }), null, 'skip was not offered');
});

// -------------------------------------------------------------- Spanish ---

const es = { lang: 'es-ES' };
const esFour = { lang: 'es-ES', scheme: SCHEME.FOUR };

test('Spanish ratings are recognised', () => {
  assert.equal(parseRating('otra vez', esFour), RATING.AGAIN);
  assert.equal(parseRating('difícil', esFour), RATING.HARD);
  assert.equal(parseRating('bien', esFour), RATING.GOOD);
  assert.equal(parseRating('fácil', esFour), RATING.EASY);
});

test('Spanish works with or without accents, since recognizers vary', () => {
  assert.equal(parseRating('dificil', esFour), RATING.HARD);
  assert.equal(parseRating('facil', esFour), RATING.EASY);
  assert.equal(parseRating('no se', esFour), RATING.AGAIN);
  assert.equal(parseRating('no sé', esFour), RATING.AGAIN);
});

test('Spanish controls are recognised', () => {
  assert.equal(parseVoiceCommand('respuesta', es)?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('muestra', es)?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('siguiente', es)?.action, CONTROL.SKIP);
  assert.equal(parseVoiceCommand('para', es)?.action, CONTROL.STOP);
  assert.equal(parseVoiceCommand('pausa', es)?.action, CONTROL.PAUSE);
});

test('the Spanish two-way scheme collapses to two ratings', () => {
  assert.equal(parseRating('difícil', es), RATING.AGAIN);
  assert.equal(parseRating('fácil', es), RATING.GOOD);
  assert.equal(parseRating('bien', es), RATING.GOOD);
});

test('a regional tag resolves to its base language', () => {
  assert.equal(localeFor('es-MX'), 'es');
  assert.equal(localeFor('es'), 'es');
  assert.equal(parseRating('bien', { lang: 'es-MX' }), RATING.GOOD);
});

test('an unsupported language falls back to English rather than failing', () => {
  assert.equal(localeFor('ja-JP'), 'en');
  assert.equal(parseRating('good', { lang: 'ja-JP' }), RATING.GOOD);
  assert.equal(isLanguageSupported('ja-JP'), false);
  assert.equal(isLanguageSupported('es-ES'), true);
});

// ------------------------------------------------- French, German, Italian,
// ------------------------------------------------- Portuguese

const frFour = { lang: 'fr-FR', scheme: SCHEME.FOUR };
const deFour = { lang: 'de-DE', scheme: SCHEME.FOUR };
const itFour = { lang: 'it-IT', scheme: SCHEME.FOUR };
const ptFour = { lang: 'pt-BR', scheme: SCHEME.FOUR };

test('French ratings and controls are recognised', () => {
  assert.equal(parseRating('encore', frFour), RATING.AGAIN);
  assert.equal(parseRating('difficile', frFour), RATING.HARD);
  assert.equal(parseRating('je sais', frFour), RATING.GOOD);
  assert.equal(parseRating('facile', frFour), RATING.EASY);
  assert.equal(parseVoiceCommand('réponse', { lang: 'fr-FR' })?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('suivant', { lang: 'fr-FR' })?.action, CONTROL.SKIP);
  assert.equal(parseVoiceCommand('arrête', { lang: 'fr-FR' })?.action, CONTROL.STOP);
});

test('German ratings and controls are recognised', () => {
  assert.equal(parseRating('nochmal', deFour), RATING.AGAIN);
  assert.equal(parseRating('schwer', deFour), RATING.HARD);
  assert.equal(parseRating('gut', deFour), RATING.GOOD);
  assert.equal(parseRating('leicht', deFour), RATING.EASY);
  assert.equal(parseVoiceCommand('antwort', { lang: 'de-DE' })?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('weiter', { lang: 'de-DE' })?.action, CONTROL.SKIP);
  assert.equal(parseVoiceCommand('beenden', { lang: 'de-DE' })?.action, CONTROL.STOP);
});

test('Italian ratings and controls are recognised', () => {
  assert.equal(parseRating('ancora', itFour), RATING.AGAIN);
  assert.equal(parseRating('difficile', itFour), RATING.HARD);
  assert.equal(parseRating('bene', itFour), RATING.GOOD);
  assert.equal(parseRating('facile', itFour), RATING.EASY);
  assert.equal(parseVoiceCommand('risposta', { lang: 'it-IT' })?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('avanti', { lang: 'it-IT' })?.action, CONTROL.SKIP);
  assert.equal(parseVoiceCommand('basta', { lang: 'it-IT' })?.action, CONTROL.STOP);
});

test('Portuguese ratings and controls are recognised', () => {
  assert.equal(parseRating('de novo', ptFour), RATING.AGAIN);
  assert.equal(parseRating('difícil', ptFour), RATING.HARD);
  assert.equal(parseRating('sei', ptFour), RATING.GOOD);
  assert.equal(parseRating('fácil', ptFour), RATING.EASY);
  assert.equal(parseVoiceCommand('resposta', { lang: 'pt-BR' })?.action, CONTROL.REVEAL);
  assert.equal(parseVoiceCommand('próxima', { lang: 'pt-BR' })?.action, CONTROL.SKIP);
  assert.equal(parseVoiceCommand('parar', { lang: 'pt-BR' })?.action, CONTROL.STOP);
});

// The dangerous case in every language: the phrase for "I didn't know it"
// contains the phrase for "I knew it". Longest-match-wins is what stops a miss
// being recorded as a hit, which would quietly corrupt the schedule.
test('a negated phrase never scores as its positive', () => {
  assert.equal(parseRating('non lo so', itFour), RATING.AGAIN);
  assert.equal(parseRating('lo so', itFour), RATING.GOOD);

  assert.equal(parseRating('não sei', ptFour), RATING.AGAIN);
  assert.equal(parseRating('sei', ptFour), RATING.GOOD);

  assert.equal(parseRating('nicht gewusst', deFour), RATING.AGAIN);
  assert.equal(parseRating('gewusst', deFour), RATING.GOOD);

  assert.equal(parseRating('je ne sais pas', frFour), RATING.AGAIN);
  assert.equal(parseRating('je sais', frFour), RATING.GOOD);
});

test('a control beats a rating that is a substring of it', () => {
  // "nochmal bitte" is a repeat request, not the rating "nochmal".
  assert.equal(parseVoiceCommand('nochmal bitte', deFour)?.action, CONTROL.REPEAT);
  assert.equal(parseRating('nochmal', deFour), RATING.AGAIN);

  // Likewise "encore une fois" versus the rating "encore".
  assert.equal(parseVoiceCommand('encore une fois', frFour)?.action, CONTROL.REPEAT);
  assert.equal(parseRating('encore', frFour), RATING.AGAIN);

  assert.equal(parseVoiceCommand('de novo por favor', ptFour)?.action, CONTROL.REPEAT);
  assert.equal(parseRating('de novo', ptFour), RATING.AGAIN);
});

test('article-like number words are deliberately not rating words', () => {
  // "un" and "um" are indefinite articles and would fire on ordinary speech.
  assert.equal(parseVoiceCommand('un instant', frFour)?.action, CONTROL.PAUSE);
  assert.equal(parseRating('un', frFour), null);
  assert.equal(parseRating('um', ptFour), null);
  // The digits still work in every language.
  assert.equal(parseRating('1', frFour), RATING.AGAIN);
  assert.equal(parseRating('4', ptFour), RATING.EASY);
});

test('the two-way scheme collapses correctly in every locale', () => {
  for (const lang of ['fr-FR', 'de-DE', 'it-IT', 'pt-BR']) {
    const two = { lang };
    const [knew, missed] = promptFor(SCHEME.TWO, lang);

    assert.equal(parseRating(knew, two), RATING.GOOD, `${lang}: "${knew}" should read as knowing it`);
    assert.equal(parseRating(missed, two), RATING.AGAIN, `${lang}: "${missed}" should read as a miss`);
  }
});

test('every shipped locale answers its own on-screen prompts', () => {
  // The prompt tells the user exactly what to say, so every word it suggests
  // must parse back to the rating it is offered for — in both schemes.
  const order = [RATING.AGAIN, RATING.HARD, RATING.GOOD, RATING.EASY];

  for (const code of Object.keys(LOCALES)) {
    const four = { lang: code, scheme: SCHEME.FOUR };

    promptFor(SCHEME.FOUR, code).forEach((phrase, i) => {
      assert.equal(parseRating(phrase, four), order[i], `${code}: prompt "${phrase}"`);
    });

    for (const phrase of revealPromptFor(code)) {
      assert.equal(
        parseVoiceCommand(phrase, { lang: code, only: [CONTROL.REVEAL] })?.action,
        CONTROL.REVEAL,
        `${code}: reveal prompt "${phrase}"`,
      );
    }
  }
});

test('"no" matches as a whole word in Spanish, not inside another word', () => {
  assert.equal(parseRating('no', esFour), RATING.AGAIN);
  // "nota" contains "no" but must not match it.
  assert.equal(parseVoiceCommand('nota musical', esFour), null);
});

test('prompts are localised', () => {
  assert.deepEqual(promptFor(SCHEME.TWO, 'es-ES'), ['bien', 'no']);
  assert.deepEqual(promptFor(SCHEME.TWO, 'en-US'), ['got it', 'missed it']);
  assert.deepEqual(revealPromptFor('es-ES'), ['respuesta', 'muestra']);
  assert.deepEqual(revealPromptFor('en-US'), ['show', 'answer']);
});

test('every locale defines all four ratings and all five controls', () => {
  for (const [code, locale] of Object.entries(LOCALES)) {
    for (const rating of Object.values(RATING)) {
      assert.ok(locale.ratings[rating]?.length > 0, `${code} is missing rating ${rating}`);
    }
    for (const control of Object.values(CONTROL)) {
      assert.ok(locale.controls[control]?.length > 0, `${code} is missing control ${control}`);
    }
    assert.ok(locale.prompts[SCHEME.TWO]?.length === 2, `${code} two-way prompt`);
    assert.ok(locale.prompts[SCHEME.FOUR]?.length === 4, `${code} four-way prompt`);
    assert.ok(locale.prompts.reveal?.length > 0, `${code} reveal prompt`);
  }
});
