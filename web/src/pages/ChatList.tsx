import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { ChatSummary } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { useServerEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { formatListTime } from '../lib/format';
import { stripWaFormatting } from '../lib/waText';

type Filter = 'all' | 'groups' | 'deleted' | 'archived';

function norm(s: string) {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function ChatList({ activeId }: { activeId: string | null }) {
  const navigate = useNavigate();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setChats(await api.chats());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  useServerEvents((ev) => {
    if (ev.type === 'message' || ev.type === 'chat_update' || (ev.type === 'message_update' && ev.reason === 'deleted')) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), 600);
    }
  });

  const visible = useMemo(() => {
    if (!chats) return [];
    const q = norm(query.trim());
    return chats.filter((c) => {
      // Like WhatsApp: archived chats only show under "Archived" (the deleted filter shows everything).
      if (filter === 'archived') {
        if (!c.archived) return false;
      } else if (filter !== 'deleted' && c.archived) return false;
      if (filter === 'groups' && c.kind !== 'group') return false;
      if (filter === 'deleted' && c.deletedCount === 0) return false;
      if (q && !norm(c.name).includes(q)) return false;
      return true;
    });
  }, [chats, query, filter]);

  const searchMessages = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  };

  return (
    <section className="chat-list" aria-label="Chats">
      <header className="pane-head">
        <h2>Chats</h2>
      </header>
      <form className="search-box" onSubmit={searchMessages} role="search">
        <Icon name="search" size={18} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats · Enter searches messages" aria-label="Search" />
        {query ? (
          <button type="button" className="icon-btn small" onClick={() => setQuery('')} aria-label="Clear">
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </form>
      <div className="chips">
        {(['all', 'groups', 'deleted', 'archived'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'groups' ? 'Groups' : f === 'deleted' ? 'Has deleted' : 'Archived'}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="chat-items">
        {!chats ? (
          <div className="center pad">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon="chats" title={chats.length ? 'No matching chats' : 'No chats logged yet'}>
            {chats.length ? null : 'Chats appear here as soon as WhatsApp is connected and messages arrive.'}
          </EmptyState>
        ) : (
          visible.map((c) => (
            <button key={c.id} className={c.id === activeId ? 'chat-item active' : 'chat-item'} onClick={() => navigate(`/chat/${encodeURIComponent(c.id)}`)}>
              <Avatar id={c.id} name={c.name} url={c.avatarUrl} kind={c.kind} />
              <span className="chat-item-body">
                <span className="chat-item-top">
                  <span className="chat-name">{c.name}</span>
                  <span className="chat-time">{formatListTime(c.lastTs)}</span>
                </span>
                <span className="chat-item-bottom">
                  <span className={c.lastMessage?.deleted ? 'chat-preview deleted' : 'chat-preview'}>
                    {c.lastMessage?.deleted ? <Icon name="ban" size={14} /> : null}
                    {c.lastMessage ? (
                      <>
                        {c.kind === 'group' && c.lastMessage.senderName ? <b>{c.lastMessage.senderName}: </b> : c.lastMessage.fromMe ? <b>You: </b> : null}
                        {c.lastMessage.text ? stripWaFormatting(c.lastMessage.text) : ''}
                      </>
                    ) : (
                      <i className="muted">No messages logged</i>
                    )}
                  </span>
                  <span className="chat-badges">
                    {c.pinned ? <Icon name="pushpin" size={14} title="Pinned" /> : null}
                    {c.removed ? <span className="badge gray" title="Removed from WhatsApp, kept in the log">removed</span> : null}
                    {c.deletedCount > 0 ? (
                      <span className="badge red" title={`${c.deletedCount} deleted message(s) preserved`}>
                        <Icon name="ban" size={12} /> {c.deletedCount}
                      </span>
                    ) : null}
                  </span>
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
