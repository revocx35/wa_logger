import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decryptRange, openMediaFile, plaintextSizeFromFileSize } from '../crypto/stream.js';
import { F, type MediaRow, type MessageRow } from '../db/repo.js';
import { Errors } from '../errors.js';
import { getReader } from '../http/server.js';
import { ZIP_MAX_BYTES, zipStream } from '../http/zip.js';

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
    // Only spaces (never CR/LF/tabs) may appear: this value ends up in a response header.
    const codecs = params.find((p) => /^codecs="?[a-z0-9., -]{1,64}"?$/.test(p));
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

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf',
};

/** Name inside a ZIP: the original file name if WhatsApp had one, else e.g. "wa_photo_2026-10-10_13-05-22.jpg" (UTC). */
export function zipEntryName(msg: Pick<MessageRow, 'type' | 'ts'>, mime: string | null, filename: string | null): string {
  if (filename) return safeFilename(filename, 'file');
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = EXT[base] ?? 'bin';
  const kind = msg.type === 'image' ? 'photo' : msg.type === 'video' || msg.type === 'gif' ? 'video' : msg.type === 'sticker' ? 'sticker' : 'file';
  const stamp = new Date(msg.ts).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return `wa_${kind}_${stamp}.${ext}`;
}

/** Makes names unique inside one ZIP: "a.jpg", "a (2).jpg", … */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}

const ZIP_MAX_FILES = 500;

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The absolute path of a stored media file, refusing anything outside the media directory. */
  const mediaPath = (row: MediaRow): string => {
    const abs = path.join(ctx.config.mediaDir, row.path);
    if (!abs.startsWith(ctx.config.mediaDir + path.sep)) throw Errors.notFound('Media');
    return abs;
  };

  // Several message media files as one ZIP download (web "select → Download"). Decrypted on the fly, never
  // written to disk unencrypted. Ids are media ids (the number in a message's media.url).
  app.get('/api/media-zip', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { ids } = z.object({ ids: z.string().regex(/^\d{1,12}(,\d{1,12})*$/) }).parse(req.query);
    const unique = [...new Set(ids.split(',').map(Number))];
    if (unique.length > ZIP_MAX_FILES) throw Errors.validation(`Select at most ${ZIP_MAX_FILES} files at once.`);
    const reader = getReader(ctx, req);
    const items = [];
    let total = 0;
    for (const id of unique) {
      const row = ctx.repo.getMedia(id);
      const msg = row?.kind === 'message' ? ctx.repo.getMessageByMediaId(id) : undefined;
      if (!row || !msg) throw Errors.notFound('Media');
      const abs = mediaPath(row);
      let size: number;
      try {
        size = plaintextSizeFromFileSize((await fs.stat(abs)).size);
      } catch {
        throw Errors.notFound('Media');
      }
      total += size;
      const mime = reader.tryText(...F.mediaMime(row.path), row.mime_enc);
      const filename = reader.tryText(...F.mediaFilename(row.path), row.filename_enc);
      items.push({ row, msg, abs, size, name: zipEntryName(msg, mime, filename) });
    }
    if (total > ZIP_MAX_BYTES) throw Errors.validation('Too large for one download (4 GB). Select fewer files.');
    const names = uniqueNames(items.map((i) => i.name));
    // Exact length: lets the browser show progress. Per entry: local header 30 + name, data, descriptor 16,
    // central entry 46 + name; then the 22-byte end record.
    const length = items.reduce((n, it, i) => n + 30 + 16 + 46 + 2 * Buffer.byteLength(names[i]!, 'utf8') + it.size, 22);
    const entries = items.map((it, i) => ({
      name: names[i]!,
      mtime: it.msg.ts,
      data: async function* () {
        const media = await openMediaFile(it.abs);
        try {
          if (`${media.header.fileId.toString('hex')}.bin` !== path.basename(it.row.path) || media.size !== it.size) throw new Error('media file mismatch');
          if (media.size > 0) yield* decryptRange(media, reader.key(media.header.keyId), 0, media.size - 1);
        } finally {
          await media.fh.close().catch(() => undefined);
        }
      },
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition('attachment', `wa_logger-media-${stamp}.zip`));
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Length', String(length));
    return reply.send(Readable.from(zipStream(entries)));
  });

  app.get('/api/media/:mediaId', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { mediaId } = z.object({ mediaId: z.coerce.number().int().positive() }).parse(req.params);
    const { download } = z.object({ download: z.enum(['1']).optional() }).parse(req.query);
    const row = ctx.repo.getMedia(mediaId);
    if (!row) throw Errors.notFound('Media');
    const reader = getReader(ctx, req);
    const mime = reader.tryText(...F.mediaMime(row.path), row.mime_enc);
    const filename = safeFilename(reader.tryText(...F.mediaFilename(row.path), row.filename_enc), `media-${mediaId}`);
    const abs = mediaPath(row);

    let media;
    try {
      media = await openMediaFile(abs);
    } catch {
      throw Errors.notFound('Media');
    }
    // The file name is the file id bound into every chunk's AAD: a file moved/swapped on disk is refused.
    if (`${media.header.fileId.toString('hex')}.bin` !== path.basename(row.path)) {
      await media.fh.close();
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
