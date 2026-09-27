/**
 * Turning a speech transcript into a rating or a control command.
 *
 * Pure and synchronous: no recognizer, no clock. The recognizer lives in
 * SpeechService; this file only interprets the string it produced, which is
 * what makes hands-free behaviour testable without a microphone.
 *
 * Design notes:
 *  - Roadmap §7.3: recognizing "hard" versus "again" while driving is
 *    unreliable, so the default scheme is two-way (got it / missed it). The
 *    four-way scheme stays available for users studying somewhere quiet.
 *  - Commands are per-language. The recognizer is already listening in the
 *    deck's language, so a Spanish deck must accept Spanish commands. Adding a
 *    language means adding one entry to LOCALES — nothing else changes.
 */

import { RATING } from './sm2.js';

export const SCHEME = Object.freeze({
  TWO: 'two',
  FOUR: 'four',
});

export const CONTROL = Object.freeze({
  REVEAL: 'reveal',
  STOP: 'stop',
  REPEAT: 'repeat',
  SKIP: 'skip',
  PAUSE: 'pause',
});

/**
 * Phrase tables per language, keyed by the base of a BCP-47 tag ('es-MX' → 'es').
 *
 * Deliberately generous: recognizers routinely return "I got it" for "got it",
 * "again." with punctuation, or a near-miss homophone. A missed command costs a
 * repeat prompt while driving, so leaning permissive is the safer error.
 */
