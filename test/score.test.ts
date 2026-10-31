import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { BEATS, ITEMS, ITEM_POINTS, MAX_POINTS, pointsOf } from '../src/score/table';
import { RULES } from '../src/story';
import { haveRom, rom } from './rom-fixture';

describe('score table', () => {
  test('the maximum is every item and every beat', () => {
    expect(MAX_POINTS).toBe(ITEMS.length * ITEM_POINTS + Object.values(BEATS).reduce((n, b) => n + b.points, 0));
    expect(new Set(ITEMS).size).toBe(ITEMS.length);
    expect([pointsOf('won'), pointsOf(`item:${ITEMS[0]}`), pointsOf('item:46'), pointsOf('bogus')]).toEqual([2500, 25, null, null]);
  });
});

describe.skipIf(!haveRom)('scorer', () => {
  test('the winning route scores its items and beats, in order, and nothing before the players take over', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true, rules: RULES }));
    runRoute(d, readFileSync('test/route.txt', 'utf8'));
    const s = d.s.scorer;
    const beats = s.reached.filter((m) => !m.id.startsWith('item:')).map((m) => m.id);
    expect(beats).toEqual(['door', 'police', 'tentacle', 'won']);
    const items = s.reached.filter((m) => m.id.startsWith('item:')).map((m) => Number(m.id.slice(5)));
    expect(items).toEqual(expect.arrayContaining([55, 158, 73, 141, 104, 214]));
    expect(items).not.toContain(48); // Bernard's CD player, from the intro
    expect(s.points).toBe(s.reached.reduce((n, m) => n + pointsOf(m.id)!, 0));
    expect(s.reached.map((m) => m.tick)).toEqual([...s.reached.map((m) => m.tick)].sort((a, b) => a - b));
  });
});
