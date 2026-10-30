// SCUMM v1 (NES) opcode semantics. Ported from ScummVM engines/scumm/script_v2.cpp and
// script_v5.cpp (GPL-3.0+), adapted to the multi-context Engine.

import { type Arg, type Ins, decode } from './bytecode';
import {
  type Actor,
  MF_TURN,
  adjustXYToBeInBox,
  animateActor,
  faceToObject,
  newDirToOldDir,
  putActor,
  setActorCostume,
  setDirection,
  startWalkActor,
} from './actor';
import { type Engine, NUM_ACTORS, OWNER_ROOM, SENTENCE_SCRIPT, V, VIEW_W } from './engine';

const MAX_INSTRUCTIONS = 200_000;

export class ScriptError extends Error {}

export function execute(e: Engine, slotIdx: number) {
  const s = e.slots[slotIdx];
  s.didExec = true;
  while (e.curSlot === slotIdx) {
    const code = e.codeOf(s);
    if (!code) {
      e.killSlot(slotIdx);
      return;
    }
    let ins: Ins;
    try {
      ins = decode(code, s.pc);
    } catch (err) {
      throw new ScriptError(`decode ${s.kind}${s.number}@${s.pc}: ${(err as Error).message}`);
    }
    s.pc = ins.next;
    if (++e.insCount > MAX_INSTRUCTIONS) throw new ScriptError(`runaway script ${s.kind}${s.number} at ${ins.pc}`);
    op(e, s, ins);
  }
}

function val(e: Engine, a: Arg): number {
  return typeof a === 'number' ? a : e.readVar(a.v);
}

function actor(e: Engine, n: number): Actor {
  const a = e.actors[n];
  if (!a) throw new ScriptError(`invalid actor ${n}`);
  return a;
}

function yieldAndRetry(e: Engine, s: { pc: number }, ins: Ins) {
  s.pc = ins.pc;
  e.curSlot = -1;
}

function breakHere(e: Engine) {
  e.curSlot = -1;
}

function jumpUnless(s: { pc: number }, ins: Ins, cond: boolean) {
  if (!cond) s.pc = ins.jump!;
}

function setResult(e: Engine, ins: Ins, v: number) {
  if (ins.result !== undefined) e.writeVar(ins.result, v);
  else if (ins.resultIndirect !== undefined) e.writeVar(e.vars[ins.resultIndirect], v);
}

const u16 = (v: number) => v & 0xffff;

