import { useEffect, useRef, useState } from 'react';

import Icon from './Icon.jsx';
import { formatBytes } from './AiImport.jsx';
import { api } from '../services/ApiClient.js';

const KIND_ICON = { text: 'text', document: 'file', audio: 'audio' };
const KIND_LABEL = { text: 'Pasted text', document: 'Document', audio: 'Recording' };

/**
 * The material this deck's cards were made from, kept for reference.
 *
 * Everything that has ever been generated from lands here: the passage someone
 * pasted, the chapter they uploaded, the lecture they recorded — with the
 * original file where there was one, and the transcript beside it where the
 * source was audio. Cards outlive their source (deleting material never
 * deletes cards), but until something is deleted, every card can be traced
 * back to the text that produced it.
 */
export default function SourceLibrary({ sources, onChanged, onGenerateFrom }) {
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingText, setLoadingText] = useState(false);
  const [error, setError] = useState(null);

  if (sources.length === 0) return null;

  async function toggle(source) {
    if (openId === source.id) {
      setOpenId(null);
      setDetail(null);
      return;
    }

    setOpenId(source.id);
    setDetail(null);
    setError(null);
    setLoadingText(true);

    try {
      // The list deliberately carries only a preview — a lecture transcript is
      // far too big to ship for every row, so the full text is fetched on open.
      setDetail(await api.getSource(source.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingText(false);
    }
  }

  async function handleDelete(source) {
    const warning = source.card_count > 0
      ? `Delete "${source.title}"? The ${source.card_count} card${source.card_count === 1 ? '' : 's'} made from it stay in the deck — only the original material and its text are removed.`
      : `Delete "${source.title}"? The original file and its text are removed.`;

    if (!window.confirm(warning)) return;

    try {
      await api.deleteSource(source.id);
      if (openId === source.id) { setOpenId(null); setDetail(null); }
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card stack stack--full">
      <h2 className="section-title">Saved material ({sources.length})</h2>

      {error && <p className="alert" role="alert">{error}</p>}

      <ul className="source-list">
        {sources.map((source) => {
          const open = openId === source.id;

          return (
            <li key={source.id} className="source">
              <div className="source__head">
                <Icon name={KIND_ICON[source.kind] ?? 'file'} className="source__icon" size={20} />

                <div className="source__main">
                  <p className="source__title">{source.title}</p>
                  <p className="source__meta">
                    <span>{KIND_LABEL[source.kind] ?? source.kind}</span>
                    {source.duration_seconds != null && <span>{formatDuration(source.duration_seconds)}</span>}
                    {source.has_file && <span>{formatBytes(source.byte_size)}</span>}
                    <span>{source.text_chars.toLocaleString()} characters</span>
                    {source.card_count > 0 && (
                      <span className="pill pill--new">{source.card_count} card{source.card_count === 1 ? '' : 's'}</span>
                    )}
                  </p>
                </div>
              </div>

              <div className="source__actions">
                <button className="button button--link" type="button" onClick={() => toggle(source)}>
                  <Icon name="text" size={15} /> {open ? 'Hide' : source.kind === 'audio' ? 'Transcript' : 'Text'}
                </button>

                {source.has_file && <OpenFileButton source={source} onError={setError} />}

                <button
                  className="button button--link"
                  type="button"
                  onClick={() => onGenerateFrom(source.id)}
                  title="Make more cards from this"
                >
                  <Icon name="copy" size={15} /> More cards
                </button>

                <button
                  className="button button--link button--danger"
                  type="button"
                  onClick={() => handleDelete(source)}
                >
                  <Icon name="trash" size={15} /> Delete
                </button>
              </div>

              {open && (
                <div className="source__body">
                  {loadingText && <p className="muted">Loading…</p>}
                  {detail && (
                    <>
                      {source.kind === 'audio' && <AudioPlayer sourceId={source.id} onError={setError} />}
                      <pre className="source__text">{detail.content_text}</pre>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Opens the stored original in a new tab.
 *
 * Stored files are not web-readable and the route needs an Authorization
 * header, so there is no URL to link to — the bytes are fetched and handed to
 * the browser as an object URL instead.
 */
function OpenFileButton({ source, onError }) {
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      const blob = await api.fetchSourceFile(source.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // Long enough for the new tab to have taken its own reference.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="button button--link" type="button" onClick={open} disabled={busy}>
      <Icon name="download" size={15} /> {busy ? 'Opening…' : 'Original'}
    </button>
  );
}

/** Plays the stored recording inline, beside its transcript. */
function AudioPlayer({ sourceId, onError }) {
  const [url, setUrl] = useState(null);
  const urlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    api.fetchSourceFile(sourceId)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((err) => { if (!cancelled) onError(err.message); });

    return () => {
      cancelled = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // onError is a setState function and stable; re-running on it would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  if (!url) return <p className="muted">Loading audio…</p>;

  return <audio className="source__audio" src={url} controls preload="metadata" />;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}
