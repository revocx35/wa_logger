import type { Page } from 'puppeteer';
import type { RawMsg } from './mapper.js';
import type { ChatLite } from './sync.js';

/*
 * Direct, defensive reads from WhatsApp Web's in-memory models.
 *
 * whatsapp-web.js' chat helpers (getChats / getChatById → WWebJS.getChatModel) also look up each
 * chat's "last received message" and refresh group metadata. On current WhatsApp Web builds those
 * lookups throw ("Failed to execute 'get' on 'IDBObjectStore': No key or key range specified") for
 * most chats, and getChats() uses Promise.all — one failure loses the whole list. We only need a few
 * plain fields, so we read them straight from the models, isolating errors per chat/contact.
 *
 * Everything here runs inside the page via page.evaluate(); arguments/results are plain JSON.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ContactInfo {
  name: string | null;
  pushname: string | null;
  phone: string | null; // "+<digits>" when WhatsApp exposes it (LID contacts map to a phone number)
  isMe: boolean;
  isBusiness: boolean;
}

export async function listChats(page: Page): Promise<ChatLite[]> {
  return (await page.evaluate(() => {
    const w = window as any;
    const out: any[] = [];
    for (const c of w.require('WAWebCollections').Chat.getModelsArray()) {
      try {
        const id = c.id?._serialized;
        if (!id) continue;
        out.push({
          id,
          name: (c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || null) ?? null,
          timestamp: typeof c.t === 'number' && c.t > 0 ? c.t * 1000 : null,
          archived: !!c.archive,
          pinned: !!c.pin,
          muted: !!(c.mute && c.mute.expiration !== 0 && c.mute.expiration !== undefined),
        });
      } catch {
        /* skip a broken chat model */
      }
    }
    return out;
  })) as ChatLite[];
}

export async function chatInfo(page: Page, chatId: string): Promise<Omit<ChatLite, 'id'> | null> {
  return (await page.evaluate((id: string) => {
    const w = window as any;
    try {
      const C = w.require('WAWebCollections');
      const c = C.Chat.get(id) ?? C.Chat.get(w.require('WAWebWidFactory').createWid(id));
      if (!c) return null;
      return {
        name: (c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || null) ?? null,
        timestamp: typeof c.t === 'number' && c.t > 0 ? c.t * 1000 : null,
        archived: !!c.archive,
        pinned: !!c.pin,
        muted: !!(c.mute && c.mute.expiration !== 0 && c.mute.expiration !== undefined),
      };
    } catch {
      return null;
    }
  }, chatId)) as Omit<ChatLite, 'id'> | null;
}

export async function contactInfo(page: Page, contactId: string): Promise<ContactInfo | null> {
  return (await page.evaluate((id: string) => {
    const w = window as any;
    try {
      const C = w.require('WAWebCollections');
      const wid = w.require('WAWebWidFactory').createWid(id);
      const c = C.Contact.get(id) ?? C.Contact.get(wid);
      // LID ("@lid") ids hide the phone number; WhatsApp keeps a LID → phone mapping.
      let pn: any = c?.phoneNumber ?? null;
      if (!pn && id.endsWith('@lid')) {
        try {
          pn = w.require('WAWebLidMigrationUtils').toPn(wid);
        } catch {
          pn = null;
        }
      }
      const pnSerialized: string | null = pn ? (pn._serialized ?? String(pn)) : null;
      const pnContact = pnSerialized ? C.Contact.get(pnSerialized) : null;
      const digits = pnSerialized ? /^(\d{5,20})@/.exec(pnSerialized)?.[1] : null;
      if (!c && !pnContact) return digits ? { name: null, pushname: null, phone: `+${digits}`, isMe: false, isBusiness: false } : null;
      return {
        name: c?.name || pnContact?.name || c?.verifiedName || pnContact?.verifiedName || null,
        pushname: c?.pushname || pnContact?.pushname || null,
        phone: digits ? `+${digits}` : null,
        isMe: !!(c?.isMe || pnContact?.isMe),
        isBusiness: !!(c?.isBusiness || pnContact?.isBusiness),
      };
    } catch {
      return null;
    }
  }, contactId)) as ContactInfo | null;
}

/**
 * Same algorithm as whatsapp-web.js Chat.fetchMessages (loaded messages + loadEarlierMsgs until
 * `limit`), but without going through the fragile chat model, and tolerant of individual failures.
 */
export async function fetchMessages(page: Page, chatId: string, limit: number): Promise<RawMsg[]> {
  return (await page.evaluate(
    async (id: string, max: number) => {
      const w = window as any;
      let chat: any = null;
      try {
        chat = await w.WWebJS.getChat(id, { getAsModel: false });
      } catch {
        chat = null;
      }
      if (!chat?.msgs) return [];
      // (No named helper functions in here: dev transpilers may wrap them with helpers that don't
      // exist inside the page.)
      let msgs: any[] = chat.msgs.getModelsArray().filter((m: any) => !m.isNotification);
      let rounds = 0;
      while (msgs.length < max && rounds++ < 100) {
        let loaded: any[] | null = null;
        try {
          loaded = await w.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        } catch {
          loaded = null;
        }
        if (!loaded || !loaded.length) break;
        msgs = [...loaded.filter((m: any) => !m.isNotification), ...msgs];
      }
      msgs.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      if (msgs.length > max) msgs = msgs.slice(msgs.length - max);
      const out: any[] = [];
      for (const m of msgs) {
        try {
          out.push(w.WWebJS.getMessageModel(m));
        } catch {
          /* skip one unserializable message */
        }
      }
      return out;
    },
    chatId,
    limit,
  )) as RawMsg[];
}

/** Profile picture URL for a chat (whatsapp-web.js getProfilePicUrl goes through the broken chat model). */
export async function profilePicUrl(page: Page, chatId: string): Promise<string | null> {
  return (await page.evaluate(async (id: string) => {
    const w = window as any;
    try {
      const C = w.require('WAWebCollections');
      const cached = C.ProfilePicThumb?.get?.(id);
      if (cached?.eurl) return cached.eurl as string;
      const chat = C.Chat.get(id) ?? (await w.WWebJS.getChat(id, { getAsModel: false }));
      if (!chat) return null;
      const res = await w.require('WAWebContactProfilePicThumbBridge').requestProfilePicFromServer(chat);
      return (res?.eurl as string | undefined) ?? null;
    } catch {
      return null;
    }
  }, chatId)) as string | null;
}
