import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { Session } from '../src/engine/session';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('dialogue', () => {
  test('speakers alternate yellow and white, narration is yellow, and no names are shown', () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true });
    new Driver(s).idle(1);
    const e = s.engine;
    const say = (actor: number, text: string) => {
      e.switchCtx(1);
      e.actorTalk(actor, new TextEncoder().encode(text));
      e.switchCtx(0);
      const line = s.dialogueFor(1).find((l) => l.text === text)!;
      return line.color;
    };
    const bernard = e.egoOf(1);
    const michael = e.egoOf(2);
    expect(e.actors[bernard].room).toBe(e.actors[michael].room);
    const first = say(bernard, 'Hello');
    expect(say(michael, 'Hi there')).toBe(1 - first);
    expect(say(michael, 'Again')).toBe(1 - first); // same speaker, same colour
    expect(say(bernard, 'Bye')).toBe(first);
    expect(say(0xff, 'Meanwhile')).toBe(0);
    expect(s.dialogueFor(1).map((l) => l.text)).toContain('Meanwhile');
    expect(s.messagesFor(1).join(' ')).not.toContain('Bernard: Meanwhile');
  });
});
