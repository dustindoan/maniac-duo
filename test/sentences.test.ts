import { describe, expect, test } from 'bun:test';
import { Driver, VERB_IDS } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('sentences', () => {
  test("one player's sentence doesn't trip up the other's", () => {
    // Bernard waits at the mansion; Michael sets off for it from the yard. The sentence script keeps
    // the thing it walks to in a variable while the kid walks; Bernard opening the bushes meanwhile
    // must not change where Michael thinks he's going.
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, '1 go to 258');
    expect(d.room(1)).toBe(1);
    expect(d.s.apply({ type: 'sentence', player: 2, verb: VERB_IDS['go to'], a: 258 })).toBe(true);
    d.step(5);
    expect(d.s.apply({ type: 'sentence', player: 1, verb: VERB_IDS.open, a: 562 })).toBe(true);
    d.idle(2);
    d.idle(1);
    expect(d.room(2)).toBe(1);
    expect(d.log.map((l) => l.text).join(' ')).not.toContain("I can't reach it.");
  });

  test('"Go to <person>" walks up beside them', () => {
    // The game's scripts ignore Go to on a person, so the engine walks the kid over instead.
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    d.idle(1);
    const e = d.s.engine;
    const bernard = e.actors[e.egoOf(1)];
    const michael = e.actors[e.egoOf(2)];
    expect(d.s.apply({ type: 'walk', player: 2, x: Math.max(0, michael.x - 40) * 8, y: michael.y * 2 })).toBe(true);
    d.idle(2);
    expect(bernard.room).toBe(michael.room);
    expect(Math.abs(bernard.x - michael.x)).toBeGreaterThan(10);
    expect(d.s.apply({ type: 'sentence', player: 1, verb: VERB_IDS['go to'], a: michael.id })).toBe(true);
    d.idle(1);
    expect(Math.abs(bernard.x - michael.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(bernard.y - michael.y)).toBeLessThanOrEqual(4);
  });
});
