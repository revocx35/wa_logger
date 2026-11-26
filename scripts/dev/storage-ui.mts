// Storage controls in a real browser: Settings → Storage (retention for messages and for photos/videos, with the
// "delete now" confirmation), "Delete from log" in a message's menu and deleting several selected messages.
// Real server (in-process, test harness) + built web UI + the test browser from README.md. Screenshots go to $SHOTS.
//   (cd web && npm run build) && cd server && SHOTS=<dir> npx tsx ../scripts/dev/storage-ui.mts
import fs from 'node:fs';
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { makeHarness, PASSWORD } from '../../server/src/testutil/harness.ts';
import { RetentionService } from '../../server/src/retention.ts';
import { Ingest } from '../../server/src/wa/ingest.ts';
import { beginMediaFile, finishMediaFile } from '../../server/src/wa/media.ts';

const PORT = 18095;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS ?? '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const h = await makeHarness({ WEB_DIR: new URL('../../web/dist', import.meta.url).pathname, COOKIE_SECURE: 'false', PUBLIC_ORIGIN: ORIGIN });
await h.app.listen({ port: PORT, host: '127.0.0.1' });
const results: string[] = [];
const check = (c: boolean, n: string) => results.push(`${c ? 'PASS' : 'FAIL'} ${n}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

const CHAT = '905551112233@c.us';
const ingest = new Ingest(h.ctx, {
  getChat: async () => ({ name: 'Ali Storage', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Storage', pushname: 'ali', isMe: false, isBusiness: false }),
}, { enqueue: () => undefined });
const mid = (k: string) => `false_${CHAT}_${k}`;
const msg = (k: string, body: string, ageDays: number) => ({
  id: { fromMe: false, remote: CHAT, id: k, _serialized: mid(k) }, type: 'chat', body, t: Math.floor((Date.now() - ageDays * DAY) / 1000), from: CHAT,
});

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: { width: 1300, height: 850 } });
const bctx = await browser.createBrowserContext();
const p = await bctx.newPage();
const problems: string[] = [];
p.on('pageerror', (e) => problems.push(e.message));
// The 404 of a message that was just deleted is expected (the UI then drops it).
p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && problems.push(m.text()));
const shot = async (name: string) => SHOTS && (await p.screenshot({ path: `${SHOTS}/${name}.png` }));
const clickText = async (sel: string, text: string) => {
  const ok = await p.$$eval(sel, (els, t) => {
    const el = els.find((e) => (e.textContent ?? '').includes(t as string)) as HTMLElement | undefined;
    el?.click();
    return !!el;
  }, text);
  if (!ok) throw new Error(`no ${sel} with "${text}"`);
};
const bubbles = () => p.$$eval('.bubble', (els) => els.map((e) => e.textContent ?? ''));
try {
  await p.goto(`${ORIGIN}/signup`, { waitUntil: 'load' });
  await wait(800);
  await p.type('input[placeholder^="SETUP_TOKEN"]', 'test-setup-token-0123456789');
  const inputs = await p.$$('form input');
  await inputs[1]!.type('owner'); await inputs[2]!.type(PASSWORD); await inputs[3]!.type(PASSWORD);
  await p.click('button.btn.primary'); await wait(2000);
  await p.click('label.check input'); await p.click('button.btn.primary'); await wait(1500);
  h.ctx.repo.setState('onboarding_complete', '1');
  for (let i = 1; i <= 8; i++) await ingest.message(msg(`S${i}`, `storage message ${i}`, 50 - i * 5), 'live');
  // A 25-day-old photo with a file.
  const f = await beginMediaFile(h.ctx);
  await f.writer.write(Buffer.from('not really a jpeg'));
  const { mediaId } = await finishMediaFile(h.ctx, f, 'message', 'image/jpeg', null);
  h.ctx.repo.updateMessage(mid('S5'), { type: 'image', media_id: mediaId, media_status: 'downloaded' });

  // 1. One message via its menu.
  await p.goto(`${ORIGIN}/chat/${encodeURIComponent(CHAT)}`, { waitUntil: 'load' }); await wait(1500);
  check((await bubbles()).length === 8, 'chat shows 8 messages');
  await p.$eval(`[id="m-${mid('S8')}"] .msg-actions button`, (b) => (b as HTMLElement).click());
  await wait(300);
  await clickText('.menu button', 'Delete from log');
  await shot('1-menu-confirm');
  await clickText('.menu button', 'Yes, delete from the log');
  await wait(1200);
  const after1 = await bubbles();
  check(after1.length === 7 && !after1.some((t) => t.includes('storage message 8')), 'message deleted from its menu disappears');
  check(!h.ctx.repo.getMessage(mid('S8')) && h.ctx.repo.isMessageRemoved(mid('S8')), 'server deleted it and remembers the id');

  // 2. Several selected messages.
  await p.click('button[aria-label="Select messages to delete from the log"]'); await wait(400);
  for (const k of ['S6', 'S7']) await p.click(`[id="m-${mid(k)}"]`);
  await wait(200);
  await shot('2-selected');
  await clickText('.chat-head button', 'Delete from log');
  await clickText('.chat-head button', 'Delete 2');
  await wait(1500);
  const after2 = await bubbles();
  check(after2.length === 5 && !after2.some((t) => t.includes('storage message 6') || t.includes('storage message 7')), 'two selected messages deleted');
  await p.reload({ waitUntil: 'load' }); await wait(1500);
  check((await bubbles()).length === 5, 'still gone after a reload');

  // 3. Settings → Storage.
  await p.goto(`${ORIGIN}/settings#storage`, { waitUntil: 'load' }); await wait(1500);
  const selects = await p.$$('#storage select');
  check(selects.length === 2, 'Storage section has two retention pickers');
  await selects[1]!.select('7');
  await wait(300);
  await p.$eval('#storage', (e) => e.scrollIntoView());
  await shot('3-media-confirm');
  const warn = await p.$eval('#storage', (e) => e.textContent ?? '');
  check(warn.includes('will be deleted from the log now'), 'shortening retention asks for confirmation');
  await clickText('#storage button', 'Delete and save');
  await wait(1000);
  check(h.ctx.settings.get().mediaRetentionDays === 7, 'photo/video retention saved');
  await (await p.$$('#storage select'))[0]!.select('30');
  await wait(300);
  await clickText('#storage button', 'Delete and save');
  await wait(1000);
  check(h.ctx.settings.get().messageRetentionDays === 30, 'message retention saved');
  await shot('4-storage-saved');
  const out = await new RetentionService(h.ctx).sweep(Date.now());
  check(out.messages === 4 && out.media === 1, `sweep removed old data (${JSON.stringify(out)})`);
  await p.goto(`${ORIGIN}/chat/${encodeURIComponent(CHAT)}`, { waitUntil: 'load' }); await wait(1500);
  const left = await bubbles();
  check(left.length === 1 && left[0]!.includes('storage message 5'), 'chat shows only the last 30 days');
  check(left[0]!.includes('Removed by your storage setting'), 'the old photo is marked as removed by the storage setting');
  await shot('4b-expired-photo');

  // 4. Phone layout.
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await p.goto(`${ORIGIN}/settings#storage`, { waitUntil: 'load' }); await wait(1500);
  await (await p.$$('#storage select'))[0]!.select('0');
  await wait(300);
  await p.$eval('#storage', (e) => e.scrollIntoView());
  await shot('5-phone-storage');
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'no horizontal scroll on a phone');
} catch (e) {
  results.push(`FAIL crashed ${(e as Error).stack}`);
} finally {
  await bctx.close();
  browser.disconnect();
  await h.close();
}
console.log(results.join('\n'));
console.log('browser problems:', JSON.stringify(problems));
