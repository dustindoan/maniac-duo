// Footsteps: when a walking actor's foot lands, in the rooms this screen shows. Presentation
// only (the original has none): it reads the world and never changes it, so it can't put clients
// out of step, and it stays out of the game's sound driver, whose effects mute the music.

import { WALK_FRAME } from '../engine/actor';
import type { Session } from '../engine/session';

export interface Footfall {
  actor: number;
  /** 0 or 1: which foot, for a slightly different sound. */
  foot: number;
}

export class Footfalls {
  /** Walking actors' animation positions at the last update. */
  private last = new Map<number, number>();

  /** Feet that landed since the last update, for actors in the rooms `viewers` see. */
  update(s: Session, viewers: number[]): Footfall[] {
    const e = s.engine;
    const rooms = new Set(s.shared() !== null ? [s.viewRoom(viewers[0] ?? 1)] : viewers.map((p) => s.viewRoom(p)));
    const out: Footfall[] = [];
    for (const a of e.actors) {
      const walking = a.id > 0 && a.visible && a.costume && a.moving && a.frame === WALK_FRAME && a.animId !== 0xffff && rooms.has(a.room);
      if (!walking) {
        this.last.delete(a.id);
        continue;
      }
      const prev = this.last.get(a.id);
      this.last.set(a.id, a.animPos);
      // Two steps per walk cycle: at its start and halfway.
      const half = Math.max(1, a.animEnd >> 1);
      if (a.animPos !== prev && a.animPos % half === 0) out.push({ actor: a.id, foot: a.animPos === 0 ? 0 : 1 });
    }
    return out;
  }
}
