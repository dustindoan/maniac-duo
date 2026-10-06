// NES-format graphics: room backgrounds, object overlays, costume sprites.
// Ported from ScummVM engines/scumm/gfx.cpp (GdiNES) and costume.cpp (NESCostumeRenderer), GPL-3.0+.

import type { ObjectDef, Rom, Room } from '../rom/rom';

/** Mesen NTSC palette, as used by ScummVM. 64 entries of RGB. */
export const NES_RGB = new Uint8Array([
  0x66, 0x66, 0x66, 0x00, 0x2a, 0x88, 0x14, 0x12, 0xa7, 0x3b, 0x00, 0xa4, 0x5c, 0x00, 0x7e, 0x6e, 0x00, 0x40, 0x6c, 0x06, 0x00, 0x56, 0x1d, 0x00,
  0x33, 0x35, 0x00, 0x0b, 0x48, 0x00, 0x00, 0x52, 0x00, 0x00, 0x4f, 0x08, 0x00, 0x40, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xad, 0xad, 0xad, 0x15, 0x5f, 0xd9, 0x42, 0x40, 0xff, 0x75, 0x27, 0xfe, 0xa0, 0x1a, 0xcc, 0xb7, 0x1e, 0x7b, 0xb5, 0x31, 0x20, 0x99, 0x4e, 0x00,
  0x6b, 0x6d, 0x00, 0x38, 0x87, 0x00, 0x0c, 0x93, 0x00, 0x00, 0x8f, 0x32, 0x00, 0x7c, 0x8d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xfe, 0xff, 0x64, 0xb0, 0xff, 0x92, 0x90, 0xff, 0xc6, 0x76, 0xff, 0xf3, 0x6a, 0xff, 0xfe, 0x6e, 0xcc, 0xfe, 0x81, 0x70, 0xea, 0x9e, 0x22,
  0xbc, 0xbe, 0x00, 0x88, 0xd8, 0x00, 0x5c, 0xe4, 0x30, 0x45, 0xe0, 0x82, 0x48, 0xcd, 0xde, 0x4f, 0x4f, 0x4f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xfe, 0xff, 0xc0, 0xdf, 0xff, 0xd3, 0xd2, 0xff, 0xe8, 0xc8, 0xff, 0xfb, 0xc2, 0xff, 0xfe, 0xc4, 0xea, 0xfe, 0xcc, 0xc5, 0xf7, 0xd8, 0xa5,
  0xe4, 0xe5, 0x94, 0xcf, 0xef, 0x96, 0xbd, 0xf4, 0xab, 0xb3, 0xf3, 0xcc, 0xb5, 0xeb, 0xf2, 0xb8, 0xb8, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** NES palette index used for black/background. */
export const NES_BLACK = 0x1d;

/** Indexed-colour surface; each byte is an NES palette index. */
export interface Surface {
  w: number;
  h: number;
  px: Uint8Array;
}

export function surface(w: number, h: number, fill = NES_BLACK): Surface {
  return { w, h, px: new Uint8Array(w * h).fill(fill) };
}

/** Room tile pattern table: base tiles followed by the room's tileset. */
export function roomPatterns(rom: Rom, room: Room): Uint8Array {
  const base = rom.roomGfx[0];
  const set = rom.roomGfx[room.tileset];
  const out = new Uint8Array(256 * 16);
  out.set(base);
  out.set(set.subarray(0, Math.max(0, out.length - base.length)), base.length);
  return out;
}

/** Tile, attribute and mask state after drawing visible objects over the room. */
export interface Composite {
  nametable: Uint8Array[];
  attributes: Uint8Array;
  mask: Uint8Array[] | null;
}

export function compose(room: Room, objects: Iterable<ObjectDef>): Composite {
  const c: Composite = {
    nametable: room.nametable.map((r) => r.slice()),
    attributes: room.attributes.slice(),
    mask: room.mask ? room.mask.map((r) => r.slice()) : null,
  };
  for (const o of objects) if (o.image) applyObject(c, o, o.x, o.y * 8);
  return c;
}

/** decodeNESObject: patch tiles, attributes and mask with an object image. xpos in tiles, ypos in pixels. */
export function applyObject(c: Composite, o: ObjectDef, xpos: number, ypos: number) {
  const ptr = o.image!;
  let p = 0;
  const width = o.width;
  const height = o.height >> 3;
  const ty = ypos >> 3;
  for (let y = ty; y < ty + height; y++) {
    let x = xpos;
    while (x < xpos + width) {
      const len = ptr[p++];
      for (let i = 0; i < (len & 0x7f); i++) {
        const v = len & 0x80 ? ptr[p++] : ptr[p];
        if (y < 16 && 2 + x < 64) c.nametable[y][2 + x] = v;
        x++;
      }
      if (!(len & 0x80)) p++;
    }
  }
  let ay = ty;
  for (let yy = height >> 1; yy > 0; yy--) {
    let ax = xpos + 2;
    let adata = 0;
    for (let x = 0; x < width >> 1; x++) {
      if (!(x & 3)) adata = ptr[p++];
      const idx = ((ay << 2) & 0x30) | ((ax >> 2) & 0xf);
      let aand = 3;
      let aor = adata & 3;
      if (ay & 2) {
        aand <<= 4;
        aor <<= 4;
      }
      if (ax & 2) {
        aand <<= 2;
        aor <<= 2;
      }
      c.attributes[idx] = (~aand & c.attributes[idx]) | aor;
      adata >>= 2;
      ax += 2;
    }
    ay += 2;
  }
  if (!c.mask) return;
  const mx = ptr[p++];
  const mwidth = ptr[p++];
  const lmask = ptr[p++];
  const rmask = ptr[p++];
  for (let y = 0; y < height; y++) {
    const row = c.mask[y + ty];
    if (!row) {
      p += mwidth;
      continue;
    }
    row[mx] = (row[mx] & lmask) | ptr[p++];
    for (let x = 1; x < mwidth; x++) {
      row[mx + x] = x + 1 === mwidth ? (row[mx + x] & rmask) | ptr[p++] : ptr[p++];
    }
  }
}

const DARK_ROOM = [0x2d, 0x1d, 0x3d, 0x20];
const DARK_SPRITE = [0x2d, 0x1d, 0x2d, 0x3d];

export interface Background {
  surface: Surface;
  /** One byte per pixel: 1 where the background is in front of actors. */
  front: Uint8Array;
}

/** Draw the full room width (room.width tiles) at 1px = 1px. */
export function drawBackground(rom: Rom, room: Room, c: Composite, lightsOn: boolean, patterns = roomPatterns(rom, room)): Background {
  const w = room.width * 8;
  const h = 128;
  const s = surface(w, h);
  const front = new Uint8Array(w * h);
  for (let ty = 0; ty < 16; ty++) {
    for (let tx = 0; tx < room.width; tx++) {
      const x = tx + 2;
      const pal = (c.attributes[((ty << 2) & 0x30) | ((x >> 2) & 0xf)] >> (((ty & 2) << 1) | (x & 2))) & 3;
      const tile = c.nametable[ty][x];
      const masked = c.mask ? (c.mask[ty][tx >> 3] >> (tx & 7)) & 1 : 0;
      for (let i = 0; i < 8; i++) {
        const c0 = patterns[tile * 16 + i];
        const c1 = patterns[tile * 16 + i + 8];
        const row = (ty * 8 + i) * w + tx * 8;
        for (let j = 0; j < 8; j++) {
          const v = ((c0 >> (7 - j)) & 1) | (((c1 >> (7 - j)) & 1) << 1);
          s.px[row + j] = lightsOn ? room.palette[v | (pal << 2)] : DARK_ROOM[v];
          if (masked && v) front[row + j] = 1;
        }
      }
    }
  }
  return { surface: s, front };
}

const COSTUME_LOOKUP = [0x00, 0x03, 0x01, 0x06, 0x08, 0x02, 0x00, 0x07, 0x0c, 0x04, 0x09, 0x0a, 0x12, 0x0b, 0x14, 0x0d, 0x11, 0x0f, 0x0e, 0x10, 0x17, 0x00, 0x01, 0x05, 0x16];

/** Number of frames in an animation (anim = 4*frame + oldDir). */
export function costumeAnimLength(rom: Rom, costume: number, anim: number): number {
  const src = rom.costumes[costume];
  if (!src || anim > 0x17) return 0;
  return src[2 * anim + 1];
}

export interface SpriteOpts {
  set: number;
  costume: number;
  anim: number;
  pos: number;
  /** Facing right: sprites are mirrored. */
  flipped: boolean;
  lightsOn: boolean;
}

/** Draw one costume frame with its feet at (x, y) in surface coordinates. Returns false if nothing drawn. */
export function drawCostume(rom: Rom, o: SpriteOpts, dst: Surface, x0: number, y0: number, front: Uint8Array | null): boolean {
  const src = rom.costumes[o.costume];
  if (!src || o.anim > 0x17) return false;
  const frame = src[src[2 * o.anim] + o.pos];
  const desc = rom.sprDesc[o.set];
  const lens = rom.sprLens[o.set];
  const offs = rom.sprOffs[o.set];
  const data = rom.sprData[o.set];
  const tiles = rom.costumeGfx[o.set];
  const pal = rom.sprPals[o.set];
  const offset = desc[COSTUME_LOOKUP[o.costume] * 2] | (desc[COSTUME_LOOKUP[o.costume] * 2 + 1] << 8);
  const n = lens[offset + frame] + 1;
  let sp = (offs[2 * (offset + frame)] | (offs[2 * (offset + frame) + 1] << 8)) + n * 3;
  for (let i = 0; i < n; i++) {
    sp -= 3;
    let mask = data[sp] & 0x80 ? 0x01 : 0x80;
    const y = ((data[sp] << 1) << 24) >> 25;
    const tile = data[sp + 1];
    const sprpal = (data[sp + 2] & 3) << 2;
    let x = (data[sp + 2] << 24) >> 26;
    if (o.flipped) {
      mask = mask === 0x80 ? 0x01 : 0x80;
      x = -x;
    }
    for (let ty = 0; ty < 8; ty++) {
      let c1 = tiles[tile * 16 + ty];
      let c2 = tiles[tile * 16 + ty + 8];
      for (let tx = 0; tx < 8; tx++) {
        const c = (c1 & mask ? 1 : 0) | (c2 & mask ? 2 : 0);
        if (mask === 1) {
          c1 >>= 1;
          c2 >>= 1;
        } else {
          c1 <<= 1;
          c2 <<= 1;
        }
        if (!c) continue;
        const px = x0 + x + tx;
        const py = y0 + y + ty;
        if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) continue;
        if (front && front[py * dst.w + px]) continue;
        dst.px[py * dst.w + px] = o.lightsOn ? pal[c | sprpal] : DARK_SPRITE[c];
      }
    }
  }
  return true;
}

/** Convert an indexed surface to RGBA. */
export function toRGBA(s: Surface, out = new Uint8ClampedArray(s.w * s.h * 4)): Uint8ClampedArray {
  for (let i = 0; i < s.px.length; i++) {
    const c = (s.px[i] & 0x3f) * 3;
    out[i * 4] = NES_RGB[c];
    out[i * 4 + 1] = NES_RGB[c + 1];
    out[i * 4 + 2] = NES_RGB[c + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
