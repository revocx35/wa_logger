import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeletedFeedPage, MessageEdit, MessagePage, SearchHit, SearchResponse } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { F, decodeCursor, encodeCursor, type MessageRow } from '../db/repo.js';
import { Errors } from '../errors.js';
import { getReader } from '../http/server.js';
import { Presenter } from './view.js';

const ChatIdParam = z.object({ chatId: z.string().min(3).max(200).regex(/^[^\s/?#]+@[a-z.]+$/i) });
const MessageIdParam = z.object({ messageId: z.string().min(3).max(300).regex(/^[^\s/?#]+$/) });
const Cursor = z.string().regex(/^\d{1,16}_\d{1,16}$/).optional();
const Limit = z.coerce.number().int().min(1).max(200).default(60);

const SEARCH_MAX_SCAN = 25_000;
const SEARCH_MAX_HITS = 100;
const SEARCH_MAX_MS = 4_000;
const SEARCH_BATCH = 500;

function norm(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
}

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo } = ctx;
  const presenter = (req: Parameters<typeof getReader>[1]) => new Presenter(ctx, getReader(ctx, req));

  app.get('/api/chats', async (req) => presenter(req).chats(repo.listChats()));

  app.get('/api/chats/:chatId/messages', async (req) => {
    const { chatId } = ChatIdParam.parse(req.params);
    const q = z.object({ before: Cursor, limit: Limit }).parse(req.query);
    if (!repo.getChat(chatId)) throw Errors.notFound('Chat');
    const rows = repo.listMessagesBefore(chatId, decodeCursor(q.before), q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(1) : rows;
    const first = page[0];
    const res: MessagePage = {
      messages: presenter(req).messages(page),
      nextBefore: hasMore && first ? encodeCursor({ ts: first.ts, rowid: first.rowid }) : null,
    };
    return res;
  });

  app.get('/api/chats/:chatId/messages/around/:messageId', async (req) => {
    const { chatId } = ChatIdParam.parse({ chatId: (req.params as { chatId: string }).chatId });
    const { messageId } = MessageIdParam.parse({ messageId: (req.params as { messageId: string }).messageId });
    const q = z.object({ limit: Limit }).parse(req.query);
    const target = repo.getMessage(messageId);
    if (!target || target.chat_id !== chatId) throw Errors.notFound('Message');
    const half = Math.max(5, Math.floor(q.limit / 2));
    const older = repo.listMessagesBefore(chatId, { ts: target.ts, rowid: target.rowid }, half + 1);
    const newer = repo.listMessagesAfter(chatId, { ts: target.ts, rowid: target.rowid }, half + 1);
    const hasOlder = older.length > half;
    const hasNewer = newer.length > half;
    const olderPage = hasOlder ? older.slice(1) : older;
    const newerPage = hasNewer ? newer.slice(0, half) : newer;
    const page = [...olderPage, target, ...newerPage];
    const first = page[0]!;
    const last = page[page.length - 1]!;
    const res: MessagePage = {
      messages: presenter(req).messages(page),
      nextBefore: hasOlder ? encodeCursor({ ts: first.ts, rowid: first.rowid }) : null,
      nextAfter: hasNewer ? encodeCursor({ ts: last.ts, rowid: last.rowid }) : null,
    };
    return res;
  });

  app.get('/api/chats/:chatId/messages/after', async (req) => {
    const { chatId } = ChatIdParam.parse(req.params);
    const q = z.object({ after: z.string().regex(/^\d{1,16}_\d{1,16}$/), limit: Limit }).parse(req.query);
    const rows = repo.listMessagesAfter(chatId, decodeCursor(q.after)!, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    const res: MessagePage = {
      messages: presenter(req).messages(page),
      nextBefore: null,
      nextAfter: hasMore && last ? encodeCursor({ ts: last.ts, rowid: last.rowid }) : null,
    };
    return res;
  });

  app.get('/api/messages/:messageId', async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    const row = repo.getMessage(messageId);
    if (!row) throw Errors.notFound('Message');
    return presenter(req).messages([row])[0];
  });

  app.get('/api/messages/:messageId/edits', async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    const row = repo.getMessage(messageId);
    if (!row) throw Errors.notFound('Message');
    const reader = getReader(ctx, req);
    const edits: MessageEdit[] = repo
      .listEdits(messageId)
      .map((e) => ({ body: reader.tryText(...F.body(messageId), e.body_enc), capturedAt: e.captured_at }));
    return edits;
  });

  app.post('/api/messages/:messageId/media/retry', async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    if (!repo.getMessage(messageId)) throw Errors.notFound('Message');
    if (!ctx.wa.retryMedia(messageId)) throw Errors.conflict('This media cannot be retried.');
    return { ok: true };
  });

  app.get('/api/deleted', async (req) => {
    const q = z.object({ before: Cursor, limit: Limit }).parse(req.query);
    const rows = repo.listDeleted(decodeCursor(q.before), q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const p = presenter(req);
    const chats = new Map(repo.getChatsByIds([...new Set(page.map((r) => r.chat_id))]).map((c) => [c.id, c] as const));
    const msgs = p.messages(page);
    const last = page[page.length - 1];
    const res: DeletedFeedPage = {
      items: msgs.map((m) => ({ chat: p.chatRef(chats.get(m.chatId), m.chatId), message: m })),
      nextBefore: hasMore && last ? encodeCursor({ ts: last.deleted_at ?? 0, rowid: last.rowid }) : null,
    };
    return res;
  });

  app.get('/api/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const q = z
      .object({ q: z.string().trim().min(2).max(100), chatId: ChatIdParam.shape.chatId.optional() })
      .parse(req.query);
    const needle = norm(q.q);
    const p = presenter(req);
    const hits: MessageRow[] = [];
    let scanned = 0;
    let cursor: { ts: number; rowid: number } | null = null;
    const started = Date.now();
    let truncated = false;
    for (;;) {
      const batch = repo.scanForSearch(q.chatId ?? null, cursor, SEARCH_BATCH);
      if (batch.length === 0) break;
      for (const row of batch) {
        scanned++;
        if (norm(p.searchableText(row)).includes(needle)) {
          hits.push(row);
          if (hits.length >= SEARCH_MAX_HITS) break;
        }
      }
      const last = batch[batch.length - 1]!;
      cursor = { ts: last.ts, rowid: last.rowid };
      if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_SCAN || Date.now() - started > SEARCH_MAX_MS) {
        truncated = batch.length === SEARCH_BATCH;
        break;
      }
      if (batch.length < SEARCH_BATCH) break;
    }
    const chats = new Map(repo.getChatsByIds([...new Set(hits.map((r) => r.chat_id))]).map((c) => [c.id, c] as const));
    const res: SearchResponse = {
      hits: p.messages(hits).map((m): SearchHit => ({ chat: p.chatRef(chats.get(m.chatId), m.chatId), message: m })),
      truncated,
    };
    return res;
  });
}
