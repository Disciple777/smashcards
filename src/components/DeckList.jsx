import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import FolderPicker from './FolderPicker.jsx';
import Icon from './Icon.jsx';
import UserMenu from './UserMenu.jsx';
import { api } from '../services/ApiClient.js';
import {
  breadcrumbPath,
  childFolders,
  decksInFolder,
  decksInFolderRecursive,
  isSelfOrDescendant,
} from '../services/folderTree.js';

/** Drop targets: every folder id, plus this sentinel for the root ("All decks"). */
const ROOT = 'root';

/**
 * Decks and folders, one level at a time.
 *
 * Folders are optional structure, not a mode switch: with none created, this
 * looks exactly like the flat deck list it always was. The current folder is
 * a route param (/folders/:folderId), not local state, so the URL is
 * shareable and the browser back button walks back up the tree correctly.
 *
 * Moving things has two paths on purpose: drag-and-drop for speed, and an
 * Edit-revealed picker as the fallback that also works on touch, where HTML5
 * drag-and-drop mostly does not.
 */
export default function DeckList() {
  // The signed-in user is shown by UserMenu; this screen itself needs nothing
  // from the auth context any more.
  const { folderId: folderIdParam } = useParams();

  // A malformed id in the URL is treated as root rather than crashing the tree walk.
  const currentFolderId = folderIdParam && /^\d+$/.test(folderIdParam) ? Number(folderIdParam) : null;

  const [folders, setFolders] = useState([]);
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);

  // Which folder row (if any) has its actions expanded — collapsed by default
  // so the list reads as name + count, not a row of controls.
  const [editingFolderId, setEditingFolderId] = useState(null);
  // Which deck row (if any) has its "move to folder" picker expanded.
  const [movingDeckId, setMovingDeckId] = useState(null);

  // Drag-and-drop state. Kept in React state rather than only in
  // dataTransfer because dataTransfer's payload cannot be read during
  // dragover in most browsers — only on drop — and the UI needs to know
  // what's being dragged the whole time, for hover highlighting and for the
  // client-side cycle check.
  const [draggedItem, setDraggedItem] = useState(null); // { type: 'deck'|'folder', id }
  const [dragOverTarget, setDragOverTarget] = useState(null); // folder id, ROOT, or null

  const load = useCallback(async () => {
    try {
      const [loadedFolders, loadedDecks] = await Promise.all([api.listFolders(), api.listDecks()]);
      setFolders(loadedFolders);
      setDecks(loadedDecks);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const crumbs = breadcrumbPath(folders, currentFolderId);
  const subfolders = childFolders(folders, currentFolderId);
  const visibleDecks = decksInFolder(decks, currentFolderId);

  async function handleCreateFolder(event) {
    event.preventDefault();
    if (!newFolderName.trim()) return;

    setCreatingFolder(true);
    try {
      const folder = await api.createFolder({ name: newFolderName.trim(), parent_id: currentFolderId });
      setFolders((current) => [...current, folder]);
      setNewFolderName('');
      setShowNewFolder(false);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleRenameFolder(folder) {
    const name = window.prompt('Rename folder', folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;

    try {
      const updated = await api.updateFolder(folder.id, { name: name.trim() });
      setFolders((current) => current.map((f) => (f.id === folder.id ? updated : f)));
    } catch (err) {
      setError(err.message);
    }
  }

  const handleMoveFolder = useCallback(async (folder, newParentId) => {
    if (folder.parent_id === newParentId) return; // already there
    const previous = folders;
    setFolders((current) => current.map((f) => (f.id === folder.id ? { ...f, parent_id: newParentId } : f)));
    try {
      await api.updateFolder(folder.id, { parent_id: newParentId });
    } catch (err) {
      setFolders(previous); // the server refused (e.g. a cycle) — put it back
      setError(err.message);
    }
  }, [folders]);

  async function handleDeleteFolder(folder) {
    const directDeckCount = decksInFolderRecursive(folders, decks, folder.id).length;
    const message = directDeckCount > 0
      ? `Delete "${folder.name}"? Its subfolders go with it, but its ${directDeckCount} deck${directDeckCount === 1 ? '' : 's'} will move to the root, not be deleted.`
      : `Delete "${folder.name}" and its subfolders?`;
    if (!window.confirm(message)) return;

    try {
      await api.deleteFolder(folder.id);
      await load(); // subfolders and any moved-to-root decks changed server-side
    } catch (err) {
      setError(err.message);
    }
  }

  const handleMoveDeck = useCallback(async (deck, newFolderId) => {
    if ((deck.folder_id ?? null) === newFolderId) return;
    const previous = decks;
    setDecks((current) => current.map((d) => (d.id === deck.id ? { ...d, folder_id: newFolderId } : d)));
    try {
      await api.updateDeck(deck.id, { folder_id: newFolderId });
    } catch (err) {
      setDecks(previous);
      setError(err.message);
    }
  }, [decks]);

  // -------------------------------------------------------- drag and drop --

  function handleDragStart(type, id) {
    return (event) => {
      setDraggedItem({ type, id });
      event.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag at all unless data is actually set.
      event.dataTransfer.setData('text/plain', String(id));
    };
  }

  function handleDragEnd() {
    setDraggedItem(null);
    setDragOverTarget(null);
  }

  /** A folder may not be dropped onto itself or anywhere in its own subtree. */
  function isValidTarget(target) {
    if (!draggedItem) return false;
    if (draggedItem.type === 'deck') return true;

    const destId = target === ROOT ? null : target;
    if (destId === draggedItem.id) return false;
    return destId === null || !isSelfOrDescendant(folders, destId, draggedItem.id);
  }

  function dropZoneProps(target) {
    return {
      onDragOver: (event) => {
        if (!isValidTarget(target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (dragOverTarget !== target) setDragOverTarget(target);
      },
      onDragLeave: () => {
        setDragOverTarget((current) => (current === target ? null : current));
      },
      onDrop: (event) => {
        event.preventDefault();
        setDragOverTarget(null);
        if (!draggedItem || !isValidTarget(target)) { setDraggedItem(null); return; }

        const destFolderId = target === ROOT ? null : target;
        if (draggedItem.type === 'deck') {
          const deck = decks.find((d) => d.id === draggedItem.id);
          if (deck) handleMoveDeck(deck, destFolderId);
        } else {
          const folder = folders.find((f) => f.id === draggedItem.id);
          if (folder) handleMoveFolder(folder, destFolderId);
        }
        setDraggedItem(null);
      },
    };
  }

  function dragOverClass(target) {
    return dragOverTarget === target ? ' drag-over' : '';
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Link className="button button--link" to="/">← Menu</Link>
        <h1 className="topbar__title">Your decks</h1>
        <UserMenu />
      </header>

      <main className="content">
        {(crumbs.length > 0 || folders.length > 0) && (
          <nav className="breadcrumbs" aria-label="Folder path">
            <Link
              to="/decks"
              className={(currentFolderId === null ? 'breadcrumbs__current' : '') + dragOverClass(ROOT)}
              {...dropZoneProps(ROOT)}
            >
              All decks
            </Link>
            {crumbs.map((folder, i) => (
              <span key={folder.id}>
                <span className="breadcrumbs__sep">/</span>
                <Link
                  to={`/folders/${folder.id}`}
                  className={(i === crumbs.length - 1 ? 'breadcrumbs__current' : '') + dragOverClass(folder.id)}
                  {...dropZoneProps(folder.id)}
                >
                  {folder.name}
                </Link>
              </span>
            ))}
          </nav>
        )}

        {showNewFolder ? (
          <form className="card row" onSubmit={handleCreateFolder}>
            <input
              type="text"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              aria-label="New folder name"
              autoFocus
            />
            <button className="button button--primary" type="submit" disabled={creatingFolder || !newFolderName.trim()}>
              Create
            </button>
            <button className="button" type="button" onClick={() => setShowNewFolder(false)}>Cancel</button>
          </form>
        ) : (
          <div className="row">
            <button className="button" type="button" onClick={() => setShowNewFolder(true)}>
              + New folder
            </button>
            {/* Carries the folder being viewed, so "new deck" from inside a
                folder still puts the deck in that folder. */}
            <Link
              className="button"
              to={currentFolderId === null ? '/new' : `/new?folder=${currentFolderId}`}
            >
              + New deck
            </Link>
          </div>
        )}

        {error && <p className="alert" role="alert">{error}</p>}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {subfolders.length > 0 && (
              <ul className="folder-list">
                {subfolders.map((folder) => {
                  const count = decksInFolderRecursive(folders, decks, folder.id).length;
                  const editing = editingFolderId === folder.id;
                  const isDragging = draggedItem?.type === 'folder' && draggedItem.id === folder.id;

                  return (
                    <li
                      key={folder.id}
                      className={`card folder-row${dragOverClass(folder.id)}${isDragging ? ' is-dragging' : ''}`}
                      {...dropZoneProps(folder.id)}
                    >
                      <span
                        className="drag-handle"
                        draggable
                        onDragStart={handleDragStart('folder', folder.id)}
                        onDragEnd={handleDragEnd}
                        title="Drag to move"
                      >
                        <Icon name="grip" size={18} />
                      </span>

                      <Link className="folder-row__main" to={`/folders/${folder.id}`}>
                        <Icon name="folder" className="folder-row__icon" size={22} />
                        <span className="folder-row__name">{folder.name}</span>
                        <span className="muted">{count} deck{count === 1 ? '' : 's'}</span>
                      </Link>

                      <div className="folder-row__actions">
                        {editing ? (
                          <>
                            <FolderPicker
                              folders={folders}
                              value={folder.parent_id}
                              excludeSubtreeOf={folder.id}
                              onChange={(newParentId) => handleMoveFolder(folder, newParentId)}
                            />
                            <button className="button button--link" type="button" onClick={() => handleRenameFolder(folder)}>
                              <Icon name="edit" size={15} /> Rename
                            </button>
                            <button
                              className="button button--link button--danger"
                              type="button"
                              onClick={() => handleDeleteFolder(folder)}
                            >
                              <Icon name="trash" size={15} /> Delete
                            </button>
                            <button className="button button--link" type="button" onClick={() => setEditingFolderId(null)}>
                              Done
                            </button>
                          </>
                        ) : (
                          <button className="button button--link" type="button" onClick={() => setEditingFolderId(folder.id)}>
                            <Icon name="edit" size={15} /> Edit
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {visibleDecks.length === 0 && subfolders.length === 0 ? (
              <p className="muted">
                {currentFolderId === null
                  ? 'No decks yet. Use “New deck” above to get started.'
                  : 'This folder is empty.'}
              </p>
            ) : (
              <ul className="deck-list">
                {visibleDecks.map((deck) => {
                  const isDragging = draggedItem?.type === 'deck' && draggedItem.id === deck.id;
                  const moving = movingDeckId === deck.id;

                  return (
                    <li key={deck.id} className={`card deck${isDragging ? ' is-dragging' : ''}`}>
                      <span
                        className="drag-handle"
                        draggable
                        onDragStart={handleDragStart('deck', deck.id)}
                        onDragEnd={handleDragEnd}
                        title="Drag to move"
                      >
                        <Icon name="grip" size={18} />
                      </span>

                      <div className="deck__main">
                        <Link className="deck__title" to={`/decks/${deck.id}`}>{deck.title}</Link>
                        {deck.description && <p className="muted">{deck.description}</p>}
                        <p className="deck__counts">
                          <span>{deck.card_count} card{deck.card_count === 1 ? '' : 's'}</span>
                          {deck.due_count > 0 && <span className="pill pill--due">{deck.due_count} due</span>}
                          {deck.new_count > 0 && <span className="pill pill--new">{deck.new_count} new</span>}
                        </p>
                      </div>

                      <div className="deck__actions">
                        {/* Edit, not Rename. A rename is one of several things
                            you might come to a deck to change, and offering
                            only that one from the list meant a typo was fixable
                            here but a card was not. This opens the deck's own
                            editor, where renaming lives alongside everything
                            else. */}
                        <Link
                          className="button button--link"
                          to={`/decks/${deck.id}`}
                          title="Edit this deck"
                        >
                          <Icon name="edit" size={15} /> Edit
                        </Link>

                        {folders.length > 0 && (
                          moving ? (
                            <>
                              <FolderPicker
                                folders={folders}
                                value={deck.folder_id}
                                onChange={(newFolderId) => { handleMoveDeck(deck, newFolderId); setMovingDeckId(null); }}
                              />
                              <button className="button button--link" type="button" onClick={() => setMovingDeckId(null)}>
                                Done
                              </button>
                            </>
                          ) : (
                            <button
                              className="button button--link"
                              type="button"
                              onClick={() => setMovingDeckId(deck.id)}
                              title="Move to a folder"
                            >
                              <Icon name="folder" size={15} /> Move
                            </button>
                          )
                        )}
                        <Link
                          className="button button--primary"
                          to={`/decks/${deck.id}/study`}
                          // Nothing to study when every card is scheduled for later.
                          aria-disabled={deck.card_count === 0}
                        >
                          Study
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}
