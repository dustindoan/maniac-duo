// SCUMM v1 assembler: the inverse of the decoder in bytecode.ts, using its opcode tables. It writes
// the scripts we add to the game (src/story) in the game's own bytecode, so they run in the same
// VM as the original scripts: cutscenes, skipping, talking and walking all behave the same.

import { type Arg, NAMES, PARAMS, SIG } from './bytecode';

/**
 * An operand: a number, a variable ({v}), a jump target (a label, or a position in this script),
 * or text (a string, or raw bytes).
 */
export type Operand = Arg | string | Uint8Array;

/** Opcodes for each name; variants differ in which operands are variables (PARAM bits). */
const OPS = new Map<string, number[]>();
NAMES.forEach((name, op) => OPS.set(name, [...(OPS.get(name) ?? []), op]));

export class Asm {
  private code: number[] = [];
  private labels = new Map<string, number>();
  private fixups: { at: number; target: string | number }[] = [];

  /** Mark where the next instruction starts. */
  label(name: string): this {
    if (this.labels.has(name)) throw new Error(`label ${name} defined twice`);
    this.labels.set(name, this.code.length);
    return this;
  }

  /**
   * Append one instruction. Operands follow the opcode's signature in bytecode.ts, result first:
   * op('getActorRoom', 1, 3) is Var[1] = getActorRoom(3), and op('isEqual', 1, 4, 'out') jumps to
   * 'out' unless Var[1] == 4.
   */
  op(name: string, ...args: Operand[]): this {
    const sig = SIG[name];
    if (sig === undefined || (sig === '' && !OPS.has(name))) throw new Error(`unknown opcode ${name}`);
    if (sig === '' && ['actorOps', 'doSentence', 'setVarRange', 'verbOps', 'pseudoRoom'].includes(name)) throw new Error(`no encoder for ${name}`);
    if (args.length !== sig.length) throw new Error(`${name} takes ${sig.length} operands, got ${args.length}`);
    const isVar = [...sig].flatMap((ch, i) => (ch === 'b' || ch === 'w' ? [typeof args[i] === 'object' && 'v' in (args[i] as object)] : []));
    const op = OPS.get(name)!.find((o) => isVar.every((v, i) => !!(o & PARAMS[i]) === v));
    if (op === undefined) throw new Error(`no ${name} variant for these operands`);
    this.code.push(op);
    [...sig].forEach((ch, i) => this.operand(name, ch, args[i]));
    return this;
  }

  /** The finished script, with jumps resolved. */
  bytes(): Uint8Array {
    for (const { at, target } of this.fixups) {
      const to = typeof target === 'number' ? target : this.labels.get(target);
      if (to === undefined) throw new Error(`undefined label ${target}`);
      const off = to - (at + 2);
      this.code[at] = off & 0xff;
      this.code[at + 1] = (off >> 8) & 0xff;
    }
    return new Uint8Array(this.code);
  }

  private operand(name: string, ch: string, a: Operand) {
    const num = (): number => {
      if (typeof a === 'number') return a;
      if (typeof a === 'object' && 'v' in a) return a.v;
      throw new Error(`${name}: expected a number, got ${String(a)}`);
    };
    const byte = (n: number) => {
      if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`${name}: ${n} doesn't fit in a byte`);
      this.code.push(n);
    };
    const word = (n: number) => {
      if (!Number.isInteger(n) || n < -0x8000 || n > 0xffff) throw new Error(`${name}: ${n} doesn't fit in a word`);
      this.code.push(n & 0xff, (n >> 8) & 0xff);
    };
    switch (ch) {
      case 'r':
      case 'R':
      case 'V':
      case 'B':
        return byte(num());
      case 'W':
        return word(num());
      case 'b':
        return byte(num());
      case 'w':
        return typeof a === 'object' && 'v' in a ? byte(a.v) : word(num());
      case 'j':
        if (typeof a !== 'string' && typeof a !== 'number') throw new Error(`${name}: expected a jump target`);
        this.fixups.push({ at: this.code.length, target: a });
        this.code.push(0, 0);
        return;
      case 's': {
        const text = typeof a === 'string' ? Array.from(a, (c) => c.charCodeAt(0)) : a instanceof Uint8Array ? [...a] : null;
        if (!text) throw new Error(`${name}: expected text`);
        if (typeof a === 'string' && text.some((c) => c === 0 || c > 0x7e)) throw new Error(`${name}: text must be ASCII: ${a}`);
        this.code.push(...text, 0);
        return;
      }
      case 'd': {
        const d = 0xffffff - num();
        this.code.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff);
        return;
      }
    }
  }
}
