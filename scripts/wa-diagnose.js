// wa_logger health check for a RUNNING instance — run on the Docker host:
//
//   docker compose exec -T app node - < scripts/wa-diagnose.js
//
// Prints aggregates only (never message content, names or numbers). Use it when WhatsApp Web changes break
// something (history import, names, media): it shows which assumptions in docs/wwebjs-notes.md still hold.
/* eslint-disable */
'use strict';
const dns = require('dns').promises;
const Database = require('/app/node_modules/better-sqlite3');
const puppeteer = require('/app/node_modules/puppeteer');

function section(t) {
  console.log(`\n== ${t}`);
}

async function browserChecks() {
  const host = process.env.CHROMIUM_HOST || 'chromium';
  const port = process.env.CDP_PORT || '9223';
  const { address } = await dns.lookup(host, { family: 4 });
  const browser = await puppeteer.connect({ browserURL: `http://${address}:${port}`, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const wa = pages.find((p) => p.url().startsWith('https://web.whatsapp.com'));
    console.log(`tabs: ${pages.length}, WhatsApp tab: ${wa ? 'yes' : 'NO'}`);
    if (!wa) return;
    const r = await wa.evaluate(async () => {
      const w = window;
      const out = { version: w.Debug && w.Debug.VERSION, wwebjs: typeof w.WWebJS };
      let C;
      try {
        C = w.require('WAWebCollections');
      } catch (e) {
        out.collectionsError = String(e && e.message);
        return out;
      }
      const chats = C.Chat.getModelsArray();
      out.chats = chats.length;
      out.chatServers = {};
      for (const c of chats) {
        const s = (c.id && c.id.server) || '?';
        out.chatServers[s] = (out.chatServers[s] || 0) + 1;
      }
      // Do whatsapp-web.js' chat helpers work again? (If yes, pageapi.ts could be simplified.)
      let ok = 0;
      let fail = 0;
      for (const c of chats.slice(0, 20)) {
        try {
          await w.WWebJS.getChatModel(c);
          ok++;
        } catch (e) {
          fail++;
        }
      }
      out.wwebjsGetChatModel = `${ok} ok / ${fail} failed (first 20 chats)`;
      // Does mapper.msgKey()'s rebuild rule still match WhatsApp's own MsgKey.toString()?
      let match = 0;
      let total = 0;
      let hasSerialized = 0;
      const stages = {};
      for (const c of chats) {
        for (const m of c.msgs.getModelsArray()) {
          total++;
          let k;
          try {
            k = w.WWebJS.getMessageModel(m).id;
          } catch (e) {
            continue;
          }
          if (typeof k._serialized === 'string') hasSerialized++;
          const part = k.participant ? (typeof k.participant === 'string' ? k.participant : k.participant._serialized) : null;
          const built = `${k.fromMe}_${k.remote}_${k.id}${part ? `_${part}` : ''}${k.self ? `_${k.self}` : ''}`;
          if (built === String(m.id)) match++;
          if (m.mediaData) stages[m.mediaData.mediaStage] = (stages[m.mediaData.mediaStage] || 0) + 1;
        }
      }
      out.loadedMessages = total;
      out.msgKeyRebuildMatches = `${match}/${total}`;
      out.keysWithSerialized = hasSerialized;
      out.mediaStagesInMemory = stages;
      out.modules = {};
      for (const name of ['WAWebDownloadManager', 'WAWebChatLoadMessages', 'WAWebLidMigrationUtils', 'WAWebContactProfilePicThumbBridge', 'WAWebSocketModel']) {
        try {
          out.modules[name] = !!w.require(name);
        } catch (e) {
          out.modules[name] = false;
        }
      }
      return out;
    });
    for (const [k, v] of Object.entries(r)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  } finally {
    await browser.disconnect();
  }
}

function dbChecks() {
  const db = new Database('/data/wa_logger.db', { readonly: true, fileMustExist: true });
  const all = (q, ...a) => db.prepare(q).all(...a);
  const one = (q, ...a) => db.prepare(q).get(...a);
  console.log('owner:', one('select count(*) n from owner').n ? 'yes' : 'NO');
  console.log('app_state:', all('select key from app_state').map((r) => r.key).join(', '));
  console.log('chats by kind:', JSON.stringify(all('select kind, count(*) n from chats group by kind')));
  console.log('messages:', JSON.stringify(one("select count(*) n, sum(source='live') live, sum(source='history') history, sum(deleted_at is not null) deleted from messages")));
  console.log('messages without full key (should be 0):', one("select count(*) n from messages where instr(id, '_') = 0").n);
  console.log('by type:', all('select type, count(*) n from messages group by type order by n desc').map((r) => `${r.type}:${r.n}`).join(' '));
  console.log('media status:', all("select media_status s, count(*) n from messages where media_status != 'none' group by s").map((r) => `${r.s}:${r.n}`).join(' '));
  console.log('pending media by attempts:', JSON.stringify(all("select media_attempts a, count(*) n from messages where media_status = 'pending' group by a")));
  console.log('contacts:', JSON.stringify(one('select count(*) n, sum(name_enc is not null) named, sum(pushname_enc is not null) pushname, sum(phone_enc is not null) phone from contacts')));
  console.log('stored media files:', one('select count(*) n, coalesce(sum(size),0) bytes from media').n, '| avatars:', one('select count(*) n from chats where avatar_media_id is not null').n);
  console.log('last audit events:', all('select event from audit_log order by id desc limit 8').map((r) => r.event).join(', '));
}

(async () => {
  section('database');
  try {
    dbChecks();
  } catch (e) {
    console.log('db check failed:', e.message);
  }
  section('whatsapp web (live browser)');
  try {
    await browserChecks();
  } catch (e) {
    console.log('browser check failed:', e.message);
  }
})();
