import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { completeNewPassword, signInWithPassword } from '../auth/cognito.jsx';
import { Field } from '../components/Field.jsx';

export default function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function finish(tokens) {
    signIn(tokens);
    navigate('/classes');
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        if (newPassword !== confirm) throw new Error('The two passwords do not match');
        finish((await completeNewPassword(email.trim().toLowerCase(), challenge.session, newPassword)).tokens);
        return;
      }
      const res = await signInWithPassword(email.trim().toLowerCase(), password);
      if (res.challenge) setChallenge(res);
      else finish(res.tokens);
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
          <h2>{challenge ? 'Choose your own password.' : 'Fill out the following form to log in.'}</h2>
          {error && <div className="error">{error}</div>}

          {!challenge ? (
            <>
              <Field label="Email" htmlFor="email">
                <input id="email" type="email" autoComplete="username" placeholder="Enter school email address"
                  value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password" htmlFor="password">
                <input id="password" type="password" autoComplete="current-password" placeholder="•••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          ) : (
            <>
              <div className="hint">You signed in with a temporary password. Choose the password you will use from now on.</div>
              <Field label="New password" htmlFor="new" hint="At least 8 characters, with upper and lower case, a number and a symbol">
                <input id="new" type="password" autoComplete="new-password" value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)} required />
              </Field>
              <Field label="Confirm new password" htmlFor="confirm">
                <input id="confirm" type="password" autoComplete="new-password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
            </>
          )}

          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Please wait' : challenge ? 'Set password and log in' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}