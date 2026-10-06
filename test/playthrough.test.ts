// Acceptance test: two players -- Bernard and Michael -- beat the game with the original scripts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { type RouteStep, runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { affordances, describe as sentence, pairSentence } from '../src/verbs/affordances';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('playthrough', () => {
  test('Bernard and Michael beat the game, each controlled by their own player', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    // Every sentence must be one the interface offers: a tap-menu verb, or a drag of an item onto a target.
    d.validate = (p, verb, a, b) => {
      if (b) {
        const pair = pairSentence(d.e, a, b);
        expect(`${pair.verb}/${pair.a}/${pair.b}`, sentence(d.e, verb, a, b)).toBe(`${verb}/${a}/${b}`);
      } else {
        const offered = affordances(d.e, p, a).map((x) => x.verb);
        expect(offered, `${sentence(d.e, verb, a)} (offered ${offered})`).toContain(verb);
      }
    };
    const steps: RouteStep[] = [];
    const daveRooms = new Set<number>();
    runRoute(d, readFileSync('test/route.txt', 'utf8'), (s) => {
      steps.push(s);
      if (!d.won) daveRooms.add(d.e.actors[3].room);
    });

    expect(d.won).toBe(true);
    const said = (p: number) => steps.filter((s) => s.player === p).flatMap((s) => s.output).join(' ').replace(/\s+/g, ' ');
    // Michael's half: the tentacle, the Hunk-O-Matic, the grating.
    expect(said(2)).toContain("WOW! My favorite!");
    expect(said(2)).toContain('Ah. I feel much stronger!');
    expect(said(2)).toContain('Easy!');
    // Bernard's half: the poster, the dungeon, Purple Tentacle.
    expect(said(1)).toMatch(/If found, call \d{4}\./);
    expect(said(1)).toContain('You\'re with the Meteor Police!!');
    expect(steps.filter((s) => s.player === 2).length).toBeGreaterThan(20);
    // Nobody plays Dave: he stays in the front yard where the intro left him.
    expect([...daveRooms]).toEqual([44]);
  });
});
