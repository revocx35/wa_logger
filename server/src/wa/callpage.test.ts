import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { WAL_CALL_SOURCE } from './callpage.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const LID = '123456789012345@lid';
const PN = '905551112233@c.us';

/** Minimal Web Audio + media devices: just the shapes callpage.ts touches. */
function fakeAudio() {
  class AudioNode {
    out: any[] = [];
    constructor(readonly context: any) {}
    connect(dest: any) {
      this.out.push(dest);
      return dest;
    }
    disconnect() {
      this.out = [];
    }
  }
  class AudioDestinationNode extends AudioNode {}
  class Track {
    label = '';
    clone() {
      return new Track();
    }
    getSettings() {
      return { sampleRate: 48000 };
    }
  }
  class MediaStreamAudioDestinationNode extends AudioNode {
    stream = { getAudioTracks: () => [new Track()] };
  }
  class MediaStream {
    constructor(readonly tracks: any[]) {}
    getAudioTracks() {
      return this.tracks;
    }
  }
  const started: number[] = [];
  class AudioContext {
    state = 'running';
    currentTime = 1;
    destination: any;
    processors: any[] = [];
    constructor(readonly opts: any = {}, readonly sampleRate = 48000) {
      this.destination = new AudioDestinationNode(this);
    }
    resume() {
      return Promise.resolve();
    }
    createMediaStreamDestination() {
      return new MediaStreamAudioDestinationNode(this);
    }
    createScriptProcessor() {
      const sp: any = new AudioNode(this);
      this.processors.push(sp);
      return sp;
    }
    createGain() {
      const g: any = new AudioNode(this);
      g.gain = { value: 1 };
      return g;
    }
    createBuffer(_ch: number, n: number, rate: number) {
      const data = new Float32Array(n);
      return { duration: n / rate, getChannelData: () => data };
    }
    createBufferSource() {
      const s: any = new AudioNode(this);
      s.start = (t: number) => started.push(t);
      return s;
    }
  }
  return { AudioNode, AudioDestinationNode, MediaStreamAudioDestinationNode, MediaStream, AudioContext, started, ...fakeVideo() };
}

/** Canvas capture and WebCodecs, faked: decoding yields a 320x240 frame, encoding a 3-byte chunk. */
function fakeVideo() {
  const drawn: { rot: number; w: number; h: number }[] = [];
  const camTracks: any[] = [];
  const decoded: any[] = [];
  class VideoDecoder {
    state = 'unconfigured';
    decodeQueueSize = 0;
    config: any = null;
    constructor(readonly init: any) {}
    configure(c: any) {
      this.config = c;
      this.state = 'configured';
    }
    decode(chunk: any) {
      decoded.push({ codec: this.config.codec, ...chunk });
      this.init.output({ displayWidth: 320, displayHeight: 240, close: () => undefined });
    }
    reset() {}
    close() {
      this.state = 'closed';
    }
  }
  class EncodedVideoChunk {
    constructor(init: any) {
      Object.assign(this, init);
    }
  }
  class VideoEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    constructor(readonly init: any) {}
    configure() {
      this.state = 'configured';
    }
    encode(frame: any, o: any) {
      this.init.output({ type: o.keyFrame ? 'key' : 'delta', byteLength: 3, timestamp: frame.init.timestamp, copyTo: (d: Uint8Array) => d.set([7, 8, 9]) });
    }
    close() {
      this.state = 'closed';
    }
  }
  class VideoFrame {
    constructor(
      readonly data: any,
      readonly init: any,
    ) {}
    close() {}
  }
  const canvas = () => {
    let rot = 0;
    const el: any = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect: () => undefined,
        save: () => (rot = 0),
        restore: () => undefined,
        translate: () => undefined,
        rotate: (r: number) => (rot = Math.round(r / (Math.PI / 2))),
        drawImage: (_f: any, _x: number, _y: number, w: number, h: number) => drawn.push({ rot, w, h }),
      }),
      captureStream: () => {
        const track: any = { kind: 'video', readyState: 'live', frames: 0, label: '', getSettings: () => ({}) };
        track.requestFrame = () => track.frames++;
        camTracks.push(track);
        return { getVideoTracks: () => [track] };
      },
    };
    return el;
  };
  return { VideoDecoder, EncodedVideoChunk, VideoEncoder, VideoFrame, canvas, drawn, camTracks, decoded };
}

