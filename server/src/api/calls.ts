import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallAudioHello, CallInfo, CurrentCall } from '../../../shared/api.js';
import type { AppContext, CallAudioClient } from '../context.js';
import { Errors } from '../errors.js';
import { getReader, requireSession } from '../http/server.js';
import { chatKind } from '../wa/mapper.js';
import { Presenter } from './view.js';

const ChatIdParam = z.object({ chatId: z.string().min(3).max(200).regex(/^[^\s/?#]+@[a-z.]+$/i) });
const CallIdParam = z.object({ callId: z.string().min(1).max(128).regex(/^[\w.:-]+$/) });

/** Largest audio message: 200 ms of 16 kHz s16le. */
const MAX_FRAME = 6400;
/** Real time is 32 000 bytes/s; a client may burst (after a stall) but not stream much faster than that. */
const MAX_BYTES_PER_SEC = 96_000;
/** Audio queued towards a slow client beyond this is dropped (it would only add delay). */
const HIGH_WATER = 64 * 1024;
const REVALIDATE_MS = 30_000;

/**
 * Voice calls. The POST routes need a session, the CSRF token and a same-origin Origin (global hooks in
 * http/server.ts); the audio WebSocket needs a session and a same-origin Origin like /api/vnc. Audio is never
 * stored or logged.
 */
export function registerCallRoutes(app: FastifyInstance, ctx: AppContext): void {
  const withName = (req: Parameters<typeof getReader>[1], call: CallInfo): CallInfo => {
    if (!call.chatId) return { ...call, name: null, avatarUrl: null };
    const p = new Presenter(ctx, getReader(ctx, req));
    const chat = ctx.repo.getChat(call.chatId);
    return {
      ...call,
      name: chat ? p.chatName(chat) : p.contactName(call.chatId),
      avatarUrl: chat?.avatar_media_id ? `/api/media/${chat.avatar_media_id}` : null,
    };
  };

  app.get('/api/calls/current', async (req) => {
    const call = ctx.wa.calls.current();
    const res: CurrentCall = { call: call ? withName(req, call) : null, available: ctx.wa.calls.available() };
    return res;
  });

  app.post('/api/chats/:chatId/call', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { chatId } = ChatIdParam.parse(req.params);
    z.object({}).strict().parse(req.body ?? {});
    if (!ctx.repo.getChat(chatId)) throw Errors.notFound('Chat');
    if (chatKind(chatId) !== 'user') throw Errors.conflict('Only one-to-one chats can be called from here.');
    return withName(req, await ctx.wa.calls.start(chatId));
  });

  app.post('/api/calls/:callId/accept', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { callId } = CallIdParam.parse(req.params);
    return withName(req, await ctx.wa.calls.accept(callId));
  });

  app.post('/api/calls/:callId/reject', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { callId } = CallIdParam.parse(req.params);
    await ctx.wa.calls.reject(callId);
    return { ok: true };
  });

  app.post('/api/calls/:callId/hangup', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { callId } = CallIdParam.parse(req.params);
    await ctx.wa.calls.hangup(callId);
    return { ok: true };
  });

  app.get('/api/calls/audio', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (socket, req) => {
    const session = requireSession(req);
    let closed = false;
    let detach: (() => void) | null = null;
    const client: CallAudioClient = {
      send: (pcm) => {
        if (closed || socket.readyState !== socket.OPEN || socket.bufferedAmount > HIGH_WATER) return;
        socket.send(pcm, { binary: true });
      },
      close: (code, reason) => close(code, reason),
    };
    const close = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      clearInterval(revalidate);
      unsubscribe();
      const d = detach;
      detach = null;
      d?.();
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    const check = () => {
      const row = ctx.repo.getSession(session.idHash);
      const t = Date.now();
      if (!row || row.expires_at <= t || row.last_seen_at + ctx.config.sessionIdleMs <= t) close(4001, 'Session ended');
    };
    const revalidate = setInterval(check, REVALIDATE_MS);
    const unsubscribe = ctx.events.subscribe((ev) => {
      if (ev.type === 'session_revoked') check();
    });

    let windowStart = Date.now();
    let windowBytes = 0;
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (closed || !isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 0 || buf.length > MAX_FRAME || buf.length % 2 !== 0) {
        close(1007, 'Bad audio frame');
        return;
      }
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowBytes = 0;
      }
      windowBytes += buf.length;
      if (windowBytes > MAX_BYTES_PER_SEC) {
        close(1008, 'Too much audio');
        return;
      }
      ctx.wa.calls.audioIn(client, buf);
    });
    socket.on('close', () => close());
    socket.on('error', () => close(1011));

    const call = ctx.wa.calls.current();
    if (!call || call.state === 'ended') {
      close(4004, 'No call');
      return;
    }
    const hello: CallAudioHello = { type: 'hello', sampleRate: 16000, channels: 1, format: 's16le', callId: call.id };
    socket.send(JSON.stringify(hello));
    detach = ctx.wa.calls.attachAudio(client);
    if (!detach) close(4004, 'No call');
  });
}