export const LOCALES = Object.freeze({
  en: {
    label: 'English',
    ratings: {
      [RATING.AGAIN]: [
        'again', 'nope', 'no', 'missed it', 'missed', 'miss', 'wrong', 'forgot',
        'i forgot', 'no idea', 'dont know', "don't know", 'do not know', 'fail',
        'failed', 'one', '1',
      ],
      [RATING.HARD]: ['hard', 'difficult', 'barely', 'just barely', 'tough', 'two', '2'],
      [RATING.GOOD]: [
        'good', 'got it', 'i got it', 'yes', 'yep', 'yeah', 'correct', 'right',
        'ok', 'okay', 'knew it', 'i knew it', 'three', '3',
      ],
      [RATING.EASY]: ['easy', 'very easy', 'too easy', 'simple', 'instantly', 'four', '4'],
    },
    controls: {
      [CONTROL.REVEAL]: [
        'show', 'answer', 'reveal', 'show me', 'show answer', 'show the answer',
        'flip', 'tell me', 'what is it', 'whats the answer', "what's the answer",
      ],
      [CONTROL.STOP]: ['stop', 'quit', 'exit', 'end session', 'finish', 'im done', "i'm done"],
      [CONTROL.REPEAT]: ['repeat', 'again please', 'say again', 'say that again', 'pardon'],
      [CONTROL.SKIP]: ['skip', 'next', 'pass', 'move on'],
      [CONTROL.PAUSE]: ['pause', 'wait', 'hold on'],
    },
    prompts: {
      [SCHEME.TWO]: ['got it', 'missed it'],
      [SCHEME.FOUR]: ['again', 'hard', 'good', 'easy'],
      reveal: ['show', 'answer'],
    },
  },

  es: {
    label: 'Español',
    ratings: {
      [RATING.AGAIN]: [
        'otra vez', 'otra', 'no', 'nope', 'fallé', 'falle', 'fallo', 'fallé',
        'no sé', 'no se', 'ni idea', 'no la sé', 'no lo sé', 'mal', 'incorrecto',
        'olvidé', 'olvide', 'uno', '1',
      ],
      [RATING.HARD]: ['difícil', 'dificil', 'apenas', 'casi', 'duro', 'dos', '2'],
      [RATING.GOOD]: [
        'bien', 'la sé', 'la se', 'lo sé', 'lo se', 'sí', 'si', 'correcto',
        'bueno', 'vale', 'exacto', 'tres', '3',
      ],
      [RATING.EASY]: ['fácil', 'facil', 'muy fácil', 'muy facil', 'sencillo', 'cuatro', '4'],
    },
    controls: {
      [CONTROL.REVEAL]: [
        'muestra', 'mostrar', 'respuesta', 'la respuesta', 'revela', 'revelar',
        'enséñame', 'ensename', 'dime', 'cuál es', 'cual es', 'voltea',
      ],
      [CONTROL.STOP]: ['para', 'parar', 'alto', 'salir', 'terminar', 'termina', 'ya está', 'ya esta'],
      [CONTROL.REPEAT]: ['repite', 'repetir', 'otra vez por favor', 'cómo', 'como dices'],
      [CONTROL.SKIP]: ['salta', 'saltar', 'siguiente', 'pasa', 'pasar'],
      [CONTROL.PAUSE]: ['pausa', 'pausar', 'espera', 'espérate', 'esperate'],
    },
    prompts: {
      [SCHEME.TWO]: ['bien', 'no'],
      [SCHEME.FOUR]: ['otra vez', 'difícil', 'bien', 'fácil'],
      reveal: ['respuesta', 'muestra'],
    },
  },

  fr: {
    label: 'Français',
    ratings: {
      // "un" is missing on purpose: it is also the indefinite article, so it
      // would fire on ordinary speech. The digit still works, and the on-screen
      // prompt never asks for numbers anyway. Same reasoning for "um" in pt.
      [RATING.AGAIN]: [
        'encore', 'non', 'raté', 'rate', 'manqué', 'manque', 'je ne sais pas',
        'sais pas', 'aucune idée', 'aucune idee', 'oublié', 'oublie', 'faux',
        'incorrect', '1',
      ],
      [RATING.HARD]: ['difficile', 'dur', 'à peine', 'a peine', 'presque', 'deux', '2'],
      [RATING.GOOD]: [
        'bien', 'je sais', 'oui', 'correct', 'juste', 'exact', "d'accord",
        'trouvé', 'trouve', 'trois', '3',
      ],
      [RATING.EASY]: [
        'facile', 'très facile', 'tres facile', 'trop facile', 'simple', 'quatre', '4',
      ],
    },
    controls: {
      [CONTROL.REVEAL]: [
        'montre', 'montrer', 'montre moi', 'réponse', 'reponse', 'la réponse',
        'la reponse', 'révèle', 'revele', 'dis moi', 'affiche', 'retourne',
      ],
      [CONTROL.STOP]: [
        'stop', 'arrête', 'arrete', 'arrêter', 'arreter', 'quitter', 'terminer',
        'fini', "c'est fini",
      ],
      [CONTROL.REPEAT]: [
        'répète', 'repete', 'répéter', 'repeter', 'redis', 'encore une fois', 'pardon',
      ],
      [CONTROL.SKIP]: ['passe', 'passer', 'suivant', 'suivante', 'saute', 'sauter'],
      [CONTROL.PAUSE]: ['pause', 'attends', 'attendre', 'un instant'],
    },
    prompts: {
      [SCHEME.TWO]: ['je sais', 'non'],
      [SCHEME.FOUR]: ['encore', 'difficile', 'bien', 'facile'],
      reveal: ['réponse', 'montre'],
    },
  },

  de: {
    label: 'Deutsch',
    ratings: {
      [RATING.AGAIN]: [
        'nochmal', 'noch mal', 'nein', 'falsch', 'verpasst', 'vergessen',
        'weiß nicht', 'weiss nicht', 'nicht gewusst', 'keine ahnung', 'eins', '1',
      ],
      [RATING.HARD]: ['schwer', 'schwierig', 'knapp', 'fast', 'zwei', '2'],
      [RATING.GOOD]: [
        'gut', 'gewusst', 'ja', 'richtig', 'korrekt', 'stimmt', 'okay', 'ok',
        'drei', '3',
      ],
      [RATING.EASY]: [
        'leicht', 'einfach', 'sehr leicht', 'sehr einfach', 'kinderleicht', 'vier', '4',
      ],
    },
    controls: {
      [CONTROL.REVEAL]: [
        'zeig', 'zeige', 'zeig mir', 'antwort', 'die antwort', 'auflösen',
        'auflosen', 'umdrehen', 'sag mir',
      ],
      [CONTROL.STOP]: [
        'stopp', 'stop', 'beenden', 'ende', 'aufhören', 'aufhoren', 'schluss', 'fertig',
      ],
      [CONTROL.REPEAT]: [
        'wiederhole', 'wiederholen', 'nochmal bitte', 'noch einmal', 'wie bitte',
      ],
      [CONTROL.SKIP]: [
        'überspringen', 'uberspringen', 'überspring', 'uberspring', 'weiter',
        'nächste', 'nachste',
      ],
      [CONTROL.PAUSE]: ['pause', 'warte', 'moment', 'kurz warten'],
    },
    prompts: {
      [SCHEME.TWO]: ['gewusst', 'nicht gewusst'],
      [SCHEME.FOUR]: ['nochmal', 'schwer', 'gut', 'leicht'],
      reveal: ['antwort', 'zeig'],
    },
  },

  it: {
    label: 'Italiano',
    ratings: {
      [RATING.AGAIN]: [
        'ancora', 'no', 'sbagliato', 'sbagliata', 'non lo so', 'non so',
        'nessuna idea', 'dimenticato', 'ho dimenticato', 'mancato', 'uno', '1',
      ],
      [RATING.HARD]: ['difficile', 'quasi', 'appena', 'duro', 'due', '2'],
      [RATING.GOOD]: [
        'bene', 'lo so', 'sì', 'si', 'giusto', 'corretto', 'esatto', 'va bene',
        'tre', '3',
      ],
      [RATING.EASY]: [
        'facile', 'molto facile', 'troppo facile', 'semplice', 'quattro', '4',
      ],
    },
    controls: {
      [CONTROL.REVEAL]: [
        'mostra', 'mostrami', 'risposta', 'la risposta', 'rivela', 'dimmi',
        'gira', 'scopri',
      ],
      [CONTROL.STOP]: ['stop', 'ferma', 'fermare', 'basta', 'esci', 'finito', 'ho finito'],
      [CONTROL.REPEAT]: ['ripeti', 'ripetere', 'ancora una volta', 'come', 'scusa'],
      [CONTROL.SKIP]: ['salta', 'saltare', 'avanti', 'prossima', 'passa'],
      [CONTROL.PAUSE]: ['pausa', 'aspetta', 'aspettare', 'un attimo'],
    },
    prompts: {
      [SCHEME.TWO]: ['lo so', 'no'],
      [SCHEME.FOUR]: ['ancora', 'difficile', 'bene', 'facile'],
      reveal: ['risposta', 'mostra'],
    },
  },

  pt: {
    label: 'Português',
    ratings: {
      [RATING.AGAIN]: [
        'de novo', 'não', 'nao', 'errei', 'errado', 'não sei', 'nao sei',
        'nem ideia', 'esqueci', 'falhei', '1',
      ],
      [RATING.HARD]: ['difícil', 'dificil', 'quase', 'custou', 'dois', '2'],
      [RATING.GOOD]: [
        'bem', 'sei', 'eu sei', 'sim', 'certo', 'correto', 'acertei', 'isso',
        'três', 'tres', '3',
      ],
      [RATING.EASY]: [
        'fácil', 'facil', 'muito fácil', 'muito facil', 'simples', 'quatro', '4',
      ],
    },
    controls: {
      // Bare "para" is left out, unlike in Spanish: in Portuguese it is also
      // the preposition "for", and a false match here ends the session — the
      // most expensive mistake this parser can make. "pare"/"parar" are
      // unambiguous imperatives.
      [CONTROL.REVEAL]: [
        'mostra', 'mostrar', 'resposta', 'a resposta', 'revela', 'revelar',
        'me diz', 'vira',
      ],
      [CONTROL.STOP]: ['pare', 'parar', 'sair', 'terminar', 'acabou', 'chega', 'fim'],
      [CONTROL.REPEAT]: ['repete', 'repetir', 'outra vez', 'de novo por favor', 'como'],
      [CONTROL.SKIP]: [
        'pula', 'pular', 'próxima', 'proxima', 'próximo', 'proximo', 'passa', 'seguinte',
      ],
      [CONTROL.PAUSE]: ['pausa', 'pausar', 'espera', 'esperar', 'um momento'],
    },
    prompts: {
      [SCHEME.TWO]: ['sei', 'não'],
      [SCHEME.FOUR]: ['de novo', 'difícil', 'bem', 'fácil'],
      reveal: ['resposta', 'mostra'],
    },
  },
});

