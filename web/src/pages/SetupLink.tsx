import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { VncViewer } from '../components/VncViewer';
import { ErrorNote, Spinner, WaStatePill } from '../components/ui';
import { useAppState } from '../state/AppState';

export function SetupLinkPage() {
  const { wa, refresh } = useAppState();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = wa?.state ?? 'starting';
  const linked = state === 'ready' || state === 'syncing';

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.completeOnboarding();
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setError(null);
    try {
      await api.waRestart();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="setup-link">
      <header className="setup-head">
        <div>
          <h1>Link WhatsApp</h1>
          <p className="muted">
            This is the real WhatsApp Web running in a private browser on your server. Log in to it exactly like on a computer.
          </p>
        </div>
        <WaStatePill status={wa} />
      </header>
      <div className="setup-body">
        <ol className="steps">
          <li>Open <b>WhatsApp</b> on your phone.</li>
          <li>
            Tap <b>Menu ⋮</b> or <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b>.
          </li>
          <li>Point your phone at the QR code on the right (or use “Log in with phone number” in the browser view).</li>
          <li>Wait until the status says <b>Connected</b> or <b>Importing history</b>, then press <b>Complete</b>.</li>
          <li className="muted small">
            View-once photos/videos are never logged. Everything else you send or receive from now on is saved, encrypted, even if it is later deleted.
          </li>
        </ol>
        <VncViewer viewOnly={false} className="setup-vnc" />
      </div>
      <footer className="setup-foot">
        <div className="muted small">
          {wa?.detail ?? ''}
          {wa?.sync ? ` · ${wa.sync.chatsDone}/${wa.sync.chatsTotal} chats` : ''}
        </div>
        <ErrorNote error={error} />
        <div className="row gap">
          <button className="btn ghost" onClick={restart} title="Reload WhatsApp Web in the background browser">
            <Icon name="refresh" size={18} /> Restart
          </button>
          <button className="btn primary" disabled={!linked || busy} onClick={complete}>
            {busy ? <Spinner size={18} /> : linked ? 'Complete' : 'Waiting for WhatsApp…'}
          </button>
        </div>
      </footer>
    </div>
  );
}
