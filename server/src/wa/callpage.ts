/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Calls: code that runs inside WhatsApp Web (the Chromium container's page), installed as `window.__walcall`.
 *
 *  - a call monitor: polls WhatsApp Web's call models (WAWebCallCollection) and reports every state change through
 *    the CDP binding `__walCallEvent` (ids and states only, no names)
 *  - call control (start / accept / reject / hang up) through WhatsApp Web's own VoIP functions, the ones its call
 *    buttons use (module names from WhatsApp Web 2.3000.1050x; the same calls as the wa2sip project's agent/page.js)
 *  - audio: WhatsApp Web's VoIP stack takes its microphone from getUserMedia and plays the other side through Web
 *    Audio (a worklet connected to AudioContext.destination or to a MediaStreamDestination + <audio>). The Chromium
 *    container has no sound devices, so this code gives WhatsApp Web a *virtual microphone* (a MediaStream the app
 *    feeds with the owner's voice, `audioIn`) and *taps* every Web Audio node that is connected to an output, so the
 *    other side's voice goes out through the binding `__walCallAudio`. Audio crosses only while `setBridge(true)`.
 *    Format both ways: 16 kHz mono signed 16-bit little-endian PCM, base64.
 *
 * The app injects WAL_CALL_SOURCE at document start of every page load (the audio hooks must be in place before
 * WhatsApp Web creates its audio graph) and once into the page already open. installWalCalls() must stay
 * self-contained: no imports, no closures over Node values (callpage.test.ts runs the string in a bare `vm`).
 */
export function installWalCalls(): string {
  const W = window as any;
  if (W.__walcall) return 'already';

  // WhatsApp Web replaces the timer functions after it loads; keep the browser's own.
  const T = { set: W.setTimeout.bind(W), clear: W.clearTimeout.bind(W), every: W.setInterval.bind(W) };
  const RATE = 16000;
  const MIC_ID = 'wa-logger-mic';
  const MIC_LABEL = 'wa_logger (your browser)';

  const R = (name: string): any => {
    try {
      return W.require(name);
    } catch {
      return null;
    }
  };
  const D = (name: string): any => {
    const m = R(name);
    return m && m.default ? m.default : m;
  };
  const fail = (code: string, message?: string) => Object.assign(new Error(message || code), { code });
  const emit = (binding: string, payload: string): void => {
    try {
      const f = W[binding];
      if (typeof f === 'function') f(payload);
    } catch {
      /* binding gone during navigation */
    }
  };
  const widStr = (w: any): string | null => {
    if (!w) return null;
    if (typeof w === 'string') return w;
    try {
      if (typeof w._serialized === 'string') return w._serialized;
      if (typeof w.$1 === 'string') return w.$1;
      const s = w.toString();
      return s && s !== '[object Object]' ? s : null;
    } catch {
      return null;
    }
  };
  const toWid = (s: string): any => {
    try {
      return R('WAWebWidFactory').createWid(s);
    } catch {
      return null;
    }
  };
  const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesToB64 = (u8: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
    return btoa(s);
  };

  /* ------------------------------------------------------------------------------------------- audio */

  /** Our own audio objects: never tapped, never hooked. */
  const ours = new WeakSet<object>();
  let bridging = false;
  let micFrames = 0;
  let outFrames = 0;

  // Virtual microphone: buffers of the owner's voice are scheduled into a MediaStreamDestination; WhatsApp Web
  // gets clones of its track from getUserMedia. Silence when nothing arrives.
  let mic: { ctx: any; dest: any; next: number } | null = null;
  function micGraph(): { ctx: any; dest: any; next: number } {
    if (!mic) {
      const ctx = new W.AudioContext({ latencyHint: 'interactive' });
      const dest = ctx.createMediaStreamDestination();
      ours.add(ctx);
      ours.add(dest);
      mic = { ctx, dest, next: 0 };
    }
    if (mic.ctx.state === 'suspended') mic.ctx.resume().catch(() => undefined);
    return mic;
  }
  function micStream(win: any): any {
    const m = micGraph();
    const track = m.dest.stream.getAudioTracks()[0].clone();
    try {
      Object.defineProperty(track, 'label', { value: MIC_LABEL });
      const settings = track.getSettings.bind(track);
      track.getSettings = () => Object.assign({}, settings(), { deviceId: MIC_ID, groupId: MIC_ID });
    } catch {
      /* cosmetic */
    }
    return new (win.MediaStream || W.MediaStream)([track]);
  }
  /** The owner's voice (16 kHz s16le, base64) → the virtual microphone, ~80 ms behind real time. */
  function audioIn(b64: string): number {
    if (!bridging || typeof b64 !== 'string' || !b64) return 0;
    const m = micGraph();
    const bytes = b64ToBytes(b64);
    const n = bytes.length >> 1;
    if (!n) return 0;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, n);
    const buf = m.ctx.createBuffer(1, n, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = pcm[i]! / 32768;
    const src = m.ctx.createBufferSource();
    ours.add(src);
    src.buffer = buf;
    mainConnect.call(src, m.dest);
    const now = m.ctx.currentTime;
    // Too late (a gap) or too far ahead (a backlog): restart close to now.
    if (m.next < now + 0.02 || m.next > now + 0.4) m.next = now + 0.08;
    src.start(m.next);
    m.next += buf.duration;
    micFrames++;
    return n;
  }

  // Speaker tap: every node connected to an output (AudioContext.destination or a MediaStreamDestination) is also
  // connected to a per-context ScriptProcessor that downsamples to 16 kHz and sends the samples out.
  const taps = new WeakMap<object, any>();
  const tapped = new WeakSet<object>();
  // Several contexts may have tapped nodes (each runs on its own clock), so only one tap sends at a time: the one
  // that last carried sound. Digital silence is not sent at all (the browser side plays silence when nothing comes).
  let owner: object | null = null;
  let ownerAt = 0;
  function tapFor(ctx: any, connect: (this: any, ...a: any[]) => any): any {
    let t = taps.get(ctx);
    if (t) return t;
    // not offline contexts (WhatsApp renders voice-note waveforms with them)
    if (typeof ctx.createScriptProcessor !== 'function' || typeof ctx.startRendering === 'function') return null;
    const rate = ctx.sampleRate;
    const sp = ctx.createScriptProcessor(rate > 24000 ? 1024 : 512, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ours.add(sp);
    ours.add(mute);
    // Box-filter decimator (rate → 16 kHz), state kept across callbacks.
    const step = rate / RATE;
    let acc = 0;
    let cnt = 0;
    let pos = 0;
    let pending: number[] = [];
    sp.onaudioprocess = (e: any) => {
      if (!bridging) return;
      const x: Float32Array = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
      const now = Date.now();
      if (peak < 1e-5 || (owner !== sp && now - ownerAt < 500)) {
        acc = cnt = pos = 0;
        pending = [];
        return;
      }
      owner = sp;
      ownerAt = now;
      for (let i = 0; i < x.length; i++) {
        acc += x[i]!;
        cnt++;
        pos += 1;
        if (pos >= step) {
          pos -= step;
          const v = acc / cnt;
          acc = 0;
          cnt = 0;
          pending.push(v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767));
        }
      }
      if (pending.length >= 320) {
        const pcm = Int16Array.from(pending);
        pending = [];
        outFrames++;
        emit('__walCallAudio', bytesToB64(new Uint8Array(pcm.buffer)));
      }
    };
    connect.call(sp, mute);
    connect.call(mute, ctx.destination);
    taps.set(ctx, sp);
    return sp;
  }

  /**
   * Installs the virtual microphone and the speaker tap into a window: this one, and any window WhatsApp Web opens
   * (it can move a call into a popout window, whose getUserMedia and Web Audio are that window's own).
   */
  function hookRealm(win: any): void {
    const md = win.navigator && win.navigator.mediaDevices;
    if (md && md.getUserMedia && !md.__walHooked) {
      const getUserMedia = md.getUserMedia.bind(md);
      md.getUserMedia = function (c: any) {
        // Audio-only requests (calls, voice notes) get the virtual microphone; anything with video is left alone.
        if (c && c.audio && !c.video) {
          try {
            return Promise.resolve(micStream(win));
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return getUserMedia(c);
      };
      const enumerate = md.enumerateDevices ? md.enumerateDevices.bind(md) : async () => [];
      const proto = (win.InputDeviceInfo || win.MediaDeviceInfo || Object).prototype;
      const device = Object.create(proto, {
        deviceId: { value: MIC_ID, enumerable: true },
        groupId: { value: MIC_ID, enumerable: true },
        kind: { value: 'audioinput', enumerable: true },
        label: { value: MIC_LABEL, enumerable: true },
        toJSON: { value: () => ({ deviceId: MIC_ID, groupId: MIC_ID, kind: 'audioinput', label: MIC_LABEL }) },
        getCapabilities: { value: () => ({ deviceId: MIC_ID, groupId: MIC_ID, channelCount: { min: 1, max: 1 }, sampleRate: { min: RATE, max: 48000 } }) },
      });
      md.enumerateDevices = async () => {
        let list: any[] = [];
        try {
          list = await enumerate();
        } catch {
          /* none */
        }
        return [device].concat(list.filter((d) => d && d.kind !== 'audioinput'));
      };
      md.__walHooked = true;
    }

    // The browser itself has no microphone permission (managed policy). WhatsApp Web only ever gets the virtual one.
    const perms = win.navigator && win.navigator.permissions;
    if (perms && perms.query && !perms.__walHooked) {
      const query = perms.query.bind(perms);
      perms.query = function (d: any) {
        if (d && d.name === 'microphone') {
          const status: any = typeof win.EventTarget === 'function' ? new win.EventTarget() : {};
          status.name = 'microphone';
          status.state = 'granted';
          status.onchange = null;
          return Promise.resolve(status);
        }
        return query(d);
      };
      perms.__walHooked = true;
    }

    const AN = win.AudioNode && win.AudioNode.prototype;
    if (AN && !AN.__walHooked) {
      const connect: (this: any, ...a: any[]) => any = AN.connect;
      if (win === W) mainConnect = connect;
      const isOutput = (d: any) =>
        (win.AudioDestinationNode && d instanceof win.AudioDestinationNode) ||
        (win.MediaStreamAudioDestinationNode && d instanceof win.MediaStreamAudioDestinationNode);
      AN.connect = function (this: any, dest: any, ...rest: any[]) {
        const r = connect.call(this, dest, ...rest);
        try {
          if (dest && !ours.has(this) && !ours.has(dest) && !tapped.has(this) && this.context && !ours.has(this.context) && isOutput(dest)) {
            const t = tapFor(this.context, connect);
            if (t) {
              tapped.add(this);
              connect.call(this, t);
            }
          }
        } catch {
          /* never break WhatsApp's own audio */
        }
        return r;
      };
      const disconnect = AN.disconnect;
      AN.disconnect = function (this: any, ...a: any[]) {
        // disconnect() without arguments also drops our tap; tap again on the next connect to an output
        if (a.length === 0) tapped.delete(this);
        return disconnect.apply(this, a);
      };
      AN.__walHooked = true;
    }
  }

  let mainConnect: (this: any, ...a: any[]) => any = function () {};
  hookRealm(W);
  // Windows WhatsApp Web opens itself (call popout): hook them as soon as they exist.
  if (typeof W.open === 'function' && !W.open.__walHooked) {
    const open = W.open;
    W.open = function (this: any, ...a: any[]) {
      const w = open.apply(this, a);
      try {
        if (w) hookRealm(w);
      } catch {
        /* cross-origin or closed */
      }
      return w;
    };
    W.open.__walHooked = true;
  }
  // Document picture-in-picture would move the call UI into a window we never see; WhatsApp Web checks for it with
  // `"documentPictureInPicture" in window` and keeps the call in the tab without it.
  try {
    delete W.documentPictureInPicture;
  } catch {
    /* not configurable */
  }

  function setBridge(a: { on: boolean }): boolean {
    bridging = !!(a && a.on);
    owner = null;
    if (bridging) micGraph();
    else if (mic) mic.next = 0;
    return bridging;
  }

  /* ------------------------------------------------------------------------------------ call monitor */

  function peerOf(m: any): { jid: string | null; alt: string | null; group: string | null } {
    const jid = widStr(m.peerJid);
    let alt: string | null = null;
    try {
      const LU = R('WAWebLidMigrationUtils');
      if (jid && LU) alt = widStr(jid.endsWith('@lid') ? LU.toPn(m.peerJid) : LU.toLid(m.peerJid));
    } catch {
      /* no mapping */
    }
    return { jid, alt, group: widStr(m.groupJid) };
  }

  function snap(m: any): any {
    let state: number | null = null;
    try {
      state = m.getState();
    } catch {
      /* keep null */
    }
    const p = peerOf(m);
    return {
      id: String(m.id),
      state,
      outgoing: !!m.outgoing,
      isVideo: !!m.isVideo,
      isGroup: !!(m.isGroup || m.groupJid),
      peer: p.jid,
      peerAlt: p.alt,
      group: p.group,
      peerBusy: !!m.peerBusy,
      failedReason: m.callFailedReason == null ? null : String(m.callFailedReason).slice(0, 40),
      logResult: typeof m.callLogResult === 'number' ? m.callLogResult : null,
      everConnected: !!m.wasEverConnected,
      userEnded: !!m.userEndedCall,
      removed: false,
    };
  }

  const seen = new Map<string, { model: any; state: number | null }>();
  function tick(): void {
    const CC = D('WAWebCallCollection');
    if (!CC) return;
    const models = new Set<any>();
    try {
      for (const m of CC.getModelsArray()) models.add(m);
    } catch {
      /* older builds */
    }
    if (CC.activeCall) models.add(CC.activeCall);
    for (const m of models) {
      if (!m || !m.id) continue;
      let st: number | null = null;
      try {
        st = m.getState();
      } catch {
        /* ignore */
      }
      const id = String(m.id);
      const rec = seen.get(id);
      if (!rec || rec.state !== st || rec.model !== m) {
        seen.set(id, { model: m, state: st });
        emit('__walCallEvent', JSON.stringify(snap(m)));
      }
    }
    for (const [id, rec] of seen) {
      if (!models.has(rec.model)) {
        seen.delete(id);
        const s = snap(rec.model);
        s.removed = true;
        emit('__walCallEvent', JSON.stringify(s));
      }
    }
  }
  T.every(() => {
    try {
      tick();
    } catch {
      /* next tick */
    }
  }, 250);

  /* ------------------------------------------------------------------------------------ call control */

  async function stack(): Promise<any> {
    const SI = R('WAWebVoipStackInterface');
    if (!SI || !SI.getVoipStackInterface) throw fail('unsupported', 'This WhatsApp Web version has no calling.');
    const s = await SI.getVoipStackInterface();
    if (!s) throw fail('unsupported', 'Calling is not enabled for this WhatsApp Web session.');
    return s;
  }

  function activeCall(callId: string): any {
    const CC = D('WAWebCallCollection');
    const call = CC && CC.activeCall;
    if (!call || (callId && String(call.id) !== callId)) throw fail('not_found', 'That call is no longer ringing or active.');
    return call;
  }

  function supported(): string | null {
    const G = R('WAWebVoipGatingUtils');
    try {
      if (G && G.getUnsupportedBrowserReason) {
        const r = G.getUnsupportedBrowserReason();
        if (r) return String(r);
      }
    } catch {
      /* unknown */
    }
    try {
      const ab = R('WAWebABProps');
      if (ab && ab.getABPropConfigValue('enable_web_calling') === false) return 'calling_disabled';
    } catch {
      /* unknown */
    }
    return null;
  }

  async function start(a: { chatId: string }): Promise<any> {
    const CC = D('WAWebCallCollection');
    if (CC && CC.activeCall) throw fail('busy', 'WhatsApp is already in a call.');
    const why = supported();
    if (why) throw fail('unsupported', 'WhatsApp Web can’t call from this account or browser (' + why + ').');
    const SC = R('WAWebVoipStartCall');
    if (!SC || !SC.startWAWebVoipCall) throw fail('unsupported', 'This WhatsApp Web version has no calling.');
    const wid = toWid(a.chatId);
    if (!wid) throw fail('validation', 'Not a WhatsApp chat.');
    const enums = R('WAWebWamEnumCallFromUi');
    const fromUi = (enums && enums.CALL_FROM_UI && enums.CALL_FROM_UI.CONVERSATION) || 8;
    let startError: any = null;
    let doneAt = 0;
    // Resolves once WhatsApp has set the call up (or gave up); the call model appears before that.
    Promise.resolve(SC.startWAWebVoipCall(wid, false, fromUi, 0, null, { entryTrust: 'user_gesture' })).then(
      () => {
        doneAt = Date.now();
      },
      (e: any) => {
        doneAt = Date.now();
        startError = e || new Error('unknown error');
      },
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const c = CC && CC.activeCall;
      if (c && c.outgoing) {
        tick();
        return snap(c);
      }
      if (startError) throw fail('failed', 'WhatsApp could not start the call.');
      if (doneAt && Date.now() - doneAt > 3000) throw fail('failed', 'WhatsApp did not start the call.');
      await new Promise((r) => T.set(r, 100));
    }
    throw fail('timeout', 'WhatsApp did not start the call in time.');
  }

  async function accept(a: { callId: string }): Promise<any> {
    const call = activeCall(a.callId);
    try {
      R('WAWebCallRingtone').stopCallRingtone();
    } catch {
      /* optional */
    }
    const AMS = R('WAWebVoipAcquireMediaStream');
    if (AMS && AMS.checkVoipDevicePermissions) {
      const ok = await AMS.checkVoipDevicePermissions(false, call);
      if (ok === false) throw fail('failed', 'WhatsApp Web refused the microphone.');
    }
    const s = await stack();
    await s.acceptCall(true, false); // audio only
    tick();
    return snap(call);
  }

  async function reject(a: { callId: string }): Promise<boolean> {
    const call = activeCall(a.callId);
    call.userEndedCall = true;
    const s = await stack();
    await s.rejectCall();
    return true;
  }

  async function hangup(a: { callId: string }): Promise<boolean> {
    const call = activeCall(a.callId);
    call.userEndedCall = true;
    const SE = R('WAWebVoipSignalingEnums');
    const self = (SE && SE.EndCallReason && SE.EndCallReason.Self) || 2;
    const s = await stack();
    await s.endCall(self, true);
    return true;
  }

  /** Aggregates only: whether calling can work here and what the audio path is doing. */
  function diag(): any {
    const mods: Record<string, boolean> = {};
    for (const n of ['WAWebCallCollection', 'WAWebVoipStartCall', 'WAWebVoipStackInterface', 'WAWebVoipAcquireMediaStream', 'WAWebVoipSignalingEnums', 'WAWebCallRingtone']) {
      mods[n] = !!R(n);
    }
    let webCalling: any = null;
    try {
      webCalling = R('WAWebABProps').getABPropConfigValue('enable_web_calling');
    } catch {
      /* unknown */
    }
    const CC = D('WAWebCallCollection');
    return {
      unsupported: supported(),
      webCalling,
      sharedArrayBuffer: typeof W.SharedArrayBuffer !== 'undefined',
      crossOriginIsolated: !!W.crossOriginIsolated,
      modules: mods,
      activeCall: CC && CC.activeCall ? { state: snap(CC.activeCall).state } : null,
      audio: { bridging, mic: mic ? mic.ctx.state : null, micFrames, outFrames },
    };
  }

  const api: Record<string, (a: any) => any> = { start, accept, reject, hangup, diag, setBridge };

  async function call(op: string, args: any): Promise<any> {
    const fn = Object.prototype.hasOwnProperty.call(api, op) ? api[op] : null;
    if (!fn) return { ok: false, code: 'unknown', error: 'unknown op' };
    if (typeof W.require !== 'function') return { ok: false, code: 'not_ready', error: 'WhatsApp Web is not loaded yet.' };
    try {
      return { ok: true, value: await fn(args || {}) };
    } catch (e: any) {
      return { ok: false, code: (e && e.code) || 'error', error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // Starting and answering run inside a trusted click on a tiny button (the app clicks it over CDP), so they carry
  // user activation: WhatsApp Web's audio needs it (autoplay policy) like its own call buttons get it from a click.
  const jobs: Record<string, any> = {};
  let armed: { op: string; args: any; token: string } | null = null;
  function runJob(job: { op: string; args: any; token: string }): void {
    if (mic) mic.ctx.resume().catch(() => undefined);
    call(job.op, job.args).then((r) => {
      jobs[job.token] = r;
    });
  }
  function arm(a: { op: string; args: any; token: string }): string {
    let b = W.document.getElementById('__walcall_gesture');
    if (!b) {
      b = W.document.createElement('button');
      b.id = '__walcall_gesture';
      b.setAttribute('aria-hidden', 'true');
      b.tabIndex = -1;
      b.style.cssText =
        'position:fixed;left:0;top:0;width:6px;height:6px;opacity:0.01;z-index:2147483647;border:0;padding:0;margin:0;background:transparent';
      b.addEventListener('click', () => {
        const job = armed;
        armed = null;
        if (job) runJob(job);
      });
      W.document.body.appendChild(b);
    }
    armed = { op: a.op, args: a.args, token: a.token };
    return '#__walcall_gesture';
  }
  /** Fallback when the click could not be delivered: run without user activation. */
  function runArmed(a: { token: string }): boolean {
    if (armed && armed.token === a.token) {
      const job = armed;
      armed = null;
      runJob(job);
    }
    return true;
  }
  function result(a: { token: string }): any {
    const r = jobs[a.token];
    if (r) delete jobs[a.token];
    return r || null;
  }

  Object.defineProperty(W, '__walcall', { value: { v: 1, call, audioIn, arm, runArmed, result, tick } });
  return 'installed';
}

/** Source text for Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate (dev transpilers may add __name). */
export const WAL_CALL_SOURCE = `(function(){var __name=function(f){return f};return (${installWalCalls.toString()})();})()`;
