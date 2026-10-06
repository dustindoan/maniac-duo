// Reads a Maniac Mansion (USA) NES ROM into typed resources.
// Layouts follow ScummVM (engines/scumm/file_nes.cpp, object.cpp, gfx.cpp; GPL-3.0+)
// and gmarty/scumm-nes (Blue Oak Model License 1.0.0).

import { USA, USA_PRG_CRC32, type ResEntry } from './tables';
import { crc32 } from './crc32';

export interface ObjectDef {
  /** Global object number. */
  id: number;
  /** Offset of this object's code block inside the room resource. */
  codeOffset: number;
  /** Raw OBCD bytes (size-prefixed), used for verb scripts and as the inventory copy. */
  code: Uint8Array;
  classByte: number;
  /** Tile units (8px). */
  x: number;
  y: number;
  width: number;
  /** Pixels (multiple of 8). */
  height: number;
  parent: number;
  /** 0 or 8: the parent state that makes this object visible/active. */
  parentState: number;
  /** Pixels. */
  walkX: number;
  walkY: number;
  actorDir: number;
  preposition: number;
  name: Uint8Array;
  /** verb id -> offset into `code` */
  verbs: [verb: number, offset: number][];
  /** Encoded image (tile + attribute + mask update stream), or null for imageless objects. */
  image: Uint8Array | null;
}

export interface Box {
  uy: number;
  ly: number;
  ulx: number;
  urx: number;
  llx: number;
  lrx: number;
  mask: number;
  flags: number;
}

export interface Room {
  id: number;
  raw: Uint8Array;
  /** In tiles (28 or 60). */
  width: number;
  height: number;
  tileset: number;
  palette: Uint8Array;
  /** 16 rows x 64 columns of tile ids; column 0,1 and width+2,width+3 are padding. */
  nametable: Uint8Array[];
  /** 64 attribute bytes, NES layout. */
  attributes: Uint8Array;
  /** 16 rows x 8 bytes of per-tile mask bits, or null when the room has no mask. */
  mask: Uint8Array[] | null;
  objects: ObjectDef[];
  boxes: Box[];
  /** boxes.length x boxes.length, next-box-towards matrix. */
  matrix: Uint8Array;
  /** Offsets into raw, 0 when absent. */
  exitScript: number;
  entryScript: number;
}

export interface Rom {
  prg: Uint8Array;
  rooms: (Room | null)[];
  /** Global script bytecode (resource header stripped). */
  scripts: (Uint8Array | null)[];
  /** Costume descriptors: index into sprdesc tables. */
  costumes: (Uint8Array | null)[];
  /** Decoded 2bpp tile data (16 bytes per tile) per room tileset; tileset 0 holds shared base tiles. */
  roomGfx: Uint8Array[];
  costumeGfx: Uint8Array[];
  sprPals: Uint8Array[];
  sprDesc: Uint8Array[];
  sprLens: Uint8Array[];
  sprOffs: Uint8Array[];
  sprData: Uint8Array[];
  /** Initial object table: low nibble owner, high nibble state. */
  objectFlags: Uint8Array;
  charset: Uint8Array;
  prepositions: string[];
  /** Sound and music resources for the NES sound driver: channel, priority, data. */
  sounds: (Uint8Array | null)[];
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

export class RomError extends Error {}

/** Accepts a .nes file (with iNES header) or bare PRG data. */
export function stripHeader(file: Uint8Array): Uint8Array {
  if (file[0] === 0x4e && file[1] === 0x45 && file[2] === 0x53 && file[3] === 0x1a) return file.subarray(16);
  return file;
}

export function identify(file: Uint8Array): 'USA' | null {
  const prg = stripHeader(file);
  if (prg.length !== 0x40000) return null;
  return crc32(prg) === USA_PRG_CRC32 ? 'USA' : null;
}

function slice(prg: Uint8Array, [off, len]: ResEntry): Uint8Array | null {
  if (off === 0 && len === 0) return null;
  return prg.subarray(off, off + len);
}

/** RLE used throughout NES MM: high bit set = literal run, else repeat next byte. */
export function rleDecode(src: Uint8Array, pos: number, count: number, out: Uint8Array, outPos = 0): number {
  let n = 0;
  while (n < count) {
    const ctl = src[pos++];
    const run = ctl & 0x7f;
    if (ctl & 0x80) {
      for (let j = 0; j < run; j++) out[outPos + n++] = src[pos++];
    } else {
      const v = src[pos++];
      for (let j = 0; j < run; j++) out[outPos + n++] = v;
    }
  }
  return pos;
}

function decodeTiles(res: Uint8Array): Uint8Array {
  const tiles = res[0] === 0 ? 256 : res[0];
  const out = new Uint8Array(tiles * 16);
  rleDecode(res, 1, tiles * 16, out);
  return out;
}

function cString(b: Uint8Array, at: number, end: number): Uint8Array {
  let e = at;
  while (e < end && b[e] !== 0) e++;
  return b.subarray(at, e);
}

function parseObject(raw: Uint8Array, codeOffset: number, imageOffset: number, firstCode: number): ObjectDef {
  const size = u16(raw, codeOffset);
  const code = raw.subarray(codeOffset, codeOffset + size);
  const id = u16(code, 4);
  const yb = code[8];
  const width = code[9];
  const hb = code[13];
  const height = hb & 0xf8;
  const nameOffset = code[14];
  const verbs: [number, number][] = [];
  for (let p = 15; p < size && code[p] !== 0; p += 2) verbs.push([code[p], code[p + 1]]);

  let image: Uint8Array | null = null;
  if (imageOffset !== firstCode && width > 0 && height > 0) {
    // Image stream length isn't stored; measure it by walking the RLE runs.
    let p = imageOffset;
    const rows = height >> 3;
    for (let r = 0; r < rows; r++) {
      let n = 0;
      while (n < width) {
        const ctl = raw[p++];
        n += ctl & 0x7f;
        p += ctl & 0x80 ? ctl & 0x7f : 1;
      }
    }
    p += Math.ceil((width >> 1) / 4) * (rows >> 1); // attribute bytes, 4 attrs per byte per row pair
    image = raw.subarray(imageOffset, Math.min(raw.length, p + 4 + rows * 8)); // mask tail is bounded by rows*mwidth
  }

  return {
    id,
    codeOffset,
    code,
    classByte: code[6],
    x: code[7],
    y: yb & 0x7f,
    width,
    height,
    parent: code[10],
    parentState: yb & 0x80 ? 8 : 0,
    walkX: code[11] * 8,
    walkY: (code[12] & 0x1f) * 8,
    actorDir: hb & 7,
    preposition: code[12] >> 5,
    name: cString(code, nameOffset, size),
    verbs,
    image,
  };
}

export function parseRoom(id: number, raw: Uint8Array): Room {
  const width = u16(raw, 4);
  const height = u16(raw, 6);
  const gfxOff = u16(raw, 0x0a);
  const attrOff = u16(raw, 0x0c);
  const maskOff = u16(raw, 0x0e);
  const numObjects = raw[0x14];
  const boxOff = raw[0x15];
  const exitScript = u16(raw, 0x18);
  const entryScript = u16(raw, 0x1a);

  const tileset = raw[gfxOff];
  const palette = raw.slice(gfxOff + 1, gfxOff + 17);
  const nametable: Uint8Array[] = [];
  let p = gfxOff + 17;
  for (let r = 0; r < 16; r++) {
    const row = new Uint8Array(64);
    p = rleDecode(raw, p, width, row, 2);
    nametable.push(row);
  }

  const attributes = new Uint8Array(64);
  p = attrOff;
  for (let n = 0; n < 64; ) {
    const ctl = raw[p++];
    const run = ctl & 0x7f;
    if (ctl & 0x80) for (let j = 0; j < run; j++) attributes[n++] = raw[p++];
    else {
      const v = raw[p++];
      for (let j = 0; j < run; j++) attributes[n++] = v;
    }
    if (!(n & 7) && width === 0x1c) n += 8;
  }

  let mask: Uint8Array[] | null = null;
  if (raw[maskOff] !== 0) {
    const mwidth = raw[maskOff + 1];
    p = maskOff + 2;
    mask = [];
    for (let r = 0; r < 16; r++) {
      const row = new Uint8Array(8);
      p = rleDecode(raw, p, mwidth, row);
      mask.push(row);
    }
  }

  const imgOffs: number[] = [];
  const codeOffs: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    imgOffs.push(u16(raw, 0x1c + i * 2));
    codeOffs.push(u16(raw, 0x1c + numObjects * 2 + i * 2));
  }
  const firstCode = numObjects ? Math.min(...codeOffs) : 0;
  const objects = codeOffs.map((c, i) => parseObject(raw, c, imgOffs[i], firstCode));

