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
/**
 * The mix. The game's audio sits under the browser's speech (which can't go louder than full),
 * and within it the music sits under the sound effects; a chip channel counts as music or effect
 * by whoever last played on it.
 */
const VOLUME = 0.35;
const MIX = { music: 0.6, effects: 1.5 };
/** Footsteps peak about as loud as the game's door sounds, but they're short. */
const STEP_VOLUME = 0.17;
const MUTE_KEY = 'maniac-duo.muted';

export class AudioOut {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private apu: Apu | null = null;
  /** When the next queued buffer starts, on the AudioContext clock. */
  private next = 0;
  /** Fractional samples carried between frames when the rate isn't a multiple of 60. */
  private carry = 0;
  private stepSound: AudioBuffer | null = null;
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
      this.apu = new Apu(this.ctx.sampleRate, MIX);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** A soft footstep, now (in time with the picture, not the queued game sound). */
  footstep(foot: number) {
    const { ctx, gain } = this;
    if (!ctx || !gain || ctx.state !== 'running') return;
    this.stepSound ??= footstepSound(ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.stepSound;
    src.playbackRate.value = foot ? 0.85 : 1;
    src.connect(gain);
    src.start();
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

/**
 * A footstep in the NES's voice: a 50 ms burst from the noise channel's shift register (at one
 * of its lower rates, for a soft scuff rather than a hiss), dying away quickly.
 */
function footstepSound(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(rate * 0.05), rate);
  const out = buf.getChannelData(0);
  const shiftHz = 1789773 / 0x2fa; // noise period 12
  let lfsr = 1;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += shiftHz / rate;
    while (phase >= 1) {
      phase--;
      lfsr = ((lfsr << 1) | (((lfsr >> 14) ^ (lfsr >> 13)) & 1)) & 0x7fff;
    }
    const decay = (1 - i / out.length) ** 2;
    out[i] = (lfsr & 0x4000 ? -1 : 1) * STEP_VOLUME * decay;
  }
  return buf;
}
