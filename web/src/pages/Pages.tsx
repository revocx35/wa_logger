import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { DeletedFeedItem, SearchResponse } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { useServerEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { MessageBubble } from '../components/MessageBubble';
import { VncViewer } from '../components/VncViewer';
import { Avatar, ConfirmButton, EmptyState, ErrorNote, Spinner, WaStatePill } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useAppState } from '../state/AppState';
import { ChatList } from './ChatList';
import { ChatView } from './ChatView';

/* ------------------------------------------------------------------ chats */

export function ChatsPage() {
  const { chatId } = useParams(); // already URL-decoded by the router
  const id = chatId ?? null;
  return (
    <div className={id ? 'two-pane has-chat' : 'two-pane'}>
      <ChatList activeId={id} />
      {id ? (
        <ChatView key={id} chatId={id} />
      ) : (
        <section className="chat-view placeholder">
          <EmptyState icon="shield" title="wa_logger">
            Select a chat to read its log. Messages deleted for everyone stay visible here and are marked in red.
          </EmptyState>
        </section>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- deleted */

export function DeletedPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DeletedFeedItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before: string | null) => {
    setBusy(true);
    try {
      const page = await api.deleted(before);
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
    if (ev.type === 'message_update' && ev.reason === 'deleted') void load(null);
  });

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          <Icon name="deleted" /> Deleted messages
        </h1>
        <p className="muted">Everything that was deleted for everyone (or on your devices) after it was logged, newest deletion first.</p>
      </header>
      <ErrorNote error={error} />
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState icon="deleted" title="Nothing deleted yet">
          When someone deletes a message you received, the logged copy shows up here.
        </EmptyState>
      ) : (
        <div className="feed">
          {items.map(({ chat, message }) => (
            <article key={message.id} className="feed-item">
              <div className="feed-head">
                <Avatar id={chat.id} name={chat.name} kind={chat.kind} size={32} />
                <b>{chat.name}</b>
                <span className="muted small">deleted {message.deletedAt ? formatDateTime(message.deletedAt) : '—'}</span>
                <button className="btn tiny ghost" onClick={() => navigate(`/chat/${encodeURIComponent(chat.id)}?m=${encodeURIComponent(message.id)}`)}>
                  Open in chat
                </button>
              </div>
              <div className="feed-body">
                <MessageBubble msg={message} isGroup={chat.kind === 'group'} showSender highlighted={false} onJump={() => undefined} />
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

/* ----------------------------------------------------------------- search */

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const initial = params.get('q') ?? '';
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (query: string) => {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await api.search(query.trim()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initial) void run(initial);
  }, [initial, run]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParams({ q: q.trim() });
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>
          <Icon name="search" /> Search messages
        </h1>
        <p className="muted">Searches decrypted text, captions, polls, locations and contact cards across all chats (including deleted messages).</p>
      </header>
      <form className="search-box big" onSubmit={submit} role="search">
        <Icon name="search" size={20} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 characters" autoFocus minLength={2} maxLength={100} />
        <button className="btn primary" disabled={busy || q.trim().length < 2}>
          {busy ? <Spinner size={16} /> : 'Search'}
        </button>
      </form>
      <ErrorNote error={error} />
      {res ? (
        <div className="feed">
          <p className="muted small">
            {res.hits.length} result{res.hits.length === 1 ? '' : 's'}
            {res.truncated ? ' (search stopped early — refine your query for more)' : ''}
          </p>
          {res.hits.map((h) => (
            <button
              key={h.message.id}
              className="search-hit"
              onClick={() => navigate(`/chat/${encodeURIComponent(h.chat.id)}?m=${encodeURIComponent(h.message.id)}`)}
            >
              <Avatar id={h.chat.id} name={h.chat.name} kind={h.chat.kind} size={36} />
              <span className="search-hit-body">
                <span className="row between">
                  <b>{h.chat.name}</b>
                  <span className="muted small">{formatDateTime(h.message.ts)}</span>
                </span>
                <span className="search-hit-text">
                  {h.message.deletedAt ? <span className="badge red">deleted</span> : null} {h.message.fromMe ? 'You' : h.message.senderName}: {h.message.text}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- WA web */

export function WaWebPage() {
  const { wa } = useAppState();
  const [viewOnly, setViewOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const needsLink = wa?.state === 'qr' || wa?.state === 'disconnected';

  useEffect(() => {
    if (needsLink) setViewOnly(false);
  }, [needsLink]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page wa-web">
      <header className="page-head row between wrap">
        <div>
          <h1>
            <Icon name="monitor" /> WA Web
          </h1>
          <p className="muted">The real WhatsApp Web session running in the background browser{wa?.me ? ` — linked to ${wa.me.name ?? ''} ${wa.me.phone ?? ''}` : ''}.</p>
        </div>
        <div className="row gap wrap">
          <WaStatePill status={wa} />
          <label className="switch" title="When on, clicks and typing are not sent to the browser">
            <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} /> View only
          </label>
          <button className="btn ghost" onClick={() => act(api.waRestart)}>
            <Icon name="refresh" size={18} /> Restart
          </button>
          <ConfirmButton className="btn ghost" confirmLabel="Unlink this device" onConfirm={() => act(api.waLogout)} disabled={wa?.state !== 'ready' && wa?.state !== 'syncing'}>
            Unlink
          </ConfirmButton>
        </div>
      </header>
      {needsLink ? (
        <div className="banner warn">
          <Icon name="warning" size={18} /> WhatsApp is not linked. Scan the QR code below with your phone (Linked devices → Link a device).
        </div>
      ) : null}
      <ErrorNote error={error} />
      <VncViewer viewOnly={viewOnly} className="wa-web-vnc" />
      <p className="muted small">
        Tip: keep “View only” on to avoid accidental clicks. The browser only allows WhatsApp domains; downloads and file uploads are disabled.
      </p>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState icon="warning" title="Page not found">
        <Link to="/">Back to chats</Link>
      </EmptyState>
    </div>
  );
}
