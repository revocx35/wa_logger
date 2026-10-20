/*
 * End-to-end check of multi-user wa_logger against a running stack (docker compose), including what only a real
 * deployment can show: unix users, file permissions, one Chromium per user, the extra port.
 *
 *   cd server && BASE=http://127.0.0.1:18090 EXTRA_PORT=18101 SETUP_TOKEN=… ADMIN_PASSWORD=… \
 *     PROJECT=walmulti npx tsx ../scripts/dev/multiuser-e2e.mts
 *
 * Needs the stack up with EXTRA_PORTS covering EXTRA_PORT (published on 127.0.0.1). Creates the users e2e_friend and
 * e2e_other and deletes them again.
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import WebSocket from '../../server/node_modules/ws/wrapper.mjs';
import { Browser } from '../../server/src/testutil/browser.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18090';
const EXTRA = Number(process.env.EXTRA_PORT ?? 18101);
const EXTRA2 = EXTRA + 1;
const PROJECT = process.env.PROJECT ?? 'walmulti';
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? 'correct-horse-battery-staple-1';
const SETUP = process.env.SETUP_TOKEN ?? '';
const host = new URL(BASE).hostname;
const mainPort = Number(new URL(BASE).port);
const APP = `${PROJECT}-app-1`;
const CHROMIUM = `${PROJECT}-chromium-1`;

let failed = 0;
const check = (ok: boolean, what: string, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : extra ? ` — ${extra}` : ''}`);
  if (!ok) failed++;
};
const sh = (container: string, cmd: string, user?: string): string => {
  try {
    return execFileSync('docker', ['exec', ...(user ? ['-u', user] : []), container, 'sh', '-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || 'ERR';
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitWa(b: Browser, port: number, states: string[], what: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const s = await b.state({ port });
    if (s?.wa && states.includes(s.wa.state)) return s.wa.state;
    await sleep(1500);
  }
  check(false, what, 'timed out');
  return '';
}

async function vncBanner(b: Browser, port: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${port}/api/vnc`, { headers: { origin: `http://${host}:${port}`, cookie: b.cookieHeader() } });
    const t = setTimeout(() => resolve('timeout'), 10_000);
    ws.on('message', (d: Buffer) => {
      clearTimeout(t);
      resolve(d.toString().slice(0, 11));
      ws.terminate();
    });
    ws.on('unexpected-response', (_r, res) => {
      clearTimeout(t);
      resolve(`HTTP ${res.statusCode}`);
    });
    ws.on('error', () => undefined);
  });
}

async function main() {
  const admin = new Browser(mainPort);
  const st0 = await admin.state();
  if (!st0.hasOwner) {
    const r = await admin.req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'admin', password: ADMIN_PW });
    check(r.status === 200, 'admin signup', JSON.stringify(r.body));
  } else {
    const r = await admin.req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
    check(r.status === 200, 'admin login', JSON.stringify(r.body));
  }
  const st = await admin.state();
  check(st.role === 'admin', 'first account is the admin');

  // Clean leftovers of an earlier run.
  const ov0 = (await admin.req('GET', '/api/admin/overview')).body;
  for (const u of ov0.users.filter((x: { username: string }) => x.username.startsWith('e2e_'))) {
    await admin.req('POST', `/api/admin/users/${u.id}/delete`, { adminPassword: ADMIN_PW });
  }

  check((await admin.req('PUT', `/api/admin/ports/${EXTRA}`, { origin: null })).status === 200, `port ${EXTRA} opened`);
  check((await admin.req('PUT', `/api/admin/ports/${EXTRA2}`, { origin: null })).status === 200, `port ${EXTRA2} opened`);
  const mk = await admin.req('POST', '/api/admin/users', { username: 'e2e_friend', port: EXTRA });
  check(mk.status === 200 && !!mk.body.temporaryPassword, 'friend created on the extra port', JSON.stringify(mk.body));
  const temp: string = mk.body.temporaryPassword;
  const mk2 = await admin.req('POST', '/api/admin/users', { username: 'e2e_other', port: EXTRA2 });
  const temp2: string = mk2.body.temporaryPassword;

  const friend = new Browser(EXTRA);
  const wrongPort = await friend.req('POST', '/api/auth/login', { username: 'e2e_friend', password: temp }, { port: mainPort, origin: `http://${host}:${mainPort}` });
  check(wrongPort.status === 401, 'friend cannot sign in on the default port');
  const l = await friend.req('POST', '/api/auth/login', { username: 'e2e_friend', password: temp });
  check(l.body?.mustChangePassword === true, 'first sign-in asks for a new password');
  const c = await friend.req('POST', '/api/auth/claim', { username: 'e2e_friend', password: temp, newPassword: 'my-own-passphrase-9876' });
  check(c.status === 200 && !!c.body.recoveryKey, 'friend sets their own password');
  const other = new Browser(EXTRA2);
  await other.req('POST', '/api/auth/claim', { username: 'e2e_other', password: temp2, newPassword: 'another-own-passphrase-123' });

  const adminHere = new Browser(EXTRA);
  const a = await adminHere.req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check(a.status === 401, 'the admin cannot sign in on the friend\'s port');
  const forged = new Browser(EXTRA);
  forged.jar = new Map(admin.jar);
  check((await forged.req('GET', '/api/admin/overview')).status === 401, 'the admin\'s cookie is useless on the friend\'s port');

  // Every user has their own WhatsApp (own Chromium): all reach the QR code.
  await Promise.all([waitWa(admin, mainPort, ['qr', 'ready'], 'admin WhatsApp'), waitWa(friend, EXTRA, ['qr', 'ready'], 'friend WhatsApp'), waitWa(other, EXTRA2, ['qr', 'ready'], 'other WhatsApp')]);
  const s1 = await friend.state({ port: EXTRA });
  check(s1.wa?.state === 'qr' || s1.wa?.state === 'ready', 'friend gets their own QR code', JSON.stringify(s1.wa));
  check((await vncBanner(admin, mainPort)).startsWith('RFB 003.00'), 'admin sees their own live screen (VNC)');
  check((await vncBanner(friend, EXTRA)).startsWith('RFB 003.00'), 'friend sees their own live screen (VNC)');
  check((await vncBanner(forged, EXTRA)).startsWith('HTTP 401'), 'no live screen with a cookie of another port');

  // Cross-account attempts with a forged tenant cookie.
  const ids = (await admin.req('GET', '/api/admin/overview')).body.users as { id: number; username: string }[];
  const friendId = ids.find((u) => u.username === 'e2e_friend')!.id;
  const fr = new Browser(EXTRA);
  fr.jar = new Map(friend.jar);
  fr.jar.set('wal_tenant', '1');
  check((await fr.req('GET', '/api/chats')).status === 401, 'friend\'s session cannot be pointed at the admin\'s worker');

  // Processes and files: one unix user per account, nothing readable across.
  const procs = sh(APP, 'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null); c=$(tr "\\0" " " < $p/cmdline 2>/dev/null | cut -c1-90); echo "$u $c"; done | grep "dist/" | sort -u');
  console.log(procs.split('\n').map((x) => `       ${x}`).join('\n'));
  const uids = new Set(procs.split('\n').filter((x) => x.includes('dist/index.js')).map((x) => x.split(' ')[0]));
  check(uids.size === 3, 'three workers run as three different unix users', [...uids].join(','));
  check(procs.includes('10003 ') && procs.includes('dist/front.js'), 'the gateway runs as its own unix user (10003)');
  const friendUid = 10100 + friendId;
  check(/Permission denied|ERR/.test(sh(APP, `ls /data /users/${friendId}`, `${friendUid}:${friendUid}`).split('\n').find((x) => x.includes('/data')) ?? 'ERR'), 'a friend-uid process cannot read the admin\'s data');
  check(/Permission denied/.test(sh(APP, `ls /run/wal/w/1`, `${friendUid}:${friendUid}`)), 'a friend-uid process cannot reach the admin worker\'s socket directory');
  check(/Permission denied/.test(sh(APP, `ls /run/wal/ctl`, `${friendUid}:${friendUid}`)), 'a friend-uid process cannot reach the supervisor');
  const caps = sh(APP, 'for p in /proc/[0-9]*; do n=$(tr "\\0" " " < $p/cmdline | cut -c1-90); c=$(awk \'/^CapEff:/{print $2}\' $p/status); echo "$c $n"; done | grep "dist/" | sort -u');
  check(!/dist\/(index|front)\.js/.test(caps.split('\n').filter((x) => !x.startsWith('0000000000000000')).join('\n')), 'workers and gateway hold no capabilities', caps);
  const chromes = sh(CHROMIUM, 'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null); c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in *user-data-dir=*) case "$c" in *type=*) ;; *) echo "$u $(echo $c | tr " " "\\n" | grep user-data-dir)";; esac;; esac; done');
  console.log(chromes.split('\n').map((x) => `       ${x}`).join('\n'));
  check(new Set(chromes.split('\n').map((x) => x.split(' ')[0])).size === 3, 'three Chromium browsers under three unix users');
  check(!sh(CHROMIUM, 'ps -eo args 2>/dev/null || cat /proc/*/cmdline | tr "\\0" " "').includes('--no-sandbox'), 'Chromium sandbox is on');
  check(/Permission denied/.test(sh(CHROMIUM, `ls /data/profile`, `${friendUid}:${friendUid}`)), 'the friend\'s browser user cannot read the admin\'s WhatsApp session');

  // Deleting a user removes everything.
  const del = await admin.req('POST', `/api/admin/users/${friendId}/delete`, { adminPassword: ADMIN_PW });
  check(del.status === 200, 'friend deleted', JSON.stringify(del.body));
  await sleep(2000);
  check(sh(APP, `ls /users`).split('\n').every((x) => x !== String(friendId)), 'the friend\'s data directory is gone');
  check(sh(CHROMIUM, 'ls /data').split('\n').every((x) => x !== `u${friendId}`), 'the friend\'s browser profile is gone');
  check(!sh(CHROMIUM, 'cat /proc/*/cmdline | tr "\\0" " "').includes(`/data/u${friendId}/`), 'the friend\'s browser is stopped');
  check((await friend.req('GET', '/api/chats')).status === 401, 'the friend\'s session is gone');
  const otherId = ids.find((u) => u.username === 'e2e_other')!.id;
  await admin.req('POST', `/api/admin/users/${otherId}/delete`, { adminPassword: ADMIN_PW });
  await admin.req('DELETE', `/api/admin/ports/${EXTRA}`);
  await admin.req('DELETE', `/api/admin/ports/${EXTRA2}`);
  const closed = await new Promise<boolean>((res) => net.connect(EXTRA, host).once('connect', () => res(false)).once('error', () => res(true)));
  void closed; // Caddy still publishes the port; the app no longer answers it (502)

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

void main();
