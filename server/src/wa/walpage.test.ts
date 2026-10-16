import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { WAL_PAGE_SOURCE } from './walpage.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHAT = '905551112233@c.us';

class Emitter {
  private fns = new Map<string, Set<(...a: any[]) => void>>();
  on(ev: string, fn: (...a: any[]) => void) {
    (this.fns.get(ev) ?? this.fns.set(ev, new Set()).get(ev)!).add(fn);
  }
  off(ev: string, fn: (...a: any[]) => void) {
    this.fns.get(ev)?.delete(fn);
  }
  emit(ev: string, ...a: any[]) {
    for (const f of this.fns.get(ev) ?? []) f(...a);
  }
}

const key = (fromMe: boolean, id: string) => ({ fromMe, remote: { toString: () => CHAT }, id, toString: () => `${fromMe}_${CHAT}_${id}` });

/** A fake WhatsApp Web module registry with the shapes walpage.ts relies on (WhatsApp Web 2.3000.1050x). */
function fakeWhatsApp() {
  const log: { op: string; args: any }[] = [];
  const chat: any = { id: { toString: () => CHAT }, msgs: new Emitter() };
  const msgs = new Map<string, any>([
    [`false_${CHAT}_IN1`, { id: key(false, 'IN1'), canReply: true }],
    [`true_${CHAT}_OUT1`, { id: key(true, 'OUT1'), canReply: true, revocable: true, editable: true }],
    [`true_${CHAT}_OLD`, { id: key(true, 'OLD'), canReply: false, revocable: false, editable: false }],
  ]);
  let result: any = 'OK';
  const modules: Record<string, any> = {
    WAWebCollections: {
      Chat: { get: (id: any) => (String(id) === CHAT ? chat : undefined) },
      Msg: { get: (id: string) => msgs.get(id), getMessagesById: async () => ({ messages: [] }) },
    },
    WAWebWidFactory: { createWid: (s: string) => ({ toString: () => s }) },
    WAWebFindChatAction: { findOrCreateLatestChat: async () => ({ chat: null }) },
    WAWebMsgReply: { canReplyMsg: (m: any) => m.canReply },
    WAWebSendTextMsgChatAction: {
      sendTextMsgToChat: async (c: any, text: string, opts: any) => {
        log.push({ op: 'text', args: { chat: c === chat, text, quoted: opts.quotedMsg ? String(opts.quotedMsg.id) : null } });
        chat.msgs.emit('add', { id: key(true, 'NEW') });
        return { messageSendResult: result };
      },
    },
    WAWebMediaOpaqueData: { createFromData: async (file: any, type: string) => ({ file, type }) },
    WAWebPrepRawMedia: {
      prepRawMedia: (opaque: Promise<any>, params: any) => ({
        sendToChat: async ({ chat: c, options }: any) => {
          const o = await opaque;
          const bytes = new Uint8Array(await o.file.arrayBuffer());
          log.push({ op: 'media', args: { chat: c === chat, params, caption: options.caption ?? null, quoted: options.quotedMsg ? String(options.quotedMsg.id) : null, type: o.type, name: o.file.name, bytes: Array.from(bytes) } });
          return { messageSendResult: result, msg: { id: key(true, 'MEDIA') } };
        },
      }),
    },
    WAWebSendReactionMsgAction: { sendReactionToMsg: async (m: any, e: string) => log.push({ op: 'react', args: { id: String(m.id), e } }) },
    WAWebMsgActionCapability: {
      canSenderRevokeMsg: (m: any) => m.revocable,
      canAdminRevokeMsg: () => false,
      canEditText: (m: any) => m.editable,
      canEditCaption: () => false,
    },
    WAWebCmd: { Cmd: { sendRevokeMsgs: (c: any, list: any, opts: any) => log.push({ op: 'revoke', args: { chat: c === chat, n: list.list.length, type: list.type, opts } }) } },
    WAWebSendMessageEditAction: { sendMessageEdit: async (m: any, t: string) => log.push({ op: 'edit', args: { id: String(m.id), t } }) },
    WAWebUpdateUnreadChatAction: { sendSeen: async (a: any) => log.push({ op: 'seen', args: { chat: a.chat === chat } }) },
    WAWebQueryExistsJob: { queryPhoneExists: async (p: string) => (p === '+905551234567' ? { wid: { toString: () => '905551234567@c.us' } } : null) },
  };
  const window: any = {
    setTimeout,
    clearTimeout,
    require: (n: string) => {
      if (!(n in modules)) throw new Error(`Requiring unknown module "${n}"`);
      return modules[n];
    },
  };
  // A fresh context like a page: only what a browser has (no Node globals), so the injected source must be self-contained.
  const sandbox: any = { window, atob, btoa, File, Blob };
  vm.createContext(sandbox);
  return {
    log,
    window,
    install: () => vm.runInContext(WAL_PAGE_SOURCE, sandbox),
    setResult: (r: any) => {
      result = r;
    },
  };
}

