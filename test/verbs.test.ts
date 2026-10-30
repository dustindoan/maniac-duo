import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { VERB, affordances, pairSentence } from '../src/verbs/affordances';
import { suggestions } from '../src/verbs/focus';
import { haveRom, rom } from './rom-fixture';

const labels = (d: Driver, obj: number) => affordances(d.e, 1, obj).map((a) => a.label);

describe.skipIf(!haveRom)('verb system', () => {
  const game = (steps: string) => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, steps);
    return d;
  };

  test('only the verbs an object handles, and only the half of a toggle that applies', () => {
    const d = game('1 go to 258');
    expect(labels(d, 54)).toEqual(['Pull', 'Read']); // door mat, lying flat: no Push, Get is Pull's twin
    runRoute(d, '1 pull door mat');
    expect(labels(d, 54)).toEqual(['Push', 'Read']);
    expect(labels(d, 55)).toEqual(['Get', 'Use']); // the key under it
    expect(labels(d, 61)).toEqual(['Open', 'Use']); // locked front door: no Close, and not Go to yet
    runRoute(d, '1 get key\n1 use key with front door');
    expect(labels(d, 61)).toEqual(['Go to', 'Close', 'Use']);
  });

  test('Turn on and Turn off are both offered, whatever the object\'s own state says', () => {
    // The light switch keeps the room's lights in a bit variable, never in its own state; the TV
    // does use its own state. Both offer both halves either way.
    const d = game('1 go to 258');
    for (const obj of [335, 190]) {
      expect(labels(d, obj)).toEqual(expect.arrayContaining(['Turn on', 'Turn off']));
      d.e.state[obj] |= 8;
      expect(labels(d, obj)).toEqual(expect.arrayContaining(['Turn on', 'Turn off']));
    }
  });

  test('items in your inventory drop Get; dragging means Give to people, Use on things', () => {
    const d = game('1 go to 258\n1 pull door mat\n1 get key');
    expect(labels(d, 55)).toEqual(['Use']);
    expect(pairSentence(d.e, 55, 61)).toEqual({ verb: VERB.use, a: 55, b: 61 });
    expect(pairSentence(d.e, 55, 4)).toEqual({ verb: VERB.give, a: 55, b: 4 });
  });

  test('suggestions put the newly revealed pickup first', () => {
    const d = game('1 go to 258\n1 pull door mat');
    const s = suggestions(d.e, 1, null).map((x) => x.label);
    expect(s[0]).toBe('Get key');
    expect(s).toContain('Push door mat');
  });

  test("suggestions offer all of one thing's verbs before the next thing's", () => {
    const d = game('1 go to 258\n1 pull door mat');
    const ids = suggestions(d.e, 1, null).map((x) => x.target.id);
    expect(new Set(ids).size).toBeLessThan(ids.length); // something has more than one verb here
    // Each thing appears in one unbroken run.
    const runs = ids.filter((id, i) => i === 0 || ids[i - 1] !== id);
    expect(new Set(runs).size).toBe(runs.length);
  });

  test('holding an item turns suggestions into "use with" for nearby things', () => {
    const d = game('1 go to 258\n1 pull door mat\n1 get key');
    const s = suggestions(d.e, 1, 55).map((x) => x.label);
    expect(s).toContain('Use key with front door');
  });
});
