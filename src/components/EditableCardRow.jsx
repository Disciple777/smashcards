import { useState } from 'react';

/**
 * One card in a deck's card list — view mode by default, an inline edit form
 * on demand. Kept as its own component (rather than inline state in
 * DeckEditor) so each row's edit buffer is independent: editing one card
 * cannot leak draft text into another.
 */
export default function EditableCardRow({ card, onSave, onDelete, onPlay }) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(card.question_text);
  const [answer, setAnswer] = useState(card.answer_text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function startEdit() {
    setQuestion(card.question_text);
    setAnswer(card.answer_text);
    setError(null);
    setEditing(true);
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!question.trim() || !answer.trim()) return;

    setSaving(true);
    setError(null);
    try {
      await onSave(card.id, { question_text: question.trim(), answer_text: answer.trim() });
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <li className="card card-row card-row--editing">
        <form className="stack" onSubmit={handleSave}>
          <label className="field">
            <span>Question</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>Answer</span>
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} required />
          </label>

          {error && <p className="alert" role="alert">{error}</p>}

          <div className="card-row__actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={saving || !question.trim() || !answer.trim()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="button" type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="card card-row">
      <div className="card-row__text">
        <strong>{card.question_text}</strong>
        <span className="muted">{card.answer_text}</span>
      </div>
      <div className="card-row__actions">
        <button className="button button--link" type="button" title="Hear this card" onClick={onPlay}>
          ▶
        </button>
        <button className="button button--link" type="button" onClick={startEdit}>
          Edit
        </button>
        <button className="button button--link button--danger" type="button" onClick={() => onDelete(card.id)}>
          Delete
        </button>
      </div>
    </li>
  );
}
