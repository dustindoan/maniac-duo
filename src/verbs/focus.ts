// Direct (D-pad) control: walk the kid with directions, and act on whatever is nearest.
// The focus target is chosen locally on each client; only the resulting sentence goes on the wire.

import { type Engine, NUM_ACTORS } from '../engine/engine';
import { VERB, VERB_LABELS, affordances, pairSentence } from './affordances';

export interface Target {
  id: number;
  name: string;
  /** Room-pixel rectangle used for highlighting. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Objects in a room the player could touch right now (mirrors findObject's visibility rules). */
export function touchable(e: Engine, room: number): Target[] {
  const lr = e.loadedRoom(room);
  if (!lr) return [];
  const out: Target[] = [];
  for (let i = 1; i < lr.objs.length; i++) {
    const o = lr.objs[i];
    if (o.number < 1 || e.getState(o.number) & 2) continue;
    let b = i;
    let ok = false;
    for (let guard = 0; guard < 32; guard++) {
      const want = lr.objs[b].parentState;
      b = lr.objs[b].parent;
      if (b === 0) {
        ok = true;
        break;
      }
      if ((e.getState(lr.objs[b].number) & 8) !== want) break;
    }
    if (ok && o.width && o.height) out.push({ id: o.number, name: e.nameOf(o.number), x: o.x, y: o.y, w: o.width, h: o.height });
  }
  return out;
}

/** Everything the player can act on: touchable objects with something to do, and (when holding
 * something to give) other people. */
export function interactables(e: Engine, p: number, includePeople = false): Target[] {
  const room = e.ctxs[p].room;
  const kid = e.egoOf(p);
  const objs = touchable(e, room)
    .filter((t) => affordances(e, p, t.id).length > 0)
    .map((t) => ({ ...t, name: t.name || 'this way' }));
  if (!includePeople) return objs;
  const people = e.actors
    .filter((a) => a.id > 0 && a.id < NUM_ACTORS && a.id !== kid && a.room === room && a.visible && a.costume && e.nameOf(a.id))
    .map((a) => ({ id: a.id, name: e.nameOf(a.id), x: a.x * 8 - 12, y: a.y * 2 - 48, w: 24, h: 48 }));
  return [...objs, ...people];
}

const FACING: Record<number, [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };

/** Things within reach, best first: nearest, preferring what the kid faces. */
export function focusTargets(e: Engine, p: number, includePeople = false, reach = 64): Target[] {
  const a = e.actors[e.egoOf(p)];
  const kx = a.x * 8;
  const ky = a.y * 2;
  const [fx, fy] = FACING[a.facing] ?? [0, 1];
  const scored: [number, Target][] = [];
  for (const t of interactables(e, p, includePeople)) {
    let tx: number;
    let ty: number;
    if (t.id < NUM_ACTORS) {
      tx = e.actors[t.id].x * 8;
      ty = e.actors[t.id].y * 2;
    } else {
      const lr = e.loadedRoom(e.ctxs[p].room)!;
      const o = lr.objs.find((x) => x && x.number === t.id)!;
      tx = o.walkX;
      ty = o.walkY;
      // Wide things (porches, fences) count from their nearest edge.
      const cx = Math.max(t.x, Math.min(kx, t.x + t.w - 1));
      if (Math.abs(cx - kx) < Math.abs(tx - kx)) tx = cx;
    }
    const dx = tx - kx;
    const dy = (ty - ky) * 0.75;
    const d = Math.hypot(dx, dy);
    if (d > reach) continue;
    const ahead = d > 0 ? (dx * fx + dy * fy) / d : 1;
    scored.push([d * (1.5 - 0.5 * ahead), t]);
  }
  return scored.sort((x, y) => x[0] - y[0]).map(([, t]) => t);
}

/** The single best thing to act on, if any. */
export function focusTarget(e: Engine, p: number, includePeople = false, reach = 64): Target | null {
  return focusTargets(e, p, includePeople, reach)[0] ?? null;
}

export interface Suggestion {
  target: Target;
  verb: number;
  label: string;
}

/**
 * What A could do next, best first. Nearby things take turns (their best verb, then their next),
 * nearest first -- except that something you could pick up comes first: it's usually the point.
 */
export function suggestions(e: Engine, p: number, inHand: number | null, max = 4): Suggestion[] {
  const targets = focusTargets(e, p, inHand !== null).slice(0, max);
  if (inHand !== null)
    return targets.map((t) => {
      const s = pairSentence(e, inHand, t.id);
      return { target: t, verb: s.verb, label: `${VERB_LABELS[s.verb]} ${e.nameOf(inHand)} ${s.verb === VERB.give ? 'to' : 'with'} ${t.name}` };
    });
  const lists = targets.map((t) => affordances(e, p, t.id).map((v) => ({ target: t, verb: v.verb, label: v.verb === VERB.goTo && t.name === 'this way' ? 'Go this way' : `${v.label} ${t.name}` })));
  const pickup = lists.findIndex((l) => l[0]?.verb === VERB.get && e.getState(l[0].target.id) & 1);
  if (pickup > 0) lists.unshift(...lists.splice(pickup, 1));
  const out: Suggestion[] = [];
  for (let round = 0; lists.some((l) => l.length > round); round++) for (const l of lists) if (l[round]) out.push(l[round]);
  return out;
}

/** Where to walk for a held D-pad direction, in room pixels. */
export function dpadTarget(e: Engine, p: number, dx: number, dy: number): { x: number; y: number } | null {
  const a = e.actors[e.egoOf(p)];
  const lr = e.loadedRoom(a.room);
  if (!lr || (!dx && !dy)) return null;
  const w = lr.room.width * 8;
  const x = dx < 0 ? 0 : dx > 0 ? w - 1 : a.x * 8;
  const y = dy < 0 ? 0 : dy > 0 ? 127 : a.y * 2;
  // Diagonals: aim a fixed distance out so both axes move together.
  if (dx && dy) return { x: Math.max(0, Math.min(w - 1, a.x * 8 + dx * 64)), y: Math.max(0, Math.min(127, a.y * 2 + dy * 32)) };
  return { x, y };
}
