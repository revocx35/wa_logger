import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decryptRange, openMediaFile } from '../crypto/stream.js';
import { F } from '../db/repo.js';
import { Errors } from '../errors.js';
import { getReader } from '../http/server.js';

/**
 * Only these types are ever served inline. Everything else (HTML, SVG, PDF, scripts, unknown) is
 * forced to download as application/octet-stream so it can never execute in our origin.
 */
const INLINE_IMAGE = /^image\/(jpeg|png|gif|webp|avif)$/;
const INLINE_AV = /^(audio\/(ogg|mpeg|mp4|aac|webm|wav|x-wav|amr|3gpp)|video\/(mp4|webm|3gpp|quicktime))$/;

export function inlineContentType(mime: string | null): string | null {
  if (!mime) return null;
  const [base, ...params] = mime.toLowerCase().split(';').map((s) => s.trim());
  if (!base) return null;
  if (INLINE_IMAGE.test(base)) return base;
  if (INLINE_AV.test(base)) {
    const codecs = params.find((p) => /^codecs="?[a-z0-9.,\s-]{1,64}"?$/.test(p));
    return codecs ? `${base}; ${codecs}` : base;
  }
  return null;
}

export function safeFilename(name: string | null, fallback: string): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\;]/g, '').trim().slice(0, 150);
  return cleaned || fallback;
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/media/:mediaId', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { mediaId } = z.object({ mediaId: z.coerce.number().int().positive() }).parse(req.params);
    const { download } = z.object({ download: z.enum(['1']).optional() }).parse(req.query);
    const row = ctx.repo.getMedia(mediaId);
    if (!row) throw Errors.notFound('Media');
    const reader = getReader(ctx, req);
    const mime = reader.tryText(...F.mediaMime(row.path), row.mime_enc);
    const filename = safeFilename(reader.tryText(...F.mediaFilename(row.path), row.filename_enc), `media-${mediaId}`);
    const abs = path.join(ctx.config.mediaDir, row.path);
    if (!abs.startsWith(ctx.config.mediaDir + path.sep)) throw Errors.notFound('Media');

    let media;
    try {
      media = await openMediaFile(abs);
    } catch {
      throw Errors.notFound('Media');
    }
    const key = reader.key(media.header.keyId);
    const inline = download ? null : inlineContentType(mime);

    reply.header('Content-Type', inline ?? 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', filename));
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'");
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Accept-Ranges', 'bytes');

    const size = media.size;
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      await media.fh.close();
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    reply.header('Content-Length', String(size === 0 ? 0 : end - start + 1));
    if (size === 0 || req.method === 'HEAD') {
      await media.fh.close();
      return reply.send();
    }
    async function* body() {
      try {
        yield* decryptRange(media!, key, start, end);
      } finally {
        await media!.fh.close().catch(() => undefined);
      }
    }
    return reply.send(Readable.from(body()));
  });
}
