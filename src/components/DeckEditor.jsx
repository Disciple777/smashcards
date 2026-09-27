import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import AiImport from './AiImport.jsx';
import EditableCardRow from './EditableCardRow.jsx';
import DeckSettings from './DeckSettings.jsx';
import Icon from './Icon.jsx';
import SourceLibrary from './SourceLibrary.jsx';
import SplitDeck from './SplitDeck.jsx';
import StagedCards from './StagedCards.jsx';
import TextImport from './TextImport.jsx';
import VoiceCardEntry from './VoiceCardEntry.jsx';
import { api } from '../services/ApiClient.js';
import { loadSettings, saveSettings } from '../services/settings.js';
import { speech } from '../services/SpeechService.js';

/**
 * The deck's sections, in the order they appear along the top.
 *
 * The editor used to be one long scroll: add form, generator, staging,
 * library, settings and every card, stacked. Finding the settings meant
 * scrolling past two hundred cards, and the page's meaning changed depending
 * on how far down you were. One section at a time, chosen from a fixed bar,
 * costs one click and gives every part a stable place.
 */
const SECTIONS = [
  { id: 'cards', label: 'Cards', icon: 'deck' },
  { id: 'add', label: 'Add', icon: 'plus' },
  { id: 'generate', label: 'Generate', icon: 'sparkle' },
  { id: 'split', label: 'Split', icon: 'split' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const SECTION_IDS = new Set(SECTIONS.map((section) => section.id));

export default function DeckEditor() {
  const { deckId } = useParams();
  const navigate = useNavigate();

  /**
   * The open section lives in the URL, not in state: a reload, a back button
   * and a link shared to yourself ("…/decks/4?tab=settings") all then land
   * where they should.
   */
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const section = SECTION_IDS.has(requested) ? requested : 'cards';

  const [deck, setDeck] = useState(null);
  const [cards, setCards] = useState([]);
  const [staged, setStaged] = useState([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(() => loadSettings(deckId));
  const [sources, setSources] = useState([]);
  /** Which saved source the generator is pointed at, if any. */
  const [selectedSource, setSelectedSource] = useState(null);

  function openSection(id) {
    // replace: true so the back button leaves the deck rather than walking
    // back through every tab that was looked at.
    setParams(id === 'cards' ? {} : { tab: id }, { replace: true });
  }

  const loadSources = useCallback(async () => {
    // A server running the older API has no such route; uploads simply are
    // not available there, which the importer already handles.
    setSources(await api.listSources(deckId).catch(() => []));
  }, [deckId]);

  const load = useCallback(async () => {
    try {
      const [loadedDeck, loadedCards, loadedStaged] = await Promise.all([
        api.getDeck(deckId),
        api.listCards(deckId),
        // Cards generated in an earlier visit are still waiting for review.
        api.listStagedCards(deckId).catch(() => []),
        loadSources(),
      ]);
      setDeck(loadedDeck);
      setCards(loadedCards);
      setStaged(loadedStaged);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deckId, loadSources]);

  useEffect(() => { load(); }, [load]);

  function updateSettings(changes) {
    setSettings(saveSettings(deckId, changes));
  }

  async function updateDeck(changes) {
    try {
      setDeck(await api.updateDeck(deckId, changes));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  /**
   * Updates local deck state only — no PATCH request. The share link's
   * dedicated create/revoke endpoints already made the network call and
   * returned the new state; a generic PATCH /v1/decks/{id} deliberately does
   * not accept share_token as a field (only those endpoints may set it), so
   * this must not route through updateDeck() above.
   */
  function applyDeckPatch(changes) {
    setDeck((current) => ({ ...current, ...changes }));
  }

  async function handleAddCard(event) {
    event.preventDefault();
    if (!question.trim() || !answer.trim()) return;

    setSaving(true);
    try {
      const card = await api.createCard(deckId, {
        question_text: question.trim(),
        answer_text: answer.trim(),
        // Recorded so phase 4 can compare how voice-entered cards perform.
        source_type: 'manual',
      });
      setCards((current) => [...current, card]);
      setQuestion('');
      setAnswer('');
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCard(cardId) {
    const previous = cards;
    setCards((current) => current.filter((card) => card.id !== cardId));
    try {
      await api.deleteCard(cardId);
    } catch (err) {
      setCards(previous);  // put it back; the server still has it
      setError(err.message);
    }
  }

  async function handleUpdateCard(cardId, changes) {
    const updated = await api.updateCard(cardId, changes);
    setCards((current) => current.map((card) => (card.id === cardId ? updated : card)));
  }

  async function handleDeleteDeck() {
    if (!window.confirm(`Delete "${deck.title}" and all ${cards.length} of its cards? This cannot be undone.`)) {
      return;
    }
    try {
      await api.deleteDeck(deckId);
      navigate('/decks');
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) {
    return <div className="screen screen--centered"><p className="muted">Loading…</p></div>;
  }

  if (!deck) {
    return (
      <div className="screen screen--centered">
        <p className="alert">{error ?? 'Deck not found.'}</p>
        <Link className="button" to="/decks">Back to decks</Link>
      </div>
    );
  }

  /** Counts that earn a badge on the bar, so nothing waiting stays hidden. */
  const badges = { cards: cards.length, generate: staged.length };

  return (
    <div className="screen">
      <header className="topbar">
        <Link className="button button--link" to="/decks">← Decks</Link>
        <h1 className="topbar__title">{deck.title}</h1>
        <Link className="button button--primary" to={`/decks/${deckId}/study`}>Study</Link>
      </header>

      <nav className="section-bar" aria-label="Deck sections">
        <div className="section-bar__inner" role="tablist">
          {SECTIONS.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={`section-tab${section === id ? ' section-tab--active' : ''}`}
              onClick={() => openSection(id)}
            >
              <Icon name={icon} size={18} />
              <span>{label}</span>
              {badges[id] > 0 && <span className="section-tab__badge">{badges[id]}</span>}
            </button>
          ))}
        </div>
      </nav>

      <main className="content">
        {error && <p className="alert" role="alert">{error}</p>}

        {section === 'cards' && (
          <>
            <h2 className="section-title">{cards.length} card{cards.length === 1 ? '' : 's'}</h2>

            {cards.length === 0 ? (
              <p className="muted">
                No cards yet. <button className="button button--link" type="button" onClick={() => openSection('add')}>Add one</button>.
              </p>
            ) : (
              <ul className="card-list">
                {cards.map((card) => (
                  <EditableCardRow
                    key={card.id}
                    card={card}
                    onSave={handleUpdateCard}
                    onDelete={handleDeleteCard}
                    onPlay={() => {
                      // Doubles as the iOS unlock, since this is a real tap.
                      speech.prime();
                      speech.speak(card.question_text, {
                        lang: deck.language_front,
                        rate: settings.rate,
                        voice: speech.voiceByUri(settings.voiceFrontUri),
                      });
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {section === 'add' && (
          <>
            <form className="card stack stack--full" onSubmit={handleAddCard}>
              <h2 className="section-title">Add a card</h2>

              <label className="field">
                <span>Question</span>
                <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} required />
              </label>
              <label className="field">
                <span>Answer</span>
                <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} required />
              </label>

              <VoiceCardEntry deck={deck} onQuestion={setQuestion} onAnswer={setAnswer} />

              <button
                className="button button--primary"
                type="submit"
                disabled={saving || !question.trim() || !answer.trim()}
              >
                {saving ? 'Saving…' : 'Add card'}
              </button>
            </form>

            <TextImport deckId={deckId} onImported={load} />
          </>
        )}

        {section === 'generate' && (
          <>
            <AiImport
              deckId={deckId}
              sources={sources}
              selected={selectedSource}
              onSelect={setSelectedSource}
              onSourcesChanged={loadSources}
              onStaged={(fresh) => setStaged((current) => [...current, ...fresh])}
            />

            <StagedCards
              deckId={deckId}
              cards={staged}
              onChange={setStaged}
              onApproved={load}
            />

            <SourceLibrary
              sources={sources}
              onChanged={loadSources}
              onGenerateFrom={(id) => {
                setSelectedSource(String(id));
                // The generator lives above the library; bring it back into view
                // rather than leaving the user wondering what the click did.
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          </>
        )}

        {section === 'split' && (
          <SplitDeck deck={deck} cards={cards} onChanged={load} />
        )}

        {section === 'settings' && (
          <>
            <DeckSettings
              deck={deck}
              settings={settings}
              onDeckChange={updateDeck}
              onDeckPatch={applyDeckPatch}
              onSettingsChange={updateSettings}
            />

            <button className="button button--danger" type="button" onClick={handleDeleteDeck}>
              <Icon name="trash" size={16} /> Delete deck
            </button>
          </>
        )}
      </main>
    </div>
  );
}
