import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field } from '../components/Field.jsx';

/**
 * Sign-in.
 *
 * Locally there is no password check: local/seed.js creates the teachers and
 * this form exchanges an email for a token via the dev endpoint. On AWS the
 * body of submit() becomes a single signIn() call against Amplify Auth and the
 * rest of the screen is untouched.
 *
 * Seeded accounts:
 *   jane.doe@saintinnocent.ac.ke    Teacher, 4 classes
 *   zama.nile@saintinnocent.ac.ke   Head Teacher, all classes
 *   john.man@saintinnocent.ac.ke    Admin, all classes
 */
const ENDPOINT = import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:4000/graphql';
const DEV_TOKEN_URL = ENDPOINT.replace('/graphql', '/dev/token');

export default function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('jane.doe@saintinnocent.ac.ke');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(DEV_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error('That email is not registered at this school');
      const { token } = await res.json();
      signIn(token);
      navigate('/classes');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ minHeight: '100vh', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>Welcome back to</p>
        <div className="brand-name" style={{ fontSize: 'var(--t-3xl)' }}>ConnectED</div>
        <div className="brand-sub">Exam and Gradebook System</div>
      </div>

      <form className="card form-card" onSubmit={submit} style={{ marginTop: 0 }}>
        <div className="stack">
          <h2>Log in to continue.</h2>

          <Field label="Email" htmlFor="email" error={error}>
            <input
              id="email"
              type="email"
              autoComplete="username"
              placeholder="Enter school email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(error)}
              required
            />
          </Field>

          <Field label="Password" htmlFor="password" hint="Not checked in local development">
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="•••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Logging in' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}