describe('walpage (in-page send code)', () => {
  let wa: ReturnType<typeof fakeWhatsApp>;
  const call = (op: string, args: any) => wa.window.__wal.call(op, args);

  beforeEach(() => {
    wa = fakeWhatsApp();
    expect(wa.install()).toBe('installed');
  });

  it('installs once', () => {
    expect(wa.install()).toBe('already');
  });

  it('sends text, with a reply, and returns the new message id', async () => {
    expect(await call('sendText', { chatId: CHAT, text: 'Merhaba', quotedId: `false_${CHAT}_IN1` })).toEqual({ ok: true, value: { id: `true_${CHAT}_NEW` } });
    expect(wa.log).toEqual([{ op: 'text', args: { chat: true, text: 'Merhaba', quoted: `false_${CHAT}_IN1` } }]);
  });

  it('reports WhatsApp send results and refusals as error codes', async () => {
    expect(await call('sendText', { chatId: CHAT, text: 'x', quotedId: `true_${CHAT}_OLD` })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await call('sendText', { chatId: CHAT, text: 'x', quotedId: `false_${CHAT}_GONE` })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call('sendText', { chatId: 'nobody@c.us', text: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
    wa.setResult('ERROR_NETWORK');
    expect(await call('sendText', { chatId: CHAT, text: 'x' })).toMatchObject({ ok: false, code: 'send_failed', error: 'WhatsApp could not send it (error_network).' });
    expect(await call('nope', {})).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('assembles uploaded chunks and sends media through prepRawMedia', async () => {
    const t = (await call('uploadBegin', { size: 6 })).value as string;
    expect((await call('uploadChunk', { token: t, offset: 0, b64: btoa('abc') })).ok).toBe(true);
    expect((await call('uploadChunk', { token: t, offset: 3, b64: btoa('def') })).ok).toBe(true);
    expect(await call('uploadChunk', { token: t, offset: 5, b64: btoa('gh') })).toMatchObject({ ok: false, code: 'validation' });
    const r = await call('sendMedia', { chatId: CHAT, token: t, mime: 'image/jpeg', filename: 'a.jpg', kind: 'auto', caption: 'deniz', quotedId: `false_${CHAT}_IN1` });
    expect(r).toEqual({ ok: true, value: { id: `true_${CHAT}_MEDIA` } });
    expect(wa.log[0]).toEqual({
      op: 'media',
      args: { chat: true, params: {}, caption: 'deniz', quoted: `false_${CHAT}_IN1`, type: 'image/jpeg', name: 'a.jpg', bytes: [...Buffer.from('abcdef')] },
    });
    // The upload is gone after sending.
    expect(await call('uploadChunk', { token: t, offset: 0, b64: btoa('a') })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('sends documents and voice notes with WhatsApp’s flags (no caption on voice notes)', async () => {
    for (const kind of ['document', 'voice', 'gif']) {
      const t = (await call('uploadBegin', { size: 1 })).value;
      await call('uploadChunk', { token: t, offset: 0, b64: btoa('x') });
      await call('sendMedia', { chatId: CHAT, token: t, mime: 'audio/ogg; codecs=opus', filename: null, kind, caption: 'c' });
    }
    expect(wa.log.map((l) => [l.args.params, l.args.caption])).toEqual([
      [{ asDocument: true }, 'c'],
      // No decoder in the fake page: duration/waveform are left to WhatsApp.
      [{ isPtt: true }, null],
      [{ asGif: true }, 'c'],
    ]);
  });

  it('reacts, deletes for everyone and edits when WhatsApp allows it', async () => {
    expect((await call('react', { id: `false_${CHAT}_IN1`, emoji: '👍' })).ok).toBe(true);
    expect((await call('revoke', { id: `true_${CHAT}_OUT1` })).ok).toBe(true);
    expect(await call('revoke', { id: `true_${CHAT}_OLD` })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect((await call('edit', { id: `true_${CHAT}_OUT1`, text: 'fixed' })).ok).toBe(true);
    expect(await call('edit', { id: `true_${CHAT}_OLD`, text: 'x' })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(wa.log).toEqual([
      { op: 'react', args: { id: `false_${CHAT}_IN1`, e: '👍' } },
      { op: 'revoke', args: { chat: true, n: 1, type: 'message', opts: { clearMedia: true } } },
      { op: 'edit', args: { id: `true_${CHAT}_OUT1`, t: 'fixed' } },
    ]);
  });

  it('marks chats read and looks up phone numbers', async () => {
    expect((await call('markRead', { chatId: CHAT })).ok).toBe(true);
    expect(wa.log).toEqual([{ op: 'seen', args: { chat: true } }]);
    expect(await call('resolvePhone', { phone: '+90 555 123 45 67' })).toEqual({ ok: true, value: '905551234567@c.us' });
    expect(await call('resolvePhone', { phone: '+1 202 555 0100' })).toEqual({ ok: true, value: null });
    expect(await call('resolvePhone', { phone: '12' })).toMatchObject({ ok: false, code: 'validation' });
  });
});
