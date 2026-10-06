// Multi-room, multi-player SCUMM v1 (NES Maniac Mansion) runtime.
//
// One script VM drives a single world, but every script slot belongs to a context:
//   ctx 0      the system/director context (boot, timers, world events)
//   ctx 1..n   one per player, each with its own kid, room, camera, sentence queue and messages.
// Context-local variables (ego, room, camera, sentence and click vars) are swapped in when a
// slot of that context runs, so the original scripts see "their" kid and room.
//
// Game semantics are ported from ScummVM engines/scumm (GPL-3.0+); multi-room handling is ours.

import type { ObjectDef, Rom, Room } from '../rom/rom';
import { decode } from './bytecode';
import {
  type Actor,
  MF_TURN,
  TALK_START_FRAME,
  TALK_STOP_FRAME,
  adjustXYToBeInBox,
  animateCostume,
  hideActor,
  newActor,
  oldDirToNewDir,
  putActor,
  setDirection,
  showActor,
  startAnimActor,
  startWalkActor,
  walkActor,
} from './actor';
import { SoundDriver } from '../sound/driver';
import { execute } from './vm';

export const NUM_ACTORS = 25;
export const NUM_SLOTS = 40;
export const NUM_INVENTORY = 80;
export const OWNER_ROOM = 0x0f;
export const SENTENCE_SCRIPT = 2;
/** Runs whenever a room starts (after its entry script); in Maniac Mansion it picks the music. */
const ROOM_START_SCRIPT = 5;
const GO_TO_VERB = 13;
/** NES MM shows 28 tiles of room (224px) between 2-tile black borders. */
export const VIEW_W = 224;
const HALF = VIEW_W / 2;
const ENCD = 10002;
const EXCD = 10001;

/** Scripts that exist once per player context rather than once per world. */
export const PLAYER_SCOPED = new Set([2, 3, 4, 5, 7]);

/**
 * NPC behaviour and world timers. These always run in the system context, whatever started them,
 * so their "is a kid in my room?" checks alternate fairly between players instead of following
 * whichever player happened to trigger them. (Edna 36-40, Fred/Purple Tentacle 47-49, Ed 87-98,
 * doorbell 12, package delivery 111, Meteor Police arrival 136, Edna's kitchen timer 152.)
 */
export const WORLD_SCRIPTS = new Set([12, 36, 38, 39, 40, 47, 48, 87, 91, 98, 111, 136, 152]);

/** Variables that belong to a context (ScummVM v2 VAR_* numbering plus MM's sentence scratch vars). */
export const CTX_VARS = [0, 2, 3, 4, 5, 7, 8, 9, 10, 12, 18, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 203, 204, 217];

export const V = {
  EGO: 0,
  RESULT: 1,
  CAMERA_POS_X: 2,
  HAVE_MSG: 3,
  ROOM: 4,
  OVERRIDE: 5,
  CHARCOUNT: 7,
  ACTIVE_VERB: 8,
  ACTIVE_OBJECT1: 9,
  ACTIVE_OBJECT2: 10,
  NUM_ACTOR: 11,
  CURRENT_LIGHTS: 12,
  VERB_ALLOWED: 18,
  ACTOR_RANGE_MIN: 19,
  ACTOR_RANGE_MAX: 20,
  CURSORSTATE: 21,
  CAMERA_MIN_X: 23,
  CAMERA_MAX_X: 24,
  TIMER_NEXT: 25,
  SENTENCE_VERB: 26,
  SENTENCE_OBJECT1: 27,
  SENTENCE_OBJECT2: 28,
  SENTENCE_PREPOSITION: 29,
  ROOM_RESOURCE: 36,
  BACKUP_VERB: 38,
} as const;

export const US = {
  SET_FREEZE: 0x01,
  SET_CURSOR: 0x02,
  SET_IFACE: 0x04,
  FREEZE_ON: 0x08,
  CURSOR_ON: 0x10,
  IFACE_ALL: 0xe0,
} as const;

export type SlotKind = 'G' | 'R' | 'O' | 'I';

export interface Slot {
  number: number;
  kind: SlotKind;
  room: number;
  running: boolean;
  paused: boolean;
  frozen: number;
  /** Players' freezes of a world script, put off while a world cutscene runs. */
  held: number;
  pc: number;
  delay: number;
  freezeResistant: boolean;
  recursive: boolean;
  ctx: number;
  didExec: boolean;
}

export interface Sentence {
  verb: number;
  a: number;
  b: number;
  prep: boolean;
}

export interface Message {
  /** 0 none, 1 shown and timing out, 0xFF pending display */
  have: number;
  talkDelay: number;
  actor: number;
  buf: number[];
  pos: number;
  text: string;
  keepText: boolean;
  msgCount: number;
  room: number;
  useTalkAnims: boolean;
}

export interface Camera {
  cur: number;
  dest: number;
  mode: 'normal' | 'follow' | 'pan';
  follows: number;
  movingToActor: boolean;
}

export interface Ctx {
  id: number;
  saved: Int32Array;
  room: number;
  cam: Camera;
  userState: number;
  userPut: boolean;
  cutscene: boolean;
  cutData: [number, number, number, string];
  cutPtr: number;
  cutSlot: number;
  sentences: Sentence[];
  msg: Message;
}

export interface LocalObj {
  def: ObjectDef;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  walkX: number;
  walkY: number;
  parent: number;
  parentState: number;
  actorDir: number;
  state: number;
}

export interface LoadedRoom {
  room: Room;
  /** 1-based like ScummVM's _objs; index 0 unused. */
  objs: LocalObj[];
  boxFlags: number[];
}

export interface PlayerConfig {
  /** Actor number of this player's kid. */
  kid: number;
}

export interface EngineEvent {
  type: 'restart' | 'gameover';
  value?: number;
}

const newMsg = (): Message => ({ have: 0, talkDelay: 0, actor: 0, buf: [], pos: 0, text: '', keepText: false, msgCount: 0, room: 0, useTalkAnims: false });

/** Deterministic xorshift32. */
class Rng {
  constructor(public s: number) {
    if (!this.s) this.s = 0x9e3779b9;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s;
  }
  /** 0..max inclusive */
  upTo(max: number) {
    return this.next() % (max + 1);
  }
}

