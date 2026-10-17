// Calls end-to-end in a real browser: the real server (in-process test harness, built web UI) with the real
// CallService and audio WebSocket, and a fake WhatsApp tab whose call models behave like WhatsApp Web's (states,
// ends) and whose "other side" speaks a 440 Hz tone. Drives the web UI through a test browser started with
// --use-fake-device-for-media-stream --use-fake-ui-for-media-stream (scripts/dev/README.md): the fake microphone's
// beeps must arrive at the "WhatsApp" side, and the tone must be audible in the page.
//
//   (cd web && npm run build); cd server && npx tsx ../scripts/dev/call-ui.mts
//
// Test data only; nothing here is real.
import puppeteer from '../../server/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { NullWa, type WaController } from '../../server/src/context.ts';
import { makeHarness, PASSWORD, SETUP_TOKEN } from '../../server/src/testutil/harness.ts';
import type { CallBridge, RawCall } from '../../server/src/wa/callbridge.ts';
import { CallService } from '../../server/src/wa/calls.ts';
import { Ingest } from '../../server/src/wa/ingest.ts';

const PORT = 18094;
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = '905551110001@c.us';
const ME = '905550000001@c.us';
const WEB_DIR = new URL('../../web/dist', import.meta.url).pathname;

const ops: string[] = [];
const raw = (over: Partial<RawCall>): RawCall => ({
  id: 'C1', state: 3, outgoing: false, isVideo: false, isGroup: false, peer: CHAT, peerAlt: null, group: null,
  peerBusy: false, failedReason: null, logResult: null, everConnected: false, userEnded: false, selfVideo: false, peerVideo: false, removed: false, ...over,
});

/** The WhatsApp tab, simulated: call models change state like WhatsApp Web's, the other side speaks a tone. */
let calls: CallService;
let bridging = false;
let micBytes = 0;
let micPeak = 0;
let phase = 0;
const later = (ms: number, f: () => void) => setTimeout(f, ms);
setInterval(() => {
  if (!bridging) return;
  const b = Buffer.alloc(1280); // 40 ms
  for (let i = 0; i < 640; i++) {
    b.writeInt16LE(Math.round(Math.sin(phase) * 8000), i * 2);
    phase += (2 * Math.PI * 440) / 16000;
  }
  calls.onPageAudio(b);
}, 40);
// Video: the other side "sends" pre-encoded VP8 frames (made in the test browser) while the video bridge is on.
let videoOn = false;
let peerFrames: Buffer[] = [];
let peerIdx = 0;
const ownerFrames: Buffer[] = [];
setInterval(() => {
  if (!videoOn || !peerFrames.length) return;
  calls.onPageVideo(peerFrames[peerIdx++ % peerFrames.length]!);
}, 66);
const fakeBridge = {
  async call(op: string, a: any) {
    ops.push(op);
    if (op === 'setBridge') bridging = a.on;
    if (op === 'setVideoBridge') videoOn = a.on;
    if (op === 'keyframe') peerIdx = 0;
    if (op === 'reject') later(100, () => calls.onCall(raw({ id: a.callId, state: 0, removed: true, logResult: 3, userEnded: true })));
    if (op === 'hangup') later(100, () => calls.onCall(raw({ id: a.callId, state: 13, everConnected: true, userEnded: true, outgoing: a.callId.startsWith('OUT') })));
    return true;
  },
  async gesture(op: string, a: any) {
    ops.push(op);
    if (op === 'start') {
      const id = `OUT${ops.length}`;
      const v = { isVideo: !!a.video, selfVideo: !!a.video };
      later(600, () => calls.onCall(raw({ id, state: 2, outgoing: true, ...v })));
      later(2500, () => calls.onCall(raw({ id, state: 6, outgoing: true, everConnected: true, ...v, peerVideo: !!a.video })));
      return raw({ id, state: 1, outgoing: true, peer: a.chatId, ...v });
    }
    if (op === 'accept') {
      const cur = calls.current();
      const v = { isVideo: !!cur?.video, selfVideo: !!a.video, peerVideo: !!cur?.video };
      calls.onCall(raw({ id: a.callId, state: 4, ...v }));
      later(500, () => calls.onCall(raw({ id: a.callId, state: 6, everConnected: true, ...v })));
    }
    if (op === 'setVideo') {
      const cur = calls.current()!;
      return raw({ id: a.callId, state: 6, everConnected: true, outgoing: cur.direction === 'outgoing', isVideo: true, selfVideo: a.on, peerVideo: cur.peerVideo });
    }
    return true;
  },
  videoIn(frame: Buffer) {
    ownerFrames.push(frame);
  },
  audioIn(pcm: Buffer) {
    micBytes += pcm.length;
    for (let i = 0; i + 1 < pcm.length; i += 2) micPeak = Math.max(micPeak, Math.abs(pcm.readInt16LE(i)));
  },
};

