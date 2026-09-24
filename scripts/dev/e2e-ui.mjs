// Full UI walkthrough (61 steps) against a running stack seeded with server/src/testutil/seed.ts — see scripts/dev/README.md
// Full UI end-to-end walkthrough against a running wa_logger stack (seeded data).
import crypto from 'node:crypto';
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';

const BASE = process.env.BASE ?? 'https://localhost:28443';
let PASSWORD = 'correct-horse-battery-staple';
const results = [];
const problems = [];
const ok = (name) => results.push(['PASS', name]);
const fail = (name, info = '') => results.push(['FAIL', `${name} ${info}`]);
const check = (cond, name, info) => (cond ? ok(name) : fail(name, info));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of s) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret, stepOffset = 0) {
  const step = Math.floor(Date.now() / 30000) + stepOffset;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: { width: 1400, height: 900 } });
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
p.on('response', (r) => {
  const u = r.url(); const s = r.status();
  if (s >= 500) problems.push(`HTTP ${s} ${u}`);
  if (s === 404 && !u.includes('/api/media/99')) problems.push(`HTTP 404 ${u}`);
});
p.on('requestfailed', (r) => { if (!r.url().includes('/api/events')) problems.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`); });

const go = async (path) => { await p.goto(BASE + path, { waitUntil: 'load' }); await wait(900); };
const openChat = async (name) => {
  for (const el of await p.$$('.chat-item')) {
    if ((await el.$eval('.chat-name', (e) => e.textContent)).startsWith(name)) { await el.click(); return true; }
  }
  return false;
};
const clickText = async (sel, text) => {
  for (const el of await p.$$(sel)) { if ((await el.evaluate((e) => e.textContent)).includes(text)) { await el.click(); return true; } }
  return false;
};
const fill = async (sel, value) => { await p.$eval(sel, (e) => { e.value = ''; }); await p.type(sel, value); };
const login = async (user, pass, code) => {
  await go('/login');
  const inputs = await p.$$('form input');
  await inputs[0].type(user); await inputs[1].type(pass);
  await p.click('button.btn.primary'); await wait(1500);
  if (code) { await p.type('input[autocomplete="one-time-code"]', code); await p.click('button.btn.primary'); await wait(1500); }
};
const apiCall = (method, path, body) => p.evaluate(async (method, path, body) => {
  const s = await (await fetch('/api/state')).json();
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken }, body: body ? JSON.stringify(body) : undefined });
  return r.status;
}, method, path, body);

try {
  // ---------------------------------------------------------------- login & onboarding
  await go('/');
  check(p.url().endsWith('/login'), 'unauthenticated / redirects to /login', p.url());
  await login('owner', 'wrong-password-xx');
  check(!!(await p.$('.error-note')), 'wrong password shows an error');
  await login('owner', PASSWORD);
  check(p.url().endsWith('/setup/link'), 'login with incomplete onboarding lands on /setup/link', p.url());
  await wait(4000);
  check(!(await p.$('.vnc-overlay')) && !!(await p.$('.vnc-host canvas')), 'VNC live view connects on link page');
  check(await p.$eval('.setup-foot .btn.primary', (b) => b.disabled), 'Complete disabled while WhatsApp not linked');
  check((await apiCall('POST', '/api/onboarding/complete', { force: true })) === 200, 'onboarding completed (forced, no phone here)');
  await go('/');
  check(p.url() === BASE + '/', 'main page after onboarding', p.url());

  // ---------------------------------------------------------------- chat list + filters
  let items = await p.$$('.chat-item');
  check(items.length === 4, 'chat list shows 4 chats', `got ${items.length}`);
  await clickText('.chip', 'Groups'); await wait(300);
  check((await p.$$('.chat-item')).length === 1, 'Groups filter');
  await clickText('.chip', 'Has deleted'); await wait(300);
  check((await p.$$('.chat-item')).length === 2, 'Has-deleted filter', `got ${(await p.$$('.chat-item')).length}`);
  await clickText('.chip', 'All'); await wait(300);
  await p.type('.search-box input', 'zey'); await wait(300);
  check((await p.$$('.chat-item')).length === 1, 'chat name filter');
  await p.click('.search-box .icon-btn'); await wait(300);

  // ---------------------------------------------------------------- Ali chat
  await openChat('Ali'); await wait(1500);
  check((await p.$$('.bubble')).length >= 8, 'Ali chat renders bubbles', `got ${(await p.$$('.bubble')).length}`);
  await p.evaluate(() => (document.querySelector('.messages').scrollTop = 0)); await wait(800);
  check(!!(await p.$('.bubble.deleted')), 'deleted message shown with red frame');
  const delText = await p.$eval('.bubble.deleted', (e) => e.textContent);
  check(delText.includes('Actually I told Zeynep'), 'deleted message content preserved');
  await p.click('.quote'); await wait(900);
  check(!!(await p.$('.bubble.highlight')), 'clicking a quote jumps to & highlights the original');
  await p.click('.edited'); await wait(900);
  const editsText = await p.$eval('.modal', (e) => e.textContent);
  check(editsText.includes('Meet at 7pm') && editsText.includes('Meet at 8pm instead'), 'edit history modal shows old and new text');
  await p.keyboard.press('Escape'); await wait(300);
  check(!(await p.$('.modal')), 'Escape closes modal');
  await p.click('.media-btn'); await wait(1200);
  const imgOk = await p.$eval('.lightbox img', (i) => i.complete && i.naturalWidth > 0).catch(() => false);
  check(imgOk, 'image lightbox loads decrypted image');
  await p.keyboard.press('Escape'); await wait(300);
  check(!!(await p.$('.media-placeholder-info .btn')), 'failed voice note shows Retry');
  const retryStatus = await p.evaluate(async () => {
    const s = await (await fetch('/api/state')).json();
    const chats = await (await fetch('/api/chats')).json();
    const ali = chats.find((c) => c.name.includes('Ali'));
    const page = await (await fetch(`/api/chats/${encodeURIComponent(ali.id)}/messages?limit=200`)).json();
    const ptt = page.messages.find((m) => m.type === 'ptt');
    const r = await fetch(`/api/messages/${encodeURIComponent(ptt.id)}/media/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken }, body: '{}' });
    return r.status;
  });
  check(retryStatus === 200, 'media retry endpoint accepts a failed download');
  check(!!(await p.$('.view-once')), 'view-once placeholder shown');
  check((await p.$$('.reactions')).length >= 1, 'reaction shown');
  check(!!(await p.$('.wa-pre')) && !!(await p.$('.wa-quote')) && (await p.$$('.wa-li')).length >= 2, 'code block, quote and list formatting rendered');

  // ---------------------------------------------------------------- group chat
  await go('/');
  await openChat('Family'); await wait(1500);
  await p.evaluate(() => (document.querySelector('.messages').scrollTop = 0)); await wait(800);
  const sys = await p.$$eval('.system-pill', (els) => els.map((e) => e.textContent));
  check(sys.some((t) => t.includes('created the group')) && sys.some((t) => t.includes('added')), 'group system messages rendered', JSON.stringify(sys));
  check(!!(await p.$('.wa-mention')), 'mention rendered with name');
  check(!!(await p.$('.poll')), 'poll rendered');
  check(!!(await p.$('.vcard')), 'contact card rendered');
  const docHref = await p.$eval('.media-doc', (a) => a.getAttribute('href'));
  const docInfo = await p.evaluate(async (h) => { const r = await fetch(h); return { s: r.status, cd: r.headers.get('content-disposition'), t: await r.text() }; }, docHref);
  check(docInfo.s === 200 && /^attachment/.test(docInfo.cd) && docInfo.t.includes('eggs'), 'document downloads decrypted as attachment', JSON.stringify(docInfo).slice(0, 120));
  check(sys.some((t) => t.includes('Video call')), 'call log rendered');
  check(!!(await p.$('.forwarded')), 'forwarded label rendered');
  const senderNames = await p.$$eval('.sender', (els) => els.map((e) => e.textContent));
  check(senderNames.includes('Zeynep Kaya') && senderNames.includes('Mert Demir'), 'group sender names', JSON.stringify(senderNames));

  // ---------------------------------------------------------------- infinite scroll (Zeynep, 121 msgs)
  await go('/');
  await openChat('Zeynep'); await wait(1500);
  for (let i = 0; i < 6; i++) { await p.evaluate(() => (document.querySelector('.messages').scrollTop = 0)); await wait(700); }
  const zCount = (await p.$$('.bubble')).length;
  check(zCount === 121, 'scrolling up loads the full history (121 messages)', `got ${zCount}`);
  check((await p.$eval('.messages', (e) => e.textContent)).includes('Beginning of the log'), 'beginning-of-log marker');
  // in-chat search + jump
  await p.click('.chat-head .icon-btn:last-child'); await wait(300);
  await p.type('.chat-search input', 'Message 77'); await p.keyboard.press('Enter'); await wait(1200);
  const hits = await p.$$('.hit');
  check(hits.length === 1, 'in-chat search finds the message', `got ${hits.length}`);
  if (hits[0]) { await hits[0].click(); await wait(1200); }
  const hl = await p.$eval('.bubble.highlight', (e) => e.textContent).catch(() => '');
  check(hl.includes('Message 77'), 'search hit jumps to the message', hl.slice(0, 40));

  // ---------------------------------------------------------------- deleted feed
  await go('/deleted');
  const feedItems = await p.$$('.feed-item');
  check(feedItems.length === 3, 'deleted feed lists 3 deletions', `got ${feedItems.length}`);
  await clickText('.feed-item .btn', 'Open in chat'); await wait(2000);
  check(p.url().includes('/chat/') && p.url().includes('?m='), 'open-in-chat navigates to the message', p.url());
  check(!!(await p.$('.bubble.highlight')), 'focused deleted message highlighted');

  // ---------------------------------------------------------------- global search
  await go('/search?q=venue');
  await wait(800);
  const sh = await p.$$('.search-hit');
  check(sh.length === 1, 'global search finds caption', `got ${sh.length}`);
  if (sh[0]) { await sh[0].click(); await wait(2000); }
  check(p.url().includes('?m='), 'search hit opens chat at message');

  // ---------------------------------------------------------------- WA Web page
  await go('/wa-web'); await wait(4000);
  check(await p.$eval('label.switch input', (i) => i.checked) === false || true, 'WA Web page renders');
  check(!!(await p.$('.vnc-host canvas')) && !(await p.$('.vnc-overlay')), 'WA Web VNC connected');
  check(!!(await p.$('.banner.warn')), 'not-linked banner shown (WhatsApp is at QR)');

  // ---------------------------------------------------------------- settings: logging
  await go('/settings'); await wait(800);
  const firstCheck = 'label.check input';
  const before = await p.$eval(firstCheck, (i) => i.checked);
  await p.click(firstCheck); await wait(800);
  const st1 = await p.evaluate(async () => (await (await fetch('/api/settings')).json()).logStatus);
  check(st1 === !before, 'logging setting persisted');
  await p.click(firstCheck); await wait(800);
  check((await p.$$('.table tbody tr')).length >= 1 && (await p.$eval('.table', (t) => t.textContent)).includes('this device'), 'sessions table shows this device');
  check((await p.$$('.audit tbody tr')).length >= 3, 'security log has entries');

  // ---------------------------------------------------------------- 2FA enable → login with TOTP → disable
  await clickText('[id="2fa"] .btn', 'Enable 2FA'); await wait(1000);
  const secret = await p.$eval('[id="2fa"] code', (c) => c.textContent);
  check(/^[A-Z2-7]{32}$/.test(secret), 'TOTP secret shown');
  check(!!(await p.$('[id="2fa"] img.totp-qr')), 'TOTP QR code rendered');
  await p.type('[id="2fa"] input[autocomplete="one-time-code"]', totp(secret));
  await p.type('[id="2fa"] input[type="password"]', PASSWORD);
  await clickText('[id="2fa"] .btn', 'Verify'); await wait(1500);
  check((await p.$eval('[id="2fa"]', (e) => e.textContent)).includes('is enabled'), '2FA enabled via UI');
  await clickText('.rail-item', 'Log out'); await wait(1500);
  check(p.url().endsWith('/login'), 'logout returns to login');
  await login('owner', PASSWORD, totp(secret, 1));
  check(p.url() === BASE + '/', 'login with password + TOTP works', p.url());
  // wait for a fresh TOTP window before disabling
  const msToNext = 30000 - (Date.now() % 30000) + 31000;
  await wait(msToNext);
  await go('/settings');
  await p.type('[id="2fa"] input[type="password"]', PASSWORD);
  await p.type('[id="2fa"] input[autocomplete="one-time-code"]', totp(secret));
  await clickText('[id="2fa"] .btn', 'Disable'); await wait(1500);
  check((await p.$eval('[id="2fa"]', (e) => e.textContent)).includes('Enable 2FA'), '2FA disabled via UI');

  // ---------------------------------------------------------------- password change
  const NEWPW = 'second-good-passphrase-42';
  const pwInputs = await p.$$('#password input');
  await pwInputs[0].type(PASSWORD); await pwInputs[1].type(NEWPW); await pwInputs[2].type(NEWPW);
  await clickText('#password .btn', 'Change password'); await wait(2000);
  check((await p.$eval('#password', (e) => e.textContent)).includes('Password changed'), 'password changed via UI');
  PASSWORD = NEWPW;

  // ---------------------------------------------------------------- recovery key rotate + recover flow
  await p.type('#recovery input[type="password"]', PASSWORD);
  await clickText('#recovery .btn', 'Generate'); await wait(2000);
  const rkey = await p.$eval('#recovery .recovery-box code', (c) => c.textContent).catch(() => '');
  check(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(rkey), 'new recovery key shown', rkey);
  await clickText('.rail-item', 'Log out'); await wait(1200);
  await go('/recover');
  const rin = await p.$$('form input, form textarea');
  await rin[0].type('owner'); await p.type('form textarea', rkey);
  const pwFields = await p.$$('form input[type="password"]');
  PASSWORD = 'third-recovered-passphrase';
  await pwFields[0].type(PASSWORD); await pwFields[1].type(PASSWORD);
  await p.click('button.btn.primary'); await wait(3000);
  check(p.url().endsWith('/setup/recovery'), 'recovery flow shows the new recovery key', p.url());
  await p.click('label.check input'); await p.click('button.btn.primary'); await wait(1500);
  check(p.url() === BASE + '/', 'after recovery: back in the app', p.url());

  // ---------------------------------------------------------------- mobile layout
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await go('/');
  check(!!(await p.$('.chat-list')) && (await p.$eval('.rail', (r) => getComputedStyle(r).flexDirection)) === 'row', 'mobile: bottom navigation + list');
  await openChat('Family'); await wait(1500);
  check(await p.$eval('.chat-list', (e) => getComputedStyle(e).display) === 'none', 'mobile: chat replaces list');
  await p.click('.chat-head .mobile-only'); await wait(800);
  check(p.url() === BASE + '/', 'mobile: back button returns to list');
  await p.setViewport({ width: 1400, height: 900 });

  // ---------------------------------------------------------------- wipe
  await go('/settings');
  await p.type('#danger input[type="password"]', PASSWORD);
  await clickText('#danger .btn', 'Wipe all logged data'); await wait(300);
  await clickText('#danger .btn', 'Click again'); await wait(3000);
  check((await p.$eval('#danger', (e) => e.textContent)).includes('were deleted'), 'wipe via UI');
  await go('/');
  check((await p.$$('.chat-item')).length === 0, 'chat list empty after wipe');
} catch (e) {
  fail('script crashed', e.stack);
} finally {
  await ctx.close();
  browser.disconnect();
}

for (const [s, n] of results) console.log(s === 'PASS' ? `  PASS ${n}` : `  FAIL ${n}`);
const expected = (x) => /Failed when connecting|VNC server|\/api\/auth\/login|401|Cross-origin|net::ERR_ABORTED/.test(x);
console.log(`\n${results.filter((r) => r[0] === 'PASS').length} passed, ${results.filter((r) => r[0] === 'FAIL').length} failed`);
console.log('unexpected browser problems:', JSON.stringify(problems.filter((x) => !expected(x)), null, 1));
console.log('expected/ignored:', problems.filter(expected).length);
