import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NewChatResponse, SendResult, UploadResponse } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { requireSession } from '../http/server.js';

const ChatIdParam = z.object({ chatId: z.string().min(3).max(200).regex(/^[^\s/?#]+@[a-z.]+$/i) });
const MessageId = z.string().min(3).max(300).regex(/^[^\s/?#]+$/);
const MessageIdParam = z.object({ messageId: MessageId });
/** WhatsApp's own limit for a text message. */
const Text = z.string().min(1).max(65_536).refine((t) => t.trim().length > 0, 'Message is empty.');
const MIME = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}(; ?codecs=[a-z0-9.,-]{1,40})?$/i;

/** Largest file the owner can send (WhatsApp's own limits are higher for documents). */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60_000;
const UPLOAD_MAX_PENDING = 4;

interface PendingUpload {
  data: Buffer;
  mime: string;
  filename: string | null;
  session: string;
  at: number;
}

/** Strips paths and control characters; null when nothing usable is left. */
export function cleanFilename(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  name = (name.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name && name !== '.' && name !== '..' ? name : null;
}

/**
 * Sending as the linked WhatsApp account. Every route needs a session and (being a POST) the CSRF token and a
 * same-origin Origin, enforced by the global hooks in http/server.ts. Message content never goes into URLs or
 * logs: text and captions are JSON bodies, files are raw bodies with the name in a header.
 */
export function registerSendRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo } = ctx;
  const uploads = new Map<string, PendingUpload>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, u] of uploads) if (now - u.at > UPLOAD_TTL_MS) uploads.delete(k);
  };

  const quoted = (chatId: string, id: string | null | undefined) => {
    if (!id) return null;
    const row = repo.getMessage(id);
    if (!row || row.chat_id !== chatId) throw Errors.notFound('Quoted message');
    return id;
  };
  const requireChat = (chatId: string) => {
    if (!repo.getChat(chatId)) throw Errors.notFound('Chat');
  };
  /** Replying in a chat means having read it, as in WhatsApp itself. Best effort. */
  const markReadLater = (chatId: string) => {
    void ctx.wa.sender.markRead(chatId).catch(() => undefined);
  };

  app.post(
    '/api/chats/:chatId/send',
    { bodyLimit: 512 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { chatId } = ChatIdParam.parse(req.params);
      const body = z.object({ text: Text, quotedId: MessageId.nullish() }).strict().parse(req.body);
      requireChat(chatId);
      const res: SendResult = await ctx.wa.sender.sendText(chatId, body.text, quoted(chatId, body.quotedId));
      markReadLater(chatId);
      return res;
    },
  );

  // Raw file bodies only on this route (the rest of the API accepts JSON only).
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES }, (_req, body, done) =>
      done(null, body),
    );
    scope.post(
      '/api/uploads',
      { bodyLimit: UPLOAD_MAX_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req) => {
        const session = requireSession(req);
        const data = req.body;
        if (!Buffer.isBuffer(data) || data.length === 0) throw Errors.validation('Send the file as application/octet-stream.');
        const type = req.headers['x-file-type'];
        const mime = typeof type === 'string' && MIME.test(type) ? type.toLowerCase() : 'application/octet-stream';
        sweep();
        if (uploads.size >= UPLOAD_MAX_PENDING) throw Errors.conflict('Too many files waiting to be sent. Send or cancel them first.');
        const uploadId = crypto.randomBytes(16).toString('hex');
        uploads.set(uploadId, { data, mime, filename: cleanFilename(req.headers['x-filename']), session: session.idHash.toString('hex'), at: Date.now() });
        const res: UploadResponse = { uploadId, size: data.length };
        return res;
      },
    );
  });

  app.post(
    '/api/chats/:chatId/send-media',
    { bodyLimit: 512 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const session = requireSession(req);
      const { chatId } = ChatIdParam.parse(req.params);
      const body = z
        .object({
          uploadId: z.string().regex(/^[0-9a-f]{32}$/),
          kind: z.enum(['auto', 'document', 'voice', 'gif']),
          caption: z.string().max(4096).nullish(),
          quotedId: MessageId.nullish(),
        })
        .strict()
        .parse(req.body);
      requireChat(chatId);
      sweep();
      const up = uploads.get(body.uploadId);
      // Uploads belong to the session that made them.
      if (!up || up.session !== session.idHash.toString('hex')) throw Errors.notFound('Upload');
      uploads.delete(body.uploadId);
      const caption = body.caption?.trim() ? body.caption : null;
      const res: SendResult = await ctx.wa.sender.sendMedia(chatId, up, body.kind, caption, quoted(chatId, body.quotedId));
      markReadLater(chatId);
      return res;
    },
  );

  app.delete('/api/uploads/:uploadId', async (req) => {
    const session = requireSession(req);
    const { uploadId } = z.object({ uploadId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    const up = uploads.get(uploadId);
    if (up && up.session === session.idHash.toString('hex')) uploads.delete(uploadId);
    return { ok: true };
  });

  app.post('/api/messages/:messageId/react', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    // One emoji (may be several code points, e.g. flags or skin tones); empty removes the reaction.
    const { emoji } = z.object({ emoji: z.string().max(32).refine((e) => !/[\s<>]/.test(e)) }).strict().parse(req.body);
    if (!repo.getMessage(messageId)) throw Errors.notFound('Message');
    await ctx.wa.sender.react(messageId, emoji);
    return { ok: true };
  });

  app.post('/api/messages/:messageId/revoke', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    const row = repo.getMessage(messageId);
    if (!row) throw Errors.notFound('Message');
    if (row.deleted_at) throw Errors.conflict('This message was already deleted.');
    await ctx.wa.sender.revoke(messageId);
    return { ok: true };
  });

  app.post('/api/messages/:messageId/edit', { bodyLimit: 512 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { messageId } = MessageIdParam.parse(req.params);
    const { text } = z.object({ text: Text }).strict().parse(req.body);
    const row = repo.getMessage(messageId);
    if (!row) throw Errors.notFound('Message');
    if (!row.from_me) throw Errors.conflict('Only your own messages can be edited.');
    if (row.deleted_at) throw Errors.conflict('This message was deleted.');
    await ctx.wa.sender.edit(messageId, text);
    return { ok: true };
  });

  app.post('/api/chats/:chatId/read', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { chatId } = ChatIdParam.parse(req.params);
    requireChat(chatId);
    await ctx.wa.sender.markRead(chatId);
    return { ok: true };
  });

  app.post('/api/chats/new', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { phone } = z.object({ phone: z.string().min(6).max(32).regex(/^[+\d\s().-]+$/) }).strict().parse(req.body);
    const chatId = await ctx.wa.sender.openChat(phone);
    if (!chatId) throw Errors.notFound('WhatsApp account for this number');
    const res: NewChatResponse = { chatId };
    return res;
  });
}