  const numBoxes = raw[boxOff];
  const boxes: Box[] = [];
  for (let i = 0; i < numBoxes; i++) {
    const b = boxOff + 1 + i * 8;
    boxes.push({ uy: raw[b], ly: raw[b + 1], ulx: raw[b + 2], urx: raw[b + 3], llx: raw[b + 4], lrx: raw[b + 5], mask: raw[b + 6], flags: raw[b + 7] });
  }
  // Matrix: numBoxes row-start bytes, then numBoxes*numBoxes entries.
  const mstart = boxOff + 1 + numBoxes * 8 + numBoxes;
  const matrix = raw.slice(mstart, mstart + numBoxes * numBoxes);

  return { id, raw, width, height, tileset, palette, nametable, attributes, mask, objects, boxes, matrix, exitScript, entryScript };
}

export function loadRom(file: Uint8Array): Rom {
  const prg = stripHeader(file);
  if (identify(prg) !== 'USA') throw new RomError('Unsupported ROM: expected Maniac Mansion (USA) NES');
  const T = USA;
  const rooms = T.rooms.map((e, i) => {
    const raw = slice(prg, e);
    return raw ? parseRoom(i, raw) : null;
  });
  const scripts = T.scripts.map((e) => {
    const raw = slice(prg, e);
    return raw ? raw.subarray(4) : null;
  });
  const costumes = T.costumes.map((e) => slice(prg, e));
  const roomGfx = T.roomgfx.map((e) => decodeTiles(slice(prg, e)!));
  const costumeGfx = T.costumegfx.map((e) => decodeTiles(slice(prg, e)!));
  const all = (es: readonly ResEntry[]) => es.map((e) => slice(prg, e)!);
  const prepBytes = slice(prg, T.preplist[0])!;
  const prepositions: string[] = [];
  let cur = '';
  for (const b of prepBytes) {
    if (b === 0) {
      prepositions.push(cur);
      cur = '';
    } else cur += String.fromCharCode(b);
  }
  return {
    prg,
    rooms,
    scripts,
    costumes,
    roomGfx,
    costumeGfx,
    sprPals: all(T.sprpals),
    sprDesc: all(T.sprdesc),
    sprLens: all(T.sprlens),
    sprOffs: all(T.sproffs),
    sprData: all(T.sprdata),
    objectFlags: slice(prg, T.globdata[0])!,
    charset: slice(prg, T.charset[0])!,
    prepositions,
    sounds: T.sounds.map((e) => slice(prg, e)),
  };
}
