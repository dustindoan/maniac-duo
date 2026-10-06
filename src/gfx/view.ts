// Renders what one player sees: a 256x152 half-screen made of a two-line text area, the 224px
// NES room view (between 16px black borders) and a one-line status bar. Indexed NES colours.

import type { Engine, LocalObj } from '../engine/engine';
import { VIEW_W } from '../engine/engine';
import type { Session } from '../engine/session';
import type { Rom, Room } from '../rom/rom';
import { type Background, type Composite, type Surface, NES_BLACK, applyObject, drawBackground, drawCostume, roomPatterns, surface } from './nes';

export const HALF_W = 256;
export const TEXT_H = 16;
export const SCENE_H = 128;
export const STATUS_H = 8;
export const HALF_H = TEXT_H + SCENE_H + STATUS_H;
export const BORDER = (HALF_W - VIEW_W) / 2;

export const WHITE = 0x30;
export const GREY = 0x10;
export const YELLOW = 0x28;

export interface ActorBox {
  actor: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface HalfView {
  room: number;
  /** Left edge of the visible room area, in room pixels. */
  scrollX: number;
  actors: ActorBox[];
}

/** NES font: glyphs are tiles in the base tileset, indexed through the ROM's charset table. */
export class Font {
  private tiles: Uint8Array;
  constructor(private rom: Rom) {
    this.tiles = rom.roomGfx[0];
  }

  draw(dst: Surface, text: string, x: number, y: number, color = WHITE, bg = -1) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code - 32 < this.rom.charset.length) {
        const tile = this.rom.charset[code - 32];
        for (let i = 0; i < 8; i++) {
          const c0 = this.tiles[tile * 16 + i];
          const c1 = this.tiles[tile * 16 + i + 8];
          for (let j = 0; j < 8; j++) {
            const px = x + j;
            const py = y + i;
            if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) continue;
            // Glyph tiles use colour 1 for paper and 2/3 for ink.
            const v = ((c0 >> (7 - j)) & 1) | (((c1 >> (7 - j)) & 1) << 1);
            if (v >= 2) dst.px[py * dst.w + px] = color;
            else if (bg >= 0) dst.px[py * dst.w + px] = bg;
          }
        }
      }
      x += 8;
    }
  }
}

/** Wrap text to lines of at most `cols` characters, honouring explicit newlines. */
export function wrap(text: string, cols = 32): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.map((l) => l.slice(0, cols));
}

export class ViewRenderer {
  private patterns = new Map<number, Uint8Array>();
  private bgCache = new Map<string, Background>();
  font: Font;

  constructor(private rom: Rom) {
    this.font = new Font(rom);
  }

  private background(room: Room, objs: LocalObj[], lights: boolean): Background {
    const key = `${room.id}|${lights ? 1 : 0}|${objs.map((o) => `${o.number}@${o.x},${o.y}`).join(';')}`;
    let bg = this.bgCache.get(key);
    if (bg) return bg;
    const c: Composite = { nametable: room.nametable.map((r) => r.slice()), attributes: room.attributes.slice(), mask: room.mask ? room.mask.map((r) => r.slice()) : null };
    for (const o of objs) if (o.def.image) applyObject(c, o.def, o.x >> 3, o.y);
    let pat = this.patterns.get(room.id);
    if (!pat) this.patterns.set(room.id, (pat = roomPatterns(this.rom, room)));
    bg = drawBackground(this.rom, room, c, lights, pat);
    if (this.bgCache.size > 64) this.bgCache.clear();
    this.bgCache.set(key, bg);
    return bg;
  }

  /** Draw player `p`'s half into `dst` at vertical offset `top`. */
  drawHalf(s: Session, p: number, dst: Surface, top: number, status: string): HalfView {
    const e = s.engine;
    const roomId = s.viewRoom(p);
    for (let i = top * dst.w; i < (top + HALF_H) * dst.w; i++) dst.px[i] = NES_BLACK;
    const view: HalfView = { room: roomId, scrollX: 0, actors: [] };

    const lr = e.loadedRoom(roomId);
    if (lr) {
      const lights = s.lightsOn(p);
      const objs = e.visibleObjects(roomId).slice().reverse();
      const bg = this.background(lr.room, objs, lights);
      const cam = this.cameraFor(s, p);
      const roomW = lr.room.width * 8;
      const scrollX = roomW <= VIEW_W ? -((VIEW_W - roomW) >> 1) : Math.max(0, Math.min(roomW - VIEW_W, cam - VIEW_W / 2));
      view.scrollX = scrollX;
      const sceneTop = top + TEXT_H;
      for (let y = 0; y < SCENE_H; y++) {
        for (let x = 0; x < VIEW_W; x++) {
          const rx = x + scrollX;
          if (rx < 0 || rx >= roomW) continue;
          dst.px[(sceneTop + y) * dst.w + BORDER + x] = bg.surface.px[y * bg.surface.w + rx];
        }
      }
      // Actors, back to front, clipped to the scene and masked by foreground tiles.
      const scene: Surface = { w: roomW, h: SCENE_H, px: new Uint8Array(0) };
      const actors = e.actors.filter((a) => a.id > 0 && a.visible && a.costume && a.room === roomId && a.animId !== 0xffff).sort((a, b) => a.y - b.y);
      for (const a of actors) {
        const tmp = surface(64, 96, 0xff);
        const ax = a.x * 8 - (a.facing === 90 ? 8 : 0);
        const ay = (a.y - a.elevation) * 2;
        drawCostume(this.rom, { set: e.costumeSet, costume: a.costume, anim: a.animId, pos: a.animPos, flipped: a.facing === 90, lightsOn: lights }, tmp, 32, 80, null);
        let bx0 = 99;
        let by0 = 99;
        let bx1 = -1;
        let by1 = -1;
        for (let y = 0; y < tmp.h; y++)
          for (let x = 0; x < tmp.w; x++) {
            const c = tmp.px[y * tmp.w + x];
            if (c === 0xff) continue;
            const rx = ax - 32 + x;
            const ry = ay - 80 + y;
            if (ry < 0 || ry >= SCENE_H || rx < 0 || rx >= scene.w) continue;
            if (bg.front[ry * roomW + rx]) continue;
            const sx = rx - scrollX;
            if (sx < 0 || sx >= VIEW_W) continue;
            dst.px[(sceneTop + ry) * dst.w + BORDER + sx] = c;
            bx0 = Math.min(bx0, x);
            by0 = Math.min(by0, y);
            bx1 = Math.max(bx1, x);
            by1 = Math.max(by1, y);
          }
        if (bx1 >= 0) view.actors.push({ actor: a.id, x0: BORDER + ax - 32 + bx0 - scrollX, y0: sceneTop + ay - 80 + by0, x1: BORDER + ax - 32 + bx1 - scrollX, y1: sceneTop + ay - 80 + by1 });
      }
    }

    // Dialogue: the most recent two lines of whatever this player can hear.
    const lines = s.messagesFor(p).flatMap((m) => wrap(m));
    lines.slice(-2).forEach((l, i) => this.font.draw(dst, l, 0, top + i * 8, WHITE));
    this.font.draw(dst, status.slice(0, 32), 0, top + TEXT_H + SCENE_H, YELLOW);
    return view;
  }

  private cameraFor(s: Session, p: number) {
    const e: Engine = s.engine;
    const sys = e.ctxs[0];
    if (sys.room && (sys.cutscene || !s.ready)) return sys.cam.cur;
    return e.ctxs[p].cam.cur;
  }
}
