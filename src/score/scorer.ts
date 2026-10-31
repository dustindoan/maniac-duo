// Scores a game as it runs, from the engine's state alone, the same way on every client: each
// milestone in table.ts counts once, at the tick it was first reached.

import type { Engine } from '../engine/engine';
import { BEATS, type Beat, ITEMS, ITEM_POINTS } from './table';

const FRONT_DOOR = 61;
const DUNGEON = 4;
const BASEMENT = 8;
/** Global scripts that mark beats: the police are on their way, Purple Tentacle gives in, the ending. */
const POLICE_COMING = 136;
const TENTACLE_GIVES_IN = 157;
const ENDING = 63;
/** Var[101]: 2 or 3, a recording contract; 4, a publishing contract (scripts 106, 118). */
const DEAL = 101;

export interface Milestone {
  id: string;
  tick: number;
}

export class Scorer {
  reached: Milestone[] = [];
  points = 0;
  private seen = new Set<string>();
  private rooms: number[] = [];

  /** Look at the world after a frame. */
  update(e: Engine, tick: number) {
    const kids = e.players.map((p) => p.kid);
    for (const obj of ITEMS) if (kids.includes(e.owner[obj])) this.reach(`item:${obj}`, ITEM_POINTS, tick);
    if (e.getState(FRONT_DOOR) & 8) this.beat('door', tick);
    kids.forEach((k, i) => {
      const room = e.actors[k].room;
      if (this.rooms[i] === DUNGEON && room === BASEMENT) this.beat('dungeon', tick);
      this.rooms[i] = room;
    });
    if (e.isScriptRunning(POLICE_COMING)) this.beat('police', tick);
    if (e.isScriptRunning(TENTACLE_GIVES_IN)) this.beat('tentacle', tick);
    if ([2, 3, 4].includes(e.vars[DEAL])) this.beat('deal', tick);
    if (e.isScriptRunning(ENDING)) this.beat('won', tick);
  }

  private beat(id: Beat, tick: number) {
    this.reach(id, BEATS[id].points, tick);
  }

  private reach(id: string, points: number, tick: number) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.reached.push({ id, tick });
    this.points += points;
  }
}
