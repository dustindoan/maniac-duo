import { describe, expect, test } from 'bun:test';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('restart', () => {
  test('"Press B to play again" after a game over starts a new game with the same kids', () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true, seed: 5 });
    for (let n = 0; !s.ready && n < 1000; n++) s.step();
    const first = s.engine;
    const code = [77, 78, 79, 80].map((v) => first.vars[v]).join('');
    // The meltdown ending (script 62 with Var[97] = 3): its override restarts the game.
    first.vars[97] = 3;
    first.runScript(62, false, false);
    for (let i = 0; i < 60; i++) s.step();
    expect(s.shared()).not.toBeNull();
    expect(s.apply({ type: 'skip', player: 1 })).toBe(true);
    for (let i = 0; i < 20 && !s.restarts; i++) s.step();
    expect(s.restarts).toBe(1);
    expect(s.engine).not.toBe(first);
    expect(s.ready).toBe(false);
    for (let n = 0; !s.ready && n < 2000; n++) s.step();
    expect(s.ready).toBe(true);
    const e = s.engine;
    expect([e.egoOf(1), e.egoOf(2)]).toEqual([5, 4]);
    expect(e.canAct(1) && e.canAct(2)).toBe(true);
    // A new seed: the randomised codes (the Meteor Police number) come out differently.
    expect([77, 78, 79, 80].map((v) => e.vars[v]).join('')).not.toBe(code);
  });
});
