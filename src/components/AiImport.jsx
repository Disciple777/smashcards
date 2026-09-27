import { useEffect, useRef, useState } from 'react';

import Icon from './Icon.jsx';
import { api } from '../services/ApiClient.js';
import { extractDocxText, isDocx } from '../services/docxText.js';
import { extractPdfText, looksLikeAScan, renderPdfPages } from '../services/pdfText.js';

const DEPTHS = [
  { value: 'recall', label: 'Facts', hint: 'Definitions, dates, names, formulas' },
  { value: 'mixed', label: 'Mixed', hint: 'Facts with some conceptual questions' },
  { value: 'concept', label: 'Concepts', hint: 'Why and how, rather than trivia' },
];

/**
 * Generate cards from study material.
 *
 * Four ways in — paste a passage, upload a document, upload a recording, or
 * reuse something uploaded earlier — but only one thing actually happens: a
 * *source* is saved, and then cards are generated from its text. Splitting it
 * that way means the material survives a failed generation, a card can be
 * traced back to the paragraph it came from, and "generate a few more from
 * chapter 3" costs no upload and no transcription.
 *
 * Generated cards still land in staging and are never added to the deck here.
 * Approving them is a separate, deliberate step in StagedCards — nothing an AI
 * writes reaches a study session without a human seeing it first.
 */
