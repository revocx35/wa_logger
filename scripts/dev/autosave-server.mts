// Media end-to-end (Android auto-save / multi-select, web "Download ZIP"): a real wa_logger server (in-process
// test harness, no WhatsApp) that the emulator reaches at http://10.0.2.2:18091 (the web UI is served too when
// web/dist exists), plus a local control endpoint that simulates "a photo arrived and finished downloading"
// through the real ingest code and media storage.
//
//   (cd web && npm run build); cd server && npx tsx ../scripts/dev/autosave-server.mts
//   curl 'http://127.0.0.1:18092/inject?kind=plain'       # normal chat
//   curl 'http://127.0.0.1:18092/inject?kind=disappearing' # chat with disappearing messages (7 days)
//
// Owner login: "owner" / the harness PASSWORD (printed at start). Test data only; nothing here is real.
import fs from 'node:fs/promises';
import http from 'node:http';
import { makeHarness, PASSWORD, SETUP_TOKEN } from '../../server/src/testutil/harness.ts';
import { Ingest } from '../../server/src/wa/ingest.ts';
import { beginMediaFile, finishMediaFile } from '../../server/src/wa/media.ts';

const PORT = 18091;
const CONTROL = 18092;
const JPEG = process.env.JPEG ?? '/opt/android-sdk/emulator/resources/default.jpg';

// No PUBLIC_ORIGIN: Origin checks fall back to the Host header, like the owner's deployment.
const WEB_DIR = new URL('../../web/dist', import.meta.url).pathname;
const web = await fs.stat(WEB_DIR).then(() => ({ WEB_DIR }), () => ({}));
const h = await makeHarness({ COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '', TRUST_PROXY: '0', ...web });
await h.app.listen({ port: PORT, host: '0.0.0.0' });

const signup = await fetch(`http://127.0.0.1:${PORT}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` },
  body: JSON.stringify({ setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD }),
});
if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
h.ctx.repo.setState('onboarding_complete', '1');

const PLAIN = '905551110001@c.us';
const EPH = '905551110002@c.us';
const ingest = new Ingest(h.ctx, {
  getChat: async (id) => ({ name: id === PLAIN ? 'Plain chat' : 'Disappearing chat', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: null, pushname: 'test', isMe: false, isBusiness: false }),
}, { enqueue: () => undefined });

let n = 0;
async function inject(kind: string): Promise<string> {
  const chat = kind === 'disappearing' ? EPH : PLAIN;
  const key = `IMG${++n}`;
  const id = `false_${chat}_${key}`;
  await ingest.message({
    id: { fromMe: false, remote: chat, id: key, _serialized: id },
    type: 'image', body: '', caption: `photo ${n}`, t: Math.floor(Date.now() / 1000), from: chat,
    directPath: '/x', mimetype: 'image/jpeg', size: 1000,
    ...(kind === 'disappearing' ? { ephemeralDuration: 604800 } : {}),
  }, 'live');
  // What the media queue does after a successful download.
  const f = await beginMediaFile(h.ctx);
  await f.writer.write(await fs.readFile(JPEG));
  const { mediaId, size } = await finishMediaFile(h.ctx, f, 'message', 'image/jpeg', null);
  h.ctx.repo.updateMessage(id, { media_id: mediaId, media_status: 'downloaded', media_size: size });
  h.ctx.events.emit({ type: 'message_update', chatId: chat, messageId: id, reason: 'media' });
  return `${id} media ${mediaId}`;
}

http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname !== '/inject') return void res.writeHead(404).end();
  inject(u.searchParams.get('kind') ?? 'plain').then(
    (r) => res.end(`${r}\n`),
    (e) => res.writeHead(500).end(String(e)),
  );
}).listen(CONTROL, '127.0.0.1');

console.log(`wa_logger on :${PORT} (emulator: http://10.0.2.2:${PORT}), owner / ${PASSWORD}; control on 127.0.0.1:${CONTROL}`);
