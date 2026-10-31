import { describe, expect, test } from 'bun:test';
import { Session } from '../src/engine/session';
import { RULES } from '../src/story';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('intro', () => {
  // Found in a browser test: a second skip just after the title landed in kid selection, whose
  // script keeps an override set, and jumped past it. The selection stayed frozen for good.
  test('pressing skip over and over through the title and selection still starts the game', () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'], seed: 335234277, rules: RULES });
    for (let f = 1; f <= 1000 && !s.ready; f++) {
      if (f >= 190 && f % 8 === 0) s.apply({ type: 'skip', player: 1 });
      s.step();
    }
    expect(s.ready).toBe(true);
    expect([s.engine.canAct(1), s.engine.canAct(2)]).toEqual([true, true]);
  });
});
