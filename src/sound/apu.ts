// The NES sound chip (APU): two square waves, a triangle and noise, driven by register writes,
// producing samples. A port of the small APU emulator in ScummVM's players/player_nes.cpp
// (GPL-3.0+), which is all Maniac Mansion needs (no DMC channel, no sweep edge cases).
//
// Presentation only: nothing here affects the game. The driver (driver.ts) decides what plays.

import { APU_ENABLE, type ApuWrite } from './driver';

const CPU_HZ = 1789773;
/** CPU cycles per quarter frame of the APU's frame counter. */
const FRAME_STEP = 7457;

// prettier-ignore
const LENGTH_COUNTS = [
  0x0a, 0xfe, 0x14, 0x02, 0x28, 0x04, 0x50, 0x06, 0xa0, 0x08, 0x3c, 0x0a, 0x0e, 0x0c, 0x1a, 0x0e,
  0x0c, 0x10, 0x18, 0x12, 0x30, 0x14, 0x60, 0x16, 0xc0, 0x18, 0x48, 0x1a, 0x10, 0x1c, 0x20, 0x1e,
];

interface Generator {
  timer: number;
  /** Current output level. */
  pos: number;
  /** CPU cycles until the next waveform step. */
  cycles: number;
  write(reg: number, val: number): void;
  run(): void;
  quarterFrame(): void;
  halfFrame(): void;
}

const DUTIES = [
  [-4, +4, -4, -4, -4, -4, -4, -4],
  [-4, +4, +4, -4, -4, -4, -4, -4],
  [-4, +4, +4, +4, +4, -4, -4, -4],
  [+4, -4, -4, +4, +4, +4, +4, +4],
];

class Square implements Generator {
  timer = 0;
  pos = 0;
  cycles = 1;
  private freq = 0;
  private curD = 1;
  private wavehold = 0;
  private volume = 0;
  private envelope = 0;
  private duty = 0;
  private swpspeed = 0;
  private swpdir = 0;
  private swpstep = 0;
  private swpenab = 0;
  private vol = 0;
  private envCtr = 1;
  private envLevel = 0;
  private bendCtr = 1;
  private enabled = false;
  private validFreq = false;
  private active = false;
  private envClk = false;
  private swpClk = false;

  private checkActive() {
    this.validFreq = this.freq >= 0x8 && (!!this.swpdir || !((this.freq + (this.freq >> this.swpstep)) & 0x800));
    this.active = !!this.timer && this.validFreq;
    this.pos = this.active ? DUTIES[this.duty][this.curD] * this.vol : 0;
  }

  write(reg: number, val: number) {
    switch (reg) {
      case 0:
        this.volume = val & 0xf;
        this.envelope = val & 0x10;
        this.wavehold = val & 0x20;
        this.duty = (val >> 6) & 0x3;
        this.vol = this.envelope ? this.volume : this.envLevel;
        break;
      case 1:
        this.swpstep = val & 0x07;
        this.swpdir = val & 0x08;
        this.swpspeed = (val >> 4) & 0x7;
        this.swpenab = val & 0x80;
        this.swpClk = true;
        break;
      case 2:
        this.freq = (this.freq & 0x700) | val;
        break;
      case 3:
        this.freq = (this.freq & 0xff) | ((val & 0x7) << 8);
        if (this.enabled) this.timer = LENGTH_COUNTS[(val >> 3) & 0x1f];
        this.curD = 0;
        this.envClk = true;
        break;
      case 4:
        this.enabled = val !== 0;
        if (!this.enabled) this.timer = 0;
        break;
    }
    this.checkActive();
  }

  run() {
    this.cycles = (this.freq + 1) << 1;
    this.curD = (this.curD + 1) & 0x7;
    if (this.active) this.pos = DUTIES[this.duty][this.curD] * this.vol;
  }

