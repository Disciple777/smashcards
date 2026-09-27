/**
 * App-wide colour themes.
 *
 * The palettes themselves live in CSS (`app.css`, one `[data-theme="…"]`
 * block each) rather than here, and this module only names them and remembers
 * the choice. That split matters for one reason: because the selector is
 * `[data-theme]` and not `:root[data-theme]`, the picker's swatches can wear
 * the theme they offer and show its *real* colours, so a palette can never
 * drift from its own preview.
 *
 * `system` is the absence of the attribute, which lets the
 * `prefers-color-scheme` block in the stylesheet do its normal job — a theme
 * that follows the phone's own light/dark schedule without any JavaScript.
 */

const STORAGE_KEY = 'smashcards.theme';

export const SYSTEM = 'system';

export const THEMES = Object.freeze([
  { id: SYSTEM, label: 'Match my device', mode: 'auto' },

  { id: 'daylight', label: 'Daylight', mode: 'light' },
  { id: 'parchment', label: 'Parchment', mode: 'light' },
  { id: 'meadow', label: 'Meadow', mode: 'light' },
  { id: 'blossom', label: 'Blossom', mode: 'light' },

  { id: 'midnight', label: 'Midnight', mode: 'dark' },
  { id: 'nebula', label: 'Nebula', mode: 'dark' },
  { id: 'forest', label: 'Forest', mode: 'dark' },
  { id: 'carbon', label: 'Carbon', mode: 'dark' },
]);

const IDS = new Set(THEMES.map((theme) => theme.id));

export function loadTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && IDS.has(saved) ? saved : SYSTEM;
  } catch {
    // Private mode or blocked storage: the system theme is a fine answer.
    return SYSTEM;
  }
}

export function saveTheme(id) {
  const theme = IDS.has(id) ? id : SYSTEM;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A theme that cannot be remembered still applies for this visit.
  }
  applyTheme(theme);
  return theme;
}

/**
 * Puts the theme on <html> and syncs the browser chrome colour to it.
 *
 * The `theme-color` meta is what tints Safari's toolbar and Android's status
 * bar. Left at its build-time value, a light theme gets a black bar above it,
 * which is the one piece of the UI CSS alone cannot reach.
 */
export function applyTheme(id) {
  const root = document.documentElement;

  if (!id || id === SYSTEM) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // Read it back from the cascade rather than from a table here, so the
    // stylesheet stays the single source of truth for every colour.
    const surface = getComputedStyle(root).getPropertyValue('--surface').trim();
    if (surface) meta.setAttribute('content', surface);
  }
}

/** Called once at boot, before React renders, so there is no flash of the wrong theme. */
export function initTheme() {
  applyTheme(loadTheme());
}
