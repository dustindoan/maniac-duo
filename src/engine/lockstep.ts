// Lockstep replay: a command log stamped with ticks fully determines the game.
// Tick N: apply the commands stamped N (in order), then run engine frame N.

import type { Rom } from '../rom/rom';
import { type Command, Session, type SessionOptions } from './session';

export class Lockstep {
  session: Session;
  /** Last tick whose frame has run. */
  tick = 0;

  constructor(rom: Rom, opts: SessionOptions) {
    this.session = new Session(rom, opts);
  }

  /** Run tick `t` with its commands. Ticks must be fed in order. */
  advance(t: number, cmds: Command[]) {
    if (t !== this.tick + 1) throw new Error(`lockstep gap: at ${this.tick}, got ${t}`);
    for (const c of cmds) this.session.apply(c);
    this.session.step();
    this.tick = t;
  }

  /** Catch up from a log of [tick, cmd] pairs to `toTick`. */
  replay(log: [number, Command][], toTick: number) {
    let i = 0;
    while (i < log.length && log[i][0] <= this.tick) i++;
    for (let t = this.tick + 1; t <= toTick; t++) {
      const cmds: Command[] = [];
      while (i < log.length && log[i][0] === t) cmds.push(log[i++][1]);
      this.advance(t, cmds);
    }
  }
}

/** A compact fingerprint of world state, for desync detection. */
export function stateHash(s: Session): string {
  const e = s.engine;
  let h = 2166136261;
  const mix = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 16777619);
  };
  for (const v of e.vars) mix(v);
  for (const a of e.actors) {
    mix(a.room);
    mix(a.x);
    mix(a.y);
    mix(a.facing);
  }
  for (let i = 0; i < e.owner.length; i++) {
    mix(e.owner[i]);
    mix(e.state[i]);
  }
  for (const c of e.ctxs) mix(c.room);
  return (h >>> 0).toString(16);
}
