import type { Page } from 'puppeteer';
import type { AppContext } from '../context.js';
import { maskId } from '../log.js';
import { fetchViaBrowser } from './browser.js';
import { beginMediaFile, deleteMediaFile, finishMediaFile } from './media.js';

const REFRESH_AFTER_MS = 3 * 86400_000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Best-effort chat avatars. The image is fetched *inside the browser* (the app container has no
 * internet access) and stored encrypted like any other media.
 */
export async function refreshAvatars(
  ctx: AppContext,
  page: Page,
  getUrl: (chatId: string) => Promise<string | null>,
  batch = 15,
): Promise<number> {
  const now = Date.now();
  let updated = 0;
  for (const chat of ctx.repo.chatsNeedingAvatar(now - REFRESH_AFTER_MS, batch)) {
    if (chat.kind === 'status' || chat.kind === 'broadcast') {
      ctx.repo.setChatAvatar(chat.id, null, now);
      continue;
    }
    try {
      const url = await getUrl(chat.id).catch(() => null);
      const img = url ? await fetchViaBrowser(page, url, MAX_AVATAR_BYTES) : null;
      const old = chat.avatar_media_id ? ctx.repo.getMedia(chat.avatar_media_id) : undefined;
      if (!img || img.data.length === 0) {
        ctx.repo.setChatAvatar(chat.id, old?.id ?? null, now);
        continue;
      }
      const f = await beginMediaFile(ctx);
      await f.writer.write(img.data);
      const mime = img.mime && /^image\/(jpeg|png|webp)$/.test(img.mime) ? img.mime : 'image/jpeg';
      const { mediaId } = await finishMediaFile(ctx, f, 'avatar', mime, null);
      ctx.repo.setChatAvatar(chat.id, mediaId, now);
      if (old) {
        ctx.repo.deleteMedia(old.id);
        await deleteMediaFile(ctx, old.path);
      }
      updated++;
      ctx.events.emit({ type: 'chat_update', chatId: chat.id });
    } catch (err) {
      ctx.log.debug({ err: (err as Error).message, chat: maskId(chat.id) }, 'avatar refresh failed');
      ctx.repo.setChatAvatar(chat.id, chat.avatar_media_id, now);
    }
  }
  return updated;
}
