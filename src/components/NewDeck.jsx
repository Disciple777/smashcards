import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import FolderPicker from './FolderPicker.jsx';
import { api } from '../services/ApiClient.js';

/**
 * Creating a deck, on its own screen.
 *
 * Reached from the main menu, or from a folder in the deck list — in which case
 * `?folder=` carries where the new deck should land, so creating "inside" a
 * folder still works without the list having to host a form.
 */
export default function NewDeck() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const requested = params.get('folder');
  const [folderId, setFolderId] = useState(
    requested && /^\d+$/.test(requested) ? Number(requested) : null,
  );

  const [title, setTitle] = useState('');
  const [folders, setFolders] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.listFolders()
      .then((loaded) => { if (!cancelled) setFolders(loaded); })
      .catch(() => { /* a picker is a convenience; creating still works */ });
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!title.trim()) return;

    setCreating(true);
    try {
      const deck = await api.createDeck({ title: title.trim(), folder_id: folderId });
      // Straight into the new deck: the next thing anyone wants is cards.
      navigate(`/decks/${deck.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Link className="button button--link" to="/">← Menu</Link>
        <h1 className="topbar__title">New deck</h1>
      </header>

      <main className="content">
        <form className="card stack stack--full" onSubmit={handleSubmit}>
          <label className="field">
            <span>Deck title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Spanish verbs, Krebs cycle, chapter 4…"
              aria-label="New deck title"
              autoFocus
            />
          </label>

          {folders.length > 0 && (
            <label className="field">
              <span>Put it in</span>
              <FolderPicker folders={folders} value={folderId} onChange={setFolderId} />
            </label>
          )}

          {error && <p className="alert" role="alert">{error}</p>}

          <button className="button button--primary" type="submit" disabled={creating || !title.trim()}>
            {creating ? 'Creating…' : 'Create deck'}
          </button>
        </form>
      </main>
    </div>
  );
}