export const DEFAULT_LOCALE = 'en';

/** In the two-way scheme, everything collapses onto these two ratings. */
const TWO_WAY = Object.freeze({
  [RATING.AGAIN]: RATING.AGAIN,
  [RATING.HARD]: RATING.AGAIN,
  [RATING.GOOD]: RATING.GOOD,
  [RATING.EASY]: RATING.GOOD,
});

/** 'es-MX' → 'es'. Unknown languages fall back to English rather than failing. */
export function localeFor(lang) {
  const base = String(lang ?? '').toLowerCase().split('-')[0];
  return LOCALES[base] ? base : DEFAULT_LOCALE;
}

export function isLanguageSupported(lang) {
  const base = String(lang ?? '').toLowerCase().split('-')[0];
  return Object.hasOwn(LOCALES, base);
}

/**
 * @param {string} transcript raw text from the recognizer
 * @param {object} options
 * @param {string} options.scheme SCHEME.TWO (default) or SCHEME.FOUR
 * @param {string} options.lang   BCP-47 tag of the language being spoken
 * @param {string[]} options.only restrict to these control actions, so that a
 *                                reveal prompt cannot be answered with a rating
 * @returns {{ type: 'rating', rating: number, matched: string }
 *          | { type: 'control', action: string, matched: string }
 *          | null}
 */
