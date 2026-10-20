import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminAuditEntry, AdminOverview, AdminUser, ResetMode, UserStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ErrorNote, Modal, Spinner, WaStatePill } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useAppState } from '../state/AppState';
import { RecoveryKeyBox } from './Auth';

const STATUS: Record<UserStatus, { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad' }> = {
  active: { label: 'Active', tone: 'ok' },
  pending: { label: 'Waiting for first sign-in', tone: 'warn' },
  reset: { label: 'Password reset', tone: 'warn' },
  unknown: { label: 'Not reachable', tone: 'bad' },
};

/** Where the person signs in: the port's own address when the admin gave one, else this host on that port. */
function signInUrl(o: AdminOverview, port: number | null): string {
  if (port === null) return o.defaultOrigin ?? window.location.origin;
  const own = o.ports.find((p) => p.port === port)?.origin;
  if (own) return own;
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {hint ? <p className="muted small">{hint}</p> : null}
      {children}
    </section>
  );
}

/** The admin's password (and 2FA code) — asked again for destructive actions. */
function Reauth({ password, onPassword, totp, onTotp }: { password: string; onPassword: (v: string) => void; totp: string; onTotp: (v: string) => void }) {
  const { state } = useAppState();
  return (
    <>
      <label>
        Your admin password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => onPassword(e.target.value)} required />
      </label>
      {state?.totpEnabled ? (
        <label>
          Authentication code
          <input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => onTotp(e.target.value)} required pattern="[0-9 ]{6,7}" />
        </label>
      ) : null}
    </>
  );
}

function TempPassword({ value, who, url }: { value: string; who: string; url: string }) {
  return (
    <>
      <p>
        Give <strong>{who}</strong> this temporary password. It is shown only now.
      </p>
      <RecoveryKeyBox recoveryKey={value} />
      <p className="muted small">
        They sign in at <span className="mono">{url}</span> with their username and this password, and are then asked to choose a password of their own. The temporary password stops working
        once they have.
      </p>
    </>
  );
}

function CreateModal({ o, onClose }: { o: AdminOverview; onClose: () => void }) {
  const [res, setRes] = useState<{ user: AdminUser; temporaryPassword: string } | null>(null);
  return (
    <Modal title={res ? 'User created' : 'Add a user'} onClose={onClose}>
      {res ? (
        <>
          <TempPassword value={res.temporaryPassword} who={res.user.username} url={signInUrl(o, res.user.port)} />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <CreateForm o={o} onCreated={setRes} />
      )}
    </Modal>
  );
}

function CreateForm({ o, onCreated }: { o: AdminOverview; onCreated: (r: { user: AdminUser; temporaryPassword: string }) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.adminCreateUser({ username: username.trim(), ...(password ? { password } : {}), port: port ? Number(port) : null }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]{3,32}" autoFocus autoComplete="off" />
      </label>
      <label>
        Temporary password <span className="muted">(leave empty to generate one)</span>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={256} autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Port
        <PortSelect o={o} value={port} onChange={setPort} />
      </label>
      <ErrorNote error={error} />
      <button className="btn primary" disabled={busy}>
        {busy ? <Spinner size={18} /> : 'Create user'}
      </button>
    </form>
  );
}

function PortSelect({ o, value, onChange, disabled }: { o: AdminOverview; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Default (:{o.defaultPort}) — same address as yours</option>
      {o.ports.map((p) => (
        <option key={p.port} value={String(p.port)}>
          :{p.port}
          {p.origin ? ` — ${p.origin}` : ''}
        </option>
      ))}
    </select>
  );
}

