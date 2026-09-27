import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../services/ApiClient.js';
import { computeStats } from '../scheduling/stats.js';

/**
 * End-of-session screen: what just happened, plus the streak that makes coming
 * back tomorrow feel worth it.
 */
export default function SessionSummary({ deckId, reviewed, readMode, error, onStudyAgain }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;

    api.get('/v1/sessions?limit=100')
      .then(({ sessions }) => {
        if (!cancelled) setStats(computeStats(sessions, new Date()));
      })
      // Stats are a nicety; failing to load them must not break the screen.
      .catch(() => { if (!cancelled) setStats(null); });

    return () => { cancelled = true; };
  }, []);

  return (
    <div className="screen screen--centered">
      <div className="card stack">
        <h1>Session complete</h1>
        <p className="muted">
          {reviewed} card{reviewed === 1 ? '' : 's'} {readMode ? 'read' : 'reviewed'}.
        </p>

        {stats && (
          <dl className="stats">
            <div className="stats__item">
              <dt>Streak</dt>
              <dd>{stats.currentStreak} day{stats.currentStreak === 1 ? '' : 's'}</dd>
            </div>
            <div className="stats__item">
              <dt>Best</dt>
              <dd>{stats.longestStreak} day{stats.longestStreak === 1 ? '' : 's'}</dd>
            </div>
            <div className="stats__item">
              <dt>Days studied</dt>
              <dd>{stats.daysStudied}</dd>
            </div>
            <div className="stats__item">
              <dt>Cards all-time</dt>
              <dd>{stats.totalReviewed}</dd>
            </div>
          </dl>
        )}

        {error && <p className="alert">{error}</p>}

        <Link className="button button--primary" to="/decks">Back to decks</Link>
        <button className="button" type="button" onClick={onStudyAgain}>Study again</button>
        <Link className="button button--link" to={`/decks/${deckId}`}>Edit deck</Link>
      </div>
    </div>
  );
}
