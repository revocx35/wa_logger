// Sending end-to-end in a real browser: the real server (in-process test harness, built web UI) with the real
// Sender, and a fake WhatsApp page whose operations behave like WhatsApp Web's (what is "sent" comes back through
// the real ingest code as an own message). Drives the web UI through a test browser (scripts/dev/README.md;
// start it with --use-fake-device-for-media-stream --use-fake-ui-for-media-stream for the voice note step).
//
//   (cd web && npm run build); cd server && npx tsx ../scripts/dev/send-ui.mts
//
// Test data only; nothing here is real.
import fs from 'node:fs/promises';
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { NullWa, type WaController } from '../../server/src/context.ts';
import { makeHarness, PASSWORD, SETUP_TOKEN } from '../../server/src/testutil/harness.ts';
import { Ingest } from '../../server/src/wa/ingest.ts';
import { Sender } from '../../server/src/wa/sender.ts';
import type { WalPage } from '../../server/src/wa/walbridge.ts';

const PORT = 18093;
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = '905551110001@c.us';
const ME = '905550000001@c.us';
const JPEG = process.env.JPEG ?? '/opt/android-sdk/emulator/resources/default.jpg';

const WEB_DIR = new URL('../../web/dist', import.meta.url).pathname;
let ingest: Ingest;
let n = 0;
const uploads = new Map<string, Buffer>();
const ops: string[] = [];

const now = () => Math.floor(Date.now() / 1000);
const key = (fromMe: boolean, id: string) => ({ fromMe, remote: CHAT, id, _serialized: `${fromMe}_${CHAT}_${id}` });

/** The page operations of walpage.ts, simulated: an own message appears as WhatsApp's message_create would. */
const fakePage = {
  page: null,
  call: async (op: string, a: Record<string, any>) => {
    ops.push(op);
    switch (op) {
      case 'sendText': {
        const id = `S${++n}`;
        const quoted = a.quotedId ? h.ctx.repo.getMessage(a.quotedId) : null;
        await ingest.message(
          {
            id: key(true, id),
            type: 'chat',
            body: a.text,
            t: now(),
            from: ME,
            to: CHAT,
            ack: 1,
            ...(quoted ? { quotedStanzaID: a.quotedId.split('_')[2], quotedParticipant: CHAT, quotedMsg: { type: 'chat', body: 'quoted' } } : {}),
          },
          'live',
        );
        return { id: `true_${CHAT}_${id}` };
      }
      case 'uploadBegin':
        uploads.set('t', Buffer.alloc(0));
        return 't';
      case 'uploadChunk':
        uploads.set('t', Buffer.concat([uploads.get('t')!, Buffer.from(a.b64, 'base64')]));
        return true;
      case 'sendMedia': {
        const id = `S${++n}`;
        const type = a.kind === 'voice' ? 'ptt' : a.kind === 'document' ? 'document' : 'image';
        // Logged before the upload finished: no directPath, like WhatsApp's own flow.
        await ingest.message({ id: key(true, id), type, body: '', caption: a.caption ?? undefined, t: now(), from: ME, to: CHAT, mimetype: a.mime, size: uploads.get('t')!.length, ack: 1 }, 'live');
        voiceBytes = a.kind === 'voice' ? uploads.get('t')! : voiceBytes;
        return { id: `true_${CHAT}_${id}` };
      }
      case 'react':
        ingest.reaction({ msgId: a.id, senderId: ME, reaction: a.emoji, timestamp: Date.now() });
        return true;
      case 'revoke': {
        const row = h.ctx.repo.getMessage(a.id)!;
        await ingest.revoke({ id: key(true, a.id.split('_')[2]), type: 'revoked', subtype: 'sender', t: Math.floor(row.ts / 1000), from: ME, to: CHAT }, null);
        return true;
      }
      case 'edit':
        await ingest.edit({ id: key(true, a.id.split('_')[2]), type: 'chat', body: a.text, t: now(), from: ME, to: CHAT, latestEditMsgKey: { _serialized: `EK${++n}` } }, a.text, null);
        return true;
      case 'markRead':
        return true;
      case 'resolvePhone':
        return `${a.phone.replace(/\D/g, '')}@c.us`;
      default:
        throw new Error(`unexpected op ${op}`);
    }
  },
} as unknown as WalPage;
let voiceBytes: Buffer | null = null;