/** A fake WhatsApp Web module registry with the call shapes callpage.ts relies on (WhatsApp Web 2.3000.1050x). */
function fakeWhatsApp() {
  const log: { op: string; args: any[] }[] = [];
  const model = (over: any = {}) => {
    let state = over.state ?? 3;
    return {
      id: over.id ?? 'CALL1',
      peerJid: { toString: () => over.peer ?? LID },
      outgoing: !!over.outgoing,
      isGroup: false,
      groupJid: undefined,
      peerBusy: false,
      callFailedReason: undefined,
      callLogResult: undefined,
      wasEverConnected: false,
      userEndedCall: false,
      isVideo: !!over.isVideo,
      selfVideoState: over.selfVideoState ?? 'off',
      peerVideoState: over.peerVideoState ?? 'off',
      getState: () => state,
      setState: (s: number) => (state = s),
    };
  };
  const CC: any = { activeCall: null, models: [] as any[], getModelsArray: () => CC.models };
  let webCalling = true;
  const stackIf = {
    type: 'web',
    acceptCall: async (a: boolean, v: boolean) => log.push({ op: 'acceptCall', args: [a, v] }),
    rejectCall: async () => log.push({ op: 'rejectCall', args: [] }),
    endCall: async (r: number, b: boolean) => log.push({ op: 'endCall', args: [r, b] }),
    requestVideoUpgrade: async () => (log.push({ op: 'upgrade', args: [] }), 0),
    setCallVideoMute: async (m: boolean) => (log.push({ op: 'videoMute', args: [m] }), 0),
    requestKeyFrame: async (w: any, ss: boolean) => (log.push({ op: 'keyframe', args: [String(w), ss] }), 0),
  };
  const rendered: any[][] = [];
  const registry = { onVideoFrameWasmToJs: (...a: any[]) => rendered.push(a) };
  const modules: Record<string, any> = {
    WAWebCallCollection: { default: CC },
    WAWebWidFactory: { createWid: (s: string) => ({ toString: () => s }) },
    WAWebLidMigrationUtils: { toPn: (w: any) => (String(w) === LID ? { toString: () => PN } : null), toLid: () => null },
    WAWebVoipStartCall: {
      startWAWebVoipCall: (...args: any[]) => {
        log.push({ op: 'start', args: [String(args[0]), ...args.slice(1)] });
        const m = model({ id: 'OUT1', outgoing: true, state: 1, peer: String(args[0]) });
        CC.activeCall = m;
        CC.models = [m];
        return new Promise(() => undefined);
      },
    },
    WAWebWamEnumCallFromUi: { CALL_FROM_UI: { CONVERSATION: 8 } },
    WAWebVoipStackInterface: { getVoipStackInterface: async () => stackIf },
    WAWebVoipAcquireMediaStream: { checkVoipDevicePermissions: async (v: boolean) => (log.push({ op: 'perm', args: [v] }), true) },
    WAWebVoipSignalingEnums: { EndCallReason: { Self: 2 } },
    WAWebCallRingtone: { stopCallRingtone: () => log.push({ op: 'ringtone', args: [] }) },
    WAWebABProps: { getABPropConfigValue: (k: string) => (k === 'enable_web_calling' ? webCalling : null) },
    WAWebVoipGatingUtils: { getUnsupportedBrowserReason: () => null },
    WAWebVoipVideoStateUtils: { isVideoStateInactiveForCallMode: (st: any) => st === 'off' },
    WAWebVoipVideoRendererRegistry: { videoRendererRegistry: registry },
    WAWebVoipMediaEnums: {
      Orientation: { Unknown: 0, Normal: 1, Rotate90: 2, Rotate180: 3, Rotate270: 4 },
      WAWebVoipVideoFormat: { NV12: 0, I420: 1, RGB24: 2, RGBA: 3, H264: 100, UNKNOWN: -1 },
    },
  };
  return { log, CC, model, modules, registry, rendered, setWebCalling: (v: boolean) => (webCalling = v) };
}

