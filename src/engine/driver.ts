// Scripted driving of a Session: issue commands by object name and run until the kid is idle.
// Used by the playthrough test and by tools.

import { Session } from './session';

export const VERB_IDS: Record<string, number> = {
  open: 1,
  close: 2,
  give: 3,
  'turn on': 4,
  'turn off': 5,
  fix: 6,
  unlock: 8,
  push: 9,
  pull: 10,
  use: 11,
  read: 12,
  'go to': 13,
  get: 14,
};

export interface StepLog {
  frame: number;
  player: number;
  room: number;
  text: string;
}

export class DriverError extends Error {}

export class Driver {
  log: StepLog[] = [];
  /** Set when the ending's "You won the game!" message has been shown. */
  won = false;
  private seen = new Map<string, string>();
  frames = 0;
  /** Called with every sentence before it is issued; throw to reject it. */
  validate: ((p: number, verb: number, a: number, b: number) => void) | null = null;

  constructor(public s: Session) {}

  get e() {
    return this.s.engine;
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      const restarts = this.s.restarts;
      this.s.step();
      this.frames++;
      this.collect();
      if (this.s.restarts > restarts && !this.won) throw new DriverError('the game restarted (all kids lost?)');
      this.e.events.length = 0;
    }
  }

  private collect() {
    for (const p of [1, 2]) {
      const msgs = this.s.messagesFor(p).join(' | ');
      const k = String(p);
      if (msgs && msgs !== this.seen.get(k)) this.log.push({ frame: this.frames, player: p, room: this.s.viewRoom(p), text: msgs });
      if (msgs.includes('You won the game!')) this.won = true;
      this.seen.set(k, msgs);
    }
  }

  /** Run until the session is ready for player input. */
  start(maxFrames = 20000) {
    while (!this.s.ready) {
      this.step();
      if (this.frames > maxFrames) throw new DriverError('game never became ready');
    }
  }

  /** Run until the player can act and is idle. Skips cutscenes if asked. */
  idle(p: number, { maxFrames = 6000, skip = false } = {}) {
    let n = 0;
    while (this.e.busy(p) || !this.e.canAct(p)) {
      if (skip) this.s.apply({ type: 'skip', player: p });
      this.step();
      if (++n > maxFrames) throw new DriverError(`player ${p} never became idle (room ${this.s.egoRoom(p)})`);
    }
    return n;
  }

  /** Resolve an object by name in the player's room or inventory, or a number. */
  obj(p: number, name: string | number): number {
    if (typeof name === 'number') return name;
    const e = this.e;
    const kid = e.egoOf(p);
    const lower = name.toLowerCase();
    for (const o of e.inventoryOf(kid)) if (e.nameOf(o).toLowerCase() === lower) return o;
    const lr = e.loadedRoom(e.ctxs[p].room);
    if (lr) {
      const visible = new Set(e.visibleObjects(lr.room.id).map((o) => o.number));
      const matches = lr.objs.slice(1).filter((o) => e.nameOf(o.number).toLowerCase() === lower);
      const best = matches.find((o) => visible.has(o.number) && !(e.getState(o.number) & 2)) ?? matches.find((o) => !(e.getState(o.number) & 2)) ?? matches[0];
      if (best) return best.number;
    }
    for (let a = 1; a < 25; a++) if (e.nameOf(a).toLowerCase() === lower) return a;
    throw new DriverError(`no object "${name}" for player ${p} in room ${e.ctxs[p].room}`);
  }

  /** Issue a sentence and wait for it to finish. Returns text shown meanwhile. */
  do(p: number, verb: string, a: string | number, b?: string | number, opts: { skip?: boolean; maxFrames?: number } = {}): string[] {
    this.idle(p, opts);
    const v = VERB_IDS[verb];
    if (!v) throw new DriverError(`unknown verb ${verb}`);
    const before = this.log.length;
    const oa = this.obj(p, a);
    const ob = b === undefined ? 0 : this.obj(p, b);
    this.validate?.(p, v, oa, ob);
    if (!this.s.apply({ type: 'sentence', player: p, verb: v, a: oa, b: ob })) throw new DriverError(`player ${p} cannot act`);
    this.step(2);
    this.idle(p, opts);
    return this.log.slice(before).filter((l) => l.player === p).map((l) => l.text);
  }

  /** Press keypad buttons (room 43) for each digit. `digits` is a literal like "0000" or a var number holding 4 digits. */
  dial(p: number, digits: string | number) {
    const e = this.e;
    const ds = typeof digits === 'number' ? [0, 1, 2, 3].map((i) => e.vars[digits + i]) : [...digits].map(Number);
    this.idle(p);
    const room = e.ctxs[p].room;
    const visible = new Set(e.visibleObjects(room).map((o) => o.number));
    const setA = (d: number) => (d === 0 ? 300 : 428 + d);
    const setB = (d: number) => 520 + d;
    const pick = (d: number) => (visible.has(setB(d)) && !visible.has(setA(d)) ? setB(d) : setA(d));
    for (const d of ds) {
      this.validate?.(p, VERB_IDS.use, pick(d), 0);
      if (!this.s.apply({ type: 'sentence', player: p, verb: VERB_IDS.use, a: pick(d) })) throw new DriverError(`player ${p} cannot press ${d}`);
      this.step(2);
      this.idle(p);
      this.step(4);
    }
    return ds.join('');
  }

  walk(p: number, x: number, y: number) {
    this.idle(p);
    if (!this.s.apply({ type: 'walk', player: p, x, y })) throw new DriverError(`player ${p} cannot walk`);
    this.step(2);
    this.idle(p);
  }

  room(p: number) {
    return this.s.egoRoom(p);
  }

  has(p: number, name: string) {
    const e = this.e;
    return e.inventoryOf(e.egoOf(p)).some((o) => e.nameOf(o).toLowerCase() === name.toLowerCase());
  }

  inventory(p: number) {
    const e = this.e;
    return e.inventoryOf(e.egoOf(p)).map((o) => e.nameOf(o));
  }

  /** Objects in the player's current room, for exploration. */
  look(p: number) {
    const e = this.e;
    const lr = e.loadedRoom(e.ctxs[p].room);
    if (!lr) return [];
    return lr.objs.slice(1).map((o) => ({ id: o.number, name: e.nameOf(o.number), state: e.getState(o.number), x: o.x / 8, y: o.y / 8, verbs: o.def.verbs.map(([v]) => v) }));
  }
}
