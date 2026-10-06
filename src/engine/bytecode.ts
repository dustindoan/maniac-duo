// SCUMM v1 (NES Maniac Mansion) bytecode decoder.
// Opcode table and operand formats follow ScummVM engines/scumm/script_v2.cpp (GPL-3.0+).
//
// Operand signature letters:
//   r  result variable (byte)            R  indirect result: target var = Var[byte]
//   V  variable to read (byte)           b  byte, or var when the next PARAM bit is set
//   w  signed word, or var when the next PARAM bit is set
//   B  raw byte                          W  raw word
//   j  relative jump (signed word)       s  string (until 0)
//   d  24-bit delay
// PARAM bits are consumed in order 0x80, 0x40, 0x20 by each b/w.

export type Arg = number | { v: number };

export interface Ins {
  op: number;
  name: string;
  pc: number;
  next: number;
  args: Arg[];
  /** Variable written by the instruction, if any. */
  result?: number;
  /** Var whose value names the result variable (indirect store). */
  resultIndirect?: number;
  /** Absolute jump target for conditionals and goto. */
  jump?: number;
  str?: Uint8Array;
  list?: number[];
  sub?: number;
}

const SIG: Record<string, string> = {
  stopObjectCode: '', putActor: 'bbb', startMusic: 'b', getActorRoom: 'rb',
  isGreaterEqual: 'Vwj', isNotEqual: 'Vwj', isLess: 'Vwj', isLessEqual: 'Vwj', isGreater: 'Vwj', isEqual: 'Vwj',
  drawObject: 'wbb', getActorElevation: 'rb',
  setStateIntrinsicOn: 'w', setStateIntrinsicOff: 'w', setStateLocked: 'w', setStateUnlocked: 'w',
  setStateUntouchable: 'w', setStateTouchable: 'w', setStatePickupable: 'w', setStateUnpickupable: 'w',
  ifStateIntrinsicOn: 'wj', ifStateIntrinsicOff: 'wj', ifStateLocked: 'wj', ifStateUnlocked: 'wj',
  ifStateUntouchable: 'wj', ifStateTouchable: 'wj', ifStatePickupable: 'wj', ifStateUnpickupable: 'wj',
  faceActor: 'bw', assignVarWordIndirect: 'Rw', setObjPreposition: 'wB', resourceRoutines: 'bB',
  walkActorToActor: 'bbB', putActorAtObject: 'bw', getObjectOwner: 'rw', animateActor: 'bb', panCameraTo: 'b',
  print: 'bs', actorFromPos: 'rbb', getRandomNr: 'rb', jumpRelative: 'j', move: 'rw', setBitVar: 'Wbb',
  startSound: 'b', ifClassOfIs: 'wbj', walkActorTo: 'bbb', stopMusic: '', saveLoadGame: 'rb', getActorY: 'rb',
  loadRoomWithEgo: 'wbBB', equalZero: 'Vj', notEqualZero: 'Vj', setOwnerOf: 'wb', addIndirect: 'Rw',
  subIndirect: 'Rw', delayVariable: 'V', assignVarByte: 'rB', putActorInRoom: 'bb', delay: 'd',
  setBoxFlags: 'bB', getBitVar: 'rWb', setCameraAt: 'b', roomOps: 'bbB', getDist: 'rww', findObject: 'rbb',
  walkActorToObject: 'bw', subtract: 'rw', add: 'rw', waitForActor: 'b', stopSound: 'b', setActorElevation: 'bb',
  cutscene: '', startScript: 'b', stopScript: 'b', chainScript: 'b', getActorX: 'rb', increment: 'r',
  decrement: 'r', waitForSentence: '', pickupObject: 'w', actorFollowCamera: 'b', setObjectName: 'ws',
  getActorMoving: 'rb', beginOverride: '', dummy: '', cursorCommand: 'w', getActorFacing: 'rb',
  getClosestObjActor: 'rw', isScriptRunning: 'rb', getObjPreposition: 'rw', lights: 'bBB', getActorCostume: 'rb',
  loadRoom: 'b', getActorWalkBox: 'rb', isSoundRunning: 'rb', breakHere: '', restart: '', switchCostumeSet: 'B',
  drawSentence: '', waitForMessage: '', endCutscene: '', printEgo: 's',
  // Special-cased below
  actorOps: '', doSentence: '', setVarRange: '', verbOps: '', pseudoRoom: '',
};

