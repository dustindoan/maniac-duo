// Actor state, walking and animation for SCUMM v1/v2 (NES).
// Ported from ScummVM engines/scumm/actor.cpp (Actor, Actor_v2, Actor_v3), GPL-3.0+.

import { BOX_INVISIBLE, BOX_LOCKED, BOX_PLAYER_ONLY, INVALID_BOX, boxDistance, closestPtOnBox, coords, inBox, nextBox } from './boxes';
import type { Engine } from './engine';

export const MF_NEW_LEG = 1;
export const MF_IN_LEG = 2;
export const MF_TURN = 4;
export const MF_LAST_LEG = 8;

const INIT_FRAME = 2;
export const WALK_FRAME = 0;
export const STAND_FRAME = 1;
export const TALK_START_FRAME = 5;
export const TALK_STOP_FRAME = 4;

export interface Actor {
  id: number;
  name: number[];
  room: number;
  /** Actor units: x in 8px columns, y in 2px rows. */
  x: number;
  y: number;
  elevation: number;
  costume: number;
  talkColor: number;
  sound: number;
  facing: number;
  targetFacing: number;
  moving: number;
  walkbox: number;
  visible: boolean;
  /** Current animation id (_frame). */
  frame: number;
  /** Costume animation state for the single NES limb: anim = 4*frame+dir, 0xFFFF = none. */
  animId: number;
  animPos: number;
  animEnd: number;
  walk: {
    destX: number;
    destY: number;
    destBox: number;
    destDir: number;
    curBox: number;
    curX: number;
    curY: number;
    nextX: number;
    nextY: number;
    xfrac: number;
    yfrac: number;
    xAdd: number;
    yAdd: number;
    dxf: number;
    dyf: number;
    facing: number;
    threshold: number;
  };
}

export function newActor(id: number): Actor {
  return {
    id,
    name: [],
    room: 0,
    x: 0,
    y: 0,
    elevation: 0,
    costume: 0,
    talkColor: 15,
    sound: 0,
    facing: 180,
    targetFacing: 180,
    moving: 0,
    walkbox: 0,
    visible: false,
    frame: 0,
    animId: 0xffff,
    animPos: 0,
    animEnd: 0,
    walk: { destX: 0, destY: 0, destBox: 0, destDir: -1, curBox: 0, curX: 0, curY: 0, nextX: 0, nextY: 0, xfrac: 0, yfrac: 0, xAdd: 0, yAdd: 0, dxf: 0, dyf: 0, facing: 0, threshold: 0 },
  };
}

export const newDirToOldDir = (dir: number) => {
  if (dir >= 71 && dir <= 109) return 1;
  if (dir >= 109 && dir <= 251) return 2;
  if (dir >= 251 && dir <= 289) return 0;
  return 3;
};
export const oldDirToNewDir = (dir: number) => [270, 90, 180, 0][dir];

// --- Box access (uses the actor's own room) ---

function roomBoxes(e: Engine, a: Actor) {
  return e.loadedRoom(a.room);
}

export function boxFlags(e: Engine, room: number, box: number): number {
  const lr = e.loadedRoom(room);
  if (!lr || box === INVALID_BOX || box >= lr.room.boxes.length) return 0;
  return lr.boxFlags[box];
}

function isPlayer(e: Engine, a: Actor) {
  return e.isEgo(a.id);
}

export function adjustXYToBeInBox(e: Engine, a: Actor, dstX: number, dstY: number): { x: number; y: number; box: number } {
  const res = { x: dstX, y: dstY, box: INVALID_BOX };
  const lr = roomBoxes(e, a);
  if (!lr) return res;
  const n = lr.room.boxes.length - 1;
  let best = 0xff;
  for (let i = 0; i <= n; i++) {
    const box = n - i;
    const flags = lr.boxFlags[box];
    if (flags & BOX_INVISIBLE && !(flags & BOX_PLAYER_ONLY && !isPlayer(e, a))) continue;
    const r = boxDistance(coords(lr.room.boxes[box]), dstX, dstY);
    if (r.dist === 0) {
      res.x = r.x;
      res.y = r.y;
      res.box = box;
      break;
    }
    if (r.dist < best) {
      best = r.dist;
      res.x = r.x;
      res.y = r.y;
      res.box = box;
    }
  }
  return res;
}

// --- Costume animation (NESCostumeLoader) ---

function costumeDecodeData(e: Engine, a: Actor, frame: number) {
  const src = e.rom.costumes[a.costume];
  if (!src) return;
  const anim = 4 * frame + newDirToOldDir(a.facing);
  if (anim > 0x17) return;
  a.animPos = 0;
  a.animEnd = src[2 * anim + 1];
  a.animId = anim;
}

