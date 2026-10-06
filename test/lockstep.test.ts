import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { Lockstep, stateHash } from '../src/engine/lockstep';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('lockstep', () => {
  test('replaying the command log reproduces the game exactly', () => {
    const opts = { kids: ['bernard', 'michael'] as const, skipIntro: true, seed: 7 };
    const live = new Driver(new Session(rom(), { ...opts, kids: [...opts.kids] }));
    const hashes = new Map<number, string>();
    runRoute(live, readFileSync('test/route.txt', 'utf8'), () => hashes.set(live.s.frame, stateHash(live.s)));
    expect(live.won).toBe(true);

    const replica = new Lockstep(rom(), { ...opts, kids: [...opts.kids] });
    const checkpoints = [...hashes.keys()].sort((a, b) => a - b);
    for (const t of checkpoints) {
      replica.replay(live.s.recorded, t);
      expect(stateHash(replica.session), `tick ${t}`).toBe(hashes.get(t)!);
    }
    expect(replica.tick).toBe(live.s.frame);
  });

  test('a different seed gives a different world (codes are randomized at boot)', () => {
    const a = new Session(rom(), { kids: ['bernard', 'michael'], seed: 1, skipIntro: true });
    const b = new Session(rom(), { kids: ['bernard', 'michael'], seed: 2, skipIntro: true });
    for (let i = 0; i < 200; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});