// 256-entry opcode -> name table (script_v2.cpp setupOpcodes), in groups of 4.
const NAMES = (
  'stopObjectCode putActor startMusic getActorRoom isGreaterEqual drawObject getActorElevation setStateIntrinsicOn ' +
  'isNotEqual faceActor assignVarWordIndirect setObjPreposition resourceRoutines walkActorToActor putActorAtObject ifStateIntrinsicOn ' +
  'getObjectOwner animateActor panCameraTo actorOps print actorFromPos getRandomNr setStateTouchable ' +
  'jumpRelative doSentence move setBitVar startSound ifClassOfIs walkActorTo ifStateTouchable ' +
  'stopMusic putActor saveLoadGame getActorY loadRoomWithEgo drawObject setVarRange setStateLocked ' +
  'equalZero setOwnerOf addIndirect delayVariable assignVarByte putActorInRoom delay ifStateLocked ' +
  'setBoxFlags getBitVar setCameraAt roomOps getDist findObject walkActorToObject setStatePickupable ' +
  'isLessEqual doSentence subtract waitForActor stopSound setActorElevation walkActorTo ifStatePickupable ' +
  'cutscene putActor startScript getActorX isLess drawObject increment setStateIntrinsicOff ' +
  'isEqual faceActor chainScript setObjPreposition waitForSentence walkActorToActor putActorAtObject ifStateIntrinsicOff ' +
  'pickupObject animateActor actorFollowCamera actorOps setObjectName actorFromPos getActorMoving setStateUntouchable ' +
  'beginOverride doSentence add setBitVar dummy ifClassOfIs walkActorTo ifStateUntouchable ' +
  'cursorCommand putActor stopScript getActorFacing loadRoomWithEgo drawObject getClosestObjActor setStateUnlocked ' +
  'isScriptRunning setOwnerOf subIndirect dummy getObjPreposition putActorInRoom dummy ifStateUnlocked ' +
  'lights getActorCostume loadRoom roomOps getDist findObject walkActorToObject setStateUnpickupable ' +
  'isGreater doSentence verbOps getActorWalkBox isSoundRunning setActorElevation walkActorTo ifStateUnpickupable ' +
  'breakHere putActor startMusic getActorRoom isGreaterEqual drawObject getActorElevation setStateIntrinsicOn ' +
  'isNotEqual faceActor assignVarWordIndirect setObjPreposition resourceRoutines walkActorToActor putActorAtObject ifStateIntrinsicOn ' +
  'getObjectOwner animateActor panCameraTo actorOps print actorFromPos getRandomNr setStateTouchable ' +
  'restart doSentence move setBitVar startSound ifClassOfIs walkActorTo ifStateTouchable ' +
  'stopObjectCode putActor saveLoadGame getActorY loadRoomWithEgo drawObject setVarRange setStateLocked ' +
  'notEqualZero setOwnerOf addIndirect switchCostumeSet drawSentence putActorInRoom waitForMessage ifStateLocked ' +
  'setBoxFlags getBitVar setCameraAt roomOps getDist findObject walkActorToObject setStatePickupable ' +
  'isLessEqual doSentence subtract waitForActor stopSound setActorElevation walkActorTo ifStatePickupable ' +
  'endCutscene putActor startScript getActorX isLess drawObject decrement setStateIntrinsicOff ' +
  'isEqual faceActor chainScript setObjPreposition pseudoRoom walkActorToActor putActorAtObject ifStateIntrinsicOff ' +
  'pickupObject animateActor actorFollowCamera actorOps setObjectName actorFromPos getActorMoving setStateUntouchable ' +
  'printEgo doSentence add setBitVar dummy ifClassOfIs walkActorTo ifStateUntouchable ' +
  'cursorCommand putActor stopScript getActorFacing loadRoomWithEgo drawObject getClosestObjActor setStateUnlocked ' +
  'isScriptRunning setOwnerOf subIndirect dummy getObjPreposition putActorInRoom dummy ifStateUnlocked ' +
  'lights getActorCostume loadRoom roomOps getDist findObject walkActorToObject setStateUnpickupable ' +
  'isGreater doSentence verbOps getActorWalkBox isSoundRunning setActorElevation walkActorTo ifStateUnpickupable'
).split(' ');
if (NAMES.length !== 256) throw new Error(`opcode table has ${NAMES.length} entries`);

export const opName = (op: number) => NAMES[op];

const PARAMS = [0x80, 0x40, 0x20];

export class DecodeError extends Error {}

const cache = new WeakMap<Uint8Array, Map<number, Ins>>();

/** Decode the instruction at pc. Results are cached per code buffer. */
export function decode(code: Uint8Array, pc: number): Ins {
  let m = cache.get(code);
  if (!m) cache.set(code, (m = new Map()));
  let ins = m.get(pc);
  if (!ins) m.set(pc, (ins = decodeUncached(code, pc)));
  return ins;
}