export function parseVoiceCommand(transcript, { scheme = SCHEME.TWO, lang = 'en-US', only = null } = {}) {
  const text = normalize(transcript);
  if (!text) return null;

  const locale = LOCALES[localeFor(lang)];

  const controls = only
    ? Object.fromEntries(Object.entries(locale.controls).filter(([action]) => only.includes(action)))
    : locale.controls;

  // Controls first: "skip" must never be swallowed by a rating match.
  const control = matchPhrases(text, controls);
  if (control) {
    return { type: 'control', action: control.key, matched: control.phrase };
  }

  // When the caller asked only for controls, a rating is not an answer here.
  if (only) return null;

  const rating = matchPhrases(text, locale.ratings);
  if (!rating) return null;

  const parsed = Number(rating.key);
  return {
    type: 'rating',
    rating: scheme === SCHEME.FOUR ? parsed : TWO_WAY[parsed],
    matched: rating.phrase,
  };
}

/** Convenience wrapper for callers that only care about ratings. */
export function parseRating(transcript, options) {
  const result = parseVoiceCommand(transcript, options);
  return result?.type === 'rating' ? result.rating : null;
}

/** What to show on screen as the spoken rating options. */
export function promptFor(scheme = SCHEME.TWO, lang = 'en-US') {
  return LOCALES[localeFor(lang)].prompts[scheme] ?? LOCALES.en.prompts[scheme];
}

/** What to show on screen as the words that reveal the answer. */
export function revealPromptFor(lang = 'en-US') {
  return LOCALES[localeFor(lang)].prompts.reveal;
}

/**
 * Finds the longest phrase from any group that appears as whole words.
 * Longest-first so "very easy" beats "easy" and "no idea" beats "no".
 */
function matchPhrases(text, groups) {
  let best = null;

  for (const [key, phrases] of Object.entries(groups)) {
    for (const phrase of phrases) {
      if (!containsWords(text, normalize(phrase))) continue;
      if (!best || phrase.length > best.phrase.length) {
        best = { key, phrase };
      }
    }
  }

  return best;
}

/** Whole-word containment, so "no" does not match inside "know" or "nota". */
function containsWords(text, phrase) {
  return ` ${text} `.includes(` ${phrase} `);
}

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * Accents are preserved rather than stripped: \p{L} keeps "fácil" intact, and
 * the tables carry both accented and unaccented spellings because recognizers
 * are inconsistent about emitting them.
 */
function normalize(transcript) {
  if (typeof transcript !== 'string') return '';
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
