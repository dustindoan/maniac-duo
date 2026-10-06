import { describe, expect, test } from 'bun:test';
import { Session } from '../src/engine/session';
import { NewLines, speakable } from '../src/web/voices';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('voices', () => {
  test("characters' lines are spoken once each as they appear; narration is not", () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'] }); // with the intro
    const lines = new NewLines();
    const said: string[] = [];
    for (let i = 0; i < 1500; i++) {
      s.step();
      for (const l of lines.update(s, [1])) said.push(`${l.actor}:${l.text}`);
    }
    // Dave's speech in the intro, each line once and in order; Bernard's reply; no narration.
    expect(said.slice(0, 3)).toEqual(['3:Ok! This looks like the\nold mansion.', '3:I\'m sure I saw Dr. Fred take\nSandy here.', "3:It's up to us to get her out."]);
    expect(said).toContain("5:Ok, I'm outta here!");
    expect(new Set(said).size).toBe(said.length);
    expect(said.some((l) => l.startsWith('255:'))).toBe(false);
  });

  test('NES text made speakable', () => {
    expect(speakable("If anyone wants out^")).toBe('If anyone wants out...');
    expect(speakable("BERNARD!\nDon't be a tuna head!")).toBe("BERNARD! Don't be a tuna head!");
  });
});
