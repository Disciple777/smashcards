/**
 * A small hand-authored icon set — no icon package dependency, just inline
 * SVG keyed by name. `currentColor` throughout, so an icon inherits text
 * color and themes for free in both light and dark mode.
 *
 * Deliberately a flat registry rather than one file per icon: the payoff is
 * that adding a per-folder or per-deck icon picker later is just adding more
 * entries here and rendering <Icon name="..." /> from a stored field — the
 * mechanism already exists.
 */

const PATHS = {
  folder: (
    <path
      d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4l1.6 1.8H19.5A1.5 1.5 0 0 1 21 8.3v9.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  ),
  edit: (
    <path
      d="M4 16.5V20h3.5L17.8 9.7l-3.5-3.5L4 16.5zM19.7 6.6a1.2 1.2 0 0 0 0-1.7l-2.6-2.6a1.2 1.2 0 0 0-1.7 0l-1.9 1.9 4.3 4.3 1.9-1.9z"
      fill="currentColor"
    />
  ),
  trash: (
    <path
      d="M4.5 7h15M9.5 7V5.2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1V7m1.5 0v12.3a1.7 1.7 0 0 1-1.7 1.7H8.7A1.7 1.7 0 0 1 7 19.3V7h10zM10.3 11v6.3M14 11v6.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  link: (
    <path
      d="M10 14a3.2 3.2 0 0 0 4.5.3l.2-.2 2.1-2.1a3.2 3.2 0 0 0-4.4-4.6l-.3.3-1.1 1M14 10a3.2 3.2 0 0 0-4.5-.3l-.2.2-2.1 2.1a3.2 3.2 0 0 0 4.4 4.6l.3-.3 1.1-1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  copy: (
    <path
      d="M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  ),
  close: (
    <path
      d="M6 6l12 12M18 6L6 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  ),
  check: (
    <path
      d="M5 12.5l4.5 4.5L19 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  deck: (
    <>
      <path
        d="M6.5 8.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8.5 5.5h9a1 1 0 0 1 1 1v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </>
  ),
  grip: (
    <g fill="currentColor">
      <circle cx="9" cy="6" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="9" cy="18" r="1.3" />
      <circle cx="15" cy="6" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="15" cy="18" r="1.3" />
    </g>
  ),
  file: (
    <path
      d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5zM13 3.8V8a1 1 0 0 0 1 1h4.2M8.5 13h7M8.5 16.5h5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  audio: (
    <path
      d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M9 20.5h6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  library: (
    <path
      d="M4.5 5.5h4v14h-4v-14zM10.5 5.5h4v14h-4v-14zM16.8 6.1l3.1.8-3.4 13.1-3.1-.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  ),
  download: (
    <path
      d="M12 4v11m0 0l-4-4m4 4l4-4M5 18.5h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  plus: (
    <path
      d="M12 5v14M5 12h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  ),
  sparkle: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M11 3.5l1.9 4.6 4.6 1.9-4.6 1.9L11 16.5l-1.9-4.6L4.5 10l4.6-1.9L11 3.5z" />
      <path d="M17.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" />
    </g>
  ),
  split: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h5M13 6h7M13 12h7M13 18h7" />
      <path d="M9 12V7.5a1.5 1.5 0 0 1 1.5-1.5H13M9 12v4.5a1.5 1.5 0 0 0 1.5 1.5H13" />
    </g>
  ),
  settings: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8l1.5 2.3 2.7-.5.6 2.7 2.4 1.4-1.4 2.4 1.4 2.4-2.4 1.4-.6 2.7-2.7-.5L12 21.2l-1.5-2.3-2.7.5-.6-2.7L4.8 15l1.4-2.4L4.8 10l2.4-1.4.6-2.7 2.7.5L12 2.8z" />
    </g>
  ),
  text: (
    <path
      d="M5 6.5h14M5 11h14M5 15.5h9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  ),
};

export default function Icon({ name, size = 20, className }) {
  const content = PATHS[name];
  if (!content) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {content}
    </svg>
  );
}