function ResetModal({ o, user, onClose, onDone }: { o: AdminOverview; user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<ResetMode>('recovery');
  const [adminPassword, setAdminPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const claimed = user.status === 'active' || user.status === 'reset';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.adminResetUser(user.id, { mode, ...(custom ? { password: custom } : {}), adminPassword, ...(totp ? { totp: totp.trim() } : {}) });
      setResult(r.temporaryPassword);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    return (
      <Modal title="Password reset" onClose={onClose}>
        <TempPassword value={result} who={user.username} url={signInUrl(o, user.port)} />
        {claimed && mode === 'recovery' ? <p className="muted small">They also need their recovery key to get back into their existing data.</p> : null}
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </Modal>
    );
  }
  return (
    <Modal title={`Reset ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {claimed ? (
          <fieldset className="radio-group">
            <label className="radio">
              <input type="radio" name="mode" checked={mode === 'recovery'} onChange={() => setMode('recovery')} />
              <span>
                <strong>Forgot the password — keep the data.</strong> They sign in with a temporary password and prove they have their recovery key. Their sessions end now.
              </span>
            </label>
            <label className="radio">
              <input type="radio" name="mode" checked={mode === 'wipe'} onChange={() => setMode('wipe')} />
              <span>
                <strong>Start over — delete everything.</strong> Deletes all their logged messages and media and unlinks their WhatsApp. Use it when they lost the recovery key too.
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="muted">They have not signed in yet. This gives them a new temporary password.</p>
        )}
        <label>
          New temporary password <span className="muted">(leave empty to generate one)</span>
          <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} minLength={12} maxLength={256} autoComplete="off" spellCheck={false} />
        </label>
        <Reauth password={adminPassword} onPassword={setAdminPassword} totp={totp} onTotp={setTotp} />
        <ErrorNote error={error} />
        <div className="row gap">
          <button className={mode === 'wipe' && claimed ? 'btn danger' : 'btn primary'} disabled={busy}>
            {busy ? <Spinner size={18} /> : mode === 'wipe' && claimed ? 'Delete their data and reset' : 'Reset password'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adminDeleteUser(user.id, adminPassword, totp.trim() || undefined);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Delete ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p>
          This permanently deletes <strong>{user.username}</strong>: every logged message and media file, their keys, and their browser with the linked WhatsApp session. Their WhatsApp is unlinked
          from the phone. It cannot be undone.
        </p>
        <Reauth password={adminPassword} onPassword={setAdminPassword} totp={totp} onTotp={setTotp} />
        <ErrorNote error={error} />
        <div className="row gap">
          <button className="btn danger" disabled={busy}>
            {busy ? <Spinner size={18} /> : 'Delete permanently'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UsersSection({ o, reload }: { o: AdminOverview; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const patch = async (u: AdminUser, body: { port?: number | null; disabled?: boolean }) => {
    setBusyId(u.id);
    setError(null);
    try {
      await api.adminUpdateUser(u.id, body);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      title="Users"
      hint="Everyone has a WhatsApp of their own, separate encrypted data, separate keys and a separate browser. You see names, status and ports — never messages."
    >
      <div className="table-wrap">
        <table className="table users">
          <thead>
            <tr>
              <th>User</th>
              <th>Account</th>
              <th>WhatsApp</th>
              <th>Port</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {o.users.map((u) => {
              const st = u.disabled ? { label: 'Disabled', tone: 'bad' as const } : STATUS[u.status];
              const me = u.id === o.currentUserId;
              return (
                <tr key={u.id}>
                  <td>
                    <strong>{u.username}</strong> {u.role === 'admin' ? <span className="badge">admin</span> : null} {me ? <span className="muted small">(you)</span> : null}
                  </td>
                  <td>
                    <span className={`pill pill-${st.tone}`}>
                      <span className="dot" />
                      {st.label}
                    </span>
                  </td>
                  <td>{u.wa ? <WaStatePill status={{ state: u.wa, mediaQueue: 0, since: 0, sync: null }} /> : <span className="muted">—</span>}</td>
                  <td>
                    {u.role === 'admin' ? (
                      <span className="muted">:{o.defaultPort} (default)</span>
                    ) : (
                      <PortSelect o={o} value={u.port === null ? '' : String(u.port)} onChange={(v) => void patch(u, { port: v ? Number(v) : null })} disabled={busyId === u.id} />
                    )}
                  </td>
                  <td className="small">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}</td>
                  <td className="actions">
                    {u.role === 'admin' ? null : (
                      <>
                        <button className="btn tiny" disabled={busyId === u.id} onClick={() => void patch(u, { disabled: !u.disabled })}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button className="btn tiny" onClick={() => setResetting(u)}>
                          Reset…
                        </button>
                        <button className="btn tiny danger" onClick={() => setDeleting(u)}>
                          Delete…
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorNote error={error} />
      <p className="muted small">
        Disabling a user ends their sessions and blocks sign-in; their WhatsApp keeps being logged. {o.users.length} of {o.maxUsers} users.
      </p>
      <button className="btn primary" onClick={() => setAdding(true)} disabled={o.users.length >= o.maxUsers}>
        <Icon name="plus" size={18} /> Add a user
      </button>
      {adding ? (
        <CreateModal
          o={o}
          onClose={() => {
            setAdding(false);
            void reload();
          }}
        />
      ) : null}
      {resetting ? <ResetModal o={o} user={resetting} onClose={() => setResetting(null)} onDone={() => void reload()} /> : null}
      {deleting ? <DeleteModal user={deleting} onClose={() => setDeleting(null)} onDone={() => void reload()} /> : null}
    </Section>
  );
}

function PortsSection({ o, reload }: { o: AdminOverview; reload: () => Promise<void> }) {
  const free = o.availablePorts.filter((p) => !o.ports.some((x) => x.port === p));
  const [port, setPort] = useState('');
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Ports"
      hint={
        <>
          The default port <span className="mono">:{o.defaultPort}</span> is yours — the admin account can only sign in there. A user assigned to another port can only sign in there, so you can put your
          own address behind a login proxy (e.g. authentik) and give a friend a separate address without one. Point a reverse-proxy host at each port you open (the compose file publishes{' '}
          <span className="mono">{o.availablePorts.length ? `${o.availablePorts[0]}–${o.availablePorts[o.availablePorts.length - 1]}` : 'none'}</span>, set by <span className="mono">EXTRA_PORTS</span>).
        </>
      }
    >
      {o.ports.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Address people use</th>
                <th>Users</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {o.ports.map((p) => (
                <PortRow key={p.port} port={p} busy={busy} onSave={(v) => run(() => api.adminPutPort(p.port, v))} onRemove={() => run(() => api.adminDeletePort(p.port))} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No extra port is open yet.</p>
      )}
      {free.length ? (
        <form
          className="row gap wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.adminPutPort(Number(port || free[0]), origin.trim() || null)).then((ok) => ok && setOrigin(''));
          }}
        >
          <select value={port || String(free[0])} onChange={(e) => setPort(e.target.value)}>
            {free.map((p) => (
              <option key={p} value={p}>
                :{p}
              </option>
            ))}
          </select>
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://friend.example.com (optional)" inputMode="url" maxLength={200} className="grow" />
          <button className="btn" disabled={busy}>
            Open port
          </button>
        </form>
      ) : (
        <p className="muted small">All published ports are open.</p>
      )}
      <p className="muted small">
        The address is the exact origin the browser uses on that port; it is checked on every request. Leave it empty to accept the address the proxy forwards.
      </p>
      <ErrorNote error={error} />
    </Section>
  );
}

function PortRow({ port, busy, onSave, onRemove }: { port: AdminOverview['ports'][number]; busy: boolean; onSave: (origin: string | null) => unknown; onRemove: () => unknown }) {
  const [origin, setOrigin] = useState(port.origin ?? '');
  const dirty = (port.origin ?? '') !== origin.trim();
  return (
    <tr>
      <td className="mono">:{port.port}</td>
      <td>
        <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="derived from the Host header" inputMode="url" maxLength={200} />
      </td>
      <td className="small">{port.usernames.length ? port.usernames.join(', ') : <span className="muted">nobody</span>}</td>
      <td className="actions">
        <button className="btn tiny" disabled={busy || !dirty} onClick={() => void onSave(origin.trim() || null)}>
          Save
        </button>
        <button className="btn tiny" disabled={busy || port.usernames.length > 0} onClick={() => void onRemove()} title={port.usernames.length ? 'Move its users away first' : 'Close this port'}>
          Close
        </button>
      </td>
    </tr>
  );
}

function LogSection() {
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.adminAudit().then(setRows, (e) => setError(errorMessage(e)));
  }, []);
  return (
    <Section title="Admin log">
      <ErrorNote error={error} />
      {!rows ? (
        <Spinner />
      ) : (
        <div className="table-wrap audit">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>By</th>
                <th>User</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={/fail|bad|deleted|disabled|reset/.test(r.event) ? 'warn-row' : undefined}>
                  <td>{formatDateTime(r.ts)}</td>
                  <td className="mono small">{r.event}</td>
                  <td className="small">{r.actor ?? '—'}</td>
                  <td className="small">{r.target ?? '—'}</td>
                  <td className="mono small">{r.ip ?? '—'}</td>
                  <td className="small">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function AdminPage() {
  const { state } = useAppState();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setOverview(await api.adminOverview());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, [reload]);

  if (state?.role !== 'admin') {
    return (
      <div className="page">
        <p className="muted">Only the admin can manage users.</p>
      </div>
    );
  }
  return (
    <div className="page settings">
      <header className="page-head">
        <h1>
          <Icon name="group" /> Users
        </h1>
        <p className="muted">Signed in as {state.username} (admin)</p>
      </header>
      <ErrorNote error={error} />
      {!overview ? (
        <Spinner />
      ) : (
        <>
          <UsersSection o={overview} reload={reload} />
          <PortsSection o={overview} reload={reload} />
          <LogSection />
        </>
      )}
    </div>
  );
}