export default function AiImport({ deckId, sources, onStaged, onSourcesChanged, selected, onSelect }) {
  const [status, setStatus] = useState(null);
  const [limits, setLimits] = useState(null);
  const [tab, setTab] = useState('text');

  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [density, setDensity] = useState(8);
  const [depth, setDepth] = useState('mixed');
  const [provider, setProvider] = useState(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  /** Opt-in, because reading a scan costs AI credit and a plain PDF never needs it. */
  const [ocr, setOcr] = useState(false);
  /** Set when a source has text left over that one request could not carry. */
  const [resume, setResume] = useState(null);

  const fileInput = useRef(null);

  useEffect(() => {
    let cancelled = false;

    api.aiStatus()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setProvider(result.provider ?? result.providers?.[0]?.name ?? null);
      })
      // A server without the phase-3 files deployed simply has no such route.
      .catch(() => { if (!cancelled) setStatus({ configured: false }); });

    // Upload limits are their own request: a server running the older API
    // answers 404 here, which just means uploads are not available yet.
    api.sourceLimits()
      .then((result) => { if (!cancelled) setLimits(result); })
      .catch(() => { if (!cancelled) setLimits({ unavailable: true }); });

    return () => { cancelled = true; };
  }, []);

  // "Generate more from this" in the library selects a source; follow it here.
  useEffect(() => {
    if (selected) setTab('saved');
  }, [selected]);

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="card stack stack--full">
        <h2 className="section-title">Generate cards from your material</h2>
        <p className="muted">
          Not set up on this server yet. It needs an API key for at least one
          provider (Claude, OpenAI or DeepSeek) in <code>api/config.php</code>.
        </p>
      </div>
    );
  }

  const uploadsReady = Boolean(limits && !limits.unavailable && limits.storage_ready);
  const audioReady = uploadsReady && Boolean(limits.audio?.enabled);
  const ocrReady = uploadsReady && Boolean(limits.ocr?.enabled);

  const charLimit = status.limits?.max_chars_per_request ?? 20000;
  const charsLeft = status.usage?.characters_left ?? 0;
  const tooLong = text.length > charLimit;
  const overQuota = text.length > charsLeft;

  const accept = tab === 'audio'
    ? (limits?.audio?.extensions ?? []).map((e) => `.${e}`).join(',')
    : (limits?.documents?.extensions ?? ['pdf', 'txt', 'md']).map((e) => `.${e}`).join(',');

  const maxBytes = tab === 'audio'
    ? (limits?.audio?.max_bytes ?? 0)
    : (limits?.documents?.max_bytes ?? 0);

  function reset() {
    setText('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function switchTab(next) {
    setTab(next);
    setError(null);
    setResume(null);
    setProgress(null);
    if (next !== 'saved') onSelect(null);
  }

  /** Shared tail: generate from a source, report what happened, refresh lists. */
  async function generateFrom(sourceId, offset) {
    setProgress('Writing cards…');

    const result = await api.extractCards(deckId, {
      source_id: sourceId,
      offset,
      density,
      depth,
      provider,
    });

    setStatus((current) => ({ ...current, usage: result.usage }));
    onStaged(result.staged);
    onSourcesChanged();

    // Long material is generated in slices; offer the next one rather than
    // silently stopping partway through a book chapter.
    setResume(
      result.range?.next_offset != null
        ? { sourceId, offset: result.range.next_offset, total: result.range.chars_total }
        : null,
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setResume(null);

    try {
      if (tab === 'text') {
        setProgress('Writing cards…');
        const result = await api.extractCards(deckId, { text: text.trim(), density, depth, provider });
        setStatus((current) => ({ ...current, usage: result.usage }));
        onStaged(result.staged);
        onSourcesChanged();
        reset();
      } else if (tab === 'saved') {
        await generateFrom(Number(selected), 0);
      } else {
        const source = await uploadChosenFile();
        reset();
        await generateFrom(source.id, 0);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Uploads the chosen document or recording and returns the saved source. */
  async function uploadChosenFile() {
    const form = new FormData();
    form.append('file', file);

    if (isPdf(file)) {
      setProgress('Reading the PDF…');
      const extracted = await extractPdfText(file, (page, total) => {
        setProgress(`Reading the PDF… page ${page} of ${total}`);
      });

      if (looksLikeAScan(extracted)) {
        // A scan: the pages are pictures, so there was never any text to find.
        if (!ocr) {
          throw new Error(
            'That PDF has no text in it — its pages are scanned images. '
            + (ocrReady
              ? 'Tick “Read scanned pages” and try again.'
              : 'Reading scanned pages is not set up on this server, so paste the text in by hand.'),
          );
        }

        const maxPages = limits?.ocr?.max_pages ?? 20;
        const images = await renderPdfPages(file, maxPages, (page, total) => {
          setProgress(`Preparing scanned page ${page} of ${total}…`);
        });

        if (images.length === 0) throw new Error('No pages could be read from that PDF.');

        images.forEach((image, i) => {
          form.append('pages[]', image, `page-${String(i + 1).padStart(3, '0')}.jpg`);
        });
      } else {
        form.append('text', extracted);
      }
    } else if (isDocx(file)) {
      setProgress('Reading the Word document…');
      const extracted = await extractDocxText(file);

      if (extracted.trim() === '') {
        throw new Error('That Word document has no text in it.');
      }

      form.append('text', extracted);
    }

    setProgress(
      tab === 'audio'
        ? 'Uploading and transcribing — this can take a few minutes for a long recording…'
        : form.has('pages[]')
          ? 'Reading the scanned pages — this takes a moment per page…'
          : 'Uploading…',
    );

    // The file and its text/transcript are saved together here; generation is
    // a separate call, so a provider failure never costs the upload.
    const saved = await api.uploadSource(deckId, form);
    onSourcesChanged();
    return saved;
  }

  async function handleResume() {
    setBusy(true);
    setError(null);
    try {
      await generateFrom(resume.sourceId, resume.offset);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const oversized = file && maxBytes > 0 && file.size > maxBytes;
  const canSubmit = !busy && (
    tab === 'text' ? Boolean(text.trim()) && !tooLong && !overQuota
      : tab === 'saved' ? Boolean(selected)
        : Boolean(file) && !oversized
  );

  return (
    <form className="card stack stack--full" onSubmit={handleSubmit}>
      <h2 className="section-title">Generate cards from your material</h2>

      <div className="tabs" role="tablist">
        <TabButton current={tab} value="text" onSelect={switchTab} icon="edit">Paste text</TabButton>
        {uploadsReady && (
          <TabButton current={tab} value="document" onSelect={switchTab} icon="file">Document</TabButton>
        )}
        {audioReady && (
          <TabButton current={tab} value="audio" onSelect={switchTab} icon="audio">Audio</TabButton>
        )}
        {sources.length > 0 && (
          <TabButton current={tab} value="saved" onSelect={switchTab} icon="library">Saved</TabButton>
        )}
      </div>

      {tab === 'text' && (
        <>
          <label className="field">
            <span>Paste your notes, an article, or a chapter</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder="Paste the material you want to study…"
            />
          </label>

          <p className={`muted ${tooLong || overQuota ? 'field__error' : ''}`}>
            {text.length.toLocaleString()} / {charLimit.toLocaleString()} characters
            {tooLong && ' — too long, split it into smaller chunks'}
            {!tooLong && overQuota && ' — over your remaining allowance this month'}
          </p>
          <p className="muted">Whatever you paste is saved below, so you can read it again later.</p>
        </>
      )}

      {(tab === 'document' || tab === 'audio') && (
        <>
          <label className="field">
            <span>
              {tab === 'audio'
                ? 'A lecture, a podcast, a voice memo'
                : 'A PDF, a Word document, or a plain text file'}
            </span>
            <input
              ref={fileInput}
              type="file"
              accept={accept}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
            />
          </label>

          <p className={`muted ${oversized ? 'field__error' : ''}`}>
            {file
              ? `${file.name} · ${formatBytes(file.size)}${oversized ? ` — over the ${formatBytes(maxBytes)} limit` : ''}`
              : `Up to ${formatBytes(maxBytes)}${tab === 'audio' ? '' : ' · PDF, DOCX, TXT or MD'}`}
          </p>

          {tab === 'audio' && (
            <p className="muted">
              The recording is transcribed, then cards are made from the transcript.
              Both are kept. {limits?.audio?.minutes_left ?? 0} minutes left this month
              {limits?.audio?.label ? ` · via ${limits.audio.label}` : ''}.
            </p>
          )}
          {tab === 'document' && (
            <>
              {ocrReady && (
                <label className="choice">
                  <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
                  <span>Read scanned pages</span>
                </label>
              )}
              {ocr && (
                <p className="muted">
                  Used only if the PDF turns out to have no text of its own. Its pages are
                  then read as images, up to {limits?.ocr?.max_pages ?? 20} of them, which
                  uses AI credit{limits?.ocr?.label ? ` · via ${limits.ocr.label}` : ''}.
                </p>
              )}
              <p className="muted">
                The file is kept alongside its text, so you can open the original later.
              </p>
            </>
          )}
        </>
      )}

      {tab === 'saved' && (
        <label className="field">
          <span>Material you have already added</span>
          <select value={selected ?? ''} onChange={(e) => onSelect(e.target.value || null)}>
            <option value="">Choose…</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.title} · {source.text_chars.toLocaleString()} characters
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>About {density} cards per 1000 words</span>
        <input
          type="range"
          min="1"
          max="30"
          step="1"
          value={density}
          onChange={(e) => setDensity(Number(e.target.value))}
        />
      </label>

      {(status.providers?.length ?? 0) > 1 && (
        <label className="field">
          <span>Generate with</span>
          <select value={provider ?? ''} onChange={(e) => setProvider(e.target.value)}>
            {status.providers.map((option) => (
              <option key={option.name} value={option.name}>{option.label}</option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>Question style</span>
        <select value={depth} onChange={(e) => setDepth(e.target.value)}>
          {DEPTHS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} — {option.hint}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="alert" role="alert">{error}</p>}
      {busy && progress && <p className="muted" role="status">{progress}</p>}

      <button className="button button--primary" type="submit" disabled={!canSubmit}>
        {busy ? 'Working…' : 'Generate cards'}
      </button>

      {resume && !busy && (
        <button className="button" type="button" onClick={handleResume}>
          Generate more — {(resume.total - resume.offset).toLocaleString()} characters left in this material
        </button>
      )}

      <p className="muted">
        You will review every card before any of them join the deck.
        {' '}
        {charsLeft.toLocaleString()} characters left this month
        {status.providers?.length === 1 && ` · via ${status.providers[0].label}`}.
      </p>
    </form>
  );
}

function TabButton({ current, value, onSelect, icon, children }) {
  const active = current === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tabs__tab${active ? ' tabs__tab--active' : ''}`}
      onClick={() => onSelect(value)}
    >
      <Icon name={icon} size={15} /> {children}
    </button>
  );
}

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