class FakeWa extends NullWa {
  override readonly sender: Sender;
  constructor(ctx: ConstructorParameters<typeof Sender>[0]) {
    super();
    this.sender = new Sender(ctx, () => fakePage, (id) => ingest.ensureChat(id, true));
  }
  override status() {
    return { state: 'ready' as const, mediaQueue: 0, since: Date.now(), sync: null };
  }
}

const h = await makeHarness({ COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '', TRUST_PROXY: '0', WEB_DIR }, { wa: (ctx) => new FakeWa(ctx) as WaController });
// SERVE=1: only run the server (e.g. for the Android emulator at http://10.0.2.2:18093) and log the page ops.
await h.app.listen({ port: PORT, host: process.env.SERVE ? '0.0.0.0' : '127.0.0.1' });
ingest = new Ingest(
  h.ctx,
  {
    getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
    getContact: async (id) => ({ name: id === ME ? null : 'Ali Veli', pushname: 'ali', isMe: id === ME, isBusiness: false }),
  },
  { enqueue: () => undefined },
);
const signup = await fetch(`${BASE}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD }),
});
if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
h.ctx.repo.setState('onboarding_complete', '1');
h.ctx.repo.setState('wa_me', ME);
await ingest.ensureContact(ME, null, true);
await ingest.message({ id: key(false, 'IN1'), type: 'chat', body: 'Selam, nasılsın?', t: now() - 60, from: CHAT, ack: 1 }, 'live');

if (process.env.SERVE) {
  console.log(`serving on :${PORT}, owner / ${PASSWORD}`);
  setInterval(() => ops.length && console.log(`ops: ${ops.splice(0).join(',')}`), 1000);
  await new Promise(() => undefined);
}

const results: string[] = [];
const problems: string[] = [];
const check = (cond: unknown, name: string) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: { width: 1300, height: 850 } });
const bctx = await browser.createBrowserContext();
const p = await bctx.newPage();
p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console.${m.type()}: ${m.text()}`));
p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
p.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
const bubbleTexts = () => p.$$eval('.msg-row .text', (els) => els.map((e) => e.textContent ?? ''));
const until = async (fn: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(150);
  }
  return false;
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await p.type('input[autocomplete="username"], input[name="username"]', 'owner');
  await p.type('input[type="password"]', PASSWORD);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.chat-item', { timeout: 15000 });
  await p.click('.chat-item');
  await p.waitForSelector('.composer textarea');
  check(true, 'composer shown in a user chat');

  // Text: Enter sends, Shift+Enter is a new line.
  await p.type('.composer textarea', 'Merhaba');
  await p.keyboard.down('Shift');
  await p.keyboard.press('Enter');
  await p.keyboard.up('Shift');
  await p.type('.composer textarea', 'ikinci satır 👋');
  await p.keyboard.press('Enter');
  check(await until(async () => (await bubbleTexts()).some((t) => t.includes('Merhaba') && t.includes('ikinci satır'))), 'sent text appears (live update) with its line break');
  check((await p.$eval('.composer textarea', (e) => (e as HTMLTextAreaElement).value)) === '', 'composer cleared after sending');

  // Reply through the message menu.
  const inRow = (await p.$$('.msg-row.in'))[0]!;
  await inRow.hover();
  await (await inRow.$('.msg-actions .icon-btn'))!.click();
  for (const b of await p.$$('.menu > button')) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Reply')) await b.click();
  check(!!(await p.$('.compose-bar')), 'reply bar shown');
  await p.type('.composer textarea', 'iyiyim');
  await p.keyboard.press('Enter');
  check(await until(async () => !!(await p.$('.msg-row.out .quote'))), 'reply sent with the quote');

  // React.
  await inRow.hover();
  await (await inRow.$('.msg-actions .icon-btn'))!.click();
  await p.click('.menu-reactions button[aria-label="React ❤️"]');
  check(await until(async () => (await p.$$eval('.msg-row.in .reactions', (e) => e.map((x) => x.textContent ?? ''))).some((t) => t.includes('❤️'))), 'reaction shown');

  // Edit own message.
  const outRow = (await p.$$('.msg-row.out'))[0]!;
  await outRow.hover();
  await (await outRow.$('.msg-actions .icon-btn'))!.click();
  const items = await p.$$('.menu > button');
  for (const b of items) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Edit')) await b.click();
  await p.waitForSelector('.compose-bar');
  await p.$eval('.composer textarea', (e) => ((e as HTMLTextAreaElement).value = ''));
  await p.type('.composer textarea', 'Merhaba (düzeltildi)');
  await p.keyboard.press('Enter');
  check(await until(async () => (await bubbleTexts()).some((t) => t.includes('düzeltildi'))), 'edit applied');
  check(await until(async () => !!(await p.$('.msg-row.out .edited'))), 'edited badge shown');

  // Delete for everyone (two-step confirm in the menu); the logged copy stays.
  const outRow2 = (await p.$$('.msg-row.out'))[0]!;
  await outRow2.hover();
  await (await outRow2.$('.msg-actions .icon-btn'))!.click();
  for (const b of await p.$$('.menu > button')) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Delete for everyone')) await b.click();
  for (const b of await p.$$('.menu > button')) if ((await b.evaluate((e) => e.textContent ?? '')).includes('Yes, delete')) await b.click();
  check(await until(async () => !!(await p.$('.msg-row.out .deleted-banner'))), 'deleted for everyone, logged copy kept');

  // Photo with a caption.
  // The test browser may run in a container: hand the file over through a DataTransfer instead of a path.
  const jpeg = (await fs.readFile(JPEG)).toString('base64');
  await p.$eval(
    '.composer input[type="file"]',
    (el, data) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'deniz.jpg', { type: 'image/jpeg' }));
      (el as HTMLInputElement).files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    jpeg,
  );
  await p.waitForSelector('.compose-bar');
  await p.type('.composer textarea', 'deniz kenarı');
  await p.keyboard.press('Enter');
  check(await until(async () => (await bubbleTexts()).some((t) => t.includes('deniz kenarı'))), 'photo sent with caption');
  check(await until(async () => !!(await p.$('.msg-row.out img[src^="/api/media/"]'))), 'sent photo is stored and shown (no re-download)');
  const sent = h.ctx.repo.getMessage(`true_${CHAT}_S${n}`);
  check(sent?.media_status === 'downloaded' && sent.media_size === (await fs.readFile(JPEG)).length, 'stored file has the uploaded size');

  // Voice note (needs the browser's fake microphone).
  await p.click('.composer button[aria-label="Record a voice message"]');
  if (await until(async () => !!(await p.$('.compose-row.recording')), 3000)) {
    await wait(2500);
    await p.click('.composer button[aria-label="Send voice message"]');
    check(await until(async () => voiceBytes !== null, 10000), 'voice note uploaded');
    // A real decoder must accept it as Ogg/Opus.
    const b64 = voiceBytes!.toString('base64');
    const decoded = await p.evaluate(async (data: string) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const magic = new TextDecoder().decode(bytes.subarray(0, 4));
      const buf = await new AudioContext().decodeAudioData(bytes.buffer);
      return { magic, seconds: buf.duration };
    }, b64);
    check(decoded.magic === 'OggS' && decoded.seconds > 1.5 && decoded.seconds < 4, `voice note is valid Ogg/Opus (${decoded.magic}, ${decoded.seconds.toFixed(2)} s)`);
  } else check(false, 'recording started (is the browser started with a fake microphone?)');

  if (process.env.SHOT) {
    const r = (await p.$$('.msg-row.in'))[0]!;
    await r.hover();
    await (await r.$('.msg-actions .icon-btn'))!.click();
    await p.screenshot({ path: `${process.env.SHOT}/chat-menu.png` });
    await p.keyboard.press('Escape');
  }

  // New chat by number.
  await p.click('button[aria-label="New chat"]');
  await p.type('.modal input', '+90 555 777 66 55');
  await p.keyboard.press('Enter');
  check(await until(async () => decodeURIComponent(p.url()).endsWith('/chat/905557776655@c.us')), 'new chat opened');
  check(await until(async () => !!(await p.$('.composer textarea'))), 'composer in the new chat');

  // Phone width.
  await p.setViewport({ width: 390, height: 800 });
  await wait(300);
  const box = await p.$eval('.composer', (e) => e.getBoundingClientRect().width);
  check(box <= 390, 'composer fits a phone screen');
} catch (e) {
  results.push(`FAIL exception: ${(e as Error).message}`);
} finally {
  await bctx.close();
  await browser.disconnect();
  await h.close();
}

console.log(results.join('\n'));
console.log(`ops: ${ops.join(',')}`);
if (problems.length) console.log(`problems:\n${problems.join('\n')}`);
process.exit(results.some((r) => r.startsWith('FAIL')) || problems.length ? 1 : 0);
