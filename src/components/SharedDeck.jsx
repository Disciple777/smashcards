import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../services/ApiClient.js';

/**
 * The landing page for a share link — /shared/:token.
 *
 * Reached by an unguessable link, not by browsing: the deck may well be
 * private (Browse public decks would never surface it), and that is the
 * point of link sharing. Viewing and cloning here need no relationship to
 * the deck beyond holding the link.
 */
export default function SharedDeck() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSharedDeck(token)
      .then((result) => { if (!cancelled) setDeck(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  async function handleClone() {
    setCloning(true);
    setError(null);
    try {
      const cloned = await api.cloneSharedDeck(token);
      navigate(`/decks/${cloned.id}`);
    } catch (err) {
      setError(err.message);
      setCloning(false);
    }
  }

  return (
    <div className="screen screen--centered">
      <div className="card stack">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : !deck ? (
          <>
            <h1>Link not found</h1>
            <p className="muted">
              {error ?? 'This share link is invalid or has been turned off by its owner.'}
            </p>
            <Link className="button" to="/decks">Back to decks</Link>
          </>
        ) : (
          <>
            <h1>{deck.title}</h1>
            {deck.description && <p className="muted">{deck.description}</p>}
            <p className="deck__counts">
              <span>{deck.card_count} card{deck.card_count === 1 ? '' : 's'}</span>
              <span className="muted">shared by {deck.owner_name}</span>
            </p>

            {error && <p className="alert" role="alert">{error}</p>}

            <button className="button button--primary button--large" type="button" disabled={cloning} onClick={handleClone}>
              {cloning ? 'Copying…' : 'Copy to my decks'}
            </button>
            <Link className="button button--link" to="/decks">Back to decks</Link>
          </>
        )}
      </div>
    </div>
  );
}
