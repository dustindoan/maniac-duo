import { describe, expect, test } from 'bun:test';
import { decode, disassemble, decodeString } from '../src/engine/bytecode';
import { haveRom, rom } from './rom-fixture';

describe('bytecode', () => {
  test('decodes operand forms', () => {
    // move Var[11] = 25 ; isEqual Var[1], 0 -> jump ; stopObjectCode
    const code = new Uint8Array([0x1a, 11, 25, 0, 0x48, 1, 0, 0, 2, 0, 0x00]);
    const a = decode(code, 0);
    expect(a.name).toBe('move');
    expect(a.result).toBe(11);
    expect(a.args).toEqual([25]);
    const b = decode(code, a.next);
    expect(b.name).toBe('isEqual');
    expect(b.args).toEqual([{ v: 1 }, 0]);
    expect(b.jump).toBe(b.next + 2);
  });

  test('strings keep control codes', () => {
    expect(decodeString(new Uint8Array([0x48, 0x69 | 0x80, 0x01, 0x21]))).toBe('Hi \\1!');
  });

  test.skipIf(!haveRom)('every global, room and object script in the ROM decodes', () => {
    const r = rom();
    let n = 0;
    for (const s of r.scripts) if (s) n += disassemble(s).filter((l) => !l.includes('??')).length;
    for (const room of r.rooms) {
      if (!room) continue;
      if (room.entryScript) n += disassemble(room.raw, room.entryScript).length;
      for (const o of room.objects) for (const [, off] of o.verbs) expect(() => decode(o.code, off)).not.toThrow();
    }
    expect(n).toBeGreaterThan(5000);
    for (const s of r.scripts) if (s) expect(disassemble(s).some((l) => l.includes('??'))).toBe(false);
  });
});
