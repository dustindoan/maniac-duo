import { describe, expect, test } from 'bun:test';
import { Asm, type Operand } from '../src/engine/asm';
import { SIG, decode, disassemble, type Ins } from '../src/engine/bytecode';
import { haveRom, rom } from './rom-fixture';

describe('assembler', () => {
  test('writes what the decoder reads, with jumps to labels', () => {
    const code = new Asm()
      .label('top')
      .op('getActorRoom', 1, 3)
      .op('isEqual', 1, 4, 'out')
      .op('walkActorTo', { v: 0 }, 27, 56)
      .op('printEgo', 'Dave!\x01Hold this.')
      .op('delay', 120)
      .op('jumpRelative', 'top')
      .label('out')
      .op('stopObjectCode')
      .bytes();
    expect(disassemble(code)).toEqual([
      '0000: Var[1] = getActorRoom (3)',
      '0003: isEqual (Var[1], 4) -> 0026',
      '0009: walkActorTo (Var[0], 27, 56)',
      '000d: printEgo ("Dave!\\\\1Hold this.")',
      '001f: delay (120)',
      '0023: jumpRelative () -> 0000',
      '0026: stopObjectCode ()',
    ]);
  });

  test('refuses what it cannot write', () => {
    expect(() => new Asm().op('actorOps')).toThrow();
    expect(() => new Asm().op('putActor', 3, 40)).toThrow();
    expect(() => new Asm().op('print', 3, 'Davé')).toThrow();
    expect(() => new Asm().op('jumpRelative', 'nowhere').bytes()).toThrow();
  });

  test.skipIf(!haveRom)('every instruction of the ROM global scripts it can write reassembles the same', () => {
    let n = 0;
    for (const code of rom().scripts) {
      if (!code) continue;
      for (let pc = 0; pc < code.length; ) {
        const ins = decode(code, pc);
        pc = ins.next;
        const sig = SIG[ins.name];
        if (sig === '' && ['actorOps', 'doSentence', 'setVarRange', 'verbOps', 'pseudoRoom'].includes(ins.name)) continue;
        const again = decode(new Asm().op(ins.name, ...operands(ins, sig)).bytes(), 0);
        expect(strip(again, 0)).toEqual(strip(ins, ins.pc));
        n++;
      }
    }
    expect(n).toBeGreaterThan(3000);
  });
});

/** An instruction's operands in signature order, with its jump made relative to its own start. */
function operands(ins: Ins, sig: string): Operand[] {
  let k = 0;
  return [...sig].map((ch) => {
    if (ch === 'r') return ins.result!;
    if (ch === 'R') return ins.resultIndirect!;
    if (ch === 'j') return ins.jump! - ins.pc;
    if (ch === 's') return ins.str!;
    return ins.args[k++];
  });
}

function strip(ins: Ins, at: number) {
  return { name: ins.name, args: ins.args, result: ins.result, resultIndirect: ins.resultIndirect, jump: ins.jump === undefined ? undefined : ins.jump - at, str: ins.str && [...ins.str], size: ins.next - ins.pc };
}
