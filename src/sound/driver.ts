// The NES game's sound driver: plays sound and music resources 60 times a second by writing the
// NES sound chip's registers. A port of ScummVM's Player_NES (players/player_nes.cpp, GPL-3.0+),
// minus the chip itself.
//
// It runs inside the engine, deterministically, because scripts wait for sounds to finish
// (isSoundRunning): how long a sound runs is decided here, by its data, never by the audio
// hardware. Its only output is a list of register writes per 1/60 s frame, for the APU in apu.ts.
//
// Three slots: 0 and 1 play sound effects (writing the chip directly), 2 plays music through four
// "music channels" with simple envelopes. While an effect plays, music is muted.

/** One register write. `reg` 0x00-0x0f are channel registers, 0x15 the channel enable register. */
export type ApuWrite = number;
/** Pseudo register: enable channels `val` on top of those still sounding (the driver's `status | mask`). */
export const APU_ENABLE = 0x40;
export const apuWrite = (reg: number, val: number): ApuWrite => (reg << 8) | (val & 0xff);
/** Marks a write made by the music rather than a sound effect, so the mix can balance the two. */
export const APU_MUSIC = 1 << 16;

const NUMSLOTS = 3;
const NUMCHANS = 4;
const MAXVOLUME = 0x7f;

const CHANNEL_MASK = [1, 2, 4, 8];

// prettier-ignore
const FREQ_TABLE = [
  0x07f0, 0x077e, 0x0712, 0x06ae, 0x064e, 0x05f3, 0x059e, 0x054d,
  0x0501, 0x04b9, 0x0475, 0x0435, 0x03f8, 0x03bf, 0x0389, 0x0357,
  0x0327, 0x02f9, 0x02cf, 0x02a6, 0x0280, 0x025c, 0x023a, 0x021a,
  0x01fc, 0x01df, 0x01c4, 0x01ab, 0x0193, 0x017c, 0x0167, 0x0152,
  0x013f, 0x012d, 0x011c, 0x010c, 0x00fd, 0x00ee, 0x00e1, 0x00d4,
  0x00c8, 0x00bd, 0x00b2, 0x00a8, 0x009f, 0x0096, 0x008d, 0x0085,
  0x007e, 0x0076, 0x0070, 0x0069, 0x0063, 0x005e, 0x0058, 0x0053,
  0x004f, 0x004a, 0x0046, 0x0042, 0x003e, 0x003a, 0x0037, 0x0034,
];
const INST_CHANNEL = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 1, 3, 3, 3];
const START_CMD = [0x05, 0x03, 0x06, 0x08, 0x0b, 0x01, 0x01, 0x1a, 0x16, 0x06, 0x04, 0x17, 0x02, 0x10, 0x0e, 0x0d];
const RELEASE_CMD = [0x0f, 0x00, 0x00, 0x09, 0x00, 0x14, 0x15, 0x00, 0x00, 0x00, 0x1b, 0x1b, 0x0f, 0x0f, 0x0f, 0x0f];
// prettier-ignore
const NEXT_CMD = [
  0xff, 0xff, 0xff, 0xff, 0x17, 0xff, 0x07, 0xff, 0xff, 0x0a, 0x09, 0x0c, 0x00, 0x00, 0x00, 0x00,
  0x11, 0x12, 0x11, 0x03, 0xff, 0xff, 0x18, 0x00, 0x19, 0x00, 0x00, 0x00,
];
// prettier-ignore
const NEXT_DELAY = [
  0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x03, 0x00, 0x00, 0x05, 0x08, 0x03, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x03, 0x00, 0x00, 0x00,
];

interface Slot {
  framesleft: number;
  id: number;
  type: number;
  data: Uint8Array;
  /** Where `data` starts within the resource, and the read position from there. */
  base: number;
  offset: number;
}

interface MusicChannel {
  command: number;
  framedelay: number;
  pitch: number;
  volume: number;
  voldelta: number;
  envflags: number;
  cmdlock: number;
}

const EMPTY = new Uint8Array(0);

export class SoundDriver {
  private slot: Slot[] = Array.from({ length: NUMSLOTS }, () => ({ framesleft: 0, id: -1, type: 0, data: EMPTY, base: 0, offset: 0 }));
  private mchan: MusicChannel[] = Array.from({ length: NUMCHANS }, () => ({ command: 0, framedelay: 0, pitch: 0, volume: 0, voldelta: 0, envflags: 0, cmdlock: 0 }));
  private sfxPlaying = false;
  private wasSfxPlaying = false;
  /** Set while the music plays, to tag its writes. */
  private musicPlaying = false;
  private numNotes = 0;
  /** Start of the music's note instruments and note pitches, within slot 2's resource. */
  private aux1 = 0;
  private aux2 = 0;
  /** Register writes for the chip, one list per 1/60 s frame, since `begin` (the current engine frame). */
  out: ApuWrite[][] = [];
  private frameOut: ApuWrite[] = [];

