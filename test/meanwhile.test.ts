import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { MEANWHILE, Session } from '../src/engine/session';
import { NES_BLACK, surface } from '../src/gfx/nes';
import { FRAME_H, FRAME_W, ViewRenderer, WHITE } from '../src/gfx/view';
import { haveRom, rom } from './rom-fixture';

const TOTAL = 2 * MEANWHILE.fade + MEANWHILE.hold;

describe.skipIf(!haveRom)('meanwhile card', () => {
  /** A game in play, with Weird Ed's "I'm coming!" world cutscene (script 97) about to take over the screen. */
  const edScene = (kidsInEdsRoom = false) => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true });
    new Driver(s).idle(1);
    for (let n = 0; !s.ready && n < 100; n++) s.step();
    expect(s.ready).toBe(true);
    let renderer: ViewRenderer | null = null;
    const frame = surface(FRAME_W, FRAME_H);
    const draw = () => {
      renderer ??= new ViewRenderer(rom());
      return renderer.drawFrame(s, frame, () => '');
    };
    draw(); // the split screen the card fades out from
    s.engine.runScript(97, false, false);
    if (kidsInEdsRoom) for (const p of [1, 2]) s.engine.actors[s.engine.egoOf(p)].room = 26;
    for (let n = 0; s.shared() === null && n < 200; n++) {
      s.step();
      draw();
    }
    expect(s.shared()).toBe(0);
    return { s, frame, draw };
  };

  test('the world waits while the card shows, then the scene plays', () => {
    const { s } = edScene();
    const e = s.engine;
    expect(s.meanwhile).toBe(TOTAL);
    const at = e.frame;
    for (let i = 0; i < TOTAL; i++) {
      expect(e.canAct(1) || e.canAct(2)).toBe(false);
      s.step();
    }
    expect(e.frame).toBe(at);
    expect(s.meanwhile).toBe(0);
    s.step();
    expect(e.frame).toBe(at + 1);
  });

  test('skipping during the card ends it, even for a scene that cannot be skipped', () => {
    // Script 97 has no override: the scene itself plays on.
    const { s } = edScene();
    s.step();
    expect(s.apply({ type: 'skip', player: 2 })).toBe(true);
    expect(s.meanwhile).toBe(0);
    expect(s.engine.ctxs[0].cutscene).toBe(true);
  });

  test('the screen fades out, says "Meanwhile", and fades the scene in', () => {
    const { s, frame, draw } = edScene();
    const lum = () => Math.max(...[...frame.px].filter((c) => c !== NES_BLACK).map((c) => c >> 4), -1);
    // First frame of the fade: everything a step darker than the brightest NES colours.
    const views = draw();
    expect(views.every((v) => v.shared)).toBe(true);
    expect(lum()).toBeLessThanOrEqual(2);
    // Then the card: black, with white text in the middle rows only.
    for (let i = 0; i < MEANWHILE.fade + 2; i++) s.step();
    draw();
    const lit = [...frame.px].map((c, i) => (c === NES_BLACK ? -1 : i)).filter((i) => i >= 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.every((i) => frame.px[i] === WHITE)).toBe(true);
    const rows = new Set(lit.map((i) => Math.floor(i / FRAME_W)));
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(FRAME_H / 2 - 8);
    expect(Math.max(...rows)).toBeLessThan(FRAME_H / 2 + 8);
    // Last frame of the fade-in: the scene, one step dark; then the scene itself.
    while (s.meanwhile > 1) s.step();
    draw();
    const dim = lum();
    s.step();
    draw();
    expect(lum()).toBe(dim + 1);
  });

  test('"Meanwhile" is only for players whose kid is elsewhere', () => {
    const { s, frame } = edScene();
    expect(s.card.present).toEqual([false, false]);
    for (let i = 0; i < MEANWHILE.fade + 2; i++) s.step();
    // Is there white text on the card's hold, drawn for these viewers?
    const text = (viewers: number[]) => {
      new ViewRenderer(rom()).drawFrame(s, frame, () => '', viewers);
      return [...frame.px].some((c) => c === WHITE);
    };
    expect(text([1])).toBe(true);
    // Bernard is in the scene (say, just caught): he sees only the fade; Michael is told.
    s.card.present = [true, false];
    expect(text([1])).toBe(false);
    expect(text([2])).toBe(true);
    // One screen for both: no "Meanwhile" if either of them is in the scene.
    expect(text([1, 2])).toBe(false);
  });

  test('when every kid is in the scene there is no card to hold, just the fade', () => {
    const { s } = edScene(true);
    expect(s.card).toEqual({ hold: 0, present: [true, true] });
    expect(s.meanwhile).toBe(2 * MEANWHILE.fade);
  });
});
