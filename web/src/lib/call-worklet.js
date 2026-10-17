// AudioWorklet for calls (plain JS: loaded as its own module by audioWorklet.addModule, never bundled).
// Input: the microphone at the context's rate → 20 ms frames of 16 kHz mono s16le, posted to the main thread.
// Output: 16 kHz s16le frames from the main thread → a small jitter buffer → the context's rate.
const RATE = 16000;
const FRAME = 320; // 20 ms
const PREBUFFER = 0.06; // seconds buffered before playback (re)starts
const MAX_BUFFER = 0.3; // more than this is a backlog: drop down to PREBUFFER

class WalCallProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const rate = sampleRate; // global in AudioWorkletGlobalScope
    // capture: box-filter decimator rate → 16 kHz
    this.step = rate / RATE;
    this.acc = 0;
    this.cnt = 0;
    this.pos = 0;
    this.frame = new Int16Array(FRAME);
    this.fill = 0;
    this.muted = false;
    // playback: queue of Float32 chunks at 16 kHz, read with linear interpolation
    this.chunks = [];
    this.queued = 0;
    this.readPos = 0; // fractional position in chunks[0]
    this.playing = false;
    this.inc = RATE / rate;
    this.last = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) this.enqueue(new Int16Array(d));
      else if (d && d.type === 'mute') this.muted = !!d.muted;
    };
  }

  enqueue(pcm) {
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    this.chunks.push(f);
    this.queued += f.length;
    if (this.queued > MAX_BUFFER * RATE) {
      while (this.chunks.length > 1 && this.queued - this.chunks[0].length >= PREBUFFER * RATE) {
        this.queued -= this.chunks.shift().length;
        this.readPos = 0;
      }
    }
  }

  sampleAt(offset) {
    // sample at integer offset from the read head across chunk boundaries (0 beyond the end)
    let i = 0;
    let o = offset;
    while (i < this.chunks.length) {
      const c = this.chunks[i];
      if (o < c.length) return c[o];
      o -= c.length;
      i++;
    }
    return this.last;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && !this.muted) {
      for (let i = 0; i < input.length; i++) {
        this.acc += input[i];
        this.cnt++;
        this.pos += 1;
        if (this.pos >= this.step) {
          this.pos -= this.step;
          const v = this.acc / this.cnt;
          this.acc = 0;
          this.cnt = 0;
          this.frame[this.fill++] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
          if (this.fill === FRAME) {
            const out = this.frame.slice();
            this.port.postMessage(out.buffer, [out.buffer]);
            this.fill = 0;
          }
        }
      }
    }

    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.playing && this.queued >= PREBUFFER * RATE) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.chunks.length === 0) {
        out[i] = 0;
        continue;
      }
      const base = Math.floor(this.readPos);
      const frac = this.readPos - base;
      const a = this.sampleAt(base);
      const b = this.sampleAt(base + 1);
      out[i] = this.last = a + (b - a) * frac;
      this.readPos += this.inc;
      while (this.chunks.length && this.readPos >= this.chunks[0].length) {
        this.readPos -= this.chunks[0].length;
        this.queued -= this.chunks.shift().length;
      }
      if (this.chunks.length === 0) {
        // underrun: wait for a new prebuffer
        this.playing = false;
        this.readPos = 0;
        this.queued = 0;
      }
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    return true;
  }
}

registerProcessor('wal-call', WalCallProcessor);
