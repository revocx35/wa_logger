// The call video path inside the real Chromium image: callpage.ts' virtual camera and renderer tap, installed by the
// real CallBridge, against a fake "WhatsApp" built the way WhatsApp Web works (its renderer registry receives the
// other side's H.264 frames through onVideoFrameWasmToJs; its camera comes from getUserMedia). Frames are real
// WebCodecs output (H.264 and VP8) made in a second page that plays the owner's browser. Checks colours end to end.
// Needs the same container as call-audio.mts (scripts/dev/README.md).
//
//   cd server && npx tsx ../scripts/dev/call-video.mts
import http from 'node:http';
import { CallBridge } from '../../server/src/wa/callbridge.ts';
import { connectManagedChromium } from './managed-chromium.mts';

const PAGE_PORT = 18778;
const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end('<!doctype html><title>t</title><body></body>'));
await new Promise<void>((r) => server.listen(PAGE_PORT, '127.0.0.1', () => r()));

const results: string[] = [];
const check = (cond: unknown, name: string) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In the "owner's browser" page: encode `n` frames of a solid colour; returns header+data frames (base64), as the
// web client's CallVideo sends them.
const ENCODE = (codec: 'vp8' | 'h264', color: string, n: number, w: number, h: number, rot: number, raw: boolean) => `(async () => {
  const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
  const g = c.getContext('2d');
  const out = [];
  const enc = new VideoEncoder({ output: (chunk) => {
    const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
    if (${raw}) { out.push({ key: chunk.type === 'key', ts: chunk.timestamp, b64: btoa(String.fromCharCode(...d)) }); return; }
    const b = new Uint8Array(12 + d.length); const dv = new DataView(b.buffer);
    b[0] = ${codec === 'h264' ? 1 : 2}; b[1] = chunk.type === 'key' ? 1 : 0; b[2] = ${rot};
    dv.setUint16(4, ${w}, true); dv.setUint16(6, ${h}, true); dv.setUint32(8, Math.floor(chunk.timestamp / 1000), true); b.set(d, 12);
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    out.push(btoa(s));
  }, error: (e) => { throw e; } });
  enc.configure(${codec === 'h264' ? `{ codec: 'avc1.42001f', avc: { format: 'annexb' }, width: ${w}, height: ${h}, bitrate: 500000, framerate: 15 }` : `{ codec: 'vp8', width: ${w}, height: ${h}, bitrate: 500000, framerate: 15 }`});
  for (let i = 0; i < ${n}; i++) {
    g.fillStyle = '${color}'; g.fillRect(0, 0, ${w}, ${h});
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, ${w} / 4, ${h} / 4); // a white corner shows the rotation
    const f = new VideoFrame(c, { timestamp: i * 66666 });
    enc.encode(f, { keyFrame: i === 0 }); f.close();
  }
  await enc.flush();
  return out;
})()`;

// In the "WhatsApp" page: a fake module registry with the renderer registry and media enums callpage.ts uses.
const FAKE_WA = `(() => {
  const registry = { got: 0, onVideoFrameWasmToJs() { this.got++; } };
  const mods = {
    WAWebVoipVideoRendererRegistry: { videoRendererRegistry: registry },
    WAWebVoipMediaEnums: { Orientation: { Normal: 1, Rotate90: 2, Rotate180: 3, Rotate270: 4 }, WAWebVoipVideoFormat: { NV12: 0, I420: 1, RGBA: 3, H264: 100 } },
  };
  window.require = (n) => { if (n in mods) return mods[n]; throw new Error('no ' + n); };
  window.__registry = registry;
  window.__peer = { isSelf: () => false, isScreenShare: () => false };
  return true;
})()`;

/** Average colour of a canvas region in a page; `region` 'center' or 'topleft'. */
const SAMPLE = (expr: string, region: 'center' | 'topleft') => `(() => {
  const src = ${expr}; const w = src.videoWidth || src.width; const h = src.videoHeight || src.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(src, 0, 0);
  const x = ${region === 'center' ? 'Math.floor(w / 2) - 4' : '4'}, y = ${region === 'center' ? 'Math.floor(h / 2) - 4' : '4'};
  const d = g.getImageData(x, y, 8, 8).data; let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  return { w, h, r: Math.round(r / 64), g: Math.round(gg / 64), b: Math.round(b / 64) };
})()`;

