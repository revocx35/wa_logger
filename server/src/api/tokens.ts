import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiTokenCreated, ApiTokenInfo, ApiTokenList, SendResult, TokenDestinations } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { getReader } from '../http/server.js';
import { Presenter } from './view.js';

const ChatId = z.string().min(3).max(200).regex(/^[^\s/?#]+@[a-z.]+$/i);
/** Short on purpose: a token is meant for notifications, not for pasting a book. */
const TokenText = z.string().min(1).max(4000).refine((t) => t.trim().length > 0, 'Message is empty.');

/**
 * API tokens for other apps (e.g. a poker tracker posting its results).
 *
 * Owner routes (/api/api-tokens) are ordinary session routes. Token routes (/api/v1/*) are `bearer` routes: they accept
 * only `Authorization: Bearer walt_…`, ignore cookies, and can reach only the chats the token was created for. Nothing a
 * token can do reads a message. Chat names and message text never go into URLs or logs.
 */
export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, apiTokens } = ctx;

  app.get('/api/api-tokens', async () => {
    const tokens: ApiTokenInfo[] = repo.listApiTokens().map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
      chatCount: t.chat_count,
    }));
    const res: ApiTokenList = { tokens };
    return res;
  });

  app.post('/api/api-tokens', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60),
        chatIds: z.array(ChatId).min(1).max(50),
      })
      .strict()
      .parse(req.body);
    const ids = [...new Set(body.chatIds)];
    const rows = repo.listChats().filter((c) => ids.includes(c.id));
    if (rows.length !== ids.length) throw Errors.notFound('Chat');
    if (rows.some((c) => c.kind !== 'user' && c.kind !== 'group')) throw Errors.validation('Only direct chats and groups can be chosen.');
    const named = new Presenter(ctx, getReader(ctx, req)).chats(rows);
    const { id, token } = apiTokens.create(
      body.name,
      named.map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
    );
    repo.audit('api_token_created', req.ip);
    const res: ApiTokenCreated = { id, name: body.name, token };
    return res;
  });

  app.delete('/api/api-tokens/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    if (!repo.deleteApiToken(id)) throw Errors.notFound('Token');
    repo.audit('api_token_deleted', req.ip);
    return { ok: true };
  });

  const bearer = (max: number) => ({ config: { bearer: true, rateLimit: { max, timeWindow: '1 minute' } } });

  app.get('/api/v1/destinations', bearer(30), async (req) => {
    const res: TokenDestinations = { destinations: apiTokens.destinations(req.apiToken!.id) };
    return res;
  });

  app.post('/api/v1/send', { bodyLimit: 16 * 1024, ...bearer(20) }, async (req) => {
    const body = z.object({ chatId: ChatId, text: TokenText }).strict().parse(req.body);
    const token = req.apiToken!;
    // Same answer for "no such chat" and "not allowed for this token": a token learns nothing about other chats.
    if (!repo.apiTokenAllows(token.id, body.chatId) || !repo.getChat(body.chatId)) throw Errors.notFound('Chat');
    const res: SendResult = await ctx.wa.sender.sendText(body.chatId, body.text, null);
    repo.audit('api_token_send', req.ip);
    return res;
  });
}
