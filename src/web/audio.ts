// Sound out: feeds each engine frame's sound-chip writes to the APU and queues what it plays.
// Every player hears the same thing, as from the one sound chip of the original. Presentation
// only: nothing here affects the game, so it may start late, drop audio or be muted freely.

import { Apu } from '../sound/apu';
import type { ApuWrite } from '../sound/driver';

/** How far ahead of the speakers audio is queued, in seconds: room for ticks arriving unevenly. */
const LEAD = 0.1;
/** Queued further ahead than this (a burst of ticks), drop audio rather than lag behind the picture. */
const MAX_AHEAD = 0.5;
/**
 * Ticks don't arrive exactly on the audio clock (timers drift, the network jitters), so playback
 * runs up to 2% fast or slow to hold the lead steady: too little to hear as a change of pitch.
 */
const MAX_SKEW = 0.02;
/** Skew per second of lead beyond LEAD. */
const SKEW_GAIN = 0.1;
const VOLUME = 0.5;
const MUTE_KEY = 'maniac-duo.muted';

export class AudioOut {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private apu: Apu | null = null;
  /** When the next queued buffer starts, on the AudioContext clock. */
  private next = 0;
  /** Fractional samples carried between frames when the rate isn't a multiple of 60. */
  private carry = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {}
  }

  /** Browsers allow sound only after the page is used: call from input handlers. */
  unlock() {
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : VOLUME;
      this.gain.connect(this.ctx.destination);
      this.apu = new Apu(this.ctx.sampleRate);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : VOLUME;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {}
  }

  /** Play one engine frame: its chip writes, one list per 1/60 s. */
  play(frames: readonly ApuWrite[][]) {
    const { ctx, apu, gain } = this;
    if (!ctx || !apu || !gain || !frames.length || ctx.state !== 'running') return;
    const rate = ctx.sampleRate;
    const counts = frames.map(() => {
      const exact = rate / 60 + this.carry;
      const n = Math.floor(exact);
      this.carry = exact - n;
      return n;
    });
    const buf = ctx.createBuffer(1, counts.reduce((a, b) => a + b, 0), rate);
    const out = buf.getChannelData(0);
    let i = 0;
    frames.forEach((writes, f) => {
      for (const w of writes) apu.apply(w);
      for (let k = 0; k < counts[f]; k++) out[i++] = apu.sample();
    });
    const now = ctx.currentTime;
    if (this.next < now + 0.01) this.next = now + LEAD;
    if (this.next > now + MAX_AHEAD) return;
    const skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, (this.next - now - LEAD) * SKEW_GAIN));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + skew;
    src.connect(gain);
    src.start(this.next);
    this.next += buf.duration / (1 + skew);
  }
}
