/**
 * Dev-only: fills a wa_logger database with realistic sample data through the real ingest code
 * (so everything is encrypted exactly like production). Requires an existing owner.
 *   DATA_DIR=... SETUP_TOKEN=... VNC_PASSWORD=... npx tsx src/testutil/seed.ts
 * Not part of the production build.
 */
import zlib from 'node:zlib';
import { loadConfig } from '../config.js';
import { AppContext } from '../context.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { EventBus } from '../events.js';
import { createLogger } from '../log.js';
import { SettingsStore } from '../settings.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import type { RawMsg } from '../wa/mapper.js';
import { beginMediaFile, finishMediaFile } from '../wa/media.js';

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const shade = ((x ^ y) & 32) ? 1 : 0.8;
      raw[o] = rgb[0] * shade;
      raw[o + 1] = rgb[1] * shade;
      raw[o + 2] = rgb[2] * shade;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ME = '905550000001@c.us';
const ALI = '905551112233@c.us';
const ZEYNEP = '905554445566@c.us';
const MERT = '905557778899@c.us';
const GROUP = '120363025555555555@g.us';
const NAMES: Record<string, string> = { [ALI]: 'Ali Yılmaz', [ZEYNEP]: 'Zeynep Kaya', [MERT]: 'Mert Demir', [GROUP]: 'Family 👨‍👩‍👧' };

