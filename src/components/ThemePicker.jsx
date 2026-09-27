import { useState } from 'react';

import { SYSTEM, THEMES, loadTheme, saveTheme } from '../services/theme.js';

/**
 * Picks the app's colour theme.
 *
 * Each option wears the theme it offers — the button carries `data-theme`,
 * so the stylesheet paints it in that palette's real colours. Nothing here
 * knows a single hex code, and a preview therefore cannot lie about the
 * theme it is previewing.
 *
 * The only exception is "Match my device", which has no palette of its own:
 * it is drawn as a split of the two device defaults.
 */
export default function ThemePicker() {
  const [theme, setTheme] = useState(loadTheme);

  function choose(id) {
    setTheme(saveTheme(id));
  }

  return (
    <section className="card stack stack--full">
      <h2 className="section-title">Appearance</h2>

      <div className="theme-grid" role="radiogroup" aria-label="Colour theme">
        {THEMES.map((option) => {
          const active = option.id === theme;

          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={
                'theme-option'
                + (active ? ' theme-option--active' : '')
                + (option.id === SYSTEM ? ' theme-option--auto' : '')
              }
              // The attribute is what themes the swatch; `system` has none.
              data-theme={option.id === SYSTEM ? undefined : option.id}
              onClick={() => choose(option.id)}
            >
              <span className="theme-option__preview" aria-hidden="true">
                <span className="theme-option__dot theme-option__dot--surface" />
                <span className="theme-option__dot theme-option__dot--primary" />
                <span className="theme-option__dot theme-option__dot--new" />
              </span>
              <span className="theme-option__label">{option.label}</span>
            </button>
          );
        })}
      </div>

      <p className="muted">
        The theme is this device's own choice and applies everywhere in the app.
      </p>
    </section>
  );
}
