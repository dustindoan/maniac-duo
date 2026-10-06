import { describe, expect, test } from 'bun:test';
import { adjustXYToBeInBox, startWalkActor, walkActor, walkRoute } from '../src/engine/actor';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { dpadTarget } from '../src/verbs/focus';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('D-pad walking', () => {
  const game = (steps: string) => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, steps);
    return d;
  };

  /** Player 1 presses a direction: every spot their kid passes through on the walk it starts. */
  const press = (d: Driver, dx: number, dy: number) => {
    const a = d.e.actors[d.e.egoOf(1)];
    const t = dpadTarget(d.e, 1, dx, dy)!;
    const path = [[a.x, a.y]];
    expect(d.s.apply({ type: 'walk', player: 1, x: t.x, y: t.y })).toBe(true);
    for (let i = 0; i < 300 && (i < 2 || a.moving); i++) {
      d.step();
      const [x, y] = path[path.length - 1];
      if (a.x !== x || a.y !== y) path.push([a.x, a.y]);
    }
    return path;
  };

  test('up from the lawn in front of the yard fence walks straight up to it', () => {
    const d = game('1 walk 80,120');
    const path = press(d, 0, -1);
    expect(d.room(1)).toBe(44);
    expect(path[0]).toEqual([10, 60]);
    expect(path.every(([x]) => x === 10)).toBe(true); // not round the end of the fence and back
    expect(path[path.length - 1]).toEqual([10, 55]);
  });

  test('up the slanted porch steps still follows them', () => {
    const d = game('1 go to 258\n1 walk 152,104');
    const path = press(d, 0, -1);
    expect(d.room(1)).toBe(1);
    expect(path[0]).toEqual([19, 52]);
    expect(path).toContainEqual([20, 43]);
    expect(path[path.length - 1]).toEqual([19, 41]);
  });

  test('a diagonal into the fence slides along it', () => {
    const d = game('1 walk 80,94'); // behind the fence
    const path = press(d, -1, -1);
    expect(path[0]).toEqual([10, 47]);
    expect(path.every(([, y]) => y === 47)).toBe(true);
    expect(path[path.length - 1]).toEqual([2, 47]);
  });

  test("walkRoute predicts the engine's own walk", () => {
    const d = game('1 go to 258');
    const e = d.e;
    const a = e.actors[e.egoOf(1)];
    const { width } = e.loadedRoom(a.room)!.room;
    let walks = 0;
    for (let y = 0; y < 64; y += 3)
      for (let x = 0; x < width; x += 3)
        for (const [tx, ty] of [[0, 0], [width - 1, 0], [0, 63], [width - 1, 63], [x, 0], [x, 63]]) {
          const at = adjustXYToBeInBox(e, a, x, y);
          Object.assign(a, { x: at.x, y: at.y, walkbox: at.box, moving: 0 });
          const route = walkRoute(e, a, tx, ty).map((p) => `${p.x},${p.y}`);
          startWalkActor(e, a, tx, ty, -1);
          const walked = [`${a.x},${a.y}`];
          for (let i = 0; i < 2000 && a.moving; i++) {
            walkActor(e, a);
            if (`${a.x},${a.y}` !== walked[walked.length - 1]) walked.push(`${a.x},${a.y}`);
          }
          // The walk passes every predicted corner in order and stops at the last one.
          let i = 0;
          for (const p of route) while (i < walked.length && walked[i] !== p) i++;
          expect(i, `predicted ${route.join(' ')}, walked ${walked.join(' ')}`).toBeLessThan(walked.length);
          expect(walked[walked.length - 1]).toBe(route[route.length - 1]);
          walks++;
        }
    expect(walks).toBeGreaterThan(1000);
  });
});