export class Engine {
  vars = new Int32Array(1024);
  owner: Uint8Array;
  state: Uint8Array;
  inventory = new Array<number>(NUM_INVENTORY).fill(0);
  newNames = new Map<number, number[]>();
  actors: Actor[] = [];
  slots: Slot[] = [];
  ctxs: Ctx[] = [];
  cur = 0;
  curSlot = -1;
  rooms = new Map<number, LoadedRoom>();
  objIndex = new Map<number, { def: ObjectDef; room: number }>();
  costumeSet = 0;
  /** The flashlight beam's size in 8-pixel strips (lights op mode 1; ScummVM's v2 default). */
  flashlight = { xStrips: 6, yStrips: 4 };
  frame = 0;
  rng: Rng;
  /** The game's sound driver: decides how long sounds run, and what the sound chip plays. */
  sound: SoundDriver;
  events: EngineEvent[] = [];
  verbs = new Map<number, number[]>();
  /** Instruction budget per runAllScripts, to catch runaway loops. */
  insCount = 0;
  trace: ((s: string) => void) | null = null;

  constructor(
    public rom: Rom,
    public players: PlayerConfig[],
    seed = 1,
  ) {
    this.rng = new Rng(seed);
    this.sound = new SoundDriver(rom.sounds);
    this.owner = new Uint8Array(rom.objectFlags.length);
    this.state = new Uint8Array(rom.objectFlags.length);
    for (let i = 0; i < rom.objectFlags.length; i++) {
      this.owner[i] = rom.objectFlags[i] & 0x0f;
      this.state[i] = rom.objectFlags[i] >> 4;
    }
    for (let i = 0; i < NUM_ACTORS; i++) this.actors.push(newActor(i));
    for (let i = 0; i < NUM_SLOTS; i++) this.slots.push(this.deadSlot());
    for (let i = 0; i <= players.length; i++) this.ctxs.push(this.newCtx(i));
    for (const room of rom.rooms) if (room) for (const o of room.objects) this.objIndex.set(o.id, { def: o, room: room.id });
    for (let p = 1; p <= players.length; p++) {
      const c = this.ctxs[p];
      c.saved[CTX_VARS.indexOf(V.EGO)] = players[p - 1].kid;
      c.saved[CTX_VARS.indexOf(V.CURSORSTATE)] = 1;
      c.userPut = true;
    }
  }

  private deadSlot(): Slot {
    return { number: 0, kind: 'G', room: 0, running: false, paused: false, frozen: 0, held: 0, pc: 0, delay: 0, freezeResistant: false, recursive: false, ctx: 0, didExec: false };
  }

  private newCtx(id: number): Ctx {
    return {
      id,
      saved: new Int32Array(CTX_VARS.length),
      room: 0,
      cam: { cur: HALF, dest: HALF, mode: 'normal', follows: 0, movingToActor: false },
      userState: 0,
      userPut: false,
      cutscene: false,
      cutData: [0, 0, 0, 'normal'],
      cutPtr: 0,
      cutSlot: -1,
      sentences: [],
      msg: newMsg(),
    };
  }

  // ---------------------------------------------------------------- boot / main loop

  boot() {
    this.cur = 0;
    this.runScript(1, false, false);
  }

  get ctx(): Ctx {
    return this.ctxs[this.cur];
  }

  /** The player whose kid the system context "sees" this frame. */
  focusPlayer(): number {
    return 1 + (this.frame % this.players.length);
  }

  /** Effective room of a context: the director's room, or for an idle system context, the focus player's room. */
  ctxRoom(id = this.cur): number {
    const c = this.ctxs[id];
    if (id === 0 && c.room === 0) return this.ctxs[this.focusPlayer()].room;
    return c.room;
  }

  switchCtx(id: number) {
    if (id === this.cur) {
      if (id === 0) this.refreshSystemFocus();
      return;
    }
    const from = this.ctxs[this.cur];
    for (let i = 0; i < CTX_VARS.length; i++) from.saved[i] = this.vars[CTX_VARS[i]];
    // Player contexts are pinned to their own kid.
    if (this.cur > 0) from.saved[0] = this.players[this.cur - 1].kid;
    const to = this.ctxs[id];
    for (let i = 0; i < CTX_VARS.length; i++) this.vars[CTX_VARS[i]] = to.saved[i];
    this.cur = id;
    if (id === 0) this.refreshSystemFocus();
  }

  private refreshSystemFocus() {
    const sys = this.ctxs[0];
    if (sys.room !== 0) return;
    const f = this.ctxs[this.focusPlayer()];
    this.vars[V.EGO] = this.players[f.id - 1].kid;
    this.vars[V.ROOM] = f.room;
  }

  /** Read a context variable of a context that may not be current. */
  ctxVar(id: number, v: number): number {
    if (id === this.cur) return this.vars[v];
    return this.ctxs[id].saved[CTX_VARS.indexOf(v)];
  }

  setCtxVar(id: number, v: number, value: number) {
    if (id === this.cur) this.vars[v] = value;
    else this.ctxs[id].saved[CTX_VARS.indexOf(v)] = value;
  }

  egoOf(p: number): number {
    return this.players[p - 1].kid;
  }

  isEgo(actor: number): boolean {
    return this.players.some((p) => p.kid === actor) || this.vars[V.EGO] === actor;
  }

  step() {
    this.frame++;
    let delta = this.vars[V.TIMER_NEXT] || 4;
    if (delta < 1) delta = 1;
    if (delta > 15) delta = 15;
    this.decreaseScriptDelay(delta);
    for (const c of this.ctxs) c.msg.talkDelay = Math.max(0, c.msg.talkDelay - delta);
    // The sound driver runs 60 times a second; a frame is `delta` sixtieths.
    this.sound.begin();
    for (let i = 0; i < delta; i++) this.sound.tick();

    for (const c of this.ctxs) {
      this.switchCtx(c.id);
      this.displayDialog(c);
    }
    for (const c of this.ctxs) {
      this.switchCtx(c.id);
      this.vars[V.CAMERA_POS_X] = c.cam.cur >> 3;
      this.vars[V.HAVE_MSG] = c.msg.have;
    }
    this.switchCtx(0);
    this.runAllScripts();
    for (const c of this.ctxs) {
      this.switchCtx(c.id);
      this.checkAndRunSentenceScript();
    }
    this.switchCtx(0);
    for (let i = 1; i < NUM_ACTORS; i++) {
      const a = this.actors[i];
      if (this.isViewed(a.room)) walkActor(this, a);
    }
    for (const c of this.ctxs) {
      if (!c.room) continue;
      this.switchCtx(c.id);
      this.moveCamera(c);
    }
    this.updateObjectStates();
    this.autoFollow();
    this.syncActorVisibility();
    for (let i = 1; i < NUM_ACTORS; i++) {
      const a = this.actors[i];
      if (a.visible && a.costume) animateCostume(this, a);
    }
    this.switchCtx(0);
  }

