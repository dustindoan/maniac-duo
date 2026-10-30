import { describe, expect, test } from 'bun:test';
import { Lockstep } from '../src/engine/lockstep';
import { type Command, Session } from '../src/engine/session';
import { Apu } from '../src/sound/apu';
import { APU_MUSIC, SoundDriver, apuWrite } from '../src/sound/driver';
import { haveRom, rom } from './rom-fixture';

describe('apu', () => {
  test('a square wave plays at the pitch its period register gives', () => {
    const rate = 44100;
    const apu = new Apu(rate);
    apu.writeReg(0x15, 0x01);
    apu.writeReg(0x00, 0x3f); // constant volume 15, length counter halted
    apu.writeReg(0x02, 0xfd);
    apu.writeReg(0x03, 0x08); // period 253: 1789773 / (16 * 254) = 440 Hz
    let rises = 0;
    let prev = apu.sample();
    for (let i = 1; i < rate; i++) {
      const s = apu.sample();
      if (prev <= 0 && s > 0) rises++;
      prev = s;
    }
    expect(Math.abs(rises - 440)).toBeLessThanOrEqual(2);
  });

  test('music and effects are mixed at their own levels', () => {
    const level = (music: boolean, gains: { music: number; effects: number }) => {
      const apu = new Apu(44100, gains);
      const tag = music ? APU_MUSIC : 0;
      for (const [r, v] of [[0x15, 1], [0x00, 0x3f], [0x02, 0xfd], [0x03, 0x08]]) apu.apply((r << 8) | v | (r === 0x15 ? 0 : tag));
      let sum = 0;
      for (let i = 0; i < 4410; i++) sum += apu.sample() ** 2;
      return Math.sqrt(sum / 4410);
    };
    const gains = { music: 0.5, effects: 1.5 };
    expect(level(true, gains) / level(true, { music: 1, effects: 1 })).toBeCloseTo(0.5, 2);
    expect(level(false, gains) / level(false, { music: 1, effects: 1 })).toBeCloseTo(1.5, 2);
  });

  test('silence until a channel is enabled', () => {
    const apu = new Apu(44100);
    apu.writeReg(0x00, 0x3f);
    apu.writeReg(0x02, 0xfd);
    apu.writeReg(0x03, 0x08);
    for (let i = 0; i < 1000; i++) expect(apu.sample()).toBe(0);
  });
});

