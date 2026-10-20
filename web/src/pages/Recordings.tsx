import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CallRecording } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { useServerEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { Avatar, ConfirmButton, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';

function Player({ r }: { r: CallRecording }) {
  if (r.status === 'recording') {
    return (
      <p className="rec-live">
        <span className="rec-dot" /> Recording now…
      </p>
    );
  }
  if (r.status === 'processing') {
    return (
      <p className="muted small">
        <Spinner size={14} /> Saving the recording…
      </p>
    );
  }
  if (r.status === 'failed' || !r.url) return <ErrorNote error="This recording could not be saved." />;
  // Plain media elements: the file is an ordinary encrypted media file served with Range support.
  return r.video ? (
    <video className="rec-player video" src={r.url} controls preload="metadata" playsInline />
  ) : (
    <audio className="rec-player" src={r.url} controls preload="metadata" />
  );
}

export function CallsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<CallRecording[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before: number | null) => {
    setBusy(true);
    try {
      const page = await api.callRecordings(before);
      setItems((cur) => (before && cur ? [...cur, ...page.items] : page.items));
      setNext(page.nextBefore);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  useServerEvents((ev) => {
    if (ev.type === 'call_recording') void load(null);
  });

  const remove = async (r: CallRecording) => {
    try {
      await api.deleteCallRecording(r.id);
      setItems((cur) => cur?.filter((x) => x.id !== r.id) ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          <Icon name="phone" /> Call recordings
        </h1>
        <p className="muted">
          Calls you recorded with the record button during a call, or automatically (Settings → Logging). The files are encrypted like everything else here. Check that the other person knows: recording
          a call without consent is not allowed everywhere.
        </p>
      </header>
      <ErrorNote error={error} />
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState icon="phone" title="No recordings yet">
          Press the record button during a call, or turn on “Record calls automatically” in Settings.
        </EmptyState>
      ) : (
        <div className="feed">
          {items.map((r) => (
            <article key={r.id} className="feed-item">
              <div className="feed-head">
                <Avatar id={r.chatId ?? String(r.id)} name={r.name ?? 'Unknown'} url={r.avatarUrl} size={32} />
                <b>{r.name ?? 'Unknown'}</b>
                <span className="muted small">
                  {r.direction === 'incoming' ? 'Incoming' : 'Outgoing'} {r.video ? 'video ' : ''}call · {formatDateTime(r.startedAt)}
                  {r.durationMs !== null ? ` · ${formatDuration(r.durationMs / 1000)}` : ''}
                  {r.size ? ` · ${formatBytes(r.size)}` : ''}
                  {r.auto ? ' · automatic' : ''}
                </span>
                {r.chatId ? (
                  <button className="btn tiny ghost" onClick={() => navigate(`/chat/${encodeURIComponent(r.chatId!)}`)}>
                    Open chat
                  </button>
                ) : null}
                <ConfirmButton className="btn tiny ghost" confirmLabel="Delete recording" onConfirm={() => remove(r)} disabled={r.status === 'recording' || r.status === 'processing'}>
                  Delete
                </ConfirmButton>
              </div>
              <div className="feed-body">
                <Player r={r} />
              </div>
            </article>
          ))}
          {next ? (
            <button className="btn block" disabled={busy} onClick={() => load(next)}>
              {busy ? <Spinner size={18} /> : 'Load more'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
