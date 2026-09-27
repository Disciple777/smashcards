import { Navigate, Route, Routes } from 'react-router-dom';

import AuthScreen from './components/AuthScreen.jsx';
import DeckEditor from './components/DeckEditor.jsx';
import DeckList from './components/DeckList.jsx';
import MainMenu from './components/MainMenu.jsx';
import NewDeck from './components/NewDeck.jsx';
import PublicDecks from './components/PublicDecks.jsx';
import SharedDeck from './components/SharedDeck.jsx';
import StudySession from './components/StudySession.jsx';
import { useAuth } from './hooks/useAuth.jsx';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="screen screen--centered">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <Routes>
      <Route path="/" element={<MainMenu />} />
      <Route path="/decks" element={<DeckList />} />
      <Route path="/new" element={<NewDeck />} />
      <Route path="/folders/:folderId" element={<DeckList />} />
      <Route path="/browse" element={<PublicDecks />} />
      <Route path="/shared/:token" element={<SharedDeck />} />
      <Route path="/decks/:deckId" element={<DeckEditor />} />
      <Route path="/decks/:deckId/study" element={<StudySession />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
