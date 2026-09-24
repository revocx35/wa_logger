import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ChatSummary, Message, SearchHit } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { useServerEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { MessageBubble } from '../components/MessageBubble';
import { Avatar, ErrorNote, Spinner } from '../components/ui';
import { dayKey, formatDayLabel, formatListTime } from '../lib/format';

const PAGE = 60;
const GROUP_GAP_MS = 5 * 60_000;

function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => a.ts - b.ts || a.capturedAt - b.capturedAt);
}

function upsert(list: Message[], m: Message): Message[] {
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = m;
    return next;
  }
  return sortMessages([...list, m]);
}

export function ChatView({ chatId }: { chatId: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const focusId = params.get('m');
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);
  const scrollTarget = useRef<string | null>(null);

  const isGroup = chat?.kind === 'group' || chat?.kind === 'status' || chat?.kind === 'broadcast';

  const loadChatInfo = useCallback(async () => {
    try {
      const all = await api.chats();
      setChat(all.find((c) => c.id === chatId) ?? null);
    } catch {
      /* header only */
    }
  }, [chatId]);

  // Initial load (latest page, or a page around a focused message).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setNextBefore(null);
    setNextAfter(null);
    setHits(null);
    void loadChatInfo();
    (async () => {
      try {
        const page = focusId ? await api.messagesAround(chatId, focusId, PAGE) : await api.messages(chatId, null, PAGE);
        if (cancelled) return;
        setMessages(page.messages);
        setNextBefore(page.nextBefore);
        setNextAfter(page.nextAfter ?? null);
        if (focusId) {
          scrollTarget.current = focusId;
          setHighlight(focusId);
          stickToBottom.current = false;
        } else {
          stickToBottom.current = true;
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, focusId, loadChatInfo]);

  // Keep scroll position stable when older messages are prepended; stick to bottom otherwise.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      return;
    }
    if (scrollTarget.current) {
      const target = document.getElementById(`m-${scrollTarget.current}`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        scrollTarget.current = null;
      }
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const loadOlder = useCallback(async () => {
    if (!nextBefore || loadingOlder) return;
    const el = scroller.current;
    setLoadingOlder(true);
    try {
      const page = await api.messages(chatId, nextBefore, PAGE);
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((cur) => sortMessages([...page.messages.filter((m) => !cur.some((c) => c.id === m.id)), ...cur]));
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, nextBefore, loadingOlder]);

  const loadNewer = useCallback(async () => {
    if (!nextAfter) return;
    try {
      const page = await api.messagesAfter(chatId, nextAfter, PAGE);
      setMessages((cur) => sortMessages([...cur, ...page.messages.filter((m) => !cur.some((c) => c.id === m.id))]));
      setNextAfter(page.nextAfter ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [chatId, nextAfter]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 && !nextAfter;
    if (el.scrollTop < 300) void loadOlder();
    if (nextAfter && el.scrollHeight - el.scrollTop - el.clientHeight < 300) void loadNewer();
  };

  // Live updates.
  useServerEvents((ev) => {
    if ((ev.type === 'message' || ev.type === 'message_update') && ev.chatId === chatId) {
      if (ev.type === 'message' && nextAfter) return; // viewing older history; will load when scrolling down
      api.message(ev.messageId).then(
        (m) => setMessages((cur) => upsert(cur, m)),
        () => undefined,
      );
      if (ev.type === 'message' || (ev.type === 'message_update' && ev.reason === 'deleted')) void loadChatInfo();
    } else if (ev.type === 'chat_update' && ev.chatId === chatId) {
      void loadChatInfo();
    }
  });

  const jump = useCallback(
    (messageId: string) => {
      if (messages.some((m) => m.id === messageId)) {
        document.getElementById(`m-${messageId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setHighlight(messageId);
        return;
      }
      setParams({ m: messageId }, { replace: false });
    },
    [messages, setParams],
  );

  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try {
      setHits((await api.search(q.trim(), chatId)).hits);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const rows = useMemo(() => {
    const out: ({ kind: 'day'; key: string; label: string } | { kind: 'msg'; m: Message; showSender: boolean })[] = [];
    let lastDay = '';
    let prev: Message | null = null;
    for (const m of messages) {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) {
        out.push({ kind: 'day', key: `d-${dk}`, label: formatDayLabel(m.ts) });
        lastDay = dk;
        prev = null;
      }
      const showSender = !prev || prev.senderId !== m.senderId || prev.fromMe !== m.fromMe || m.ts - prev.ts > GROUP_GAP_MS || prev.type === 'system';
      out.push({ kind: 'msg', m, showSender });
      prev = m;
    }
    return out;
  }, [messages]);

  const title = chat?.name ?? '…';

  return (
    <section className="chat-view" aria-label={`Chat ${title}`}>
      <header className="chat-head">
        <button className="icon-btn mobile-only" onClick={() => navigate('/')} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <Avatar id={chatId} name={title} url={chat?.avatarUrl} kind={chat?.kind} size={40} />
        <div className="chat-head-info">
          <div className="chat-head-name">{title}</div>
          <div className="muted small">
            {chat
              ? `${chat.messageCount} logged${chat.deletedCount ? ` · ${chat.deletedCount} deleted preserved` : ''}${chat.removed ? ' · removed from WhatsApp' : ''}${chat.lastTs ? ` · last ${formatListTime(chat.lastTs)}` : ''}`
              : ''}
          </div>
        </div>
        <button className={searchOpen ? 'icon-btn active' : 'icon-btn'} onClick={() => setSearchOpen((v) => !v)} aria-label="Search in chat">
          <Icon name="search" />
        </button>
      </header>
      {searchOpen ? (
        <div className="chat-search">
          <form onSubmit={runSearch} className="search-box">
            <Icon name="search" size={18} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this chat" />
          </form>
          {hits ? (
            <div className="chat-search-hits">
              {hits.length === 0 ? <div className="muted small pad">No results</div> : null}
              {hits.map((h) => (
                <button key={h.message.id} className="hit" onClick={() => jump(h.message.id)}>
                  <span className="muted small">{formatListTime(h.message.ts)}</span>
                  <span className="hit-text">{h.message.text}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={error} />
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {loading ? (
          <div className="center pad">
            <Spinner />
          </div>
        ) : null}
        {!loading && nextBefore ? (
          <div className="center pad-small">{loadingOlder ? <Spinner size={18} /> : <button className="btn tiny ghost" onClick={loadOlder}>Load older</button>}</div>
        ) : null}
        {!loading && !nextBefore && messages.length > 0 ? <div className="center muted small pad-small">Beginning of the log for this chat</div> : null}
        {!loading && messages.length === 0 ? <div className="center muted pad">No messages logged in this chat yet.</div> : null}
        {rows.map((r) =>
          r.kind === 'day' ? (
            <div key={r.key} className="day-sep">
              <span>{r.label}</span>
            </div>
          ) : (
            <MessageBubble key={r.m.id} msg={r.m} isGroup={!!isGroup} showSender={r.showSender} highlighted={highlight === r.m.id} onJump={jump} />
          ),
        )}
        {nextAfter ? (
          <div className="center pad-small">
            <button className="btn tiny ghost" onClick={loadNewer}>
              Load newer
            </button>
          </div>
        ) : null}
      </div>
      <footer className="chat-foot muted small">
        <Icon name="lock" size={14} /> Read-only log · messages are stored encrypted on your server
      </footer>
    </section>
  );
}