describe.skipIf(!haveRom)('sound driver', () => {
  const run = (d: SoundDriver, frames: number) => {
    const writes: number[] = [];
    for (let i = 0; i < frames; i++) {
      d.begin();
      d.tick();
      writes.push(...d.out.flat());
    }
    return writes;
  };

  test('a sound effect runs as long as its data says, then stops', () => {
    const d = new SoundDriver(rom().sounds);
    d.start(13);
    expect(d.status(13)).toBe(1);
    const writes = run(d, 45);
    expect(d.status(13)).toBe(1);
    expect(writes.length).toBeGreaterThan(0);
    run(d, 1);
    expect(d.status(13)).toBe(0);
  });

  test('music loops until stopped', () => {
    const d = new SoundDriver(rom().sounds);
    d.start(1);
    run(d, 3600);
    expect(d.status(1)).toBe(1);
    d.stopAll();
    expect(d.status(1)).toBe(0);
    expect(run(d, 10).filter((w) => w >> 8 === 0x15 && (w & 0xff) !== 0)).toEqual([]);
  });

  test('an effect mutes the music and the music comes back after it', () => {
    const d = new SoundDriver(rom().sounds);
    d.start(1);
    run(d, 120);
    // Sound 13 plays on the noise channel only, so the triangle's registers are the music's.
    const triangle = (ws: number[]) => ws.filter((w) => ((w >> 8) & 0xff) >= 0x08 && ((w >> 8) & 0xff) <= 0x0b).length;
    expect(triangle(run(d, 30))).toBeGreaterThan(0);
    d.start(13);
    expect(triangle(run(d, 30))).toBe(0);
    run(d, 30);
    expect(d.status(13)).toBe(0);
    expect(d.status(1)).toBe(1);
    expect(triangle(run(d, 30))).toBeGreaterThan(0);
  });

  test('sounds marked for channel 4 only play while no music does', () => {
    // Sound 0 is one of them (its channel byte is 4).
    expect(rom().sounds[0]![0]).toBe(4);
    const quiet = new SoundDriver(rom().sounds);
    quiet.start(0);
    expect(quiet.status(0)).toBe(1);
    const d = new SoundDriver(rom().sounds);
    d.start(1);
    run(d, 5);
    d.start(0);
    expect(d.status(0)).toBe(0);
  });

  test("the engine's sounds run for their real length, and only one frame's writes are kept", () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true });
    for (let i = 0; i < 200; i++) s.step();
    const e = s.engine;
    e.startSound(13);
    let frames = 0;
    while (e.isSoundRunning(13) && frames < 100) {
      s.step();
      frames++;
    }
    // 46 sixtieths of a second at 4 per frame.
    expect(frames).toBe(12);
    expect(e.sound.out.length).toBe(4);
  });

  test("Ed's theme gives way to the kid's music when his cutscene ends", () => {
    // From a co-op playtest: Bernard (player 1) rings the doorbell; Weird Ed's cutscene plays his
    // theme (78) in his room. When it ends, the original follows Bernard back into his room, whose
    // start swaps 78 for Bernard's theme (73). Here no one re-enters a room, so the engine must.
    // prettier-ignore
    const steps: [number, string, number?, number?][] = [
    [64, 'k'], [1139, 'w', 160, 127], [1147, 'w', 96, 127], [1149, 'w', 0, 116], [1154, 's'],
    [1161, 'w', 120, 127], [1162, 'w', 0, 116], [1176, 's'], [1193, 'v', 13, 258], [1207, 'w', 0, 120],
    [1245, 's'], [1248, 'w', 479, 120], [1252, 's'], [1258, 'w', 0, 120], [1262, 's'],
    [1284, 'w', 0, 120], [1293, 's'], [1304, 'w', 0, 114], [1308, 's'], [1313, 'w', 479, 114],
    [1322, 's'], [1591, 'w', 0, 114], [1594, 's'], [1596, 'w', 479, 114], [1600, 's'],
    [1608, 'w', 72, 127], [1610, 's'], [1611, 'w', 479, 114], [1620, 's'], [1627, 'w', 479, 114],
    [1634, 's'], [1952, 'w', 0, 114], [1955, 'w', 184, 0], [1960, 's'], [1963, 'w', 184, 0],
    [1968, 'w', 248, 68], [1973, 'w', 479, 90], [1975, 's'], [2001, 'v', 9, 394],
    [2044, 'w', 192, 127],
    ];
    const log: [number, Command][] = steps.map(([t, k, a = 0, b = 0]) => [
      t,
      k === 'w' ? { type: 'walk', player: 1, x: a, y: b } : k === 's' ? { type: 'stop', player: 1 } : k === 'k' ? { type: 'skip', player: 1 } : { type: 'sentence', player: 1, verb: a, a: b },
    ]);
    const ls = new Lockstep(rom(), { kids: ['bernard', 'michael'], seed: 3734883858 });
    const s = ls.session;
    ls.replay(log, 2100);
    expect(s.shared()).toBe(0);
    expect(s.engine.isSoundRunning(78)).toBe(1);
    let t = 2100;
    while (s.shared() !== null && t < 2400) ls.replay(log, ++t);
    expect(s.shared()).toBeNull();
    ls.replay(log, t + 5);
    expect(s.engine.isSoundRunning(78)).toBe(0);
    expect(s.engine.isSoundRunning(73)).toBe(1);
    expect(ls.errors).toEqual([]);
  });

  test("when the players take over from the intro, player 1's kid's theme replaces Dave's", () => {
    for (const [kids, theme] of [[['bernard', 'michael'], 73], [['michael', 'bernard'], 77]] as const) {
      const s = new Session(rom(), { kids: [...kids], skipIntro: true });
      for (let n = 0; !s.ready && n < 1000; n++) s.step();
      for (let i = 0; i < 30; i++) s.step();
      expect(s.engine.isSoundRunning(71)).toBe(0);
      expect(s.engine.isSoundRunning(theme)).toBe(1);
    }
  });

  test("music's writes are tagged, so the mix can set it against the effects", () => {
    const d = new SoundDriver(rom().sounds);
    d.start(1);
    const music = run(d, 30).filter((w) => w >> 8 !== 0x15);
    expect(music.length).toBeGreaterThan(0);
    expect(music.every((w) => w & APU_MUSIC)).toBe(true);
    const fx = new SoundDriver(rom().sounds);
    fx.start(13);
    const effect = run(fx, 30).filter((w) => w >> 8 !== 0x15);
    expect(effect.length).toBeGreaterThan(0);
    expect(effect.some((w) => w & APU_MUSIC)).toBe(false);
  });

  test('register writes encode a register and a byte', () => {
    expect(apuWrite(0x15, 0x1ff)).toBe(0x15ff);
  });
});
