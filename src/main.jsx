import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import { AuthProvider } from './hooks/useAuth.jsx';
import { initTheme } from './services/theme.js';
import './styles/app.css';

// Before the first render, so a saved light theme never flashes dark first.
initTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* basename matches Vite's base: the app lives at /smashcards/ */}
    <BrowserRouter basename="/smashcards">
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
