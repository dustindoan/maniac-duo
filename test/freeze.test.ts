import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver, VERB_IDS } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('freezes', () => {
  test('a keypad opened just as a world cutscene starts does not stop it', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    const e = d.e;
    // The winning route up to Bernard waiting by the Hunk-O-Matic; then he fixes the radio while
    // Michael comes out to the front door.
    const route = readFileSync('test/route.txt', 'utf8').split('\n');
    runRoute(d, route.slice(0, route.findIndex((l) => l.startsWith('2 go to 234'))).join('\n'));
    runRoute(
      d,
      `2 go to 234
       1 go to 109
       1 open 460
       1 go to 460
       1 use radio tube with tube socket
       1 turn on radio`.replace(/^ +/gm, ''),
    );
    // Michael rings. 77 frames later Bernard picks up the radio; its dial pad freezes the world's
    // scripts in the very frame Ed's "Oh, the doorbell!" cutscene begins. Nobody skips anything.
    expect(d.s.apply({ type: 'sentence', player: 2, verb: VERB_IDS.push, a: d.obj(2, 'doorbell') })).toBe(true);
    const radio = d.obj(1, 'radio');
    const heldByBernard = () => e.slots.some((s) => s.number && s.ctx === 0 && s.held & 2);
    const frozenByBernard = () => e.slots.some((s) => s.number && s.ctx === 0 && s.frozen & 2);
    let raced = false;
    let started = false;
    for (let frames = 0; !started || e.ctxs[0].cutscene; frames++) {
      if (frames === 77) expect(d.s.apply({ type: 'sentence', player: 1, verb: VERB_IDS.use, a: radio })).toBe(true);
      d.step();
      started ||= e.ctxs[0].cutscene;
      if (e.ctxs[0].cutscene && heldByBernard()) raced = true;
      expect(frames, 'the world cutscene never ended').toBeLessThan(2000);
    }
    expect(raced).toBe(true);
    // Bernard's freeze was put off, not dropped: still on the dial pad, he holds the world again.
    expect(e.ctxVar(1, 21)).toBe(3);
    expect(e.canAct(1)).toBe(true);
    expect(frozenByBernard()).toBe(true);
    // Once he dials, the world moves again and Ed comes down to answer the door.
    d.dial(1, 77);
    expect(frozenByBernard()).toBe(false);
    let edAtDoor = false;
    for (let i = 0; i < 3000 && !edAtDoor; i++) {
      d.step();
      edAtDoor = e.actors[11].room === 1;
    }
    expect(edAtDoor).toBe(true);
  });
});