class FakeWa extends NullWa {
  override readonly calls: CallService;
  constructor(ctx: ConstructorParameters<typeof CallService>[0]) {
    super();
    this.calls = calls = new CallService(ctx, () => fakeBridge as unknown as CallBridge);
  }
  override status() {
    return { state: 'ready' as const, mediaQueue: 0, since: Date.now(), sync: null };
  }
}

const h = await makeHarness({ COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '', TRUST_PROXY: '0', WEB_DIR }, { wa: (ctx) => new FakeWa(ctx) as WaController });
// SERVE=1: only run the server (e.g. for the Android emulator at http://10.0.2.2:18094). Commands on stdin:
// "incoming" (a call rings), "hangup" (the other side ends the current call); stats are printed every second.
await h.app.listen({ port: PORT, host: process.env.SERVE ? '0.0.0.0' : '127.0.0.1' });
const ingest = new Ingest(
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
const t = Math.floor(Date.now() / 1000);
await ingest.message({ id: { fromMe: false, remote: CHAT, id: 'IN1', _serialized: `false_${CHAT}_IN1` }, type: 'chat', body: 'Selam', t: t - 60, from: CHAT, ack: 1 }, 'live');

if (process.env.SERVE) {
  console.log(`serving on :${PORT}, owner / ${PASSWORD}`);
  // With the test browser running (CDP 127.0.0.1:9333), the other side "sends" H.264 video (red, white top-left
  // corner, 320x240) like WhatsApp Web does, and "check" decodes what the client's camera sent.
  let helper: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.connect>>['newPage']>> | null = null;
  try {
    const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', protocolTimeout: 30_000 });
    helper = await b.newPage();
    await helper.goto(`${BASE}/login`);
    await helper.evaluate('window.__name = (f) => f');
    const frames = (await helper.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); const out = [];
      const enc = new VideoEncoder({ output: (ch) => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d);
        const b = new Uint8Array(12 + d.length); const dv = new DataView(b.buffer); b[0] = 1; b[1] = ch.type === 'key' ? 1 : 0;
        dv.setUint16(4, 320, true); dv.setUint16(6, 240, true); dv.setUint32(8, Math.floor(ch.timestamp / 1000), true); b.set(d, 12);
        let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); out.push(btoa(s)); }, error: () => undefined });
      enc.configure({ codec: 'avc1.42001f', avc: { format: 'annexb' }, width: 320, height: 240, bitrate: 300000, framerate: 15 });
      for (let i = 0; i < 30; i++) { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 80, 60);
        const f = new VideoFrame(c, { timestamp: i * 66666 }); enc.encode(f, { keyFrame: i % 15 === 0 }); f.close(); }
      await enc.flush(); return out; })()`)) as string[];
    peerFrames = frames.map((x) => Buffer.from(x, 'base64'));
    console.log(`peer video: ${peerFrames.length} H.264 frames`);
  } catch (e) {
    console.log(`no test browser, no peer video (${(e as Error).message})`);
  }
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d: string) => {
    for (const cmd of d.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const cur = calls.current();
      if (cmd === 'incoming') calls.onCall(raw({ id: `SIN${++n}` }));
      else if (cmd === 'incomingvideo') calls.onCall(raw({ id: `SVIN${++n}`, isVideo: true, peerVideo: true }));
      else if (cmd === 'hangup' && cur) calls.onCall(raw({ id: cur.id, state: 0, removed: true, everConnected: true, outgoing: cur.direction === 'outgoing' }));
      else if (cmd === 'check' && helper) {
        const last = ownerFrames.slice(-40);
        const head = last[0];
        void helper
          .evaluate(
            async (frames: string[]) => {
              const c = document.createElement('canvas');
              let n = 0;
              let size = '';
              const first = Uint8Array.from(atob(frames[0]!), (ch) => ch.charCodeAt(0));
              const dec = new VideoDecoder({
                output: (f) => {
                  c.width = f.displayWidth;
                  c.height = f.displayHeight;
                  c.getContext('2d')!.drawImage(f, 0, 0);
                  size = `${f.displayWidth}x${f.displayHeight}`;
                  f.close();
                  n++;
                },
                error: (e) => (size = 'error ' + e.message),
              });
              dec.configure({ codec: first[0] === 1 ? 'avc1.42001f' : 'vp8' });
              let started = false;
              for (const b64 of frames) {
                const b = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
                if (!started && !b[1]) continue;
                started = true;
                dec.decode(new EncodedVideoChunk({ type: b[1] ? 'key' : 'delta', timestamp: new DataView(b.buffer).getUint32(8, true) * 1000, data: b.subarray(12) }));
              }
              await dec.flush().catch(() => undefined);
              const d = n ? c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data : [];
              let sum = 0;
              for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
              // the last picture turned upright as its header says (what WhatsApp's camera shows)
              const rot = first[2]! & 3;
              const o = document.createElement('canvas');
              o.width = rot % 2 ? c.height : c.width;
              o.height = rot % 2 ? c.width : c.height;
              const og = o.getContext('2d')!;
              og.translate(o.width / 2, o.height / 2);
              og.rotate((Math.PI / 2) * rot);
              og.drawImage(c, -c.width / 2, -c.height / 2);
              return { decoded: n, size, meanLuma: d.length ? Math.round(sum / (d.length / 4) / 3) : 0, png: n ? o.toDataURL('image/png') : null };
            },
            last.map((f) => f.toString('base64')),
          )
          .then(async (r) => {
            if (r.png && process.env.CHECK_PNG) await import('node:fs').then((fs) => fs.writeFileSync(process.env.CHECK_PNG!, Buffer.from(r.png!.split(',')[1]!, 'base64')));
            console.log(`CHECK camera frames=${ownerFrames.length} codec=${head?.[0]} rot=${head?.[2]} ${head?.readUInt16LE(4)}x${head?.readUInt16LE(6)} -> ${JSON.stringify({ ...r, png: !!r.png })}`);
          })
          .catch((e) => console.log(`CHECK failed ${(e as Error).message}`));
      }
    }
  });
  setInterval(() => {
    const c = calls.current();
    console.log(
      `call=${c ? `${c.id}:${c.state}:audio=${c.audio}:video=${c.videoClient}:self=${c.selfVideo}` : 'none'} bridging=${bridging} video=${videoOn} micBytes=${micBytes} cameraFrames=${ownerFrames.length} ops=${ops.join(',')}`,
    );
  }, 1000);
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
// Measures what the call worklet plays: every AudioWorkletNode connected to the speakers also feeds an analyser.
await p.evaluateOnNewDocument(() => {
  const w = window as any;
  w.__peak = 0;
  w.__wsBinary = 0;
  const connect = AudioNode.prototype.connect as any;
  (AudioNode.prototype as any).connect = function (this: AudioNode, dest: any, ...rest: any[]) {
    const r = connect.call(this, dest, ...rest);
    if (this instanceof AudioWorkletNode && dest instanceof AudioDestinationNode) {
      const an = this.context.createAnalyser();
      connect.call(this, an);
      const buf = new Float32Array(an.fftSize);
      setInterval(() => {
        an.getFloatTimeDomainData(buf);
        for (const v of buf) w.__peak = Math.max(w.__peak, Math.abs(v));
      }, 50);
    }
    return r;
  };
  const Orig = WebSocket;
  w.WebSocket = class extends Orig {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (e) => typeof e.data !== 'string' && w.__wsBinary++);
    }
  };
});
const until = async (fn: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(150);
  }
  return false;
};
const panelText = () => p.$eval('.call-panel', (e) => e.textContent ?? '').catch(() => '');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await p.type('input[autocomplete="username"], input[name="username"]', 'owner');
  await p.type('input[type="password"]', PASSWORD);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.chat-item', { timeout: 15000 });
  await p.click('.chat-item');
  await p.waitForSelector('.chat-head button[aria-label="Voice call"]');
  check(await until(async () => p.$eval('.chat-head button[aria-label="Voice call"]', (b) => !(b as HTMLButtonElement).disabled)), 'call button enabled in a one-to-one chat');

  // Outgoing call.
  await p.click('.chat-head button[aria-label="Voice call"]');
  check(await until(async () => (await panelText()).includes('Calling') || (await panelText()).includes('Ringing')), 'outgoing: "Calling…" panel');
  check(await until(async () => (await panelText()).includes('Ringing')), 'outgoing: "Ringing…" when the other phone rings');
  check(await until(async () => /Ali Veli\d:\d\d/.test(await panelText()), 6000), 'outgoing: connected, timer running');
  check(await until(async () => micBytes > 16000 && micPeak > 1000), `microphone audio reaches WhatsApp (${micBytes} bytes, peak ${micPeak})`);
  check(await until(async () => (await p.evaluate(() => (window as any).__peak)) > 0.1), 'the other side is audible in the page');
  // Mute stops the microphone.
  await p.click('.call-panel button[aria-label="Mute"]');
  await wait(300);
  const before = micBytes;
  await wait(800);
  check(micBytes === before, 'muted: no microphone audio sent');
  await p.click('.call-panel button[aria-label="Unmute"]');
  check(await until(async () => micBytes > before), 'unmuted: microphone audio again');
  // Hang up.
  await p.click('.call-panel button[aria-label="Hang up"]');
  check(await until(async () => (await panelText()).includes('Call ended')), 'hang up: "Call ended" with the duration');
  check(await until(async () => !bridging), 'audio bridge switched off');
  check(await until(async () => !(await p.$('.call-panel')), 7000), 'panel goes away');

  // Incoming call, answered.
  calls.onCall(raw({ id: 'IN1' }));
  check(await until(async () => (await panelText()).includes('Incoming voice call')), 'incoming: ringing panel with Answer/Decline');
  check(await until(async () => (await p.title()).startsWith('📞')), 'incoming: tab title shows the call');
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/call-incoming.png` });
  await p.click('.call-panel button[aria-label="Answer"]');
  check(await until(async () => /\d:\d\d/.test(await panelText())), 'incoming: answered, timer running');
  const m0 = micBytes;
  check(await until(async () => micBytes > m0 + 16000), 'incoming: microphone audio reaches WhatsApp');
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/call-active.png` });
  // The other side hangs up.
  calls.onCall(raw({ id: 'IN1', state: 0, removed: true, everConnected: true }));
  check(await until(async () => (await panelText()).includes('Call ended')), 'remote hang-up ends the call');

  // Incoming call, declined; then one answered on the phone.
  await until(async () => !(await p.$('.call-panel')), 7000);
  calls.onCall(raw({ id: 'IN2' }));
  await p.waitForSelector('.call-panel button[aria-label="Decline"]');
  await p.click('.call-panel button[aria-label="Decline"]');
  check(await until(async () => (await panelText()).includes('Declined')), 'declined');
  await until(async () => !(await p.$('.call-panel')), 7000);
  calls.onCall(raw({ id: 'IN3' }));
  await p.waitForSelector('.call-panel button[aria-label="Answer"]');
  calls.onCall(raw({ id: 'IN3', state: 7 }));
  check(await until(async () => (await panelText()).includes('Answered on another device')), 'answered on another device');

  // Reload during a call: the panel comes back and offers to join the audio.
  await until(async () => !(await p.$('.call-panel')), 7000);
  calls.onCall(raw({ id: 'IN4' }));
  await p.waitForSelector('.call-panel button[aria-label="Answer"]');
  await p.click('.call-panel button[aria-label="Answer"]');
  await until(async () => /\d:\d\d/.test(await panelText()));
  await p.reload({ waitUntil: 'domcontentloaded' });
  check(await until(async () => (await panelText()).includes('Join audio')), 'after a reload: "Join audio"');
  await p.click('.call-panel .call-note button');
  const m1 = micBytes;
  check(await until(async () => micBytes > m1 + 8000), 'joined audio after the reload');
  await p.setViewport({ width: 390, height: 800 });
  await wait(300);
  const w = await p.$eval('.call-panel', (e) => e.getBoundingClientRect().width);
  check(w <= 390 - 16, 'call panel fits a phone screen');
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/call-phone.png` });
  await p.click('.call-panel button[aria-label="Hang up"]');
  check(await until(async () => (await panelText()).includes('Call ended')), 'hung up');
  await until(async () => !(await p.$('.call-panel')), 7000);
  await p.setViewport({ width: 1300, height: 850 });

  /* ---------------------------------------------------------------------------------------------- video */
  // The other side's video: 30 frames of red with a key frame every 15, encoded as VP8 in a helper page.
  const helper = await bctx.newPage();
  await helper.goto(`${BASE}/login`);
  await helper.evaluate('window.__name = (f) => f'); // tsx's helper for named functions inside evaluate()
  const encoded = (await helper.evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); const out = [];
    const enc = new VideoEncoder({ output: (ch) => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d);
      const b = new Uint8Array(12 + d.length); const dv = new DataView(b.buffer); b[0] = 2; b[1] = ch.type === 'key' ? 1 : 0;
      dv.setUint16(4, 320, true); dv.setUint16(6, 240, true); dv.setUint32(8, Math.floor(ch.timestamp / 1000), true); b.set(d, 12);
      let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); out.push(btoa(s)); }, error: () => undefined });
    enc.configure({ codec: 'vp8', width: 320, height: 240, bitrate: 300000, framerate: 15 });
    for (let i = 0; i < 30; i++) { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 320, 240); const f = new VideoFrame(c, { timestamp: i * 66666 }); enc.encode(f, { keyFrame: i % 15 === 0 }); f.close(); }
    await enc.flush(); return out; })()`)) as string[];
  peerFrames = encoded.map((b64) => Buffer.from(b64, 'base64'));
  const remoteColor = () =>
    p.evaluate(() => {
      const c = document.querySelector('canvas.call-remote') as HTMLCanvasElement | null;
      if (!c || c.classList.contains('hidden') || !c.width) return null;
      const d = c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    });

  // Outgoing video call.
  await p.bringToFront();
  await p.click('.chat-head button[aria-label="Video call"]');
  check(await until(async () => !!(await p.$('.call-stage'))), 'video call: the call screen opens');
  check(await until(async () => (await p.$eval('.call-preview', (v) => (v as HTMLVideoElement).videoWidth).catch(() => 0)) > 0), 'video call: own camera preview');
  check(await until(async () => {
    const col = await remoteColor();
    return !!col && col[0]! > 200 && col[1]! < 60;
  }, 10000), 'video call: the other side’s video is shown');
  check(await until(async () => ownerFrames.length > 10), `video call: the camera’s frames reach WhatsApp (${ownerFrames.length})`);
  const ownerDecoded = (await helper.evaluate(
    async (frames: string[]) => {
      let n = 0;
      const codec = Uint8Array.from(atob(frames[0]!), (ch) => ch.charCodeAt(0))[0] === 1 ? 'avc1.42001f' : 'vp8';
      const dec = new VideoDecoder({ output: (f) => (n++, f.close()), error: () => undefined });
      dec.configure({ codec });
      let started = false;
      for (const b64 of frames) {
        const b = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        if (!started && !b[1]) continue;
        started = true;
        dec.decode(new EncodedVideoChunk({ type: b[1] ? 'key' : 'delta', timestamp: new DataView(b.buffer).getUint32(8, true) * 1000, data: b.subarray(12) }));
      }
      await dec.flush();
      return n;
    },
    ownerFrames.slice(0, 20).map((f) => f.toString('base64')),
  )) as number;
  check(ownerDecoded > 5, `video call: the camera’s frames decode (${ownerDecoded})`);
  // Camera off and on again.
  await p.click('.call-stage button[aria-label="Turn camera off"]');
  check(await until(async () => !(await p.$('.call-preview'))), 'camera off: preview gone');
  const sentBefore = ownerFrames.length;
  await wait(800);
  check(ownerFrames.length - sentBefore < 3, 'camera off: no frames sent');
  check(ops.includes('setVideo'), 'camera off: WhatsApp told');
  await p.click('.call-stage button[aria-label="Turn camera on"]');
  check(await until(async () => ownerFrames.length > sentBefore + 5), 'camera on again: frames flow');
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/video-call.png` });
  // Minimize to the panel and back.
  await p.click('.call-stage button[aria-label="Minimize"]');
  check(await until(async () => !(await p.$('.call-stage')) && !!(await p.$('.call-panel button[aria-label="Show video"]'))), 'minimized to the call panel');
  await p.click('.call-panel button[aria-label="Show video"]');
  check(await until(async () => !!(await p.$('.call-stage'))), 'back to the video screen');
  await p.click('.call-stage button[aria-label="Hang up"]');
  check(await until(async () => !(await p.$('.call-stage'))), 'video call hung up');
  check(await until(async () => !videoOn), 'video bridge switched off');
  await until(async () => !(await p.$('.call-panel')), 7000);

  // Incoming video call, answered with video.
  calls.onCall(raw({ id: 'VIN1', isVideo: true, peerVideo: true }));
  check(await until(async () => (await panelText()).includes('Incoming video call')), 'incoming video call rings');
  await p.click('.call-panel button[aria-label="Answer with video"]');
  check(await until(async () => !!(await p.$('.call-stage'))), 'answered with video: the call screen opens');
  check(await until(async () => {
    const col = await remoteColor();
    return !!col && col[0]! > 200;
  }, 10000), 'answered with video: the other side is shown');
  if (process.env.SHOT) {
    await p.setViewport({ width: 390, height: 800 });
    await wait(500);
    await p.screenshot({ path: `${process.env.SHOT}/video-call-phone.png` });
  }
  calls.onCall(raw({ id: 'VIN1', state: 0, removed: true, everConnected: true }));
  check(await until(async () => !(await p.$('.call-stage'))), 'the other side hung up: the call screen closes');
  await helper.close();
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