  /** `sounds[n]` is sound resource n, if any: channel, priority, then its data. */
  constructor(private sounds: readonly (Uint8Array | null)[]) {
    this.writeControl(0);
  }

  start(nr: number) {
    const res = this.sounds[nr];
    if (!res || res.length < 3) return;
    // ScummVM skips a 2-byte size header here; the ROM's resource has none.
    const base = 0;
    let chan = res[base];
    const type = res[base + 1];
    if (chan === 4) {
      if (this.slot[2].framesleft) return;
      chan = 0;
    }
    const s = this.slot[chan];
    if (!s || type < s.type) return;
    s.type = type;
    s.id = nr;
    s.data = res;
    s.base = base;
    s.offset = 2;
    s.framesleft = 1;
    this.checkSilenceChannels(chan);
    if (chan === 2) {
      this.numNotes = res[base + 2];
      this.aux1 = base + 3;
      this.aux2 = this.aux1 + this.numNotes;
      s.base = this.aux2 + this.numNotes;
      s.offset = 0;
      for (const m of this.mchan) m.cmdlock = 0;
    }
  }

  stop(nr: number) {
    if (nr === -1) return;
    for (let i = 0; i < NUMSLOTS; i++) {
      const s = this.slot[i];
      if (s.id !== nr) continue;
      this.sfxPlaying = false;
      s.framesleft = 0;
      s.type = 0;
      s.id = -1;
      this.checkSilenceChannels(i);
    }
  }

  stopAll() {
    for (const s of this.slot) {
      s.framesleft = 0;
      s.type = 0;
      s.id = -1;
    }
    this.sfxPlaying = false;
    this.checkSilenceChannels(0);
  }

  /** 1 while sound `nr` is playing (what isSoundRunning reports). */
  status(nr: number): number {
    return this.slot.some((s) => s.id === nr) ? 1 : 0;
  }

  /** Advance one 1/60 s frame. */
  tick() {
    if (this.slot[0].framesleft) this.playSfx(0);
    else if (this.slot[1].framesleft) this.playSfx(1);
    this.playMusic();
    this.out.push(this.frameOut);
    this.frameOut = [];
  }

  /** Start collecting a new engine frame's register writes (the previous frame's are dropped). */
  begin() {
    this.out = [];
  }

  private byte(s: Slot): number {
    // Reading past the end of a resource ends the sound.
    return s.data[s.base + s.offset++] ?? 0xff;
  }

  private writeChannel(chan: number, offset: number, value: number) {
    this.frameOut.push(apuWrite(4 * chan + offset, value) | (this.musicPlaying ? APU_MUSIC : 0));
  }

  private writeControl(value: number) {
    this.frameOut.push(apuWrite(0x15, value));
  }

  private enable(chan: number) {
    this.frameOut.push(apuWrite(APU_ENABLE, CHANNEL_MASK[chan]) | (this.musicPlaying ? APU_MUSIC : 0));
  }

  private checkSilenceChannels(chan: number) {
    for (chan--; chan >= 0; chan--) if (this.slot[chan].framesleft) return;
    this.writeControl(0);
  }

  private playSfx(nr: number) {
    const s = this.slot[nr];
    if (--s.framesleft) return;
    for (;;) {
      const a = this.byte(s);
      if (a < 16) {
        const ch = a >> 2;
        this.enable(ch);
        this.sfxPlaying = true;
        for (let r = 0; r < 4; r++) this.writeChannel(ch, r, this.byte(s));
      } else if (a === 0xfe) {
        s.offset = 2;
      } else if (a === 0xff) {
        s.id = -1;
        s.type = 0;
        this.sfxPlaying = false;
        this.writeControl(0);
        if (!nr && this.slot[1].framesleft) {
          this.slot[1].framesleft = 1;
          this.sfxPlaying = true;
        }
        return;
      } else {
        s.framesleft = this.byte(s);
        return;
      }
    }
  }

  private freq(pitch: number) {
    return FREQ_TABLE[pitch] ?? 0;
  }

  /** Start a tone on channel x: the register sequence most music commands share. */
  private note(x: number, sweep: number, pitch = this.mchan[x].pitch, reg0 = true) {
    if (reg0) this.writeChannel(x, 0, 0x00);
    if (sweep >= 0) this.writeChannel(x, 1, sweep);
    this.enable(x);
    this.writeChannel(x, 2, this.freq(pitch) & 0xff);
    this.writeChannel(x, 3, this.freq(pitch) >> 8);
  }

  private noise(x: number, period: number) {
    this.writeChannel(x, 2, period & 0xf);
    this.writeChannel(x, 3, 0xff);
  }

  private playMusic() {
    const s = this.slot[2];
    if (!s.framesleft) return;
    this.musicPlaying = true;
    try {
      this.playMusicFrame(s);
    } finally {
      this.musicPlaying = false;
    }
  }

