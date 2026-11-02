import { Link } from 'react-router-dom';

import Icon from './Icon.jsx';
import ThemePicker from './ThemePicker.jsx';
import { useAuth } from '../hooks/useAuth.jsx';

/**
 * Everything about the person rather than their cards: appearance, account,
 * and the two ways out.
 *
 * Appearance comes first because it is the only thing here anyone opens for
 * fun; signing out is at the bottom, where a destructive action belongs and
 * where it is not the first thing a thumb lands on.
 */
export default function Settings() {
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
        <Link className="button button--link" to="/">← Menu</Link>
        <h1 className="topbar__title">Settings</h1>
      </header>

      <main className="content">
        <ThemePicker />

        <section className="card stack stack--full">
          <h2 className="section-title">Account</h2>

          <dl className="facts">
            <div className="facts__row">
              <dt>Name</dt>
              <dd>{user.display_name}</dd>
            </div>
            <div className="facts__row">
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
          </dl>

          <hr className="rule" />

          <button className="button" type="button" onClick={logout}>
            Log out on this device
          </button>

          <button className="button button--danger" type="button" onClick={handleLogoutEverywhere}>
            <Icon name="close" size={16} /> Sign out on all devices
          </button>

          <p className="muted">
            Signing out everywhere ends every session you have open, including
            this one. Use it if you have signed in on a device you no longer have.
          </p>
        </section>
      </main>
    </div>
  );
}