export function animateCostume(e: Engine, a: Actor) {
  if (!a.costume || a.animId === 0xffff) return;
  a.animPos++;
  if (a.animPos >= a.animEnd) a.animPos = 0;
}

export function startAnimActor(e: Engine, a: Actor, f: number) {
  switch (f) {
    case 56: f = INIT_FRAME; break;
    case 57: f = WALK_FRAME; break;
    case 58: f = STAND_FRAME; break;
    case 59: f = TALK_START_FRAME; break;
    case 60: f = TALK_STOP_FRAME; break;
  }
  if (e.isViewed(a.room) && a.costume !== 0) {
    costumeDecodeData(e, a, f);
    a.frame = f;
  }
}

export function setDirection(e: Engine, a: Actor, direction: number) {
  direction = (direction + 360) % 360;
  if (a.facing === direction) return;
  a.facing = direction;
  if (a.costume === 0) return;
  const vald = a.animId;
  if (vald === 0xffff) return;
  if ((vald & 3) === newDirToOldDir(a.facing) && vald >> 2 === a.frame) return;
  a.frame = vald >> 2;
  costumeDecodeData(e, a, vald >> 2);
}

export function turnToDirection(e: Engine, a: Actor, newdir: number) {
  if (newdir === -1) return;
  a.targetFacing = newdir;
  a.moving |= MF_TURN;
}

export function stopActorMoving(a: Actor) {
  a.moving = 0;
}

export function showActor(e: Engine, a: Actor) {
  if (a.visible || !e.isViewed(a.room)) return;
  adjustActorPos(e, a);
  a.animId = 0xffff;
  startAnimActor(e, a, STAND_FRAME);
  startAnimActor(e, a, INIT_FRAME);
  startAnimActor(e, a, TALK_STOP_FRAME);
  stopActorMoving(a);
  a.visible = true;
}

export function hideActor(e: Engine, a: Actor) {
  if (!a.visible) return;
  if (a.moving) {
    stopActorMoving(a);
    startAnimActor(e, a, STAND_FRAME);
  }
  a.visible = false;
}

export function adjustActorPos(e: Engine, a: Actor) {
  const abr = adjustXYToBeInBox(e, a, a.x, a.y);
  a.x = abr.x;
  a.y = abr.y;
  a.walk.destBox = abr.box;
  a.walkbox = abr.box;
  a.walk.destX = -1;
  stopActorMoving(a);
  if (a.walkbox !== INVALID_BOX && boxFlags(e, a.room, a.walkbox) & 7) turnToDirection(e, a, a.facing);
}

export function putActor(e: Engine, a: Actor, x: number, y: number, room: number) {
  if (a.visible && a.room !== room && e.isTalking(a.id)) e.stopTalkFor(a.id);
  a.x = x;
  a.y = y;
  a.room = room;
  if (a.visible) {
    if (e.isViewed(a.room)) {
      if (a.moving) {
        stopActorMoving(a);
        startAnimActor(e, a, STAND_FRAME);
      }
      adjustActorPos(e, a);
    } else hideActor(e, a);
  } else if (e.isViewed(a.room)) showActor(e, a);
}

export function setActorCostume(e: Engine, a: Actor, c: number) {
  if (a.visible) {
    hideActor(e, a);
    a.animId = 0xffff;
    a.costume = c;
    showActor(e, a);
  } else {
    a.costume = c;
    a.animId = 0xffff;
  }
}

export function animateActor(e: Engine, a: Actor, anim: number) {
  const chore = 0x3f - (anim >> 2) + 2;
  const dir = oldDirToNewDir(anim & 3);
  switch (chore) {
    case 2:
      startAnimActor(e, a, STAND_FRAME);
      stopActorMoving(a);
      break;
    case 3:
      a.moving &= ~MF_TURN;
      setDirection(e, a, dir);
      break;
    case 4:
      turnToDirection(e, a, dir);
      break;
    default:
      startAnimActor(e, a, anim >> 2);
  }
}

// --- Walking (Actor_v2) ---