function op(e: Engine, s: Engine['slots'][number], ins: Ins) {
  const A = (i: number) => val(e, ins.args[i]);
  switch (ins.name) {
    case 'stopObjectCode':
      e.stopObjectCode();
      return;
    case 'breakHere':
      breakHere(e);
      return;
    case 'jumpRelative':
      s.pc = ins.jump!;
      return;

    // ---- arithmetic and variables
    case 'move':
      setResult(e, ins, A(0));
      return;
    case 'assignVarByte':
      setResult(e, ins, A(0));
      return;
    case 'assignVarWordIndirect':
      setResult(e, ins, A(0));
      return;
    case 'add':
      e.writeVar(ins.result!, e.vars[ins.result!] + A(0));
      return;
    case 'subtract':
      e.writeVar(ins.result!, e.vars[ins.result!] - A(0));
      return;
    case 'addIndirect': {
      const t = e.vars[ins.resultIndirect!];
      e.writeVar(t, e.vars[t] + A(0));
      return;
    }
    case 'subIndirect': {
      const t = e.vars[ins.resultIndirect!];
      e.writeVar(t, e.vars[t] - A(0));
      return;
    }
    case 'increment':
      e.writeVar(ins.result!, e.readVar(ins.result!) + 1);
      return;
    case 'decrement':
      e.writeVar(ins.result!, e.readVar(ins.result!) - 1);
      return;
    case 'setVarRange': {
      let r = ins.result!;
      for (const v of ins.list!) e.writeVar(r++, v);
      return;
    }
    case 'getRandomNr':
      setResult(e, ins, e.random(A(0)));
      return;
    case 'setBitVar': {
      const bv = A(0) + A(1);
      const v = bv >> 4;
      const bit = bv & 15;
      if (A(2)) e.vars[v] |= 1 << bit;
      else e.vars[v] &= ~(1 << bit);
      e.vars[v] = (e.vars[v] << 16) >> 16;
      return;
    }
    case 'getBitVar': {
      const bv = A(0) + A(1);
      setResult(e, ins, e.vars[bv >> 4] & (1 << (bv & 15)) ? 1 : 0);
      return;
    }

    // ---- comparisons (jump when the condition is false)
    case 'isEqual':
      jumpUnless(s, ins, (A(1) << 16) >> 16 === (A(0) << 16) >> 16);
      return;
    case 'isNotEqual':
      jumpUnless(s, ins, (A(1) << 16) >> 16 !== (A(0) << 16) >> 16);
      return;
    case 'isGreater':
      jumpUnless(s, ins, u16(A(1)) > u16(A(0)));
      return;
    case 'isGreaterEqual':
      jumpUnless(s, ins, u16(A(1)) >= u16(A(0)));
      return;
    case 'isLess':
      jumpUnless(s, ins, u16(A(1)) < u16(A(0)));
      return;
    case 'isLessEqual':
      jumpUnless(s, ins, u16(A(1)) <= u16(A(0)));
      return;
    case 'equalZero':
      jumpUnless(s, ins, A(0) === 0);
      return;
    case 'notEqualZero':
      jumpUnless(s, ins, A(0) !== 0);
      return;

    // ---- object state
    case 'setStateIntrinsicOn':
      e.putState(A(0), e.getState(A(0)) | 8);
      return;
    case 'setStateIntrinsicOff':
      e.putState(A(0), e.getState(A(0)) & ~8);
      return;
    case 'setStateLocked':
      e.putState(A(0), e.getState(A(0)) | 4);
      return;
    case 'setStateUnlocked':
      e.putState(A(0), e.getState(A(0)) & ~4);
      return;
    case 'setStateUntouchable':
      e.putState(A(0), e.getState(A(0)) | 2);
      return;
    case 'setStateTouchable':
      e.putState(A(0), e.getState(A(0)) & ~2);
      return;
    case 'setStatePickupable':
      e.putState(A(0), e.getState(A(0)) | 1);
      return;
    case 'setStateUnpickupable':
      e.putState(A(0), e.getState(A(0)) & ~1);
      return;
    case 'ifStateIntrinsicOn':
      jumpUnless(s, ins, (e.getState(A(0)) & 8) === 0);
      return;
    case 'ifStateIntrinsicOff':
      jumpUnless(s, ins, (e.getState(A(0)) & 8) !== 0);
      return;
    case 'ifStateLocked':
      jumpUnless(s, ins, (e.getState(A(0)) & 4) === 0);
      return;
    case 'ifStateUnlocked':
      jumpUnless(s, ins, (e.getState(A(0)) & 4) !== 0);
      return;
    case 'ifStateUntouchable':
      jumpUnless(s, ins, (e.getState(A(0)) & 2) === 0);
      return;
    case 'ifStateTouchable':
      jumpUnless(s, ins, (e.getState(A(0)) & 2) !== 0);
      return;
    case 'ifStatePickupable':
      jumpUnless(s, ins, (e.getState(A(0)) & 1) === 0);
      return;
    case 'ifStateUnpickupable':
      jumpUnless(s, ins, (e.getState(A(0)) & 1) !== 0);
      return;
    case 'ifClassOfIs': {
      const cls = e.classOf(A(0));
      if (cls === null) {
        s.pc = ins.jump!;
        return;
      }
      const clsop = A(1);
      jumpUnless(s, ins, (cls & clsop) === clsop);
      return;
    }
    case 'getObjectOwner':
      setResult(e, ins, e.getOwner(A(0)));
      return;
    case 'setOwnerOf':
      e.setOwnerOf(A(0), A(1));
      return;
    case 'pickupObject':
      e.pickupObject(A(0));
      // The pickup sound (ScummVM triggerSound(51)).
      e.startSound(51);
      return;
    case 'drawObject':
      e.drawObject(A(0), A(1), A(2));
      return;
    case 'setObjectName':
      if (A(0) >= NUM_ACTORS) e.newNames.set(A(0), Array.from(ins.str!));
      return;
    case 'setObjPreposition':
      return;
    case 'getObjPreposition': {
      const where = e.whereIsObject(A(0));
      setResult(e, ins, where === 'none' ? 0xff : e.objIndex.get(A(0))!.def.preposition);
      return;
    }
    case 'findObject':
      setResult(e, ins, e.findObject(A(0) * 8, A(1) * 2));
      return;
    case 'getDist':
      setResult(e, ins, e.getObjActToObjActDist(A(0), A(1)));
      return;
    case 'getClosestObjActor': {
      const act = A(0);
      let closest = 0xff;
      let best = 0xff;
      for (let obj = e.vars[V.ACTOR_RANGE_MAX]; obj >= e.vars[V.ACTOR_RANGE_MIN]; obj--) {
        const d = e.getObjActToObjActDist(act, obj);
        if (d < best) {
          best = d;
          closest = obj;
        }
      }
      setResult(e, ins, closest);
      return;
    }

    // ---- actors
    case 'putActor': {
      const a = actor(e, A(0));
      putActor(e, a, A(1), A(2), a.room);
      return;
    }
    case 'putActorInRoom': {
      const a = actor(e, A(0));
      const room = A(1);
      a.room = room;
      if (!room) putActor(e, a, 0, 0, 0);
      else e.actorMovedToRoom(a.id, room);
      return;
    }
    case 'putActorAtObject': {
      const a = actor(e, A(0));
      const obj = A(1);
      let x = 30;
      let y = 60;
      if (e.whereIsObject(obj) !== 'none') {
        const p = e.getObjectOrActorXY(obj);
        if (p) {
          const r = adjustXYToBeInBox(e, a, p.x, p.y);
          x = r.x;
          y = r.y;
        }
      }
      putActor(e, a, x, y, a.room);
      return;
    }
    case 'walkActorTo':
      startWalkActor(e, actor(e, A(0)), A(1), A(2), -1);
      return;
    case 'walkActorToObject': {
      const obj = A(1);
      if (e.whereIsObject(obj) === 'none') return;
      const a = actor(e, A(0));
      const p = obj < NUM_ACTORS ? e.getObjectOrActorXY(obj) : e.getObjectXYPos(obj);
      if (!p) return;
      const r = adjustXYToBeInBox(e, a, p.x, p.y);
      startWalkActor(e, a, r.x, r.y, 'dir' in p ? (p as { dir: number }).dir : -1);
      return;
    }
    case 'walkActorToActor': {
      const a = e.actors[A(0)];
      const to = e.actors[A(1)];
      // Both in the same viewed room (the original's isInCurrentRoom, with several rooms live).
      if (!a || !to || a.room !== to.room || !e.isViewed(a.room)) return;
      const dist = A(2) * 8;
      let x = to.x * 8;
      const y = to.y * 2;
      if (x < a.x * 8) x += dist;
      else x -= dist;
      const r = adjustXYToBeInBox(e, a, Math.trunc(x / 8), Math.trunc(y / 2));
      startWalkActor(e, a, r.x, r.y, -1);
      return;
    }
    case 'waitForActor':
      if (actor(e, A(0)).moving) yieldAndRetry(e, s, ins);
      return;
    case 'faceActor': {
      const a = e.actors[A(0)];
      if (a) faceToObject(e, a, A(1));
      return;
    }
    case 'animateActor': {
      const n = A(0);
      if (n < 1 || n >= NUM_ACTORS) return;
      animateActor(e, e.actors[n], A(1));
      return;
    }
    case 'actorOps': {
      const act = A(0);
      const arg = A(1);
      if (act === 0 && ins.sub === 5) return;
      const a = actor(e, act);
      switch (ins.sub) {
        case 1:
          a.sound = arg;
          break;
        case 2:
          break;
        case 3:
          a.name = Array.from(ins.str!);
          break;
        case 4:
          setActorCostume(e, a, arg);
          break;
        case 5:
          a.talkColor = arg;
          break;
      }
      return;
    }
    case 'setActorElevation':
      actor(e, A(0)).elevation = (A(1) << 24) >> 24;
      return;
    case 'getActorElevation':
      setResult(e, ins, actor(e, A(0)).elevation);
      return;
    case 'getActorRoom': {
      const n = A(0);
      setResult(e, ins, n >= 0 && n < NUM_ACTORS ? e.actors[n].room : 0);
      return;
    }
    case 'getActorX':
    case 'getActorY': {
      const n = A(0);
      const p = n < NUM_ACTORS ? e.actors[n] : e.getObjectOrActorXY(n);
      setResult(e, ins, p ? (ins.name === 'getActorX' ? p.x : p.y) : -1);
      return;
    }
    case 'getActorMoving':
      setResult(e, ins, actor(e, A(0)).moving);
      return;
    case 'getActorFacing':
      setResult(e, ins, newDirToOldDir(actor(e, A(0)).facing));
      return;
    case 'getActorCostume':
      setResult(e, ins, actor(e, A(0)).costume);
      return;
    case 'getActorWalkBox': {
      const a = actor(e, A(0));
      setResult(e, ins, e.isViewed(a.room) ? a.walkbox : 0xff);
      return;
    }
    case 'actorFromPos':
      setResult(e, ins, e.getActorFromPos(A(0) * 8, A(1) * 2));
      return;
    case 'actorFollowCamera':
      e.actorFollowCamera(A(0));
      return;
    case 'switchCostumeSet':
      e.costumeSet = A(0);
      return;

    // ---- scripts
    case 'startScript': {
      const script = A(0);
      // ScummVM workarounds for MM scripting bugs (MM_SCRIPT(82) / MM_SCRIPT(150) in v1 numbering).
      if (script === 87 && (e.isScriptRunning(88) || e.isScriptRunning(89))) return;
      if (script === 155 && e.vars[120] === 1) return;
      e.runScript(script, false, false);
      return;
    }
    case 'stopScript': {
      let script = A(0);
      if (script === 0) script = s.number;
      if (e.curSlot >= 0 && s.number === script) e.stopObjectCode();
      else e.stopScript(script);
      return;
    }
    case 'chainScript': {
      const script = A(0);
      const ctx = s.ctx;
      e.stopScript(s.number);
      e.killSlot(e.slots.indexOf(s));
      e.curSlot = -1;
      e.runScript(script, false, false, ctx);
      return;
    }
    case 'isScriptRunning':
      setResult(e, ins, e.isScriptRunning(A(0)) ? 1 : 0);
      return;
    case 'delay':
      s.delay = A(0);
      s.paused = true;
      s.running = false;
      breakHere(e);
      return;
    case 'delayVariable':
      s.delay = A(0);
      s.paused = true;
      s.running = false;
      breakHere(e);
      return;
    case 'waitForMessage':
      if (e.vars[V.HAVE_MSG]) yieldAndRetry(e, s, ins);
      return;
    case 'waitForSentence':
      if (e.ctx.sentences.length || e.isScriptInUse(SENTENCE_SCRIPT)) yieldAndRetry(e, s, ins);
      return;
    case 'cutscene':
      e.beginCutscene();
      return;
    case 'endCutscene':
      e.endCutscene();
      return;
    case 'beginOverride': {
      const c = e.ctx;
      c.cutPtr = ins.next;
      c.cutSlot = e.slots.indexOf(s);
      s.pc = ins.next + 3; // skip the following jump
      return;
    }
    case 'doSentence': {
      const verb = A(0);
      if (verb === 0xfc) {
        e.ctx.sentences = [];
        e.stopScript(SENTENCE_SCRIPT);
        return;
      }
      if (verb === 0xfb) {
        e.resetSentence();
        return;
      }
      const a = A(1);
      const b = A(2);
      if (ins.sub === 0) e.doSentence(verb, a, b);
      else if (ins.sub === 1) {
        if (verb === 254) {
          e.stopObjectScript(a);
          return;
        }
        let special = false;
        let bg = false;
        let v = verb;
        if (verb !== 253 && verb !== 250) {
          e.vars[V.ACTIVE_VERB] = verb;
          e.vars[V.ACTIVE_OBJECT1] = a;
          e.vars[V.ACTIVE_OBJECT2] = b;
        } else {
          bg = verb === 250;
          special = true;
          v = 253;
        }
        let reuse = -1;
        for (let i = 0; i < e.slots.length; i++) {
          const t = e.slots[i];
          if (t.number === a && t.freezeResistant === bg && t.recursive === special && (t.kind === 'O' || t.kind === 'I') && (t.running || t.paused)) {
            reuse = i;
            break;
          }
        }
        e.runObjectScript(a, v, bg, special, reuse);
      } else if (ins.sub === 2) {
        e.vars[V.SENTENCE_VERB] = verb;
        e.vars[V.SENTENCE_OBJECT1] = a;
        e.vars[V.SENTENCE_OBJECT2] = b;
      }
      return;
    }
    case 'drawSentence':
      return;

    // ---- rooms, camera, lights
    case 'loadRoom': {
      const room = A(0);
      if (room !== e.ctx.room) e.startScene(room);
      return;
    }
    case 'loadRoomWithEgo': {
      const obj = A(0);
      const room = A(1);
      const x = (A(2) << 24) >> 24;
      const y = (A(3) << 24) >> 24;
      const a = actor(e, e.vars[V.EGO]);
      putActor(e, a, 0, 0, room);
      e.startScene(a.room);
      const p = e.getObjectXYPos(obj);
      if (p) {
        const r = adjustXYToBeInBox(e, a, p.x, p.y);
        putActor(e, a, r.x, r.y, e.ctx.room);
        setDirection(e, a, p.dir + 180);
      }
      const cam = e.ctx.cam;
      cam.dest = cam.cur = a.x * 8;
      e.setCameraAt(a.x * 8);
      e.setCameraFollows(a);
      e.resetSentence();
      if (x >= 0 && y >= 0) startWalkActor(e, a, x, y, -1);
      e.runScript(5, false, false);
      return;
    }
    case 'setCameraAt':
      e.setCameraAtEx(A(0) * 8);
      return;
    case 'panCameraTo':
      e.panCameraTo(A(0) * 8);
      return;
    case 'roomOps': {
      let a = A(0);
      let b = A(1);
      if ((A(2) & 0x1f) === 1) {
        const lr = e.loadedRoom(e.ctxRoom());
        const roomWidth = lr ? lr.room.width * 8 : VIEW_W;
        const half = VIEW_W / 2;
        a *= 8;
        b *= 8;
        a = Math.min(Math.max(a, half), roomWidth - half);
        b = Math.min(Math.max(b, half), roomWidth - half);
        e.vars[V.CAMERA_MIN_X] = a;
        e.vars[V.CAMERA_MAX_X] = b;
      }
      return;
    }
    case 'lights':
      if (A(2) === 0) e.writeVar(V.CURRENT_LIGHTS, A(0));
      else if (A(2) === 1) e.flashlight = { xStrips: A(0), yStrips: A(1) };
      return;
    case 'setBoxFlags': {
      const lr = e.loadedRoom(e.ctxRoom());
      const box = A(0);
      if (lr && box < lr.boxFlags.length) lr.boxFlags[box] = A(1);
      return;
    }
    case 'pseudoRoom':
      return;

    // ---- text
    case 'print':
      e.actorTalk(A(0), ins.str!);
      return;
    case 'printEgo':
      e.actorTalk(e.vars[V.EGO], ins.str!);
      return;

    // ---- interface
    case 'cursorCommand': {
      const cmd = A(0) & 0xffff;
      if (cmd & 0xff) e.vars[V.CURSORSTATE] = cmd & 0xff;
      e.setUserState(cmd >> 8);
      return;
    }
    case 'verbOps': {
      if (ins.sub !== 0 && ins.sub !== 0xff) e.verbs.set(ins.sub!, Array.from(ins.str!));
      return;
    }

    // ---- sound
    case 'startSound':
    case 'startMusic':
      e.startSound(A(0));
      return;
    case 'stopSound':
      e.stopSound(A(0));
      return;
    case 'stopMusic':
      e.stopAllSounds();
      return;
    case 'isSoundRunning':
      setResult(e, ins, A(0) ? e.isSoundRunning(A(0)) : 0);
      return;

    // ---- misc
    case 'resourceRoutines':
    case 'dummy':
      return;
    case 'saveLoadGame':
      setResult(e, ins, 0);
      return;
    case 'restart':
      e.events.push({ type: 'restart' });
      e.stopObjectCode();
      return;
  }
  throw new ScriptError(`unimplemented opcode ${ins.name} (0x${ins.op.toString(16)})`);
}

export { MF_TURN, OWNER_ROOM };