async function main() {
  const config = loadConfig();
  const log = createLogger('warn');
  const repo = new Repo(openDb(config.dbPath));
  if (!repo.hasOwner()) throw new Error('Sign up first');
  const ctx = new AppContext(config, log, repo, new EventBus(), new SettingsStore(repo, config.defaults));
  repo.setState('wa_me', ME);
  const api: WaApi = {
    getChat: async (id) => ({ name: NAMES[id] ?? null, timestamp: null, archived: false, pinned: id === GROUP, muted: false }),
    getContact: async (id) => ({ name: NAMES[id] ?? null, pushname: (NAMES[id] ?? 'someone').split(' ')[0]!.toLowerCase(), isMe: id === ME, isBusiness: false }),
  };
  const ingest = new Ingest(ctx, api, { enqueue: () => undefined });
  await ingest.ensureContact(ME, 'me', true);

  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const id = (remote: string, fromMe: boolean, participant?: string) => {
    const mid = `3EB0${(++n).toString(16).padStart(16, '0').toUpperCase()}`;
    return { fromMe, remote, id: mid, participant, _serialized: `${fromMe}_${remote}_${mid}${participant ? `_${participant}` : ''}` };
  };
  const msg = (remote: string, from: string | null, t: number, over: RawMsg): RawMsg => {
    const fromMe = from === null;
    const isGroup = remote.endsWith('@g.us');
    return {
      id: id(remote, fromMe, isGroup && !fromMe ? from! : undefined),
      type: 'chat',
      t,
      from: fromMe ? ME : isGroup ? remote : from,
      to: fromMe ? remote : ME,
      author: isGroup && !fromMe ? from : undefined,
      ack: fromMe ? 3 : 1,
      ...over,
    };
  };

  async function attachMedia(raw: RawMsg, data: Buffer, mime: string, filename: string | null) {
    const mid = await ingest.message({ ...raw, directPath: '/v/seed' }, 'live');
    const f = await beginMediaFile(ctx);
    await f.writer.write(data);
    const { mediaId, size } = await finishMediaFile(ctx, f, 'message', mime, filename);
    repo.updateMessage(mid!, { media_id: mediaId, media_status: 'downloaded', media_size: size });
    return mid!;
  }

  // ---- 1:1 chat with Ali
  const t0 = now - 3 * 86400;
  await ingest.message(msg(ALI, ALI, t0, { body: 'Hey! Are we still on for *Saturday*? 🎉', notifyName: 'ali' }), 'live');
  const q = msg(ALI, null, t0 + 60, { body: 'Yes! _Looking forward to it_ — see https://example.com/plan_v2 for the plan' });
  await ingest.message(q, 'live');
  await ingest.message(
    msg(ALI, ALI, t0 + 120, { body: 'Perfect 👍', quotedMsg: { type: 'chat', body: q.body }, quotedStanzaID: q.id.id, quotedParticipant: ME }),
    'live',
  );
  const del = msg(ALI, ALI, t0 + 180, { body: 'Actually I told Zeynep your secret 🙈 (oops)' });
  await ingest.message(del, 'live');
  await ingest.revoke({ ...del, type: 'revoked', subtype: 'sender', body: '' }, null);
  const ed = msg(ALI, ALI, now - 86400, { body: 'Meet at 7pm' });
  await ingest.message(ed, 'live');
  await ingest.edit({ ...ed, body: 'Meet at 8pm instead', latestEditMsgKey: { _serialized: 'EDIT1' } }, 'Meet at 8pm instead', 'Meet at 7pm');
  await attachMedia(msg(ALI, ALI, now - 86000, { type: 'image', caption: 'The venue 📍', mimetype: 'image/png', width: 640, height: 400 }), png(640, 400, [0, 168, 132]), 'image/png', null);
  await ingest.message(msg(ALI, ALI, now - 85000, { type: 'location', lat: 41.0082, lng: 28.9784, loc: 'Sultanahmet Square\nIstanbul' }), 'live');
  await ingest.message(msg(ALI, null, now - 84000, { type: 'ptt', directPath: '/x', duration: '12', size: 24000 }), 'live');
  repo.db.prepare("UPDATE messages SET media_status = 'failed' WHERE type = 'ptt'").run();
  await ingest.message(msg(ALI, ALI, now - 3600, { type: 'image', isViewOnce: true, directPath: '/x' }), 'live');
  const react = msg(ALI, null, now - 1800, { body: '```\nconst plan = "done";\n```\n> quoted line\n- first\n- second' });
  const rid = await ingest.message(react, 'live');
  ingest.reaction({ msgId: { _serialized: rid }, senderId: ALI, reaction: '❤️', timestamp: now - 1700 });

  // ---- Group
  const g0 = now - 2 * 86400;
  await ingest.groupNotification({ id: id(GROUP, false, MERT), type: 'create', body: 'Family 👨‍👩‍👧', timestamp: g0 - 1000, chatId: GROUP, author: MERT, recipientIds: [] });
  await ingest.groupNotification({ id: id(GROUP, false, MERT), type: 'add', body: '', timestamp: g0 - 900, chatId: GROUP, author: MERT, recipientIds: [ZEYNEP, ME] });
  await ingest.message(msg(GROUP, ZEYNEP, g0, { body: 'Who is bringing dessert? 🍰', notifyName: 'zeynep' }), 'live');
  await ingest.message(msg(GROUP, MERT, g0 + 30, { body: 'Me! @905554445566 you bring drinks', mentionedJidList: [ZEYNEP], notifyName: 'mert' }), 'live');
  await ingest.message(msg(GROUP, MERT, g0 + 60, { type: 'poll_creation', pollName: 'Dinner time?', pollOptions: [{ name: '19:00' }, { name: '20:00' }, { name: '21:00' }], pollSelectableOptionsCount: 1 }), 'live');
  await attachMedia(
    msg(GROUP, ZEYNEP, g0 + 90, { type: 'document', filename: 'shopping-list.txt', mimetype: 'text/plain' }),
    Buffer.from('eggs\nmilk\nflour\n'),
    'text/plain',
    'shopping-list.txt',
  );
  await ingest.message(msg(GROUP, ZEYNEP, g0 + 120, { type: 'vcard', body: 'BEGIN:VCARD\nVERSION:3.0\nFN:Baker Shop\nTEL:+90 555 000 00 00\nEND:VCARD' }), 'live');
  const gdel = msg(GROUP, MERT, g0 + 150, { type: 'image', caption: 'Embarrassing photo', mimetype: 'image/png', width: 400, height: 400, isForwarded: true });
  const gdelId = await attachMedia(gdel, png(400, 400, [234, 0, 56]), 'image/png', null);
  await ingest.revoke({ ...gdel, id: { ...gdel.id }, type: 'revoked', subtype: 'admin' }, null);
  void gdelId;
  await ingest.message(msg(GROUP, null, g0 + 200, { body: 'See you all 👋' }), 'live');
  await ingest.message(msg(GROUP, MERT, g0 + 240, { type: 'call_log', isVideoCall: true, callOutcome: 'missed' }), 'live');
  await ingest.revoke({ ...msg(GROUP, ZEYNEP, g0 + 260, {}), type: 'revoked', subtype: 'sender' }, null);

  // ---- Zeynep, lots of history
  for (let i = 0; i < 120; i++) {
    await ingest.message(msg(ZEYNEP, i % 3 ? ZEYNEP : null, now - 5 * 86400 + i * 600, { body: `Message ${i + 1} — ${i % 7 === 0 ? '😂' : 'lorem ipsum dolor sit amet'}`, notifyName: 'zeynep' }), 'history');
  }
  await ingest.message(msg(ZEYNEP, ZEYNEP, now - 60, { type: 'sticker', directPath: '/x', mimetype: 'image/webp' }), 'live');
  repo.db.prepare("UPDATE messages SET media_status = 'pending' WHERE type = 'sticker'").run();

  // ---- status
  await ingest.message({ id: id('status@broadcast', false, MERT), type: 'chat', body: 'At the beach 🏖️', t: now - 7200, author: MERT, isStatusV3: true }, 'live');

  console.log('seeded', repo.listChats().length, 'chats');
  repo.db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