  quarterFrame() {
    if (this.envClk) {
      this.envClk = false;
      this.envLevel = 0xf;
      this.envCtr = this.volume + 1;
    } else if (!--this.envCtr) {
      this.envCtr = this.volume + 1;
      if (this.envLevel) this.envLevel--;
      else this.envLevel = this.wavehold ? 0xf : 0x0;
    }
    this.vol = this.envelope ? this.volume : this.envLevel;
    this.checkActive();
  }

  halfFrame() {
    if (!--this.bendCtr) {
      this.bendCtr = this.swpspeed + 1;
      if (this.swpenab && this.swpstep && this.validFreq) {
        const sweep = this.freq >> this.swpstep;
        this.freq = (this.freq + (this.swpdir ? -sweep : sweep)) & 0xffff;
      }
    }
    if (this.swpClk) {
      this.swpClk = false;
      this.bendCtr = this.swpspeed + 1;
    }
    if (this.timer && !this.wavehold) this.timer--;
    this.checkActive();
  }
}

// prettier-ignore
const TRI_DUTY = [
  -8, -7, -6, -5, -4, -3, -2, -1, +0, +1, +2, +3, +4, +5, +6, +7,
  +7, +6, +5, +4, +3, +2, +1, +0, -1, -2, -3, -4, -5, -6, -7, -8,
];

class Triangle implements Generator {
  timer = 0;
  pos = 0;
  cycles = 1;
  private freq = 0;
  private curD = 1;
  private wavehold = 0;
  private linear = 0;
  private linCtr = 0;
  private enabled = false;
  private active = false;
  private linClk = false;

  private checkActive() {
    this.active = !!this.timer && !!this.linCtr;
    // Below 4 is beyond hearing.
    this.pos = this.freq < 4 ? 0 : TRI_DUTY[this.curD] * 8;
  }

  write(reg: number, val: number) {
    switch (reg) {
      case 0:
        this.linear = val & 0x7f;
        this.wavehold = (val >> 7) & 0x1;
        break;
      case 2:
        this.freq = (this.freq & 0x700) | val;
        break;
      case 3:
        this.freq = (this.freq & 0xff) | ((val & 0x7) << 8);
        if (this.enabled) this.timer = LENGTH_COUNTS[(val >> 3) & 0x1f];
        this.linClk = true;
        break;
      case 4:
        this.enabled = val !== 0;
        if (!this.enabled) this.timer = 0;
        break;
    }
    this.checkActive();
  }

  run() {
    this.cycles = this.freq + 1;
    if (this.active) {
      this.curD = (this.curD + 1) & 0x1f;
      this.pos = this.freq < 4 ? 0 : TRI_DUTY[this.curD] * 8;
    }
  }

  quarterFrame() {
    if (this.linClk) this.linCtr = this.linear;
    else if (this.linCtr) this.linCtr--;
    if (!this.wavehold) this.linClk = false;
    this.checkActive();
  }

  halfFrame() {
    if (this.timer && !this.wavehold) this.timer--;
    this.checkActive();
  }
}

const NOISE_FREQ = [0x004, 0x008, 0x010, 0x020, 0x040, 0x060, 0x080, 0x0a0, 0x0ca, 0x0fe, 0x17c, 0x1fc, 0x2fa, 0x3f8, 0x7f2, 0xfe4];

class Noise implements Generator {
  timer = 0;
  pos = 0;
  cycles = 1;
  private freq = 0;
  /** Shift register; only its low 15 bits matter. */
  private curD = 1;
  private wavehold = 0;
  private volume = 0;
  private envelope = 0;
  private datatype = 0;
  private vol = 0;
  private envCtr = 1;
  private envLevel = 0;
  private enabled = false;
  private envClk = false;

  private level() {
    return (this.curD & 0x4000 ? -2 : 2) * this.vol;
  }

