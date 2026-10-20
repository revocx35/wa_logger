// The call audio path inside the real Chromium image: callpage.ts' virtual microphone and speaker tap, installed by
// the real CallBridge (CDP bindings, 40 ms pump, trusted-click gesture), against a fake "WhatsApp" audio graph built
// the way WhatsApp Web builds its own (getUserMedia → 16 kHz capture context; a worklet at 48 kHz → a
// MediaStreamDestination + <audio>, or straight to AudioContext.destination), in the tab and in a popout window.
// Needs the wa_logger chromium image running its own entrypoint (no sound devices, sandbox on, managed policy with
// "localhost" added to URLAllowlist) with the manager on 127.0.0.1:19223 — see scripts/dev/README.md.
//
//   cd server && npx tsx ../scripts/dev/call-audio.mts
import http from 'node:http';
import { CallBridge } from '../../server/src/wa/callbridge.ts';
import { connectManagedChromium } from './managed-chromium.mts';

const PAGE_PORT = 18777;
const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>t</title><body></body>'));
await new Promise<void>((r) => server.listen(PAGE_PORT, '127.0.0.1', () => r()));

const results: string[] = [];
const check = (cond: unknown, name: string) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dominant frequency (zero crossings) and RMS of the non-silent part. */
function analyse(x0: number[], rate: number) {
  let a = 0;
  let b = x0.length;
  while (a < b && Math.abs(x0[a]!) < 0.01) a++;
  while (b > a && Math.abs(x0[b - 1]!) < 0.01) b--;
  const x = x0.slice(a, b);
  let rms = 0;
  let zc = 0;
  for (let i = 0; i < x.length; i++) {
    rms += x[i]! * x[i]!;
    if (i && (x[i - 1]! < 0) !== (x[i]! < 0)) zc++;
  }
  return { rms: Math.sqrt(rms / (x.length || 1)), hz: Math.round(zc / 2 / (x.length / rate || 1)) };
}

// The fake WhatsApp graph, built in window W (the tab or a popout). Stored on the tab as __fake.
const BUILD = (route: string, popout: boolean) => `(async () => {
  const W = ${popout ? "window.open('', 'callpopout', 'width=400,height=300')" : 'window'};
  window.require = () => { throw new Error('no WhatsApp here'); };
  const f = window.__fake = { W, cap: [] };
  f.perm = (await W.navigator.permissions.query({ name: 'microphone' })).state;
  f.devices = (await W.navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label);
  const stream = await W.navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: 'wa-logger-mic' }, echoCancellation: true } });
  const cctx = new W.AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  const rec = cctx.createScriptProcessor(1024, 1, 1);
  rec.onaudioprocess = (e) => { f.cap.push(Array.from(e.inputBuffer.getChannelData(0))); if (f.cap.length > 40) f.cap.shift(); };
  cctx.createMediaStreamSource(stream).connect(rec);
  rec.connect(cctx.destination);
  const pctx = new W.AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const code = "registerProcessor('pass', class extends AudioWorkletProcessor { process(i, o) { const a = i[0][0], b = o[0][0]; if (a && b) b.set(a); return true; } })";
  await pctx.audioWorklet.addModule(W.URL.createObjectURL(new W.Blob([code], { type: 'text/javascript' })));
  const node = new W.AudioWorkletNode(pctx, 'pass', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const osc = pctx.createOscillator();
  osc.frequency.value = 1000;
  const g = pctx.createGain();
  g.gain.value = 0.5;
  osc.connect(g);
  g.connect(node);
  if ('${route}' === 'element') {
    const msd = pctx.createMediaStreamDestination();
    node.connect(msd);
    const el = W.document.createElement('audio');
    el.srcObject = msd.stream;
    W.document.body.appendChild(el);
    el.play().catch(() => undefined);
  } else node.connect(pctx.destination);
  osc.start();
  f.ctxs = [cctx, pctx];
  return true;
})()`;

const browser = await connectManagedChromium();
try {
  for (const [route, popout] of [
    ['element', false],
    ['direct', false],
    ['element', true],
  ] as const) {
    const label = `${popout ? 'popout' : 'tab'}, ${route === 'element' ? '<audio> output' : 'AudioContext output'}`;
    const page = await browser.newPage();
    const out: Buffer[] = [];
    const bridge = new CallBridge(page, { event: () => undefined, audio: (pcm) => out.push(pcm) });
    await page.goto(`http://localhost:${PAGE_PORT}/`);
    await bridge.attach();
    await page.evaluate(BUILD(route, popout));
    const f = await page.evaluate(() => ({ perm: (window as any).__fake.perm, devices: (window as any).__fake.devices }));
    check(f.perm === 'granted' && f.devices.join() === 'wa_logger (your browser)', `${label}: WhatsApp sees only the virtual microphone, permission granted`);
    await bridge.gesture('setBridge', { on: true }, 10_000);
    // 2.4 s of a 440 Hz tone in 40 ms packets, paced in real time, through the bridge's pump
    let ph = 0;
    const t0 = Date.now();
    for (let k = 0; k < 60; k++) {
      const b = Buffer.alloc(1280);
      for (let i = 0; i < 640; i++) {
        b.writeInt16LE(Math.round(Math.sin(ph) * 12000), i * 2);
        ph += (2 * Math.PI * 440) / 16000;
      }
      bridge.audioIn(b);
      await wait(Math.max(0, t0 + (k + 1) * 40 - Date.now()));
    }
    await wait(300);
    const cap = (await page.evaluate(() => (window as any).__fake.cap.flat())) as number[];
    const mic = analyse(cap, 16000);
    check(Math.abs(mic.hz - 440) <= 5 && mic.rms > 0.2, `${label}: WhatsApp hears the owner (440 Hz → ${mic.hz} Hz, rms ${mic.rms.toFixed(2)})`);
    const pcm = Buffer.concat(out);
    const s: number[] = [];
    for (let i = 0; i + 1 < pcm.length; i += 2) s.push(pcm.readInt16LE(i) / 32768);
    const spk = analyse(s.slice(-16000), 16000);
    check(Math.abs(spk.hz - 1000) <= 5 && spk.rms > 0.3, `${label}: the other side reaches the app at 16 kHz (1000 Hz → ${spk.hz} Hz, rms ${spk.rms.toFixed(2)})`);
    await bridge.call('setBridge', { on: false });
    const n = out.length;
    await wait(500);
    check(out.length === n, `${label}: nothing crosses once the bridge is off`);
    await page.evaluate(() => (window as any).__fake.W !== window && (window as any).__fake.W.close());
    await bridge.detach();
    await page.close();
  }
} catch (e) {
  results.push(`FAIL exception: ${(e as Error).message}`);
} finally {
  await browser.disconnect();
  server.close();
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