const REMAP1 = [0x04, 0x01, 0x02, 0x00, 0x01, 0x02, 0x03, 0x00, 0x06, 0x01, 0x03, 0x00, 0x01, 0x02, 0x03, 0x00, 0x07, 0x00, 0x03, 0x00, 0x01, 0x02, 0x03, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x02, 0x03, 0x00];
const REMAP2 = [0x00, 0x01, 0x03, 0x02, 0x03, 0x00, 0x02, 0x00, 0x00, 0x01, 0x03, 0x02, 0x01, 0x03, 0x01, 0x02, 0x00, 0x01, 0x03, 0x02, 0x01, 0x00, 0x02, 0x02, 0x00, 0x01, 0x03, 0x02, 0x03, 0x03, 0x01, 0x01];
const REMAP3 = [0x00, 0x00, 0x02, 0x00, 0x01, 0x03, 0x02, 0x00, 0x01, 0x01, 0x02, 0x00, 0x01, 0x03, 0x02, 0x00, 0x02, 0x01, 0x02, 0x00, 0x01, 0x03, 0x02, 0x00, 0x03, 0x00, 0x03, 0x00, 0x01, 0x03, 0x02, 0x00];
const TURN_TABLE = [0, 2, 2, 3, 2, 1, 2, 3, 0, 1, 2, 1, 0, 1, 0, 3];

function remapDirection(e: Engine, a: Actor, dir: number): number {
  const flags = boxFlags(e, a.room, a.walkbox) & 7;
  if (a.moving & ~MF_TURN) a.targetFacing = oldDirToNewDir(REMAP2[newDirToOldDir(dir) * 8 + REMAP1[a.walk.facing * 8 + flags]]);
  else a.targetFacing = oldDirToNewDir(REMAP3[newDirToOldDir(dir) * 8 + flags]);
  return a.targetFacing | 0x400;
}

function updateActorDirection(e: Engine, a: Actor): number {
  let dir = remapDirection(e, a, a.targetFacing);
  if (dir & 0x400) dir = oldDirToNewDir(TURN_TABLE[newDirToOldDir(dir & 0x3ff) | (newDirToOldDir(a.facing) << 2)]);
  return dir;
}

function startWalkAnim(e: Engine, a: Actor, cmd: number, angle: number) {
  if (angle === -1) angle = a.facing;
  if (cmd === 3) turnToDirection(e, a, angle);
  else setDirection(e, a, angle);
  if (cmd === 1) startAnimActor(e, a, WALK_FRAME);
  else if (cmd === 3) startAnimActor(e, a, STAND_FRAME);
}

function actorWalkStep(a: Actor) {
  const w = a.walk;
  if ((w.xfrac += w.xAdd) >= w.threshold) {
    if (a.x !== w.nextX) a.x += w.dxf;
    w.xfrac -= w.threshold;
  }
  if ((w.yfrac += w.yAdd) >= w.threshold) {
    if (a.y !== w.nextY) a.y += w.dyf;
    w.yfrac -= w.threshold;
  }
  if (a.x === w.nextX && a.y === w.nextY) a.moving |= MF_IN_LEG;
}

function calcMovementFactor(e: Engine, a: Actor, nx: number, ny: number) {
  if (a.x === nx && a.y === ny) return;
  const w = a.walk;
  const diffX = nx - a.x;
  const diffY = ny - a.y;
  w.threshold = Math.max(Math.abs(diffY), Math.abs(diffX));
  w.dxf = diffX < 0 ? -1 : 1;
  w.dyf = diffY < 0 ? -1 : 1;
  w.xfrac = w.xAdd = Math.abs(diffX);
  w.yfrac = w.yAdd = Math.abs(diffY);
  w.curX = a.x;
  w.curY = a.y;
  w.nextX = nx;
  w.nextY = ny;
  w.facing = diffX >= 0 ? (diffY >= 0 ? 1 : 0) : diffY >= 0 ? 2 : 3;
  a.targetFacing = oldDirToNewDir(Math.abs(diffY) > Math.abs(diffX) ? 3 - (diffY >= 0 ? 1 : 0) : diffX >= 0 ? 1 : 0);
  a.moving &= ~MF_IN_LEG;
  if (a.facing !== a.targetFacing) a.moving |= MF_TURN;
  if (WALK_FRAME !== a.frame || a.facing !== a.targetFacing) startWalkAnim(e, a, 1, a.facing);
  if (!(a.moving & MF_TURN)) actorWalkStep(a);
}

export function startWalkActor(e: Engine, a: Actor, destX: number, destY: number, dir: number) {
  if (!e.isViewed(a.room)) {
    a.x = destX;
    a.y = destY;
    if (dir !== -1) a.facing = dir;
    return;
  }
  const abr = adjustXYToBeInBox(e, a, destX, destY);
  if (a.x === abr.x && a.y === abr.y && (dir === -1 || a.facing === dir)) return;
  a.walk.destX = abr.x;
  a.walk.destY = abr.y;
  a.walk.destBox = abr.box;
  a.walk.destDir = dir;
  a.walk.curBox = a.walkbox;
  a.moving = (a.moving & ~MF_LAST_LEG) | MF_IN_LEG | MF_NEW_LEG;
}

