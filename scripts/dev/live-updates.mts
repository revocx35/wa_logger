// Live-update test: real server (in-process) + built web UI + real browser; WhatsApp events are
// injected through the real Ingest code and must appear in the open UI without a reload.
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { makeHarness, PASSWORD } from '../../server/src/testutil/harness.ts';
import { Ingest } from '../../server/src/wa/ingest.ts';

const PORT = 18090;
const ORIGIN = `http://localhost:${PORT}`;
const h = await makeHarness({ WEB_DIR: new URL('../../web/dist', import.meta.url).pathname, COOKIE_SECURE: 'false', PUBLIC_ORIGIN: ORIGIN });
await h.app.listen({ port: PORT, host: '127.0.0.1' });
const results: string[] = [];
const check = (c: boolean, n: string) => results.push(`${c ? 'PASS' : 'FAIL'} ${n}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHAT = '905551112233@c.us';
const OTHER = '905554445566@c.us';
const ingest = new Ingest(h.ctx, {
  getChat: async (id) => ({ name: id === CHAT ? 'Ali Live' : 'Other Live', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Live', pushname: 'ali', isMe: false, isBusiness: false }),
}, { enqueue: () => undefined });
let n = 0;
const msg = (chat: string, body: string, over: Record<string, unknown> = {}) => {
  const id = `LIVE${++n}`;
  return { id: { fromMe: false, remote: chat, id, _serialized: `false_${chat}_${id}` }, type: 'chat', body, t: Math.floor(Date.now() / 1000), from: chat, ...over };
};

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: { width: 1300, height: 850 } });
const bctx = await browser.createBrowserContext();
const p = await bctx.newPage();
const problems: string[] = [];
p.on('pageerror', (e) => problems.push(e.message));
p.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
try {
  await p.goto(`${ORIGIN}/signup`, { waitUntil: 'load' });
  await wait(800);
  await p.type('input[placeholder^="SETUP_TOKEN"]', 'test-setup-token-0123456789');
  const inputs = await p.$$('form input');
  await inputs[1]!.type('owner'); await inputs[2]!.type(PASSWORD); await inputs[3]!.type(PASSWORD);
  await p.click('button.btn.primary'); await wait(2000);
  await p.click('label.check input'); await p.click('button.btn.primary'); await wait(1500);
  h.ctx.repo.setState('onboarding_complete', '1');
  await ingest.message(msg(CHAT, 'first message'), 'live');
  await p.goto(`${ORIGIN}/`, { waitUntil: 'load' }); await wait(1500);
  check((await p.$$('.chat-item')).length === 1, 'initial chat listed');

  // A new chat appears in the list live.
  await ingest.message(msg(OTHER, 'hello from a new chat'), 'live');
  await wait(1800);
  check((await p.$$('.chat-item')).length === 2, 'new chat appears in the list without reload');

  // Open a chat; new messages, deletions and edits show up live.
  await p.goto(`${ORIGIN}/chat/${encodeURIComponent(CHAT)}`, { waitUntil: 'load' }); await wait(1500);
  const before = (await p.$$('.bubble')).length;
  const live = msg(CHAT, 'this arrives live');
  await ingest.message(live, 'live');
  await wait(1500);
  check((await p.$$('.bubble')).length === before + 1, 'incoming message appears in the open chat');
  await ingest.revoke({ ...live, type: 'revoked', subtype: 'sender', body: '' }, null);
  await wait(1500);
  const del = await p.$$eval('.bubble.deleted', (els) => els.map((e) => e.textContent ?? ''));
  check(del.some((t) => t.includes('this arrives live')), 'deletion turns the bubble red live, content kept');
  const ed = msg(CHAT, 'typo here');
  await ingest.message(ed, 'live');
  await wait(1200);
  await ingest.edit({ ...ed, body: 'fixed text', latestEditMsgKey: { _serialized: 'EDLIVE' } }, 'fixed text', 'typo here');
  await wait(1500);
  const texts = await p.$$eval('.bubble', (els) => els.map((e) => e.textContent ?? ''));
  check(texts.some((t) => t.includes('fixed text') && t.includes('Edited')), 'edit updates the bubble live with Edited label');
  const lastPreview = await p.$$eval('.chat-item', (els) => els.map((e) => e.textContent ?? ''));
  check(lastPreview.some((t) => t.includes('fixed text') || t.includes('typo here')), 'chat list preview follows live updates');

  // Deleted feed refreshes live.
  await p.goto(`${ORIGIN}/deleted`, { waitUntil: 'load' }); await wait(1200);
  const c1 = (await p.$$('.feed-item')).length;
  const d2 = msg(OTHER, 'delete me too');
  await ingest.message(d2, 'live');
  await ingest.revoke({ ...d2, type: 'revoked', subtype: 'sender', body: '' }, null);
  await wait(1800);
  check((await p.$$('.feed-item')).length === c1 + 1, 'deleted feed updates live');

  // Session revoked elsewhere → this tab is sent to login.
  h.ctx.repo.deleteAllSessions();
  h.ctx.events.emit({ type: 'session_revoked' });
  await wait(2500);
  check(p.url().endsWith('/login'), 'revoked session is logged out live');
} catch (e) {
  results.push(`FAIL crashed ${(e as Error).stack}`);
} finally {
  await bctx.close();
  browser.disconnect();
  await h.close();
}
console.log(results.join('\n'));
console.log('browser problems:', JSON.stringify(problems));
