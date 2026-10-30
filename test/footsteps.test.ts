import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { Footfalls } from '../src/web/footsteps';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('footsteps', () => {
  test('a step every other walking frame, alternating feet, none standing or off screen', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, '2 go to 258'); // Michael goes up to the porch; Bernard stays in the yard
    expect(d.room(2)).not.toBe(d.room(1));
    const bernard = d.e.actors[d.e.egoOf(1)];
    const mine = new Footfalls();
    const michaels = new Footfalls();
    d.s.apply({ type: 'walk', player: 1, x: (bernard.x + 6) * 8, y: bernard.y * 2 });
    const feet: number[] = [];
    for (let i = 0; i < 20; i++) {
      d.step();
      feet.push(...mine.update(d.s, [1]).filter((x) => x.actor === bernard.id).map((x) => x.foot));
      expect(michaels.update(d.s, [2]).filter((x) => x.actor === bernard.id)).toEqual([]);
    }
    expect(feet.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < feet.length; i++) expect(feet[i]).toBe(1 - feet[i - 1]);
    expect(bernard.moving).toBe(0);
    d.step(5);
    expect(mine.update(d.s, [1])).toEqual([]);
  });
});
