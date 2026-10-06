import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { type Command, Session } from '../src/engine/session';
import { NES_BLACK, surface } from '../src/gfx/nes';
import { FRAME_H, FRAME_W, GAP, HALF_H, SCENE_H, type View, ViewRenderer } from '../src/gfx/view';
import { VERB } from '../src/verbs/affordances';
import { PlayerUI } from '../src/web/player-ui';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('layout', () => {
  const game = (steps = '') => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, steps);
    return d;
  };
  const frame = (d: Driver) => {
    const f = surface(FRAME_W, FRAME_H);
    const views = new ViewRenderer(rom()).drawFrame(d.s, f, (p) => `PLAYER ${p}`);
    return { f, views };
  };
  /** Is player p's kid standing (feet) inside their view? */
  const feetShown = (d: Driver, v: View, p: number) => {
    const kid = d.e.actors[d.e.egoOf(p)];
    const y = kid.y * 2;
    return kid.room === v.room && y >= v.scrollY && y < v.scrollY + v.scene.h;
  };

  test('split screen: each player gets half of one 4:3 NES frame, cropped to keep their kid in view', () => {
    const d = game();
    const { f, views } = frame(d);
    expect([f.w, f.h]).toEqual([256, 240]);
    expect(views.map((v) => v.shared)).toEqual([false, false]);
    expect(views.map((v) => v.area)).toEqual([
      { x: 0, y: 0, w: 256, h: HALF_H },
      { x: 0, y: HALF_H + GAP, w: 256, h: HALF_H },
    ]);
    // The original 224px view, between 16px borders, with all but ten of the room's rows.
    for (const v of views) expect(v.scene).toEqual({ x: 16, y: v.area.y, w: 224, h: HALF_H });
    expect(SCENE_H - HALF_H).toBe(10);
    expect(views.every((v, i) => feetShown(d, v, i + 1))).toBe(true);
    // At the bottom of the lawn the half shows the lowest rows instead.
    runRoute(d, '1 walk 80,127');
    const low = frame(d).views[0];
    expect(low.scrollY).toBe(10);
    expect(feetShown(d, low, 1)).toBe(true);
  });

  test('a world cutscene fills the screen for both players', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'] })); // with the intro
    while (!(d.e.ctxs[0].cutscene && d.e.ctxs[0].room)) d.step();
    expect(d.s.shared()).toBe(0);
    const { views } = frame(d);
    expect(views.map((v) => v.shared)).toEqual([true, true]);
    expect(views[0].room).toBe(d.e.ctxs[0].room);
    expect(views[1].room).toBe(views[0].room);
    // The original arrangement: the whole 224x128 room below the dialogue, and nothing under it.
    expect(views[0].scene).toEqual({ x: 16, y: 40, w: 224, h: 128 });
    expect(views[0].scrollY).toBe(0);
    const { f } = frame(d);
    expect([...f.px.subarray((40 + 128) * FRAME_W)].every((c) => c === NES_BLACK)).toBe(true);
  });

  test("a player's cut-away fills the screen for both, and the other player waits", () => {
    // Opening the front door starts Dr. Fred's timer in Bernard's context; minutes later it cuts away
    // to Sandy in the lab: Bernard's own cutscene, in a room neither kid is in.
    const d = game('1 go to 258\n1 pull door mat\n1 get key\n1 use key with front door\n1 go to front door');
    const e = d.e;
    for (let n = 0; !e.cutAway(); n++) {
      expect(n).toBeLessThan(8000);
      d.step();
    }
    d.step(60);
    expect(e.cutAway()).toBe(1);
    expect(d.s.shared()).toBe(1);
    expect([d.s.viewRoom(1), d.s.viewRoom(2)]).toEqual([31, 31]);
    expect(frame(d).views.map((v) => v.shared)).toEqual([true, true]);
    expect(d.s.messagesFor(2).join(' ')).toContain('Hope you');
    expect(e.canAct(2)).toBe(false);
    // Either player can skip what everyone is watching.
    expect(d.s.apply({ type: 'skip', player: 2 })).toBe(true);
    d.step(10);
    expect(d.s.shared()).toBeNull();
    expect([e.canAct(1), e.canAct(2)]).toEqual([true, true]);
    expect(d.s.viewRoom(1)).toBe(e.actors[e.egoOf(1)].room);
  });

  test('player 2 can click on people in their half', () => {
    const d = game();
    const sent: Command[] = [];
    const ui = new PlayerUI(2, () => d.s, (c) => sent.push(c));
    ui.view = frame(d).views[1];
    const dave = ui.view.actors.find((a) => a.actor === 3)!;
    expect(dave).toBeDefined();
    const x = ui.view.scene.x + ((dave.x0 + dave.x1) >> 1) - ui.view.scrollX;
    const y = ui.view.scene.y + ((dave.y0 + dave.y1) >> 1) - ui.view.scrollY;
    expect(y).toBeGreaterThanOrEqual(ui.view.area.y); // in player 2's half of the frame
    ui.click(x, y);
    expect(sent).toEqual([{ type: 'sentence', player: 2, verb: VERB.goTo, a: 3, b: 0 }]);
  });
});