function setup(extra: Record<string, unknown> = {}) {
  const audio = fakeAudio();
  const wa = fakeWhatsApp();
  const emitted: { name: string; payload: string }[] = [];
  const realGum: any[] = [];
  const intervals: (() => void)[] = [];
  const elements = new Map<string, any>();
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => {
      if (tag === 'canvas') return audio.canvas();
      const el: any = { style: {}, listeners: [] as any[], setAttribute: () => undefined };
      el.addEventListener = (_t: string, f: any) => el.listeners.push(f);
      return el;
    },
    body: { appendChild: (el: any) => elements.set(el.id, el) },
  };
  const window: any = {
    ...audio,
    document,
    setTimeout,
    clearTimeout,
    setInterval: (f: () => void) => {
      intervals.push(f);
      return intervals.length;
    },
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    EventTarget: class {},
    navigator: {
      mediaDevices: {
        getUserMedia: async (c: any) => (realGum.push(c), 'real-stream'),
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'default', label: '' },
          { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
        ],
      },
      permissions: { query: async (d: any) => ({ state: 'prompt', name: d.name }) },
    },
    require: (n: string) => {
      if (!(n in wa.modules)) throw new Error(`Requiring unknown module "${n}"`);
      return wa.modules[n];
    },
    __walCallEvent: (p: string) => emitted.push({ name: 'event', payload: p }),
    __walCallAudio: (p: string) => emitted.push({ name: 'audio', payload: p }),
    __walCallVideo: (p: string) => emitted.push({ name: 'video', payload: p }),
    ...extra,
  };
  window.window = window;
  // A fresh context like a page: only what a browser has (no Node globals), so the injected source must be self-contained.
  const context = vm.createContext(window);
  const result = vm.runInContext(WAL_CALL_SOURCE, context);
  const tick = () => intervals.forEach((f) => f());
  return { window, audio, wa, emitted, realGum, result, tick, elements };
}

