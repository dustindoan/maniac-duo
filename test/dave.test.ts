// Dave goes on ahead after the intro, waits in the dungeon, and holds the loose brick (src/story).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { putActor } from '../src/engine/engine';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { RULES } from '../src/story';
import { takesGifts } from '../src/verbs/affordances';
import { suggestions } from '../src/verbs/focus';
import { haveRom, rom } from './rom-fixture';

const DAVE = 3;
const CELL_DOOR = 159;
const PUSHER = 214;
const OPEN = 8;

const route = readFileSync('test/route.txt', 'utf8').split('\n');

/** A game in which Nurse Edna has just caught Bernard (the winning route, up to the dungeon). */
function caught() {
  const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true, rules: RULES }));
  runRoute(d, route.slice(0, route.findIndex((l) => l.startsWith('# --- In the dungeon'))).join('\n'));
  expect(d.room(1)).toBe(4);
  return { d, e: d.e, dave: d.e.actors[DAVE] };
}

describe.skipIf(!haveRom)('Dave', () => {
  test('walks off toward the house after the intro, and waits in the dungeon', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true, rules: RULES }));
    d.start();
    const dave = d.e.actors[DAVE];
    expect(dave.room).toBe(44);
    const from = dave.x;
    d.step(10);
    expect(dave.x).toBeLessThan(from);
    expect(d.e.canAct(1) && d.e.canAct(2)).toBe(true);
    for (let n = 0; dave.room === 44 && n < 300; n++) d.step();
    expect([dave.room, dave.x, dave.y]).toEqual([4, 40, 60]);
  });

  test('stays in the front yard in games with the original story', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    d.start();
    d.step(300);
    expect(d.e.actors[DAVE].room).toBe(44);
  });

  test('the first time, the kid asks him to hold the brick, and walks out', () => {
    const { d, e, dave } = caught();
    expect([dave.room, dave.x, dave.y]).toEqual([4, 40, 60]);
    const said = d.do(1, 'push', 'loose brick').join(' | ');
    expect(said).toContain('Bernard: Dave! Can you hold this\nbrick in for me?');
    expect(said).toContain('Dave: Sure. Go find Sandy!');
    expect(e.getState(CELL_DOOR) & OPEN).toBe(OPEN);
    expect(e.vars[PUSHER]).toBe(DAVE);
    expect([dave.x, dave.y]).toEqual([27, 56]);

    d.do(1, 'go to', 'door');
    expect(d.room(1)).toBe(8);
    expect(e.getState(CELL_DOOR) & OPEN).toBe(0);
    d.step(2);
    // Nobody is left in the dungeon to watch him walk, so he's simply back.
    expect([dave.room, dave.x, dave.y]).toEqual([4, 40, 60]);
  });

  test('skipping that scene leaves him holding the brick all the same', () => {
    const { d, e, dave } = caught();
    d.do(1, 'push', 'loose brick', undefined, { skip: true });
    expect(e.vars[PUSHER]).toBe(DAVE);
    expect(e.getState(CELL_DOOR) & OPEN).toBe(OPEN);
    expect([dave.x, dave.y]).toEqual([27, 56]);
    d.do(1, 'go to', 'door');
    expect(d.room(1)).toBe(8);
  });

  test('after that, he comes over without a word, and the door opens at once', () => {
    const { d, e, dave } = caught();
    d.do(1, 'push', 'loose brick');
    d.do(1, 'close', 'door');
    expect(e.getState(CELL_DOOR) & OPEN).toBe(0);
    d.step(40);
    expect([dave.x, dave.y]).toEqual([40, 60]);

    d.do(1, 'go to', 'loose brick');
    const before = d.log.length;
    d.s.apply({ type: 'sentence', player: 1, verb: 9, a: 453 });
    for (let n = 0; e.vars[PUSHER] !== DAVE && n < 100; n++) d.step();
    expect(e.vars[PUSHER]).toBe(DAVE);
    expect(e.getState(CELL_DOOR) & OPEN).toBe(OPEN);
    expect(e.ctxs[1].cutscene).toBe(false);
    expect(e.canAct(1)).toBe(true);
    expect(dave.moving).toBeTruthy();

    // Bernard doesn't wait for him.
    d.do(1, 'go to', 'door');
    expect(d.room(1)).toBe(8);
    expect(d.log.slice(before).map((l) => l.text).join(' | ')).not.toContain('Dave:');
  });

  test('without him in the dungeon, the brick works as it always did', () => {
    const { d, e, dave } = caught();
    putActor(e, dave, 0, 0, 0);
    d.do(1, 'push', 'loose brick');
    expect(e.vars[PUSHER]).toBe(e.egoOf(1));
    d.do(1, 'go to', 'door');
    expect(d.room(1)).toBe(4);
    expect(e.getState(CELL_DOOR) & OPEN).toBe(0);
  });

  test('is never offered things to give him: nobody could take them back', () => {
    const { d, e } = caught();
    d.do(1, 'go to', 'Dave');
    const items = e.inventoryOf(e.egoOf(1));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(suggestions(e, 1, item).map((s) => s.target.id)).not.toContain(DAVE);
    expect(takesGifts(e, DAVE)).toBe(false);
    expect(takesGifts(e, e.egoOf(2))).toBe(true);
  });
});
