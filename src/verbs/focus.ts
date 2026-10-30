// Direct (D-pad) control: walk the kid with directions, and act on whatever is nearest.
// The focus target is chosen locally on each client; only the resulting sentence goes on the wire.

import { type Actor, adjustXYToBeInBox, walkRoute } from '../engine/actor';
import { BOX_INVISIBLE, BOX_LOCKED, nextBox } from '../engine/boxes';
import { type Engine, NUM_ACTORS } from '../engine/engine';
import { VERB, VERB_LABELS, affordances, pairSentence, takesGifts } from './affordances';

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
 * something to give) other people who can take it. */
export function interactables(e: Engine, p: number, includePeople = false): Target[] {
  const room = e.ctxs[p].room;
  const kid = e.egoOf(p);
  const objs = touchable(e, room)
    .filter((t) => affordances(e, p, t.id).length > 0)
    .map((t) => ({ ...t, name: t.name || 'this way' }));
  if (!includePeople) return objs;
  const people = e.actors
    .filter((a) => a.id > 0 && a.id < NUM_ACTORS && a.id !== kid && a.room === room && a.visible && a.costume && e.nameOf(a.id) && takesGifts(e, a.id))
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
 * What A could do next, best first: nearby things, nearest first, each with all of its verbs before
 * the next thing's -- except that something you could pick up comes first: it's usually the point.
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
  return lists.flat();
}

/** Where to walk for a held D-pad direction, in room pixels. */
export function dpadTarget(e: Engine, p: number, dx: number, dy: number): { x: number; y: number } | null {
  const a = e.actors[e.egoOf(p)];
  const lr = e.loadedRoom(a.room);
  if (!lr || (!dx && !dy)) return null;
  const w = lr.room.width * 8;
  // Aim at the room's edge that way. Diagonals aim a fixed distance out so both axes move together.
  const aim =
    dx && dy
      ? { x: Math.max(0, Math.min(w - 1, a.x * 8 + dx * 64)), y: Math.max(0, Math.min(127, a.y * 2 + dy * 32)) }
      : { x: dx < 0 ? 0 : dx > 0 ? w - 1 : a.x * 8, y: dy < 0 ? 0 : dy > 0 ? 127 : a.y * 2 };
  // The pathfinder may get there by a detour: from in front of the yard fence, "up" means round the end
  // of the fence and back along behind it. Then walk straight ahead until something is in the way.
  if (a.walkbox >= lr.room.boxes.length || !wanders(walkRoute(e, a, aim.x >> 3, aim.y >> 1), dx, dy)) return aim;
  return straightAhead(e, a, aim);
}

/**
 * Does a route (actor units) wander instead of heading the pressed way? Per axis, in pixels: travel
 * against a pressed direction, or back and forth across it, is wasted. A route wanders when it gets
 * nowhere or wastes more than it gains. Sliding along a wall, an L-shaped path or a slanted box wastes
 * nothing.
 */
function wanders(route: { x: number; y: number }[], dx: number, dy: number): boolean {
  let gain = 0;
  let waste = 0;
  let moved = false;
  for (const [axis, d, px] of [['x', dx, 8], ['y', dy, 2]] as const) {
    let total = 0;
    let net = 0;
    for (let i = 1; i < route.length; i++) {
      const v = (route[i][axis] - route[i - 1][axis]) * px;
      total += Math.abs(v);
      net += v;
    }
    if (total) moved = true;
    if (d) {
      gain += net * d;
      waste += (total - net * d) / 2;
    } else waste += total - Math.abs(net);
  }
  return moved && (gain <= 0 || waste > gain);
}

/**
 * The farthest point (room pixels) on the straight line towards `aim` the kid can walk to without
 * leaving the walk boxes it crosses, each opening directly onto the next.
 */
function straightAhead(e: Engine, a: Actor, aim: { x: number; y: number }): { x: number; y: number } {
  const lr = e.loadedRoom(a.room)!;
  const { boxes, matrix } = lr.room;
  const kx = a.x * 8;
  const ky = a.y * 2;
  const len = Math.hypot(aim.x - kx, aim.y - ky);
  let box = a.walkbox;
  let at = { x: a.x, y: a.y };
  for (let t = 1; t <= len; t++) {
    const x = Math.round((kx + ((aim.x - kx) * t) / len) / 8);
    const y = Math.round((ky + ((aim.y - ky) * t) / len) / 2);
    if (x === at.x && y === at.y) continue;
    // Only spots the engine would walk to as they are, in this box or one it opens straight onto.
    const r = adjustXYToBeInBox(e, a, x, y);
    if (r.x !== x || r.y !== y) break;
    if (r.box !== box && (lr.boxFlags[r.box] & (BOX_LOCKED | BOX_INVISIBLE) || nextBox(matrix, boxes.length, box, r.box) !== r.box)) break;
    box = r.box;
    at = { x, y };
  }
  return { x: at.x * 8, y: at.y * 2 };
}