  /**
   * Bring player views back to their kids. The original only re-follows the ego when a cutscene
   * ends; we do the same for world (system) cutscenes, and for players who have no room yet.
   */
  private autoFollow() {
    if (this.ctxs[0].cutscene) return;
    for (let p = 1; p < this.ctxs.length; p++) {
      const c = this.ctxs[p];
      if (c.cutscene) continue;
      const kid = this.actors[this.egoOf(p)];
      if (kid.room === 0 || kid.room === c.room) continue;
      if (c.room === 0 || this.refollow.has(p)) {
        this.switchCtx(p);
        this.actorFollowCamera(kid.id);
      }
    }
    this.refollow.clear();
  }

  /** Players to re-follow their kid at the next frame boundary. */
  refollow = new Set<number>();

  /**
   * A script put an actor in another room. When it is a player's kid and the script isn't that
   * player's own (Ed's capture runs in the system context, and moves the kid before its cutscene
   * begins), the player's view follows the kid once no world cutscene holds it.
   */
  actorMovedToRoom(actor: number, room: number) {
    const p = this.players.findIndex((pl) => pl.kid === actor) + 1;
    if (p && room && p !== this.cur && room !== this.ctxs[p].room) this.refollow.add(p);
  }

  private syncActorVisibility() {
    for (let i = 1; i < NUM_ACTORS; i++) {
      const a = this.actors[i];
      const viewed = this.isViewed(a.room);
      if (a.visible && !viewed) hideActor(this, a);
      else if (!a.visible && viewed && a.costume) showActor(this, a);
    }
  }

  // ---------------------------------------------------------------- scheduler

  private decreaseScriptDelay(amount: number) {
    for (const s of this.slots) {
      if (s.paused) {
        s.delay -= amount;
        if (s.delay < 0) {
          s.paused = false;
          s.running = true;
          s.delay = 0;
        }
      }
    }
  }