  write(reg: number, val: number) {
    switch (reg) {
      case 0:
        this.volume = val & 0x0f;
        this.envelope = val & 0x10;
        this.wavehold = val & 0x20;
        this.vol = this.envelope ? this.volume : this.envLevel;
        if (this.timer) this.pos = this.level();
        break;
      case 2:
        this.freq = val & 0xf;
        this.datatype = val & 0x80;
        break;
      case 3:
        if (this.enabled) this.timer = LENGTH_COUNTS[(val >> 3) & 0x1f];
        this.envClk = true;
        break;
      case 4:
        this.enabled = val !== 0;
        if (!this.enabled) this.timer = 0;
        break;
    }
  }

  run() {
    this.cycles = NOISE_FREQ[this.freq];
    const tap = this.datatype ? 8 : 13;
    this.curD = ((this.curD << 1) | (((this.curD >> 14) ^ (this.curD >> tap)) & 0x1)) & 0x7fff;
    if (this.timer) this.pos = this.level();
  }

  quarterFrame() {
    if (this.envClk) {
      this.envClk = false;
      this.envLevel = 0xf;
      this.envCtr = this.volume + 1;
    } else if (!--this.envCtr) {
      this.envCtr = this.volume + 1;
      if (this.envLevel) this.envLevel--;
      else this.envLevel = this.wavehold ? 0xf : 0x0;
    }
    this.vol = this.envelope ? this.volume : this.envLevel;
    if (this.timer) this.pos = this.level();
  }

  halfFrame() {
    if (this.timer && !this.wavehold) this.timer--;
  }
}

export class Apu {
  private square0 = new Square();
  private square1 = new Square();
  private triangle = new Triangle();
  private noise = new Noise();
  private gens: Generator[] = [this.square0, this.square1, this.triangle, this.noise];
  private bufPos = 0;
  private frameCycles = 1;
  private frameNum = 0;

  constructor(private sampleRate: number) {}

  /** Apply one write from the driver. */
  apply(w: ApuWrite) {
    const reg = w >> 8;
    const val = w & 0xff;
    this.writeReg(reg === APU_ENABLE ? 0x15 : reg, reg === APU_ENABLE ? this.status() | val : val);
  }

  writeReg(addr: number, val: number) {
    if (addr < 0x10) this.gens[addr >> 2].write(addr & 3, val);
    else if (addr === 0x15) this.gens.forEach((g, i) => g.write(4, val & (1 << i)));
  }

  /** Which channels are still sounding (register $4015). */
  status(): number {
    return this.gens.reduce((m, g, i) => m | (g.timer ? 1 << i : 0), 0);
  }

  /** The next sample, in -1..1. */
  sample(): number {
    const sampcycles = 1 + Math.floor((CPU_HZ - this.bufPos - 1) / this.sampleRate);
    this.bufPos = this.bufPos + sampcycles * this.sampleRate - CPU_HZ;
    let samppos = 0;
    for (const g of this.gens) samppos += step(g, sampcycles, this.frameCycles, this.frameNum);
    let tmp = sampcycles;
    while (tmp >= this.frameCycles) {
      tmp -= this.frameCycles;
      this.frameCycles = FRAME_STEP;
      if (this.frameNum < 4) {
        if (this.frameNum & 1) this.frameCycles++;
        this.frameNum++;
      } else this.frameNum = 0;
    }
    this.frameCycles -= tmp;
    return Math.trunc((samppos * 64) / sampcycles) / 32768;
  }
}

/** Run one generator for a sample's worth of CPU cycles; returns the sum of its levels. */
function step(g: Generator, sampcycles: number, frameCycles: number, frameNum: number): number {
  let samppos = 0;
  while (sampcycles) {
    const maxStep = Math.min(sampcycles, frameCycles, g.cycles);
    samppos += g.pos * (maxStep - 1);
    sampcycles -= maxStep;
    frameCycles -= maxStep;
    g.cycles -= maxStep;
    if (!frameCycles) {
      frameCycles = FRAME_STEP;
      if (frameNum < 4) {
        g.quarterFrame();
        if (frameNum & 1) frameCycles++;
        else g.halfFrame();
        frameNum++;
      } else frameNum = 0;
    }
    if (!g.cycles) g.run();
    samppos += g.pos;
  }
  return samppos;
}