  private playMusicFrame(s: Slot) {

    if (this.wasSfxPlaying && !this.sfxPlaying)
      for (let x = 1; x >= 0; x--)
        if (this.mchan[x].cmdlock) {
          this.mchan[x].command = this.mchan[x].cmdlock;
          this.mchan[x].framedelay = 1;
        }
    this.wasSfxPlaying = this.sfxPlaying;

    if (!--s.framesleft) {
      for (;;) {
        let b = this.byte(s);
        if (b === 0xff) {
          s.id = -1;
          s.type = 0;
          b = 0;
        } else if (b === 0xfe) {
          s.offset = 0;
          continue;
        } else {
          if (b < this.numNotes) {
            const inst = s.data[this.aux1 + b] & 0xf;
            const m = this.mchan[INST_CHANNEL[inst]];
            m.pitch = s.data[this.aux2 + b] ?? 0;
            m.cmdlock = START_CMD[inst];
            m.command = START_CMD[inst];
            m.framedelay = 1;
            continue;
          }
          b -= this.numNotes;
          if (b < 16) {
            const m = this.mchan[INST_CHANNEL[b]];
            m.cmdlock = 0;
            m.command = RELEASE_CMD[b];
            m.framedelay = 1;
            continue;
          }
          b -= 16;
        }
        s.framesleft = b;
        break;
      }
    }

    for (let x = NUMCHANS - 1; x >= 0; x--) {
      const m = this.mchan[x];
      if (this.slot[0].framesleft || this.slot[1].framesleft) {
        m.volume = 0;
        m.framedelay = 0;
        continue;
      }
      if (m.framedelay && !--m.framedelay) this.runCommand(x, m);
      m.volume = Math.max(0, Math.min(MAXVOLUME, m.volume + m.voldelta));
      this.writeChannel(x, 0, (m.volume >> 3) | m.envflags);
    }
  }

  private attack(m: MusicChannel, envflags: number, volume = 0x6f, voldelta = 0) {
    m.envflags = envflags;
    m.volume = volume;
    m.voldelta = voldelta;
  }

  private runCommand(x: number, m: MusicChannel) {
    switch (m.command) {
      case 0x00:
      case 0x13:
        m.voldelta = -10;
        return;
      case 0x01:
      case 0x03:
      case 0x08:
      case 0x16:
        this.attack(m, 0x30);
        this.note(x, 0x7f);
        break;
      case 0x02:
        this.attack(m, 0xb0);
        this.note(x, 0x84);
        break;
      case 0x04:
        this.attack(m, 0x80);
        this.note(x, 0x7f);
        break;
      case 0x05:
        this.attack(m, 0xf0, 0x6f, -15);
        this.note(x, 0x7f, m.pitch, false);
        break;
      case 0x06:
        m.pitch += 0x18;
        this.attack(m, 0x80);
        this.note(x, 0x7f);
        break;
      case 0x07:
        this.writeChannel(x, 2, this.freq(m.pitch - 0x0c) & 0xff);
        this.writeChannel(x, 3, this.freq(m.pitch - 0x0c) >> 8);
        break;
      case 0x09:
        m.voldelta = -2;
        this.writeChannel(x, 1, 0x7f);
        this.writeChannel(x, 2, this.freq(m.pitch) & 0xff);
        this.writeChannel(x, 3, this.freq(m.pitch) >> 8);
        break;
      case 0x0a:
        this.writeChannel(x, 1, 0x86);
        this.writeChannel(x, 2, this.freq(m.pitch) & 0xff);
        this.writeChannel(x, 3, this.freq(m.pitch) >> 8);
        break;
      case 0x0b:
      case 0x1a:
        this.attack(m, 0x70);
        this.note(x, 0x7f);
        break;
      case 0x0c:
        m.envflags = 0xb0;
        break;
      case 0x0d:
        this.attack(m, 0x30, 0x5f, -22);
        this.writeChannel(x, 0, 0x00);
        this.enable(x);
        this.noise(x, m.pitch);
        break;
      case 0x0e:
      case 0x10:
        this.attack(m, 0x30, 0x5f, -6);
        this.writeChannel(x, 0, 0x00);
        this.enable(x);
        this.noise(x, m.pitch);
        break;
      case 0x0f:
        break;
      case 0x11:
        this.noise(x, m.pitch);
        break;
      case 0x12:
        this.noise(x, m.pitch + 3);
        break;
      case 0x14:
        m.voldelta = -12;
        this.writeChannel(x, 1, 0x8c);
        break;
      case 0x15:
        m.voldelta = -12;
        this.writeChannel(x, 1, 0x84);
        break;
      case 0x17:
        m.pitch += 0x0c;
        this.attack(m, 0x80);
        this.note(x, 0x7f);
        break;
      case 0x18:
        m.envflags = 0x70;
        break;
      case 0x19:
        m.envflags = 0xb0;
        break;
      case 0x1b:
        m.envflags = 0x00;
        m.voldelta = -10;
        return;
      default:
        return;
    }
    // Every command that doesn't return above moves on to its follow-up.
    const i = m.command;
    m.command = NEXT_CMD[i] ?? 0xff;
    m.framedelay = NEXT_DELAY[i] ?? 0;
  }
}
