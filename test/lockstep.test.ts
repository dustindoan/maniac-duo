import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { Lockstep, stateHash } from '../src/engine/lockstep';
import { runRoute } from '../src/engine/route';
import { type Command, Session } from '../src/engine/session';
import { RULES } from '../src/story';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('lockstep', () => {
  test('replaying the command log reproduces the game exactly', () => {
    const opts = { kids: ['bernard', 'michael'] as const, skipIntro: true, seed: 7, rules: RULES };
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
    expect(replica.errors).toEqual([]);
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

  test("a command the engine throws on doesn't stop the game, now or on replay", () => {
    const opts = { kids: ['bernard', 'michael'] as ('bernard' | 'michael')[], skipIntro: true, seed: 3 };
    const log: [number, Command][] = [
      [5, { type: 'sentence', player: 1, verb: 13, a: 9999 }],
      [6, { type: 'walk', player: 2, x: 100, y: 120 }],
    ];
    const boom = (ls: Lockstep) => {
      const real = ls.session.engine.sentence.bind(ls.session.engine);
      ls.session.engine.sentence = (p, verb, a, b) => {
        if (a === 9999) throw new Error('boom');
        return real(p, verb, a, b);
      };
      return ls;
    };
    const a = boom(new Lockstep(rom(), opts));
    const b = boom(new Lockstep(rom(), opts));
    a.replay(log, 300);
    b.replay(log, 300);
    expect(a.tick).toBe(300);
    expect(a.errors.map((x) => x.tick)).toEqual([5]);
    expect(stateHash(b.session)).toBe(stateHash(a.session));
  });
});
