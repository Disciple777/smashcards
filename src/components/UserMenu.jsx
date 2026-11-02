import { Link } from 'react-router-dom';

import Icon from './Icon.jsx';
import { useAuth } from '../hooks/useAuth.jsx';

/**
 * Who is signed in, and the way to everything about them: name, then a cog.
 *
 * Logging out used to sit in the top bar of every screen, which spent a
 * permanent slot on something done once a month and put a destructive action
 * one mis-tap from the deck list. It now lives behind the cog, with the theme
 * picker and "sign out everywhere" — one place for everything that is about
 * *you* rather than about your cards.
 */
export default function UserMenu() {
  const { user } = useAuth();

  return (
    <div className="user-menu">
      <span className="user-menu__name">{user.display_name}</span>
      <Link className="icon-button" to="/settings" aria-label="Settings" title="Settings">
        <Icon name="settings" size={20} />
      </Link>
    </div>
  );
}