describe('callpage.ts (installed into WhatsApp Web)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });
  const call = (op: string, args: any = {}) => t.window.__walcall.call(op, args);
  const events = () => t.emitted.filter((e) => e.name === 'event').map((e) => JSON.parse(e.payload));

  it('installs once and is self-contained', () => {
    expect(t.result).toBe('installed');
    expect(vm.runInContext(WAL_CALL_SOURCE, vm.createContext(t.window))).toBe('already');
  });

  it('gives WhatsApp Web the virtual microphone, and only for audio', async () => {
    const md = t.window.navigator.mediaDevices;
    const s = await md.getUserMedia({ audio: { deviceId: { exact: 'wa-logger-mic' } } });
    const track = s.getAudioTracks()[0];
    expect(track.label).toBe('wa_logger (your browser)');
    expect(track.getSettings()).toMatchObject({ deviceId: 'wa-logger-mic', sampleRate: 48000 });
    expect(t.realGum).toEqual([]);
    // Video requests get the virtual camera (plus the microphone when audio is asked for too).
    const v = await md.getUserMedia({ video: { deviceId: { exact: 'wa-logger-camera' } }, audio: true });
    expect(v.tracks).toHaveLength(2);
    expect(v.tracks.find((x: any) => x.kind === 'video').label).toBe('wa_logger camera (your device)');
    expect(t.realGum).toEqual([]);
    const devices = await md.enumerateDevices();
    expect(devices.map((d: any) => `${d.kind}:${d.deviceId}`)).toEqual(['audioinput:wa-logger-mic', 'videoinput:wa-logger-camera']);
    expect(JSON.parse(JSON.stringify(devices[0]))).toEqual({ deviceId: 'wa-logger-mic', groupId: 'wa-logger-mic', kind: 'audioinput', label: 'wa_logger (your browser)' });
    expect((await t.window.navigator.permissions.query({ name: 'microphone' })).state).toBe('granted');
    expect((await t.window.navigator.permissions.query({ name: 'camera' })).state).toBe('granted');
    expect((await t.window.navigator.permissions.query({ name: 'geolocation' })).state).toBe('prompt');
  });

  it('taps audio connected to an output and sends it at 16 kHz only while bridging', async () => {
    const { AudioContext, AudioNode } = t.audio;
    const ctx = new AudioContext();
    const node = new AudioNode(ctx);
    node.connect(ctx.destination);
    expect(ctx.processors).toHaveLength(1);
    const sp = ctx.processors[0];
    expect(node.out).toEqual([ctx.destination, sp]);
    const buffer = (v: number) => ({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(v) } });

    sp.onaudioprocess(buffer(0.5));
    expect(t.emitted.filter((e) => e.name === 'audio')).toEqual([]);
    expect((await call('setBridge', { on: true })).value).toBe(true);
    sp.onaudioprocess(buffer(0)); // digital silence is not sent
    expect(t.emitted.filter((e) => e.name === 'audio')).toEqual([]);
    sp.onaudioprocess(buffer(0.5));
    const out = t.emitted.filter((e) => e.name === 'audio');
    expect(out).toHaveLength(1);
    const pcm = Buffer.from(out[0]!.payload, 'base64');
    expect(pcm.length).toBe(2 * Math.floor(1024 / 3)); // 48 kHz → 16 kHz
    expect(pcm.readInt16LE(0)).toBe(Math.round(0.5 * 32767));

    // Our own nodes and connections to plain nodes are not tapped; a second output connection is not doubled.
    const other = new AudioNode(ctx);
    other.connect(node);
    node.connect(ctx.destination);
    expect(ctx.processors).toHaveLength(1);
    expect(node.out.filter((d: any) => d === sp)).toHaveLength(1);
  });

  it('hooks windows WhatsApp Web opens (call popout) and hides document picture-in-picture', async () => {
    // another window with its own media devices and Web Audio
    const popAudio = fakeAudio();
    const pop: any = { ...popAudio, navigator: { mediaDevices: { getUserMedia: async () => 'real', enumerateDevices: async () => [] } } };
    const t2 = setup({ open: () => pop, documentPictureInPicture: {} });
    expect('documentPictureInPicture' in t2.window).toBe(false);
    expect(t2.window.open('', 'popout')).toBe(pop);
    const s = await pop.navigator.mediaDevices.getUserMedia({ audio: true });
    expect(s.getAudioTracks()[0].label).toBe('wa_logger (your browser)');
    const ctx = new popAudio.AudioContext();
    new popAudio.AudioNode(ctx).connect(ctx.destination);
    expect(ctx.processors).toHaveLength(1);
  });

  it('feeds the owner’s voice to the virtual microphone only while bridging', async () => {
    const pcm = Buffer.alloc(640);
    expect(t.window.__walcall.audioIn(pcm.toString('base64'))).toBe(0);
    await call('setBridge', { on: true });
    expect(t.window.__walcall.audioIn(pcm.toString('base64'))).toBe(320);
    expect(t.window.__walcall.audioIn(pcm.toString('base64'))).toBe(320);
    // scheduled back to back, ~80 ms ahead of the context clock
    expect(t.audio.started[0]).toBeCloseTo(1.08, 5);
    expect(t.audio.started[1]).toBeCloseTo(1.1, 5);
  });

  it('reports call models and their changes (ids and states only)', () => {
    const m = t.wa.model();
    t.wa.CC.activeCall = m;
    t.tick();
    expect(events()).toEqual([
      {
        id: 'CALL1', state: 3, outgoing: false, isVideo: false, isGroup: false, peer: LID, peerAlt: PN, group: null,
        peerBusy: false, failedReason: null, logResult: null, everConnected: false, userEnded: false, selfVideo: false,
        peerVideo: false, removed: false,
      },
    ]);
    t.tick();
    expect(events()).toHaveLength(1);
    m.setState(6);
    t.tick();
    expect(events()[1]).toMatchObject({ state: 6 });
    t.wa.CC.activeCall = null;
    t.tick();
    expect(events()[2]).toMatchObject({ id: 'CALL1', removed: true });
  });

  it('starts calls with WhatsApp Web’s own function', async () => {
    const r = await call('start', { chatId: PN });
    expect(r).toMatchObject({ ok: true, value: { id: 'OUT1', outgoing: true, state: 1 } });
    expect(t.wa.log).toEqual([{ op: 'start', args: [PN, false, 8, 0, null, { entryTrust: 'user_gesture' }] }]);
    expect(await call('start', { chatId: PN })).toMatchObject({ ok: false, code: 'busy' });
    t.wa.CC.activeCall = null;
    t.wa.setWebCalling(false);
    expect(await call('start', { chatId: PN })).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('answers, declines and hangs up through the VoIP stack', async () => {
    t.wa.CC.activeCall = t.wa.model();
    expect(await call('accept', { callId: 'OTHER' })).toMatchObject({ ok: false, code: 'not_found' });
    expect((await call('accept', { callId: 'CALL1' })).ok).toBe(true);
    expect(t.wa.log.map((l) => l.op)).toEqual(['ringtone', 'perm', 'acceptCall']);
    expect(t.wa.log[2]!.args).toEqual([true, false]); // audio only
    expect((await call('hangup', { callId: 'CALL1' })).ok).toBe(true);
    expect(t.wa.log.at(-1)).toEqual({ op: 'endCall', args: [2, true] });
    expect((await call('reject', { callId: 'CALL1' })).ok).toBe(true);
    expect(t.wa.log.at(-1)).toEqual({ op: 'rejectCall', args: [] });
    expect(t.wa.CC.activeCall.userEndedCall).toBe(true);
  });

  const source = (self: boolean) => ({ isSelf: () => self, isScreenShare: () => false });
  const header = (codec: number, key: boolean, rot: number, w: number, h: number, ts: number, data: number[]) => {
    const b = Buffer.alloc(12 + data.length);
    b[0] = codec;
    b[1] = key ? 1 : 0;
    b[2] = rot;
    b.writeUInt16LE(w, 4);
    b.writeUInt16LE(h, 6);
    b.writeUInt32LE(ts, 8);
    Buffer.from(data).copy(b, 12);
    return b;
  };
  const videoOut = () => t.emitted.filter((e) => e.name === 'video').map((e) => Buffer.from(e.payload, 'base64'));

  it('sends the other side’s H.264 frames as WhatsApp Web hands them to its renderer', async () => {
    const h264 = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
    t.wa.registry.onVideoFrameWasmToJs(source(false), h264, 640, 480, 2, 100, 1234, true);
    expect(videoOut()).toEqual([]); // not before setVideoBridge
    expect((await call('setVideoBridge', { on: true })).value).toBe(true);
    t.wa.registry.onVideoFrameWasmToJs(source(false), h264, 640, 480, 2, 100, 1234, true);
    t.wa.registry.onVideoFrameWasmToJs(source(true), h264, 640, 480, 1, 100, 1235, false); // own preview: not sent
    expect(videoOut()).toEqual([header(1, true, 1, 640, 480, 1234, [0, 0, 0, 1, 0x65, 0x88])]);
    // WhatsApp's own rendering still gets every frame
    expect(t.wa.rendered).toHaveLength(3);
    // raw frames (another renderer) are VP8-encoded here
    t.wa.registry.onVideoFrameWasmToJs(source(false), new Uint8Array(16 * 16 * 3 / 2), 16, 16, 1, 1, 2000, false);
    expect(videoOut()[1]).toEqual(header(2, true, 0, 16, 16, 2000, [7, 8, 9]));
    await call('setVideoBridge', { on: false });
    t.wa.registry.onVideoFrameWasmToJs(source(false), h264, 640, 480, 1, 100, 3000, false);
    expect(videoOut()).toHaveLength(2);
  });

  it('decodes the owner’s camera into the virtual camera, starting at a key frame', async () => {
    const md = t.window.navigator.mediaDevices;
    await md.getUserMedia({ video: true });
    const track = t.audio.camTracks.at(-1);
    const before = track.frames;
    expect(t.window.__walcall.videoIn(header(2, true, 0, 320, 240, 1, [1]).toString('base64'))).toBe(0); // not bridging
    await call('setVideoBridge', { on: true });
    expect(t.window.__walcall.videoIn(header(2, false, 0, 320, 240, 1, [1]).toString('base64'))).toBe(-1); // waits for a key frame
    expect(t.window.__walcall.videoIn(header(1, true, 1, 320, 240, 2, [0, 0, 1, 0x65]).toString('base64'))).toBe(1);
    expect(t.window.__walcall.videoIn(header(1, false, 1, 320, 240, 3, [0, 0, 1, 0x41]).toString('base64'))).toBe(1);
    expect(t.audio.decoded.map((d: any) => [d.codec, d.type, d.timestamp])).toEqual([
      ['avc1.42001f', 'key', 2000],
      ['avc1.42001f', 'delta', 3000],
    ]);
    // drawn rotated a quarter turn, on a canvas turned to portrait
    expect(t.audio.drawn.at(-1)).toEqual({ rot: 1, w: 320, h: 240 });
    expect(track.frames).toBeGreaterThan(before);
    expect(t.window.__walcall.videoIn(Buffer.from([9, 9]).toString('base64'))).toBe(0);
  });

  it('switches the camera like WhatsApp Web’s camera button and asks for key frames', async () => {
    t.wa.CC.activeCall = t.wa.model({ state: 6 });
    expect((await call('setVideo', { callId: 'CALL1', on: true })).ok).toBe(true);
    expect(t.wa.log.map((l) => l.op)).toEqual(['perm', 'upgrade']); // a voice call: ask to switch to video
    t.wa.CC.activeCall = t.wa.model({ state: 6, isVideo: true, selfVideoState: 'on' });
    await call('setVideo', { callId: 'CALL1', on: false });
    await call('setVideo', { callId: 'CALL1', on: true });
    expect(t.wa.log.filter((l) => l.op === 'videoMute').map((l) => l.args[0])).toEqual([true, false]);
    expect((await call('keyframe', {})).value).toBe(true);
    expect(t.wa.log.at(-1)).toEqual({ op: 'keyframe', args: [LID, false] });
  });

  it('starts and answers video calls', async () => {
    await call('start', { chatId: PN, video: true });
    expect(t.wa.log[0]!.args[1]).toBe(true);
    t.wa.CC.activeCall = t.wa.model({ isVideo: true, peerVideoState: 'on' });
    t.tick();
    expect(events().at(-1)).toMatchObject({ isVideo: true, peerVideo: true, selfVideo: false });
    await call('accept', { callId: 'CALL1', video: true });
    expect(t.wa.log.slice(-2)).toEqual([
      { op: 'perm', args: [true] },
      { op: 'acceptCall', args: [true, true] },
    ]);
    // the camera coming on is a change worth reporting
    t.wa.CC.activeCall.selfVideoState = 'on';
    t.tick();
    expect(events().at(-1)).toMatchObject({ selfVideo: true });
  });

  it('runs an armed operation on the gesture button’s click', async () => {
    t.wa.CC.activeCall = t.wa.model();
    const sel = t.window.__walcall.arm({ op: 'accept', args: { callId: 'CALL1' }, token: 'tok' });
    expect(sel).toBe('#__walcall_gesture');
    expect(t.window.__walcall.result({ token: 'tok' })).toBeNull();
    t.elements.get('__walcall_gesture').listeners[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.window.__walcall.result({ token: 'tok' })).toMatchObject({ ok: true });
    expect(t.window.__walcall.result({ token: 'tok' })).toBeNull();
    expect(await call('nope')).toMatchObject({ ok: false, code: 'unknown' });
  });
});