const browser = await connectManagedChromium({ protocolTimeout: 30_000 });
for (const pg of await browser.pages()) if (pg.url().includes(`:${PAGE_PORT}`)) await pg.close(); // leftovers of an aborted run
try {
  const owner = await browser.newPage(); // plays the owner's browser (encoder/decoder)
  await owner.goto(`http://localhost:${PAGE_PORT}/`);
  // tsx wraps named functions inside evaluate() callbacks with __name (scripts/dev/README.md)
  await owner.evaluate('window.__name = (f) => f');
  const wa = await browser.newPage();
  const fromPeer: Buffer[] = [];
  let needKeys = 0;
  const bridge = new CallBridge(wa, { event: () => undefined, audio: () => undefined, video: (f) => fromPeer.push(f), needKey: () => needKeys++ });
  await wa.goto(`http://localhost:${PAGE_PORT}/`);
  await bridge.attach();
  await wa.evaluate(FAKE_WA);
  await wa.evaluate('window.__name = (f) => f');
  await bridge.call('setVideoBridge', { on: true });

  // 1. The other side → us: H.264 access units (raw Annex B, no header) handed to the renderer registry.
  const peer = (await owner.evaluate(ENCODE('h264', '#ff0000', 15, 320, 240, 0, true))) as { key: boolean; ts: number; b64: string }[];
  for (const f of peer) {
    await wa.evaluate(
      (b64: string, key: boolean, ts: number) => {
        const u8 = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        (window as any).__registry.onVideoFrameWasmToJs((window as any).__peer, u8, 320, 240, 2 /* Rotate90 */, 100, ts / 1000, key);
      },
      f.b64,
      f.key,
      f.ts,
    );
  }
  await wait(300);
  check(fromPeer.length === peer.length && (await wa.evaluate(() => (window as any).__registry.got)) === peer.length, `peer frames reach the app and WhatsApp's renderer (${fromPeer.length}/${peer.length})`);
  check(fromPeer[0]?.[0] === 1 && fromPeer[0]?.[1] === 1 && fromPeer[0]?.[2] === 1 && fromPeer[0]?.readUInt16LE(4) === 320, 'header: H.264, key frame, a quarter turn, 320 wide');
  // the owner's browser decodes them like CallVideo does
  const decoded = (await owner.evaluate(
    async (frames: string[]) => {
      const c = document.createElement('canvas');
      (window as any).__dec = c;
      let n = 0;
      const dec = new VideoDecoder({
        output: (f) => {
          c.width = f.displayWidth;
          c.height = f.displayHeight;
          c.getContext('2d')!.drawImage(f, 0, 0);
          f.close();
          n++;
        },
        error: () => undefined,
      });
      dec.configure({ codec: 'avc1.42001f', optimizeForLatency: true });
      for (const b64 of frames) {
        const b = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        dec.decode(new EncodedVideoChunk({ type: b[1] ? 'key' : 'delta', timestamp: new DataView(b.buffer).getUint32(8, true) * 1000, data: b.subarray(12) }));
      }
      await dec.flush();
      return n;
    },
    fromPeer.map((f) => f.toString('base64')),
  )) as number;
  const peerColor = (await owner.evaluate(SAMPLE('window.__dec', 'center'))) as { r: number; g: number; b: number };
  check(decoded === peer.length && peerColor.r > 200 && peerColor.g < 60 && peerColor.b < 60, `the owner's browser decodes the peer's video (${decoded} frames, centre rgb ${peerColor.r},${peerColor.g},${peerColor.b})`);

  // 2. Us → the other side: VP8 from the owner's browser, a quarter turn, into WhatsApp's getUserMedia camera.
  await wa.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = s;
    document.body.appendChild(v);
    await Promise.race([v.play(), new Promise((r) => setTimeout(r, 3000))]);
    (window as any).__cam = v;
    (window as any).__camTracks = s.getTracks().map((t) => t.kind + ':' + t.label);
  });
  const mine = (await owner.evaluate(ENCODE('vp8', '#0000ff', 10, 320, 240, 1, false))) as string[];
  bridge.videoIn(Buffer.from(mine[1]!, 'base64')); // a delta frame first: the page asks for a key frame
  await wait(300);
  check(needKeys >= 1, 'a delta frame before any key frame makes the page ask for a key frame');
  for (const b64 of mine) {
    bridge.videoIn(Buffer.from(b64, 'base64'));
    await wait(66);
  }
  await wait(500);
  const cam = (await wa.evaluate(SAMPLE('window.__cam', 'center'))) as { w: number; h: number; r: number; g: number; b: number };
  const corner = (await wa.evaluate(SAMPLE('window.__cam', 'topleft'))) as { r: number; g: number; b: number };
  const tracks = (await wa.evaluate(() => (window as any).__camTracks)) as string[];
  check(tracks.includes('video:wa_logger camera (your device)') && tracks.some((t) => t.startsWith('audio:')), 'WhatsApp gets the virtual camera (and microphone)');
  check(cam.b > 200 && cam.r < 60, `WhatsApp's camera shows the owner's video (centre rgb ${cam.r},${cam.g},${cam.b})`);
  // rotated a quarter turn clockwise: 240x320, the white corner moved from the top left to the top right
  check(cam.w === 240 && cam.h === 320 && corner.b > 200 && corner.r < 60, `rotation applied (${cam.w}x${cam.h}, top-left now blue)`);
  const diag = (await bridge.call<any>('diag', {})).video;
  check(diag.videoInFrames >= mine.length - 1 && diag.registry === true, `diagnostics count the frames (${JSON.stringify(diag)})`);

  // 3. Bridge off: nothing crosses.
  await bridge.call('setVideoBridge', { on: false });
  const before = fromPeer.length;
  await wa.evaluate((b64: string) => (window as any).__registry.onVideoFrameWasmToJs((window as any).__peer, Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), 320, 240, 1, 100, 1, true), peer[0]!.b64);
  await wait(200);
  check(fromPeer.length === before, 'nothing crosses once the video bridge is off');
  await bridge.detach();
  await wa.close();
  await owner.close();
} catch (e) {
  results.push(`FAIL exception: ${(e as Error).message}`);
} finally {
  await browser.disconnect();
  server.close();
  server.closeAllConnections();
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
