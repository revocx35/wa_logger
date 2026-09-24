import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ErrorNote, Spinner } from '../components/ui';
import { useAppState } from '../state/AppState';

export function AuthShell({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className="auth-banner" />
      <div className={wide ? 'auth-card wide' : 'auth-card'}>
        <div className="auth-brand">
          <span className="brand-logo">
            <Icon name="shield" size={26} />
          </span>
          <span>wa_logger</span>
        </div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}

function PasswordHints({ password, username }: { password: string; username: string }) {
  const long = [...password].length >= 12;
  const noUser = !username || username.length < 3 || !password.toLowerCase().includes(username.toLowerCase());
  return (
    <ul className="hints">
      <li className={long ? 'ok' : ''}>At least 12 characters (a passphrase of 4+ words is best)</li>
      <li className={noUser ? 'ok' : ''}>Does not contain your username</li>
    </ul>
  );
}

export function SignupPage() {
  const { refresh, setPendingRecoveryKey } = useAppState();
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const res = await api.signup(setupToken.trim(), username.trim(), password);
      setPendingRecoveryKey(res.recoveryKey);
      await refresh();
      navigate('/setup/recovery', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="This instance has no owner yet. Create the single owner account to start logging your WhatsApp."
    >
      <form onSubmit={submit} className="form">
        <label>
          Setup token
          <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" spellCheck={false} required placeholder="SETUP_TOKEN from your .env file" />
        </label>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]{3,32}" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={256} />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <PasswordHints password={password} username={username} />
        <p className="note">
          <Icon name="lock" size={16} /> Your logs are encrypted with a key derived from this password. If you lose both the password and the recovery key,
          the logged data cannot be recovered by anyone.
        </p>
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? <Spinner size={18} /> : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}

export function LoginPage() {
  const { refresh } = useAppState();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password, needTotp ? totp.trim() : undefined);
      if (!res.ok && res.needTotp) {
        setNeedTotp(true);
        return;
      }
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Log in" subtitle="Unlock your encrypted WhatsApp log.">
      <form onSubmit={submit} className="form">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus disabled={needTotp} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required disabled={needTotp} />
        </label>
        {needTotp ? (
          <label>
            Authentication code
            <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus placeholder="123456" />
          </label>
        ) : null}
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? <Spinner size={18} /> : needTotp ? 'Verify' : 'Log in'}
        </button>
        <p className="center muted small">
          <Link to="/recover">Forgot your password?</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function RecoverPage() {
  const { refresh, setPendingRecoveryKey } = useAppState();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const res = await api.recover(username.trim(), recoveryKey, password);
      setPendingRecoveryKey(res.recoveryKey);
      await refresh();
      navigate('/setup/recovery', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Recover access" subtitle="Use the recovery key you saved during signup to set a new password. Two-factor authentication will be turned off.">
      <form onSubmit={submit} className="form">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Recovery key
          <textarea value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} rows={3} spellCheck={false} autoComplete="off" required className="mono" />
        </label>
        <label>
          New password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <PasswordHints password={password} username={username} />
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? <Spinner size={18} /> : 'Reset password'}
        </button>
        <p className="center muted small">
          <Link to="/login">Back to login</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function RecoveryKeyBox({ recoveryKey }: { recoveryKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="recovery-box">
      <code className="mono">{recoveryKey}</code>
      <button type="button" className="btn ghost" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function SetupRecoveryPage() {
  const { pendingRecoveryKey, setPendingRecoveryKey, state } = useAppState();
  const navigate = useNavigate();
  const [ack, setAck] = useState(false);
  const next = () => {
    setPendingRecoveryKey(null);
    navigate(state?.onboardingComplete ? '/' : '/setup/link', { replace: true });
  };
  if (!pendingRecoveryKey) {
    return (
      <AuthShell title="Recovery key" subtitle="The recovery key is only shown once. You can create a new one any time in Settings → Recovery key.">
        <button className="btn primary block" onClick={next}>
          Continue
        </button>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      wide
      title="Save your recovery key"
      subtitle="This key is the only way to regain access to your logs if you forget your password. It is shown only once — store it in a password manager or print it."
    >
      <RecoveryKeyBox recoveryKey={pendingRecoveryKey} />
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have stored my recovery key somewhere safe
      </label>
      <button className="btn primary block" disabled={!ack} onClick={next}>
        Continue
      </button>
    </AuthShell>
  );
}