function decodeUncached(code: Uint8Array, start: number): Ins {
  let p = start;
  if (p >= code.length) throw new DecodeError(`pc ${p} past end of script (${code.length})`);
  const op = code[p++];
  const name = NAMES[op];
  const ins: Ins = { op, name, pc: start, next: 0, args: [] };
  let param = 0;
  const byte = () => code[p++];
  const word = () => {
    const v = code[p] | (code[p + 1] << 8);
    p += 2;
    return v;
  };
  const sword = () => (word() << 16) >> 16;
  const varOrByte = (): Arg => (op & PARAMS[param++] ? { v: byte() } : byte());
  const varOrWord = (): Arg => (op & PARAMS[param++] ? { v: byte() } : sword());
  const str = () => {
    const s = p;
    while (code[p] !== 0) {
      const c = code[p++] & 0x7f;
      if (c > 3 && c < 8) p++;
      if (p > code.length) throw new DecodeError('unterminated string');
    }
    ins.str = code.subarray(s, p);
    p++;
  };

  switch (name) {
    case 'actorOps': {
      ins.args.push(varOrByte(), varOrByte());
      ins.sub = byte();
      if (ins.sub === 3) str();
      break;
    }
    case 'doSentence': {
      const first = varOrByte();
      ins.args.push(first);
      if (first === 0xfc || first === 0xfb) break;
      ins.args.push(varOrWord(), varOrWord());
      ins.sub = byte();
      break;
    }
    case 'setVarRange': {
      ins.result = byte();
      const n = byte();
      ins.list = [];
      for (let i = 0; i < n; i++) ins.list.push(op & 0x80 ? sword() : byte());
      break;
    }
    case 'verbOps': {
      ins.sub = byte();
      if (ins.sub === 0) ins.args.push(varOrByte());
      else if (ins.sub === 0xff) ins.args.push(byte(), byte());
      else {
        const x = byte();
        const y = byte();
        const slot = varOrByte();
        const prep = byte();
        ins.args.push(x, y, slot, prep);
        str();
      }
      break;
    }
    case 'pseudoRoom': {
      ins.args.push(byte());
      ins.list = [];
      let j: number;
      while ((j = byte()) !== 0) ins.list.push(j);
      break;
    }
    default: {
      const sig = SIG[name];
      if (sig === undefined) throw new DecodeError(`no signature for ${name}`);
      for (const ch of sig) {
        switch (ch) {
          case 'r': ins.result = byte(); break;
          case 'R': ins.resultIndirect = byte(); break;
          case 'V': ins.args.push({ v: byte() }); break;
          case 'b': ins.args.push(varOrByte()); break;
          case 'w': ins.args.push(varOrWord()); break;
          case 'B': ins.args.push(byte()); break;
          case 'W': ins.args.push(word()); break;
          case 'j': { const off = sword(); ins.jump = p + off; break; }
          case 's': str(); break;
          case 'd': {
            const d = byte() | (byte() << 8) | (byte() << 16);
            ins.args.push(0xffffff - d);
            break;
          }
        }
      }
    }
  }
  ins.next = p;
  return ins;
}

/** Characters are ASCII with bit 7 meaning "followed by a space"; codes 1-7 are control codes. */
export function decodeString(s: Uint8Array): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const raw = s[i];
    const c = raw & 0x7f;
    if (c < 8) {
      out += `\\${c}`;
      if (c > 3) out += `{${s[++i]}}`;
    } else out += String.fromCharCode(c);
    if (raw & 0x80) out += ' ';
  }
  return out;
}

const fmtArg = (a: Arg) => (typeof a === 'number' ? String(a) : `Var[${a.v}]`);

export function format(ins: Ins): string {
  const parts: string[] = [];
  if (ins.result !== undefined) parts.push(`Var[${ins.result}] =`);
  if (ins.resultIndirect !== undefined) parts.push(`Var[Var[${ins.resultIndirect}]] =`);
  parts.push(ins.name + (ins.sub !== undefined ? `.${ins.sub}` : ''));
  const args = ins.args.map(fmtArg);
  if (ins.list) args.push(`[${ins.list.join(',')}]`);
  if (ins.str) args.push(JSON.stringify(decodeString(ins.str)));
  parts.push(`(${args.join(', ')})`);
  if (ins.jump !== undefined) parts.push(`-> ${ins.jump.toString(16).padStart(4, '0')}`);
  return parts.join(' ');
}

/** Linear disassembly from pc until a stopObjectCode at top level, or the end of code. */
export function disassemble(code: Uint8Array, pc = 0, end = code.length): string[] {
  const out: string[] = [];
  while (pc < end) {
    let ins: Ins;
    try {
      ins = decode(code, pc);
    } catch (e) {
      out.push(`${pc.toString(16).padStart(4, '0')}: ?? ${(e as Error).message}`);
      break;
    }
    out.push(`${pc.toString(16).padStart(4, '0')}: ${format(ins)}`);
    pc = ins.next;
  }
  return out;
}
