import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../services/ApiClient.js';

/**
 * Browsing decks other users have made public, and copying one into your
 * own account. A clone is a snapshot: new deck, new cards, no connection back
 * to the original and no study history — the roadmap's "clone-to-my-account".
 */
export default function PublicDecks() {
  const navigate = useNavigate();

  const [decks, setDecks] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [cloningId, setCloningId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // A short pause after typing avoids firing a request per keystroke.
    const timer = setTimeout(() => {
      api.listPublicDecks(query)
        .then((result) => { if (!cancelled) { setDecks(result); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  async function handleClone(deck) {
    setCloningId(deck.id);
    setError(null);
    try {
      const cloned = await api.cloneDeck(deck.id);
      navigate(`/decks/${cloned.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCloningId(null);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Link className="button button--link" to="/decks">← Decks</Link>
        <h1 className="topbar__title">Browse public decks</h1>
      </header>

      <main className="content">
        <input
          type="text"
          placeholder="Search by title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search public decks"
        />

        {error && <p className="alert" role="alert">{error}</p>}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : decks.length === 0 ? (
          <p className="muted">
            {query ? 'No public decks match that search.' : 'No public decks yet.'}
          </p>
        ) : (
          <ul className="deck-list">
            {decks.map((deck) => (
              <li key={deck.id} className="card deck">
                <div className="deck__main">
                  <span className="deck__title">{deck.title}</span>
                  {deck.description && <p className="muted">{deck.description}</p>}
                  <p className="deck__counts">
                    <span>{deck.card_count} card{deck.card_count === 1 ? '' : 's'}</span>
                    <span className="muted">by {deck.owner_name}</span>
                  </p>
                </div>
                <div className="deck__actions">
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={cloningId === deck.id}
                    onClick={() => handleClone(deck)}
                  >
                    {cloningId === deck.id ? 'Copying…' : 'Copy to my decks'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
