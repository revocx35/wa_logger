/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Code that runs inside WhatsApp Web (the Chromium container's page), installed as `window.__wal`: sending
 * text (with replies), media/documents/voice notes, reactions, delete for everyone, edits, read receipts and
 * number lookup. Everything goes through WhatsApp Web's own send actions, the same functions its compose box
 * and message menu call (module names from WhatsApp Web 2.3000.1050x, see docs/wwebjs-notes.md).
 *
 * The app injects WAL_PAGE_SOURCE at document start of every page load (so WhatsApp Web's self-reloads keep
 * it) and once into the page already open. installWalPage() must stay self-contained: no imports, no closures
 * over Node values. Results contain no message content.
 */
export function installWalPage(): string {
  const W = window as any;
  if (W.__wal) return 'already';

  // WhatsApp Web replaces the timer functions after it loads; keep the browser's own.
  const T = { set: W.setTimeout.bind(W), clear: W.clearTimeout.bind(W) };
  const TIMEOUT = { timeout: true };
  const within = (p: Promise<any>, ms: number): Promise<any> => {
    let timer: any;
    const limit = new Promise((r) => {
      timer = T.set(() => r(TIMEOUT), ms);
    });
    return Promise.race([p, limit]).finally(() => T.clear(timer));
  };
  const R = (name: string): any => {
    try {
      return W.require(name);
    } catch {
      return null;
    }
  };
  const fail = (code: string, message?: string) => Object.assign(new Error(message || code), { code });
  const widStr = (w: any): string | null => {
    if (!w) return null;
    if (typeof w === 'string') return w;
    try {
      if (typeof w._serialized === 'string') return w._serialized;
      if (typeof w.$1 === 'string') return w.$1;
      const s = w.toString();
      return s && s !== '[object Object]' ? s : null;
    } catch {
      return null;
    }
  };
  /** MsgKey.toString(): "<fromMe>_<remote>_<id>[_<participant>]" (the app's message ids). */
  const keyStr = (k: any): string | null => {
    if (!k) return null;
    if (typeof k === 'string') return k;
    try {
      const s = k.toString();
      if (s && s !== '[object Object]' && s.indexOf('_') > 0) return s;
    } catch {
      /* rebuild below */
    }
    const remote = widStr(k.remote);
    if (!remote || !k.id) return null;
    const p = widStr(k.participant);
    return (k.fromMe ? 'true' : 'false') + '_' + remote + '_' + k.id + (p ? '_' + p : '');
  };
  const toWid = (s: string): any => {
    try {
      return R('WAWebWidFactory').createWid(s);
    } catch {
      return null;
    }
  };
  const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  async function findChat(id: string): Promise<any> {
    const C = R('WAWebCollections');
    const wid = toWid(id);
    if (!wid) return null;
    const chat = C.Chat.get(id) || C.Chat.get(wid);
    if (chat) return chat;
    const found = await within(R('WAWebFindChatAction').findOrCreateLatestChat(wid), 20_000);
    return found && found !== TIMEOUT ? found.chat || null : null;
  }

  async function findMsg(id: string): Promise<any> {
    const Msg = R('WAWebCollections').Msg;
    const m = Msg.get(id);
    if (m) return m;
    const got = await within(Msg.getMessagesById([id]), 20_000);
    return got && got !== TIMEOUT && got.messages ? got.messages[0] || null : null;
  }

  async function quoteFor(quotedId: string | undefined | null): Promise<any> {
    if (!quotedId) return undefined;
    const q = await findMsg(quotedId);
    if (!q) throw fail('not_found', 'The message you replied to is no longer in WhatsApp.');
    const RU = R('WAWebMsgReply');
    const ok = RU && RU.canReplyMsg ? RU.canReplyMsg(q.unsafe ? q.unsafe() : q) : true;
    if (!ok) throw fail('not_allowed', 'You can’t reply to that message.');
    return q;
  }

  /** Records the first own message added to [chat] while [p] runs (the id of what was sent). */
  async function capture(chat: any, p: () => Promise<any>): Promise<{ result: any; id: string | null }> {
    let id: string | null = null;
    const onAdd = (m: any) => {
      try {
        if (!id && m && m.id && m.id.fromMe) id = keyStr(m.id);
      } catch {
        /* ignore */
      }
    };
    const msgs = chat.msgs;
    try {
      if (msgs && msgs.on) msgs.on('add', onAdd);
    } catch {
      /* no events */
    }
    try {
      const result = await p();
      return { result, id };
    } finally {
      try {
        if (msgs && msgs.off) msgs.off('add', onAdd);
      } catch {
        /* ignore */
      }
    }
  }

  /** WAWebSendMsgResultAction.SendMsgResult is a mirrored enum: "OK", "ERROR_NETWORK", … */
  function checkResult(r: any): void {
    if (r === TIMEOUT) throw fail('timeout', 'WhatsApp did not confirm the message in time. It may still be sent.');
    const v = r && typeof r === 'object' ? r.messageSendResult : undefined;
    if (v !== undefined && v !== null && String(v) !== 'OK') throw fail('send_failed', 'WhatsApp could not send it (' + String(v).toLowerCase() + ').');
  }

  async function sendText(a: { chatId: string; text: string; quotedId?: string | null }): Promise<any> {
    const chat = await findChat(a.chatId);
    if (!chat) throw fail('not_found', 'Chat not found in WhatsApp.');
    const quotedMsg = await quoteFor(a.quotedId);
    const TM = R('WAWebSendTextMsgChatAction');
    const { result, id } = await capture(chat, () => within(TM.sendTextMsgToChat(chat, a.text, quotedMsg ? { quotedMsg } : {}), 60_000));
    checkResult(result);
    return { id };
  }

  // Files arrive in base64 chunks (uploadBegin → uploadChunk… → sendMedia) and are dropped after sending.
  const uploads = new Map<string, { u8: Uint8Array; t: number }>();
  function uploadBegin(a: { size: number }): string {
    for (const [k, v] of uploads) if (Date.now() - v.t > 10 * 60_000) uploads.delete(k);
    if (!(a.size > 0) || a.size > 200 * 1024 * 1024) throw fail('validation', 'bad size');
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
    uploads.set(token, { u8: new Uint8Array(a.size), t: Date.now() });
    return token;
  }
  function uploadChunk(a: { token: string; offset: number; b64: string }): boolean {
    const up = uploads.get(a.token);
    if (!up) throw fail('not_found', 'upload expired');
    const bytes = b64ToBytes(a.b64);
    if (a.offset < 0 || a.offset + bytes.length > up.u8.length) throw fail('validation', 'chunk out of range');
    up.u8.set(bytes, a.offset);
    return true;
  }
  function uploadDrop(a: { token: string }): boolean {
    uploads.delete(a.token);
    return true;
  }

  /** Duration (s) and the 64-bar waveform (0..100) WhatsApp shows for a voice note. */
  async function voiceFields(file: Blob): Promise<{ duration: number; waveform: Uint8Array } | undefined> {
    try {
      const ctx = new OfflineAudioContext(1, 1, 16000);
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const data = buf.getChannelData(0);
      const bars = 64;
      const block = Math.max(1, Math.floor(data.length / bars));
      const levels: number[] = [];
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < block; j++) sum += Math.abs(data[i * block + j] || 0);
        levels.push(sum / block);
      }
      const max = Math.max(...levels) || 1;
      return { duration: Math.max(1, Math.round(buf.duration)), waveform: new Uint8Array(levels.map((v) => Math.floor((100 * v) / max))) };
    } catch {
      return undefined;
    }
  }

  /** WhatsApp's own attach flow: OpaqueData → prepRawMedia → MediaPrep.sendToChat (uploads, then sends). */
  async function sendMedia(a: {
    chatId: string;
    token: string;
    mime: string;
    filename: string | null;
    kind: 'auto' | 'document' | 'voice' | 'gif';
    caption?: string | null;
    quotedId?: string | null;
  }): Promise<any> {
    const up = uploads.get(a.token);
    if (!up) throw fail('not_found', 'upload expired');
    try {
      const chat = await findChat(a.chatId);
      if (!chat) throw fail('not_found', 'Chat not found in WhatsApp.');
      const quotedMsg = await quoteFor(a.quotedId);
      const file = new File([up.u8 as BlobPart], a.filename || 'file', { type: a.mime });
      const params: any = {};
      if (a.kind === 'document') params.asDocument = true;
      else if (a.kind === 'gif') params.asGif = true;
      else if (a.kind === 'voice') {
        params.isPtt = true;
        const pre = await voiceFields(file);
        if (pre) params.precomputedFields = pre;
      }
      const opaque = R('WAWebMediaOpaqueData').createFromData(file, a.mime);
      const prep = R('WAWebPrepRawMedia').prepRawMedia(opaque, params);
      const options: any = {};
      if (a.caption && a.kind !== 'voice') options.caption = a.caption;
      if (quotedMsg) options.quotedMsg = quotedMsg;
      const { result, id } = await capture(chat, () => within(prep.sendToChat({ chat, options }), 300_000));
      checkResult(result);
      return { id: (result && result.msg && keyStr(result.msg.id)) || id };
    } finally {
      uploads.delete(a.token);
    }
  }

  async function react(a: { id: string; emoji: string }): Promise<boolean> {
    const msg = await findMsg(a.id);
    if (!msg) throw fail('not_found', 'Message not found in WhatsApp.');
    const r = await within(R('WAWebSendReactionMsgAction').sendReactionToMsg(msg, a.emoji), 30_000);
    if (r === TIMEOUT) throw fail('timeout', 'WhatsApp did not confirm the reaction in time.');
    return true;
  }

  async function revoke(a: { id: string }): Promise<boolean> {
    const msg = await findMsg(a.id);
    if (!msg) throw fail('not_found', 'Message not found in WhatsApp.');
    const cap = R('WAWebMsgActionCapability');
    if (!(cap.canSenderRevokeMsg(msg) || (cap.canAdminRevokeMsg && cap.canAdminRevokeMsg(msg)))) {
      throw fail('not_allowed', 'This message can no longer be deleted for everyone.');
    }
    const chat = await findChat(widStr(msg.id.remote)!);
    if (!chat) throw fail('not_found', 'Chat not found in WhatsApp.');
    R('WAWebCmd').Cmd.sendRevokeMsgs(chat, { list: [msg], type: 'message' }, { clearMedia: true });
    return true;
  }

  async function edit(a: { id: string; text: string }): Promise<boolean> {
    const msg = await findMsg(a.id);
    if (!msg) throw fail('not_found', 'Message not found in WhatsApp.');
    const cap = R('WAWebMsgActionCapability');
    const ok = cap && cap.canEditText ? cap.canEditText(msg) || (cap.canEditCaption && cap.canEditCaption(msg)) : !!(msg.id && msg.id.fromMe);
    if (!ok) throw fail('not_allowed', 'This message can no longer be edited.');
    const r = await within(R('WAWebSendMessageEditAction').sendMessageEdit(msg, a.text, {}), 60_000);
    if (r === TIMEOUT) throw fail('timeout', 'WhatsApp did not confirm the edit in time.');
    return true;
  }

  async function markRead(a: { chatId: string }): Promise<boolean> {
    const chat = await findChat(a.chatId);
    if (!chat) throw fail('not_found', 'Chat not found in WhatsApp.');
    await within(R('WAWebUpdateUnreadChatAction').sendSeen({ chat, threadId: undefined }), 20_000);
    return true;
  }

  async function resolvePhone(a: { phone: string }): Promise<string | null> {
    const digits = String(a.phone || '').replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15) throw fail('validation', 'Enter the full number with country code.');
    const res = await within(R('WAWebQueryExistsJob').queryPhoneExists('+' + digits), 20_000);
    if (!res || res === TIMEOUT || !res.wid) return null;
    return widStr(res.wid);
  }

  const api: Record<string, (a: any) => any> = { sendText, uploadBegin, uploadChunk, uploadDrop, sendMedia, react, revoke, edit, markRead, resolvePhone };

  /** Runs an API op; errors come back as {ok: false, code, error} values so CDP keeps the code. */
  async function call(op: string, args: any): Promise<any> {
    const fn = Object.prototype.hasOwnProperty.call(api, op) ? api[op] : null;
    if (!fn) return { ok: false, code: 'unknown', error: 'unknown op' };
    if (typeof W.require !== 'function') return { ok: false, code: 'not_ready', error: 'WhatsApp Web is not loaded yet.' };
    try {
      return { ok: true, value: await fn(args || {}) };
    } catch (e: any) {
      return { ok: false, code: (e && e.code) || 'error', error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  Object.defineProperty(W, '__wal', { value: { v: 1, call } });
  return 'installed';
}

/** Source text for Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate (dev transpilers may add __name). */
export const WAL_PAGE_SOURCE = `(function(){var __name=function(f){return f};return (${installWalPage.toString()})();})()`;