  private runAllScripts() {
    for (const s of this.slots) s.didExec = false;
    this.curSlot = -1;
    this.insCount = 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const s = this.slots[i];
      if (s.running && !s.frozen && !s.didExec && s.number) {
        this.curSlot = i;
        this.switchCtx(s.ctx);
        execute(this, i);
      }
    }
    this.curSlot = -1;
  }

  codeOf(s: Slot): Uint8Array {
    switch (s.kind) {
      case 'G':
        return this.rom.scripts[s.number]!;
      case 'R':
        return this.rom.rooms[s.room]!.raw;
      default:
        return this.objIndex.get(s.number)!.def.code;
    }
  }

  getScriptSlot(): number {
    for (let i = 1; i < NUM_SLOTS; i++) if (!this.slots[i].running && !this.slots[i].paused && !this.slots[i].number) return i;
    throw new Error('Too many scripts running');
  }

  private scopedMatch(s: Slot, script: number) {
    return !PLAYER_SCOPED.has(script) || s.ctx === this.cur;
  }

  runScript(script: number, freezeResistant: boolean, recursive: boolean, ctx = this.cur) {
    if (!script) return;
    if (WORLD_SCRIPTS.has(script)) ctx = 0;
    if (!this.rom.scripts[script]) return;
    if (!recursive) this.stopScript(script);
    const i = this.getScriptSlot();
    Object.assign(this.slots[i], { number: script, kind: 'G', room: 0, running: true, paused: false, frozen: 0, held: 0, pc: 0, delay: 0, freezeResistant, recursive, ctx, didExec: false });
    this.trace?.(`runScript ${script} ctx=${ctx} slot=${i}`);
    this.runNested(i);
  }

  runObjectScript(obj: number, entry: number, freezeResistant: boolean, recursive: boolean, slotHint = -1) {
    if (!obj) return;
    const where = this.whereIsObject(obj);
    if (where === 'none') return;
    const slot = slotHint >= 0 ? slotHint : this.getScriptSlot();
    const offs = this.getVerbEntrypoint(obj, entry);
    if (!offs) return;
    const home = this.objIndex.get(obj)!;
    Object.assign(this.slots[slot], { number: obj, kind: where === 'inventory' ? 'I' : 'O', room: home.room, running: true, paused: false, frozen: 0, held: 0, pc: offs, delay: 0, freezeResistant, recursive, ctx: this.cur, didExec: false });
    this.trace?.(`runObjectScript ${obj} verb=${entry} ctx=${this.cur}`);
    this.runNested(slot);
  }

  private runRoomScript(number: number, room: number, offs: number) {
    const i = this.getScriptSlot();
    Object.assign(this.slots[i], { number, kind: 'R', room, running: true, paused: false, frozen: 0, held: 0, pc: offs, delay: 0, freezeResistant: false, recursive: false, ctx: this.cur, didExec: false });
    this.runNested(i);
  }

  runNested(i: number) {
    const caller = this.curSlot;
    const callerSlot = caller >= 0 ? this.slots[caller] : null;
    const nest = callerSlot ? { number: callerSlot.number, kind: callerSlot.kind, ctx: callerSlot.ctx } : null;
    const callerCtx = this.cur;
    this.curSlot = i;
    this.switchCtx(this.slots[i].ctx);
    execute(this, i);
    this.switchCtx(callerCtx);
    if (nest && callerSlot && callerSlot.number === nest.number && callerSlot.kind === nest.kind && (callerSlot.running || callerSlot.paused)) {
      this.curSlot = caller;
      this.switchCtx(callerSlot.ctx);
    } else this.curSlot = -1;
  }

  killSlot(i: number) {
    const s = this.slots[i];
    s.number = 0;
    s.running = false;
    s.paused = false;
    s.frozen = 0;
    s.held = 0;
    if (this.curSlot === i) this.curSlot = -1;
  }

  stopScript(script: number) {
    if (!script) return;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const s = this.slots[i];
      if (s.number === script && s.kind === 'G' && (s.running || s.paused) && this.scopedMatch(s, script)) this.killSlot(i);
    }
  }

  stopObjectScript(obj: number) {
    if (!obj) return;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const s = this.slots[i];
      if (s.number === obj && (s.kind === 'O' || s.kind === 'I') && (s.running || s.paused)) this.killSlot(i);
    }
  }

  /** v2 stopObjectCode: end the current slot. */
  stopObjectCode() {
    const i = this.curSlot;
    const s = this.slots[i];
    if (s.kind === 'G') this.stopScript(s.number);
    this.killSlot(i);
    this.curSlot = -1;
  }

  isScriptRunning(script: number): boolean {
    return this.slots.some((s) => s.number === script && s.kind === 'G' && (s.running || s.paused) && this.scopedMatch(s, script));
  }

  isScriptInUse(script: number): boolean {
    return this.slots.some((s) => s.number === script && this.scopedMatch(s, script));
  }

  /**
   * v2 freezeScripts, limited to the given context and the system context. A player's freeze of world
   * scripts waits while the world is in a cutscene: the player can't act until it ends, so a freeze
   * waiting on them (a keypad opened just as Ed answers the door) would never be released.
   */
  freezeScripts(by: number) {
    const later = by > 0 && this.ctxs[0].cutscene;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const s = this.slots[i];
      if (i === this.curSlot || !s.number || s.freezeResistant) continue;
      if (s.ctx === by) s.frozen |= 1 << by;
      else if (s.ctx === 0) {
        if (later) s.held |= 1 << by;
        else s.frozen |= 1 << by;
      }
    }
  }

  unfreezeScripts(by: number) {
    for (const s of this.slots) {
      s.frozen &= ~(1 << by);
      s.held &= ~(1 << by);
    }
  }

  // ---------------------------------------------------------------- variables

  readVar(v: number): number {
    if (v >= 14 && v <= 16) v = this.vars[v];
    return this.vars[v & 1023];
  }

  writeVar(v: number, value: number) {
    value = (value << 16) >> 16;
    this.vars[v & 1023] = value;
    if (v === V.CURRENT_LIGHTS) this.propagateLights(value);
  }

  private propagateLights(value: number) {
    const room = this.ctxRoom();
    for (const c of this.ctxs) if (c.id !== this.cur && c.room === room && room) this.setCtxVar(c.id, V.CURRENT_LIGHTS, value);
  }

  random(max: number) {
    return this.rng.upTo(max);
  }

  // ---------------------------------------------------------------- rooms

  loadedRoom(room: number): LoadedRoom | undefined {
    return this.rooms.get(room);
  }

  /** A room is viewed when any context (player or director) is in it. */
  isViewed(room: number): boolean {
    if (!room) return false;
    for (const c of this.ctxs) if (c.room === room) return true;
    return false;
  }

  private viewers(room: number, except = -1) {
    return this.ctxs.filter((c) => c.room === room && c.id !== except);
  }

  private loadRoomObjects(id: number): LoadedRoom {
    let lr = this.rooms.get(id);
    if (lr) return lr;
    const room = this.rom.rooms[id]!;
    const objs: LocalObj[] = [null as unknown as LocalObj];
    for (const def of room.objects)
      objs.push({ def, number: def.id, x: def.x * 8, y: def.y * 8, width: def.width * 8, height: def.height, walkX: def.walkX, walkY: def.walkY, parent: def.parent, parentState: def.parentState, actorDir: def.actorDir, state: this.state[def.id] });
    lr = { room, objs, boxFlags: room.boxes.map((b) => b.flags) };
    this.rooms.set(id, lr);
    return lr;
  }

  /** startScene for the current context. */
  startScene(room: number) {
    const c = this.ctx;
    this.stopTalk(c);
    const old = c.room;
    if (this.curSlot >= 0) {
      const s = this.slots[this.curSlot];
      if ((s.kind === 'O' || s.kind === 'R') && s.room === old) this.curSlot = -1;
    }
    if (old) {
      const lastViewer = this.viewers(old, c.id).length === 0;
      if (lastViewer) this.runExitScript(old);
      // killScriptsAndResources: this context's room scripts always; everyone's when the room empties.
      for (let i = 0; i < NUM_SLOTS; i++) {
        const s = this.slots[i];
        if ((s.kind === 'O' || s.kind === 'R') && s.room === old && (s.running || s.paused) && (lastViewer || s.ctx === c.id)) this.killSlot(i);
      }
      for (const [obj] of this.newNames) if (this.owner[obj] === 0 || this.owner[obj] === OWNER_ROOM) this.newNames.delete(obj);
    }
    this.resetSentence();
    c.room = room;
    if (old && !this.isViewed(old)) this.rooms.delete(old);
    this.vars[V.ROOM] = room;
    this.vars[V.ROOM_RESOURCE] = room;
    if (!room) return;
    const lr = this.loadRoomObjects(room);
    const roomWidth = lr.room.width * 8;
    this.vars[V.CAMERA_MIN_X] = HALF;
    this.vars[V.CAMERA_MAX_X] = Math.max(HALF, roomWidth - HALF);
    c.cam.mode = 'normal';
    this.syncActorVisibility();
    this.runEntryScript(room);
    this.runScript(ROOM_START_SCRIPT, false, false);
  }

  private runExitScript(room: number) {
    const r = this.rom.rooms[room];
    if (r?.exitScript) this.runRoomScript(EXCD, room, r.exitScript);
  }

  private runEntryScript(room: number) {
    const r = this.rom.rooms[room];
    if (r?.entryScript) this.runRoomScript(ENCD, room, r.entryScript);
  }

  // ---------------------------------------------------------------- camera

  setCameraAt(x: number) {
    const cam = this.ctx.cam;
    if (cam.mode !== 'follow' || Math.abs(x - cam.cur) > HALF) cam.cur = x;
    cam.dest = x;
    if (cam.cur < this.vars[V.CAMERA_MIN_X]) cam.cur = this.vars[V.CAMERA_MIN_X];
    if (cam.cur > this.vars[V.CAMERA_MAX_X]) cam.cur = this.vars[V.CAMERA_MAX_X];
  }

  setCameraAtEx(x: number) {
    const cam = this.ctx.cam;
    cam.mode = 'normal';
    cam.cur = x;
    this.setCameraAt(x);
    cam.movingToActor = false;
  }

  panCameraTo(x: number) {
    const cam = this.ctx.cam;
    cam.dest = x;
    cam.mode = 'pan';
    cam.movingToActor = false;
  }

  private screenStartStrip(c: Ctx) {
    return (c.cam.cur >> 3) - (HALF >> 3);
  }

  setCameraFollows(a: Actor) {
    const c = this.ctx;
    c.cam.mode = 'follow';
    c.cam.follows = a.id;
    if (a.room !== c.room) {
      this.startScene(a.room);
      c.cam.mode = 'follow';
      c.cam.cur = a.x * 8;
      this.setCameraAt(c.cam.cur);
    }
    const t = a.x - this.screenStartStrip(c);
    if (t < 6 || t > 21) this.setCameraAt(a.x * 8);
  }

  actorFollowCamera(act: number) {
    this.setCameraFollows(this.actors[act]);
    this.ctx.cam.movingToActor = false;
  }

  private cameraMoved(c: Ctx) {
    const lr = this.rooms.get(c.room);
    const roomWidth = lr ? lr.room.width * 8 : VIEW_W;
    if (c.cam.cur < HALF) c.cam.cur = HALF;
    else if (c.cam.cur > roomWidth - HALF) c.cam.cur = Math.max(HALF, roomWidth - HALF);
  }

  private moveCamera(c: Ctx) {
    const cam = c.cam;
    cam.cur &= 0xfff8;
    const min = this.vars[V.CAMERA_MIN_X];
    const max = this.vars[V.CAMERA_MAX_X];
    if (cam.cur < min) {
      cam.cur += 8;
      this.cameraMoved(c);
      return;
    }
    if (cam.cur > max) {
      cam.cur -= 8;
      this.cameraMoved(c);
      return;
    }
    let a: Actor | null = null;
    if (cam.mode === 'follow') {
      a = this.actors[cam.follows];
      const t = a.x - this.screenStartStrip(c);
      if (t < 6 || t > 21) cam.movingToActor = true;
    }
    if (cam.movingToActor) {
      a = this.actors[cam.follows];
      cam.dest = a.x * 8;
    }
    if (cam.dest < min) cam.dest = min;
    if (cam.dest > max) cam.dest = max;
    if (cam.cur < cam.dest) cam.cur += 8;
    if (cam.cur > cam.dest) cam.cur -= 8;
    if (cam.movingToActor && a && cam.cur >> 3 === a.x) cam.movingToActor = false;
    this.cameraMoved(c);
  }

  // ---------------------------------------------------------------- user state & cutscenes

  setUserState(state: number) {
    const c = this.ctx;
    if (state & US.SET_IFACE) c.userState = (c.userState & ~US.IFACE_ALL) | (state & US.IFACE_ALL);
    if (state & US.SET_FREEZE) {
      if (state & US.FREEZE_ON) this.freezeScripts(c.id);
      else this.unfreezeScripts(c.id);
    }
    if (state & US.SET_CURSOR) {
      c.userState = (c.userState & ~US.CURSOR_ON) | (state & US.CURSOR_ON);
      c.userPut = !!(state & US.CURSOR_ON);
    }
  }

  beginCutscene() {
    const c = this.ctx;
    c.cutData = [c.userState | (c.userPut ? 16 : 0), this.vars[V.CURSORSTATE], c.room, c.cam.mode];
    this.vars[V.CURSORSTATE] = 200;
    this.setUserState(US.SET_IFACE | US.SET_CURSOR | US.SET_FREEZE | US.FREEZE_ON);
    c.sentences = [];
    this.stopScript(SENTENCE_SCRIPT);
    this.resetSentence();
    c.cutPtr = 0;
    c.cutscene = true;
    if (c.id === 0) {
      this.kidRoomsAtCutscene = this.players.map((pl) => this.actors[pl.kid].room);
      // The world's cutscene outranks players' freezes: they wait until it ends.
      for (const s of this.slots) {
        if (s.ctx !== 0) continue;
        s.held |= s.frozen & ~1;
        s.frozen &= 1;
      }
    }
  }

  /** Where each player's kid was when the current world cutscene began. */
  private kidRoomsAtCutscene: number[] = [];

  endCutscene() {
    const c = this.ctx;
    c.cutPtr = 0;
    c.cutSlot = -1;
    this.vars[V.OVERRIDE] = 0;
    this.vars[V.CURSORSTATE] = c.cutData[1];
    this.setUserState(c.cutData[0] | US.SET_IFACE | US.SET_CURSOR | US.SET_FREEZE);
    c.cutscene = false;
    if (c.id === 0) {
      // The director only exists for the length of a cutscene; players go back to their kids.
      const showedElsewhere = !!c.room;
      if (c.room) this.startScene(0);
      // The NES game ends a cutscene by following the ego back into its room, and starting that
      // room runs script 5, which swaps a chase theme (Ed's, Edna's) for the kid's own music.
      // Players never left their rooms here, so run it for each of them.
      if (showedElsewhere)
        for (let p = 1; p < this.ctxs.length; p++) {
          if (!this.ctxs[p].room) continue;
          this.switchCtx(p);
          this.runScript(ROOM_START_SCRIPT, false, false);
        }
      this.switchCtx(0);
      // Players whose kid was moved by the cutscene (e.g. captured) follow them to the new room.
      for (let p = 1; p < this.ctxs.length; p++) if (this.actors[this.egoOf(p)].room !== this.kidRoomsAtCutscene[p - 1]) this.refollow.add(p);
      // Players' freezes put off by the cutscene (a keypad still open) take hold again.
      for (const s of this.slots) {
        if (s.ctx !== 0) continue;
        s.frozen |= s.held;
        s.held = 0;
      }
    } else this.actorFollowCamera(this.vars[V.EGO]);
  }

  /** Skip the current cutscene of a context (ESC). */
  abortCutscene(ctx: number) {
    const c = this.ctxs[ctx];
    if (!c.cutPtr || c.cutSlot < 0) return false;
    const s = this.slots[c.cutSlot];
    s.pc = c.cutPtr;
    s.running = true;
    s.paused = false;
    s.frozen = 0;
    this.setCtxVar(ctx, V.OVERRIDE, 1);
    c.cutPtr = 0;
    return true;
  }

  // ---------------------------------------------------------------- sentences

  resetSentence() {
    this.vars[V.SENTENCE_VERB] = this.vars[V.BACKUP_VERB];
    this.vars[V.SENTENCE_OBJECT1] = 0;
    this.vars[V.SENTENCE_OBJECT2] = 0;
    this.vars[V.SENTENCE_PREPOSITION] = 0;
  }

  doSentence(verb: number, a: number, b: number) {
    const q = this.ctx.sentences;
    if (q.length >= 6) return;
    q.push({ verb, a, b, prep: b !== 0 });
  }

  private checkAndRunSentenceScript() {
    const c = this.ctx;
    if (this.isScriptInUse(SENTENCE_SCRIPT)) return;
    const st = c.sentences.pop();
    if (!st) return;
    if (st.prep && st.b === st.a) return;
    this.vars[V.ACTIVE_VERB] = st.verb;
    this.vars[V.ACTIVE_OBJECT1] = st.a;
    this.vars[V.ACTIVE_OBJECT2] = st.b;
    this.vars[V.VERB_ALLOWED] = this.getVerbEntrypoint(st.a, st.verb) ? 1 : 0;
    this.curSlot = -1;
    this.runScript(SENTENCE_SCRIPT, false, false);
  }

  // ---------------------------------------------------------------- objects

  getOwner(obj: number) {
    return this.owner[obj] ?? 0;
  }

  getState(obj: number) {
    return this.state[obj] ?? 0;
  }

  putState(obj: number, st: number) {
    if (obj < this.state.length) this.state[obj] = st & 0xff;
  }

  /** Search the current context's room first, then any other viewed room. */
  findLocal(obj: number): { lr: LoadedRoom; idx: number } | null {
    if (obj < 1) return null;
    const first = this.rooms.get(this.ctxRoom());
    const order = first ? [first, ...[...this.rooms.values()].filter((r) => r !== first)] : [...this.rooms.values()];
    for (const lr of order) {
      for (let i = lr.objs.length - 1; i > 0; i--) if (lr.objs[i].number === obj) return { lr, idx: i };
    }
    return null;
  }

  whereIsObject(obj: number): 'none' | 'room' | 'inventory' {
    if (obj < 1 || obj >= this.owner.length) return 'none';
    if (this.owner[obj] !== OWNER_ROOM) return this.inventory.includes(obj) ? 'inventory' : 'none';
    return this.findLocal(obj) ? 'room' : 'none';
  }

  getVerbEntrypoint(obj: number, entry: number): number {
    if (this.whereIsObject(obj) === 'none') return 0;
    const code = this.objIndex.get(obj)?.def.code;
    if (!code) return 0;
    for (let p = 15; p < code.length && code[p]; p += 2) if (code[p] === entry || code[p] === 0xff) return code[p + 1];
    return 0;
  }

  classOf(obj: number): number | null {
    const where = this.whereIsObject(obj);
    if (where === 'none') return null;
    return this.objIndex.get(obj)!.def.classByte;
  }

  getObjectXYPos(obj: number): { x: number; y: number; dir: number } | null {
    const f = this.findLocal(obj);
    if (!f) return null;
    const o = f.lr.objs[f.idx];
    return { x: o.walkX >> 3, y: o.walkY >> 1, dir: oldDirToNewDir(o.actorDir & 3) };
  }

  getObjectOrActorXY(obj: number): { x: number; y: number } | null {
    if (obj < NUM_ACTORS) {
      const a = this.actors[obj];
      return this.isViewed(a.room) ? { x: a.x, y: a.y } : null;
    }
    const where = this.whereIsObject(obj);
    if (where === 'none') return null;
    if (where === 'inventory') {
      const own = this.owner[obj];
      if (own < NUM_ACTORS && this.isViewed(this.actors[own].room)) return { x: this.actors[own].x, y: this.actors[own].y };
      return null;
    }
    return this.getObjectXYPos(obj);
  }

  /** Room an object or actor is in (inventory objects are with their owner), or 0. */
  roomOfObjectOrActor(obj: number): number {
    if (obj < NUM_ACTORS) return this.actors[obj]?.room ?? 0;
    if (this.owner[obj] !== OWNER_ROOM) return this.owner[obj] < NUM_ACTORS ? this.actors[this.owner[obj]].room : 0;
    return this.findLocal(obj)?.lr.room.id ?? 0;
  }

  getObjActToObjActDist(a: number, b: number): number {
    const acta = a < NUM_ACTORS ? this.actors[a] : null;
    const actb = b < NUM_ACTORS ? this.actors[b] : null;
    if (acta && actb && acta.room === actb.room && acta.room && !this.isViewed(acta.room)) return 0;
    // With several rooms live at once, things in different rooms are never "near".
    if (this.roomOfObjectOrActor(a) !== this.roomOfObjectOrActor(b)) return 0xff;
    const pa = this.getObjectOrActorXY(a);
    if (!pa) return 0xff;
    let pb = this.getObjectOrActorXY(b);
    if (!pb) return 0xff;
    if (acta && !actb) pb = adjustXYToBeInBox(this, acta, pb.x, pb.y);
    return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
  }

  /** findObject in pixel coordinates within the current context's room. */
  findObject(x: number, y: number, room = this.ctxRoom()): number {
    const lr = this.rooms.get(room);
    if (!lr) return 0;
    for (let i = 1; i < lr.objs.length; i++) {
      const o = lr.objs[i];
      if (o.number < 1 || o.state & 2) continue;
      let b = i;
      for (let guard = 0; guard < 32; guard++) {
        const a = lr.objs[b].parentState;
        b = lr.objs[b].parent;
        if (b === 0) {
          if (o.x <= x && o.width + o.x > x && o.y <= y && o.height + o.y > y) return o.number;
          break;
        }
        if ((lr.objs[b].state & 8) !== a) break;
      }
    }
    return 0;
  }

  drawObject(obj: number, xpos: number, ypos: number) {
    const f = this.findLocal(obj);
    if (!f) return;
    const od = f.lr.objs[f.idx];
    if (xpos !== 0xff) {
      od.walkX += xpos * 8 - od.x;
      od.x = xpos * 8;
      od.walkY += ypos * 8 - od.y;
      od.y = ypos * 8;
    }
    for (let i = f.lr.objs.length - 1; i > 0; i--) {
      const o = f.lr.objs[i];
      if (o.number && o.x === od.x && o.y === od.y && o.width === od.width && o.height === od.height) this.putState(o.number, this.getState(o.number) & ~8);
    }
    this.putState(obj, this.getState(od.number) | 8);
  }

  private updateObjectStates() {
    for (const lr of this.rooms.values()) for (let i = 1; i < lr.objs.length; i++) lr.objs[i].state = this.state[lr.objs[i].number];
  }

  /** Objects to draw in a loaded room, in draw order (ScummVM drawRoomObjects). */
  visibleObjects(room: number): LocalObj[] {
    const lr = this.rooms.get(room);
    if (!lr) return [];
    const out: LocalObj[] = [];
    for (let i = lr.objs.length - 1; i > 0; i--) {
      let od = lr.objs[i];
      if (!od.number || !(this.state[od.number] & 8)) continue;
      for (let guard = 0; guard < 32; guard++) {
        const a = od.parentState;
        if (!od.parent) {
          out.push(lr.objs[i]);
          break;
        }
        od = lr.objs[od.parent];
        if ((this.state[od.number] & 8) !== a) break;
      }
    }
    return out;
  }

  addObjectToInventory(obj: number) {
    const slot = this.inventory.indexOf(0);
    if (slot < 0) throw new Error('Inventory full');
    this.inventory[slot] = obj;
  }

  pickupObject(obj: number) {
    if (!this.findLocal(obj)) return;
    if (this.whereIsObject(obj) === 'inventory') return;
    this.addObjectToInventory(obj);
    this.owner[obj] = this.vars[V.EGO];
    this.putState(obj, this.getState(obj) | 8 | 2);
  }

  setOwnerOf(obj: number, owner: number) {
    if (obj < 1) return;
    if (owner === 0) {
      this.stopObjectScript(obj);
      const i = this.inventory.indexOf(obj);
      if (i >= 0 && this.owner[obj] !== OWNER_ROOM) this.inventory[i] = 0;
    }
    this.owner[obj] = owner;
  }

  inventoryOf(owner: number): number[] {
    return this.inventory.filter((o) => o && this.owner[o] === owner);
  }

  nameOf(obj: number): string {
    let bytes: ArrayLike<number> | undefined;
    if (obj < NUM_ACTORS) bytes = this.actors[obj]?.name;
    else bytes = this.newNames.get(obj) ?? this.objIndex.get(obj)?.def.name;
    return bytes ? String.fromCharCode(...Array.from(bytes)).replace(/@/g, '') : '';
  }

  // ---------------------------------------------------------------- actors

  getActorFromPos(x: number, y: number, room = this.ctxRoom()): number {
    for (let i = 1; i < NUM_ACTORS; i++) {
      const a = this.actors[i];
      if (i === this.vars[V.EGO] || a.room !== room || !a.visible || !a.costume) continue;
      let y2 = a.y * 2;
      let y1 = a.y * 2 - 80;
      y2 = (y2 - a.elevation) & 0xff;
      y1 = (y1 - a.elevation) & 0xff;
      const ax = a.x * 8 - (a.facing === 90 ? 8 : 0);
      if (x >= ax - 12 && x < ax + 12 && y >= y1 && y <= y2) return i;
    }
    return 0;
  }

  // ---------------------------------------------------------------- messages

  isTalking(actor: number): boolean {
    return this.ctxs.some((c) => c.msg.actor === actor && c.msg.have);
  }

  stopTalkFor(actor: number) {
    for (const c of this.ctxs) if (c.msg.actor === actor) this.stopTalk(c);
  }

  /** Expand message control codes 4-7 into text now (ScummVM convertMessageToString). */
  private convertMessage(raw: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const byte = raw[i];
      const c = byte & 0x7f;
      if (c < 8) {
        if (c <= 3) out.push(0x100 | c);
        else {
          const arg = raw[++i];
          let s = '';
          if (c === 4) s = String(this.readVar(arg));
          else if (c === 5) s = String.fromCharCode(...(this.verbs.get(this.readVar(arg)) ?? [])).replace(/@/g, '');
          else if (c === 6) s = this.nameOf(this.readVar(arg));
          for (const ch of s) out.push(ch.charCodeAt(0));
        }
      } else out.push(c);
      if (byte & 0x80) out.push(32);
    }
    return out;
  }

  actorTalk(actor: number, raw: Uint8Array) {
    const c = this.ctx;
    const buf = this.convertMessage(raw);
    if (actor !== 0xff) {
      const a = this.actors[actor];
      if (!a || !this.isViewed(a.room)) return;
      if (!c.msg.keepText) this.stopTalk(c);
      c.msg.actor = actor;
      c.msg.room = a.room;
      if (a.visible && a.frame !== TALK_START_FRAME) startAnimActor(this, a, TALK_START_FRAME);
      c.msg.useTalkAnims = true;
    } else {
      if (!c.msg.keepText) this.stopTalk(c);
      c.msg.actor = 0xff;
      c.msg.room = this.ctxRoom();
    }
    c.msg.buf = buf;
    c.msg.pos = 0;
    c.msg.talkDelay = 0;
    c.msg.have = 0xff;
    this.vars[V.HAVE_MSG] = 0xff;
    this.vars[V.CHARCOUNT] = 0;
    this.displayDialog(c);
  }

  stopTalk(c: Ctx) {
    const m = c.msg;
    m.have = 0;
    m.talkDelay = 0;
    if (m.actor && m.actor < 0x80) {
      const a = this.actors[m.actor];
      if (this.isViewed(a.room) && m.useTalkAnims && a.frame !== TALK_STOP_FRAME) startAnimActor(this, a, TALK_STOP_FRAME);
      m.useTalkAnims = false;
    }
    m.actor = 0xff;
    m.keepText = false;
    m.text = '';
  }

  private displayDialog(c: Ctx) {
    const m = c.msg;
    if (!m.have) return;
    if (m.talkDelay) return;
    if (m.have === 1) {
      this.stopTalk(c);
      return;
    }
    if (m.actor < 0x80) {
      const a = this.actors[m.actor];
      if (this.isViewed(a.room) && a.frame !== TALK_START_FRAME) startAnimActor(this, a, TALK_START_FRAME);
      m.useTalkAnims = true;
    }
    const textSpeed = 6;
    m.talkDelay = 60;
    if (!m.keepText) {
      m.text = '';
      m.msgCount = 0;
    } else m.talkDelay += m.msgCount * textSpeed;
    while (true) {
      if (m.pos >= m.buf.length) {
        m.have = 1;
        m.keepText = false;
        m.msgCount = 0;
        break;
      }
      const ch = m.buf[m.pos++];
      if (ch === 0x101) {
        m.text += '\n';
        continue;
      }
      if (ch === 0x102) {
        m.have = 0;
        m.keepText = true;
        break;
      }
      if (ch === 0x103) {
        m.have = 0xff;
        m.keepText = false;
        m.msgCount = 0;
        break;
      }
      if (ch >= 0x100) continue;
      m.text += String.fromCharCode(ch);
      m.msgCount++;
      m.talkDelay += textSpeed;
      this.vars[V.CHARCOUNT]++;
    }
  }

  // ---------------------------------------------------------------- sound

  startSound(s: number) {
    this.sound.start(s);
  }

  stopSound(s: number) {
    this.sound.stop(s);
  }

  stopAllSounds() {
    this.sound.stopAll();
  }

  isSoundRunning(s: number) {
    return this.sound.status(s);
  }

  // ---------------------------------------------------------------- player commands

  /**
   * A player whose own cutscene has cut away to a room their kid isn't in ("Meanwhile, in the
   * lab..."), or 0. Everyone watches it, so the other players wait until it ends.
   */
  cutAway(): number {
    for (let p = 1; p < this.ctxs.length; p++) {
      const c = this.ctxs[p];
      if (c.cutscene && c.room && c.room !== this.actors[this.egoOf(p)].room) return p;
    }
    return 0;
  }

  /** Can this player act right now? */
  canAct(p: number): boolean {
    const c = this.ctxs[p];
    const sys = this.ctxs[0];
    if (!c.userPut || c.cutscene || sys.cutscene || !sys.userPut || c.room === 0 || this.cutAway()) return false;
    // Cursor state 3 is a full-screen interface (keypads, phone): the kid isn't in that "room".
    return this.actors[this.egoOf(p)].room === c.room || this.ctxVar(p, V.CURSORSTATE) === 3;
  }

  /** Walk to a point in pixel coordinates of the player's room. */
  walk(p: number, px: number, py: number): boolean {
    if (!this.canAct(p)) return false;
    const prev = this.cur;
    this.switchCtx(p);
    this.ctxs[p].sentences = [];
    this.stopScript(SENTENCE_SCRIPT);
    const a = this.actors[this.egoOf(p)];
    startWalkActor(this, a, px >> 3, py >> 1, -1);
    this.switchCtx(prev);
    return true;
  }

  /** Stop the player's kid where they stand (releasing the D-pad). */
  stopWalk(p: number): boolean {
    if (!this.canAct(p)) return false;
    const a = this.actors[this.egoOf(p)];
    if (!a.moving) return true;
    a.moving = 0;
    startAnimActor(this, a, 1);
    return true;
  }

  /** Queue a sentence (verb, objectA[, objectB]) for a player's kid. */
  sentence(p: number, verb: number, a: number, b = 0): boolean {
    if (!this.canAct(p)) return false;
    // "Go to <person>": the game's scripts do nothing with it, so walk up beside them.
    if (verb === GO_TO_VERB && a > 0 && a < NUM_ACTORS) return this.walkToActor(p, a);
    const prev = this.cur;
    this.switchCtx(p);
    this.ctxs[p].sentences = [];
    this.stopScript(SENTENCE_SCRIPT);
    this.vars[V.SENTENCE_VERB] = verb;
    this.vars[V.SENTENCE_OBJECT1] = a;
    this.vars[V.SENTENCE_OBJECT2] = b;
    this.doSentence(verb, a, b);
    this.switchCtx(prev);
    return true;
  }

  /** Walk the player's kid to stand a few steps beside another actor in the same room. */
  private walkToActor(p: number, actor: number): boolean {
    const to = this.actors[actor];
    const ego = this.actors[this.egoOf(p)];
    if (!to || actor === ego.id || to.room !== ego.room) return false;
    const side = ego.x <= to.x ? -1 : 1;
    return this.walk(p, (to.x + side * 3) * 8, to.y * 2);
  }

  /** Run an object's verb script directly in a context, as doSentence(..., execute) does. */
  execSentence(ctx: number, verb: number, a: number, b = 0) {
    const prev = this.cur;
    this.switchCtx(ctx);
    this.vars[V.ACTIVE_VERB] = verb;
    this.vars[V.ACTIVE_OBJECT1] = a;
    this.vars[V.ACTIVE_OBJECT2] = b;
    this.curSlot = -1;
    this.runObjectScript(a, verb, false, false);
    this.curSlot = -1;
    this.switchCtx(prev);
  }

  /** Is the given context busy (walking, running a sentence, or in a cutscene)? */
  busy(p: number): boolean {
    const c = this.ctxs[p];
    if (c.cutscene || this.ctxs[0].cutscene) return true;
    if (c.sentences.length) return true;
    if (this.slots.some((s) => s.number === SENTENCE_SCRIPT && s.kind === 'G' && s.ctx === p && (s.running || s.paused))) return true;
    // Object and room scripts the player started (e.g. a door that waits a frame before moving them).
    if (this.slots.some((s) => s.number && s.kind !== 'G' && s.ctx === p && (s.running || s.paused))) return true;
    if (this.actors[this.egoOf(p)].moving) return true;
    if (c.msg.have) return true;
    return false;
  }

  turnAll() {
    for (const a of this.actors) if (a.moving & MF_TURN) setDirection(this, a, a.targetFacing);
  }
}

export { putActor };
