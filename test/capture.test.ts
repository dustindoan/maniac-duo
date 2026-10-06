import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('captures', () => {
  test("a kid Ed drags to the dungeon takes their player's view along", () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    // The winning route, up to Bernard waiting by the Hunk-O-Matic, but nobody lures Ed away.
    const route = readFileSync('test/route.txt', 'utf8').split('\n');
    runRoute(d, route.slice(0, route.findIndex((l) => l.startsWith('2 go to 234'))).join('\n'));
    runRoute(
      d,
      `2 go to 234           # out through the grate, then upstairs to join Bernard
       2 go to front door
       2 go to stairs
       2 go to steel security door
       2 go to 194
       2 go to 457
       2 go to 463
       2 go to 109
       1 go to 109
       1 open 462
       2 go to 462
       1 go to 462           # both in Weird Ed's room while he's home: he takes the nearest kid
       1 until a5=4
       1 idle`.replace(/^ +/gm, ''),
    );
    const e = d.e;
    // Ed's capture moves Bernard before its cutscene begins; his player still ends up with him.
    expect(e.actors[e.egoOf(1)].room).toBe(4);
    expect(e.ctxs[1].room).toBe(4);
    expect(e.canAct(1)).toBe(true);
    // Michael, left behind in Ed's room, keeps his own view.
    expect(e.actors[e.egoOf(2)].room).toBe(26);
    expect(d.s.viewRoom(2)).toBe(26);
  });
});
