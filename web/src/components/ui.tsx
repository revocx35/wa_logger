import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatKind, WaState, WaStatus } from '../../../shared/api';
import { colorFor, initials } from '../lib/format';
import { Icon } from './Icon';

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function Avatar({ id, name, url, kind, size = 49 }: { id: string; name: string; url?: string | null; kind?: ChatKind; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.38 };
  if (url && !failed) {
    return <img className="avatar" src={url} alt="" style={style} onError={() => setFailed(true)} loading="lazy" decoding="async" />;
  }
  if (kind === 'group' || kind === 'broadcast') {
    return (
      <span className="avatar avatar-icon" style={style}>
        <Icon name="group" size={size * 0.55} />
      </span>
    );
  }
  if (kind === 'status') {
    return (
      <span className="avatar avatar-icon status-ring" style={style}>
        <Icon name="refresh" size={size * 0.5} />
      </span>
    );
  }
  return (
    <span className="avatar avatar-initials" style={{ ...style, backgroundColor: colorFor(id) }}>
      {initials(name)}
    </span>
  );
}

const STATE_LABEL: Record<WaState, string> = {
  idle: 'Not started',
  starting: 'Starting',
  qr: 'Waiting for QR scan',
  authenticating: 'Linking',
  syncing: 'Importing history',
  ready: 'Connected',
  disconnected: 'Disconnected',
  error: 'Reconnecting',
};

export function WaStatePill({ status, compact = false }: { status: WaStatus | null | undefined; compact?: boolean }) {
  const state = status?.state ?? 'idle';
  const tone = state === 'ready' ? 'ok' : state === 'syncing' || state === 'authenticating' || state === 'starting' ? 'busy' : state === 'qr' ? 'warn' : 'bad';
  let label = STATE_LABEL[state];
  if (state === 'syncing' && status?.sync) label = `Importing ${status.sync.chatsDone}/${status.sync.chatsTotal}`;
  return (
    <span className={`pill pill-${tone}`} title={status?.detail ?? label}>
      <span className="dot" />
      {compact ? null : label}
    </span>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Confirmation built into the page (no window.confirm). */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  className = 'btn',
  disabled,
}: {
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => unknown;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return armed ? (
    <span className="confirm-row">
      <button className={`${className} danger`} disabled={disabled} onClick={() => { setArmed(false); void onConfirm(); }}>
        {confirmLabel}
      </button>
      <button className="btn ghost" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button className={className} disabled={disabled} onClick={() => setArmed(true)}>
      {children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="error-note" role="alert">
      <Icon name="warning" size={16} /> {error}
    </p>
  );
}

export function EmptyState({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={56} />
      <h3>{title}</h3>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}
