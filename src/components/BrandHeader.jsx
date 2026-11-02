/**
 * The app's name and mark, shown at the top of the two screens that are
 * somebody's first sight of it: the login screen and the main menu.
 *
 * The mark is drawn inline rather than loaded from `public/icon.svg` so that
 * its body is `currentColor` and follows the theme — the tab icon and the
 * home-screen icon cannot change colour per theme, but the one *inside* the
 * app can, and a fixed blue square on the green or cherry palettes was the
 * one thing on the screen not wearing the theme. The geometry is the same
 * artwork, `SHAPES` in tools/make-icons.mjs; the card stays white in every
 * theme, exactly as it does in the generated files.
 *
 * "Cards" takes the primary colour rather than the whole title being a
 * gradient: a gradient wordmark has to be re-tuned for twelve palettes and
 * reads as grey on at least one of them, while an accented second word
 * borrows a colour the rest of the UI has already proved readable.
 */
export default function BrandHeader({ tagline = 'Flashcards you can study by ear.' }) {
  return (
    <div className="brand">
      <svg className="brand__mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
        <rect x="0" y="0" width="1024" height="1024" rx="224" fill="currentColor" />
        <rect
          x="302" y="232" width="420" height="560" rx="56"
          fill="#ffffff" opacity="0.42" transform="rotate(-15 512 512)"
        />
        <rect
          x="302" y="232" width="420" height="560" rx="56"
          fill="#ffffff" transform="rotate(4 512 512)"
        />
        <path
          d="M560 332 L422 532 L500 532 L464 692 L602 492 L524 492 Z"
          fill="currentColor"
          transform="rotate(4 512 512)"
        />
      </svg>

      <h1 className="brand__title">
        Smash<span className="brand__title-em">Cards</span>
      </h1>
      {tagline && <p className="brand__tagline">{tagline}</p>}
    </div>
  );
}
