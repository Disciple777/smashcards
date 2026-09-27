import { Link } from 'react-router-dom';

import Icon from './Icon.jsx';
import ThemePicker from './ThemePicker.jsx';
import { useAuth } from '../hooks/useAuth.jsx';

/**
 * The landing screen: open something, or make something.
 *
 * The deck list used to be the front door, which meant arriving at a wall of
 * folders, a create form and every deck at once. Those are two different
 * intentions, so they are now two doors — and the list is free to be only a
 * list.
 */
export default function MainMenu() {
  const { user, logout, logoutEverywhere } = useAuth();

  function handleLogoutEverywhere() {
    if (!window.confirm(
      'Sign out on every device? Anything still signed in elsewhere will have to log in again.',
    )) return;

    logoutEverywhere();
  }

  return (
    <div className="screen">
      <header className="topbar">
        <h1 className="topbar__title">Smashcards</h1>
        <div className="topbar__actions">
          <span className="muted">{user.display_name}</span>
          <button className="button button--link" type="button" onClick={logout}>Log out</button>
        </div>
      </header>

      <main className="content menu">
        <Link className="menu__choice" to="/decks">
          <Icon name="folder" className="menu__icon" size={30} />
          <span className="menu__label">Open a deck</span>
          <span className="menu__hint">Your folders and every deck you have</span>
        </Link>

        <Link className="menu__choice" to="/new">
          <Icon name="deck" className="menu__icon" size={30} />
          <span className="menu__label">New deck</span>
          <span className="menu__hint">Start a fresh deck of cards</span>
        </Link>

        <Link className="button button--link" to="/browse">Browse public decks</Link>

        <ThemePicker />

        <button className="button button--link" type="button" onClick={handleLogoutEverywhere}>
          Sign out on all devices
        </button>
      </main>
    </div>
  );
}