export function walkActor(e: Engine, a: Actor) {
  if (a.moving & MF_TURN) {
    const newDir = updateActorDirection(e, a);
    if (a.targetFacing === newDir) a.moving &= ~MF_TURN;
    setDirection(e, a, newDir);
    return;
  }
  if (!(a.moving & MF_NEW_LEG)) return;
  if (!(a.moving & MF_IN_LEG)) {
    actorWalkStep(a);
    return;
  }
  if (a.moving & MF_LAST_LEG) {
    a.moving = MF_TURN;
    startAnimActor(e, a, STAND_FRAME);
    if (a.walk.destDir !== -1) turnToDirection(e, a, a.walk.destDir);
    return;
  }
  const lr = roomBoxes(e, a);
  if (!lr) return;
  a.walkbox = a.walk.curBox;
  let fx: number;
  let fy: number;
  if (a.walkbox === a.walk.destBox) {
    fx = a.walk.destX;
    fy = a.walk.destY;
    a.moving |= MF_LAST_LEG;
  } else {
    const nb = a.walkbox === INVALID_BOX ? a.walk.destBox : a.walk.destBox === INVALID_BOX ? -1 : nextBox(lr.room.matrix, lr.room.boxes.length, a.walkbox, a.walk.destBox);
    // Room 34's matrix names a box 2 it doesn't have; treat that like no way through (as walkRoute does).
    if (nb < 0 || nb >= lr.room.boxes.length) {
      a.moving |= MF_LAST_LEG;
      return;
    }
    const flags = lr.boxFlags[nb] ?? 0;
    if (flags & BOX_LOCKED && !(flags & BOX_PLAYER_ONLY && !isPlayer(e, a))) {
      a.moving |= MF_LAST_LEG;
      a.walk.destDir = -1;
    }
    a.walk.curBox = nb;
    const tmp = closestPtOnBox(coords(lr.room.boxes[nb]), a.x, a.y);
    const cur = lr.room.boxes[a.walkbox];
    const f = cur ? closestPtOnBox(coords(cur), tmp.x, tmp.y) : tmp;
    fx = f.x;
    fy = f.y;
  }
  calcMovementFactor(e, a, fx, fy);
}

/**
 * The points an actor would pass through walking to (destX, destY), without moving it: the legs
 * walkActor takes through the box matrix, ending where that walk would stop. Keep in step with
 * startWalkActor and walkActor above.
 */
export function walkRoute(e: Engine, a: Actor, destX: number, destY: number): { x: number; y: number }[] {
  const route = [{ x: a.x, y: a.y }];
  const lr = roomBoxes(e, a);
  if (!lr) return route;
  const dest = adjustXYToBeInBox(e, a, destX, destY);
  let box = a.walkbox;
  for (let legs = 0; legs <= lr.room.boxes.length; legs++) {
    if (box === dest.box) {
      route.push({ x: dest.x, y: dest.y });
      break;
    }
    const nb = box === INVALID_BOX ? dest.box : dest.box === INVALID_BOX ? -1 : nextBox(lr.room.matrix, lr.room.boxes.length, box, dest.box);
    // Room 34's matrix names a box 2 it doesn't have; treat that like no way through.
    if (nb < 0 || nb >= lr.room.boxes.length) break;
    const { x, y } = route[route.length - 1];
    const tmp = closestPtOnBox(coords(lr.room.boxes[nb]), x, y);
    const cur = lr.room.boxes[box];
    route.push(cur ? closestPtOnBox(coords(cur), tmp.x, tmp.y) : tmp);
    box = nb;
    const flags = lr.boxFlags[nb] ?? 0;
    if (flags & BOX_LOCKED && !(flags & BOX_PLAYER_ONLY && !isPlayer(e, a))) break;
  }
  return route;
}

export function faceToObject(e: Engine, a: Actor, obj: number) {
  if (!e.isViewed(a.room)) return;
  const p = e.getObjectOrActorXY(obj);
  if (!p) return;
  let dir = a.x < p.x ? 1 : 0;
  if (Math.abs(a.x - p.x) < 2) dir = a.y > p.y ? 3 : 2;
  turnToDirection(e, a, oldDirToNewDir(dir));
}

/** True if (x,y) in actor units is inside box `box` of the actor's room. */
export function inActorBox(e: Engine, room: number, box: number, x: number, y: number) {
  const lr = e.loadedRoom(room);
  if (!lr || box >= lr.room.boxes.length) return false;
  return inBox(coords(lr.room.boxes[box]), x, y);
}
