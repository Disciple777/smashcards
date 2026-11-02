import { Link } from 'react-router-dom';

import BrandHeader from './BrandHeader.jsx';
import Icon from './Icon.jsx';
import UserMenu from './UserMenu.jsx';

/**
 * The landing screen: the name, then the three things anyone comes here to do.
 *
 * It used to carry the theme picker and "sign out on all devices" as well,
 * which meant the first screen of the app gave equal billing to choosing a
 * colour, ending every session you have, and studying. Those both moved
 * behind the cog; what is left is one identity and three doors.
 */
export default function MainMenu() {
  return (
    <div className="screen screen--hero">
      <header className="topbar topbar--floating">
        <UserMenu />
      </header>

      <main className="content menu">
        <BrandHeader />

        <nav className="menu__choices" aria-label="Main">
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

          <Link className="menu__choice" to="/browse">
            <Icon name="library" className="menu__icon" size={30} />
            <span className="menu__label">Browse public decks</span>
            <span className="menu__hint">Copy a deck someone else has shared</span>
          </Link>
        </nav>
      </main>
    </div>
  );
}
