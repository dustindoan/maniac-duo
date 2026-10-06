import { describe, expect, test } from 'bun:test';
import { identify, loadRom, stripHeader } from '../src/rom/rom';
import { readFileSync } from 'node:fs';
import { ROM_PATH, haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('ROM', () => {
  test('identifies the USA release with or without the iNES header', () => {
    const file = new Uint8Array(readFileSync(ROM_PATH));
    expect(identify(file)).toBe('USA');
    expect(identify(stripHeader(file))).toBe('USA');
  });

  test('rejects anything else', () => {
    expect(identify(new Uint8Array(0x40000))).toBeNull();
    expect(() => loadRom(new Uint8Array(1024))).toThrow();
  });

  test('parses rooms, objects and their verb tables', () => {
    const r = rom();
    expect(r.rooms.filter(Boolean)).toHaveLength(54);
    const front = r.rooms[1]!;
    expect(front.width).toBe(60);
    const key = front.objects.find((o) => o.id === 55)!;
    expect(String.fromCharCode(...key.name)).toBe('key');
    expect(key.verbs.map(([v]) => v).sort()).toEqual([11, 14]);
    expect(r.prepositions).toEqual(['in', 'with', 'on', 'to']);
    expect(r.objectFlags).toHaveLength(775);
  });
});
