import { useState } from 'react';

import BrandHeader from './BrandHeader.jsx';
import { useAuth } from '../hooks/useAuth.jsx';

export default function AuthScreen() {
  const { login, register } = useAuth();

  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      if (isRegister) {
        await register(email, password, displayName);
      } else {
        await login(email, password);
      }
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  }

  return (
    /* The same name and mark the signed-in menu shows, so the first screen
       and the home screen are recognisably one app. */
    <div className="screen screen--centered screen--hero">
      <BrandHeader />

      <form className="card auth" onSubmit={handleSubmit} noValidate>
        {isRegister && (
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              required
            />
            {fieldErrors.display_name && <em className="field__error">{fieldErrors.display_name}</em>}
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          {fieldErrors.email && <em className="field__error">{fieldErrors.email}</em>}
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
          />
          {fieldErrors.password && <em className="field__error">{fieldErrors.password}</em>}
        </label>

        {error && <p className="alert" role="alert">{error}</p>}

        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : isRegister ? 'Create account' : 'Log in'}
        </button>

        <button
          className="button button--link"
          type="button"
          onClick={() => {
            setMode(isRegister ? 'login' : 'register');
            setError(null);
            setFieldErrors({});
          }}
        >
          {isRegister ? 'I already have an account' : 'Create an account'}
        </button>
      </form>
    </div>
  );
}
