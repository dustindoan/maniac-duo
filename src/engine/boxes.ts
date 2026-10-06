// Walk-box geometry for SCUMM v1/v2 rooms. Coordinates are actor units (x: 8px, y: 2px).
// Ported from ScummVM engines/scumm/boxes.cpp and actor.cpp (GPL-3.0+).

import type { Box } from '../rom/rom';

export interface Pt {
  x: number;
  y: number;
}

export interface BoxCoords {
  ul: Pt;
  ur: Pt;
  ll: Pt;
  lr: Pt;
}

export const BOX_PLAYER_ONLY = 0x20;
export const BOX_LOCKED = 0x40;
export const BOX_INVISIBLE = 0x80;
export const INVALID_BOX = 255;

export function coords(b: Box): BoxCoords {
  return {
    ul: { x: b.ulx, y: b.uy },
    ur: { x: b.urx, y: b.uy },
    ll: { x: b.llx, y: b.ly },
    lr: { x: b.lrx, y: b.ly },
  };
}

const compareSlope = (p1: Pt, p2: Pt, p3: Pt) => (p2.y - p1.y) * (p3.x - p1.x) <= (p3.y - p1.y) * (p2.x - p1.x);

/** ScummEngine::checkXYInBoxBounds (v1-v6 variant). */
export function inBox(box: BoxCoords, x: number, y: number): boolean {
  const { ul, ur, ll, lr } = box;
  if (x < ul.x && x < ur.x && x < lr.x && x < ll.x) return false;
  if (x > ul.x && x > ur.x && x > lr.x && x > ll.x) return false;
  if (y < ul.y && y < ur.y && y < lr.y && y < ll.y) return false;
  if (y > ul.y && y > ur.y && y > lr.y && y > ll.y) return false;
  const p = { x, y };
  return compareSlope(ul, ur, p) && compareSlope(ur, lr, p) && compareSlope(lr, ll, p) && compareSlope(ll, ul, p);
}

const trunc = (n: number) => (n < 0 ? Math.ceil(n) : Math.floor(n));

function closestPtOnLine(s: Pt, e: Pt, p: Pt): Pt {
  const lxdiff = e.x - s.x;
  const lydiff = e.y - s.y;
  let r: Pt;
  if (e.x === s.x) r = { x: s.x, y: p.y };
  else if (e.y === s.y) r = { x: p.x, y: s.y };
  else {
    const dist = lxdiff * lxdiff + lydiff * lydiff;
    if (Math.abs(lxdiff) > Math.abs(lydiff)) {
      const a = trunc((s.x * lydiff) / lxdiff);
      const b = trunc((p.x * lxdiff) / lydiff);
      const c = trunc(((a + b - s.y + p.y) * lydiff * lxdiff) / dist);
      r = { x: c, y: trunc((c * lydiff) / lxdiff) - a + s.y };
    } else {
      const a = trunc((s.y * lxdiff) / lydiff);
      const b = trunc((p.y * lydiff) / lxdiff);
      const c = trunc(((a + b - s.x + p.x) * lydiff * lxdiff) / dist);
      r = { x: trunc((c * lxdiff) / lydiff) - a + s.x, y: c };
    }
  }
  if (Math.abs(lydiff) < Math.abs(lxdiff)) {
    if (lxdiff > 0) {
      if (r.x < s.x) r = s;
      else if (r.x > e.x) r = e;
    } else {
      if (r.x > s.x) r = s;
      else if (r.x < e.x) r = e;
    }
  } else {
    if (lydiff > 0) {
      if (r.y < s.y) r = s;
      else if (r.y > e.y) r = e;
    } else {
      if (r.y > s.y) r = s;
      else if (r.y < e.y) r = e;
    }
  }
  return { x: r.x, y: r.y };
}

/** getClosestPtOnBox. */
export function closestPtOnBox(box: BoxCoords, x: number, y: number): Pt {
  const p = { x, y };
  let best = 0xffffff;
  let out: Pt = { x, y };
  for (const [a, b] of [[box.ul, box.ur], [box.ur, box.lr], [box.lr, box.ll], [box.ll, box.ul]] as const) {
    const t = closestPtOnLine(a, b, p);
    const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
    if (d < best) {
      best = d;
      out = t;
    }
  }
  return out;
}

/** Actor_v2 helper: closest point inside a box plus a coarse distance (actor.cpp checkXYInBoxBounds). */
export function boxDistance(box: BoxCoords, x: number, y: number): { dist: number; x: number; y: number } {
  let destX = x;
  let destY = y;
  let xmin: number;
  let xmax: number;
  if (y < box.ul.y) {
    destY = box.ul.y;
    xmin = box.ul.x;
    xmax = box.ur.x;
  } else if (y >= box.ll.y) {
    destY = box.ll.y;
    xmin = box.ll.x;
    xmax = box.lr.x;
  } else if (x >= box.ul.x && x >= box.ll.x && x < box.ur.x && x < box.lr.x) {
    xmin = xmax = x;
  } else {
    destY = y;
    let ul = box.ul.x;
    let ll = box.ll.x;
    let ur = box.ur.x;
    let lr = box.lr.x;
    let top = box.ul.y;
    let bottom = box.ll.y;
    let cury: number;
    let guard = 0;
    do {
      xmin = trunc((ul + ll) / 2);
      xmax = trunc((ur + lr) / 2);
      cury = trunc((top + bottom) / 2);
      if (cury < y) {
        top = cury;
        ul = xmin;
        ur = xmax;
      } else if (cury > y) {
        bottom = cury;
        ll = xmin;
        lr = xmax;
      }
    } while (cury !== y && ++guard < 64);
  }
  if (x < xmin) destX = xmin;
  else if (x > xmax) destX = xmax;
  else destX = x;
  const xDist = Math.abs(x - destX);
  const yDist = trunc(Math.abs(y - destY) / 4);
  const dist = xDist < yDist ? (xDist >> 1) + yDist : (yDist >> 1) + xDist;
  return { dist, x: destX, y: destY };
}

/** v2 box matrix lookup: next box on the way from `from` to `to`, or -1. */
export function nextBox(matrix: Uint8Array, numBoxes: number, from: number, to: number): number {
  if (from === to) return to;
  if (from >= numBoxes || to >= numBoxes) return -1;
  const v = matrix[from * numBoxes + to];
  return (v << 24) >> 24;
}
