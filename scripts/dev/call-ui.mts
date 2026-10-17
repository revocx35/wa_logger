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
  peerBusy: false, failedReason: null, logResult: null, everConnected: false, userEnded: false, removed: false, ...over,
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
const fakeBridge = {
  async call(op: string, a: any) {
    ops.push(op);
    if (op === 'setBridge') bridging = a.on;
    if (op === 'reject') later(100, () => calls.onCall(raw({ id: a.callId, state: 0, removed: true, logResult: 3, userEnded: true })));
    if (op === 'hangup') later(100, () => calls.onCall(raw({ id: a.callId, state: 13, everConnected: true, userEnded: true, outgoing: a.callId.startsWith('OUT') })));
    return true;
  },
  async gesture(op: string, a: any) {
    ops.push(op);
    if (op === 'start') {
      const id = `OUT${ops.length}`;
      later(600, () => calls.onCall(raw({ id, state: 2, outgoing: true })));
      later(2500, () => calls.onCall(raw({ id, state: 6, outgoing: true, everConnected: true })));
      return raw({ id, state: 1, outgoing: true, peer: a.chatId });
    }
    if (op === 'accept') {
      calls.onCall(raw({ id: a.callId, state: 4 }));
      later(500, () => calls.onCall(raw({ id: a.callId, state: 6, everConnected: true })));
    }
    return true;
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
await h.app.listen({ port: PORT, host: '127.0.0.1' });
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
