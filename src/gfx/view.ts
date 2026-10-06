// Renders the picture: one NES screen (256x240), shown at 4:3. Split screen gives each player a half
// with the original 224px room view, cropped to 118 of its 128 rows to keep their kid in view, with
// dialogue and status drawn over the scene. When everyone watches one scene (the intro, a world
// cutscene, a player's cut-away), it fills the screen in the original arrangement: dialogue, the
// whole 224x128 room, then each player's status line. Indexed NES colours.

import type { LocalObj } from '../engine/engine';
import { VIEW_W } from '../engine/engine';
import type { Session } from '../engine/session';
import type { Rom, Room } from '../rom/rom';
import { type Background, type Composite, type Surface, NES_BLACK, applyObject, drawBackground, drawCostume, roomPatterns, surface } from './nes';

/** The whole picture. */
export const FRAME_W = 256;
export const FRAME_H = 240;
/** The room as the NES shows it: 224px between black borders, 128 rows. */
export const BORDER = (FRAME_W - VIEW_W) / 2;
export const SCENE_H = 128;
/** Split screen: each player's half, all scene, and the bar between the two. */
export const HALF_H = 118;
export const GAP = 4;
const LINE = 8;
/** Shared screen: dialogue lines, then the room, then one status line per player. */
const SHARED_SCENE_Y = 5 * LINE;
const SHARED_STATUS_Y = SHARED_SCENE_Y + SCENE_H + 2 * LINE;

export const WHITE = 0x30;
export const GREY = 0x10;
export const YELLOW = 0x28;
const BAR = 0x2d;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pixels drawn for an actor, in room pixels (for clicking on people). */
export interface ActorBox {
  actor: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What one player sees, and where it is in the frame. */
export interface View {
  /** Everyone is watching this one scene full-screen. */
  shared: boolean;
  room: number;
  /** This player's part of the frame: their half, or all of it when shared. */
  area: Rect;
  /** Where the room is drawn; (scrollX, scrollY) is the room pixel at its top-left corner. */
  scene: Rect;
  scrollX: number;
  scrollY: number;
  /** Top of this player's status line. */
  statusY: number;
  actors: ActorBox[];
}

/** The room pixel under a frame pixel, if it is in the scene. */
export function toRoom(v: View, x: number, y: number): { x: number; y: number } | null {
  const s = v.scene;
  if (x < s.x || x >= s.x + s.w || y < s.y || y >= s.y + s.h) return null;
  return { x: x - s.x + v.scrollX, y: y - s.y + v.scrollY };
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

  /** Draw the whole frame; `status` gives each player's status line. Returns what each player sees. */
  drawFrame(s: Session, dst: Surface, status: (player: number) => string): View[] {
    dst.px.fill(NES_BLACK);
    const players = s.engine.players.map((_, i) => i + 1);
    if (s.shared() !== null) {
      const area = { x: 0, y: 0, w: FRAME_W, h: FRAME_H };
      const scene = this.drawScene(s, 1, dst, { x: BORDER, y: SHARED_SCENE_Y, w: VIEW_W, h: SCENE_H }, 0);
      this.drawText(dst, s.messagesFor(1), 3, LINE, -1);
      return players.map((p, i) => {
        const statusY = SHARED_STATUS_Y + i * (LINE + 4);
        this.font.draw(dst, status(p).slice(0, 32), 0, statusY, YELLOW);
        return { ...scene, shared: true, area, statusY };
      });
    }
    const views = players.map((p, i) => {
      const area = { x: 0, y: i * (HALF_H + GAP), w: FRAME_W, h: HALF_H };
      const scene = this.drawScene(s, p, dst, { x: BORDER, y: area.y, w: VIEW_W, h: HALF_H }, this.cropFor(s, p));
      // Dialogue over the top of the scene, status over the bottom.
      this.drawText(dst, s.messagesFor(p), 2, area.y, NES_BLACK);
      const statusY = area.y + HALF_H - LINE;
      this.font.draw(dst, status(p).slice(0, 32), 0, statusY, YELLOW, NES_BLACK);
      return { ...scene, shared: false, area, statusY };
    });
    for (let y = HALF_H; y < HALF_H + GAP; y++) dst.px.fill(BAR, y * dst.w, (y + 1) * dst.w);
    return views;
  }

  /** The last `lines` lines of dialogue, from `top`. */
  private drawText(dst: Surface, messages: string[], lines: number, top: number, bg: number) {
    messages
      .flatMap((m) => wrap(m))
      .slice(-lines)
      .forEach((l, i) => this.font.draw(dst, l, 0, top + i * LINE, WHITE, bg));
  }

  /**
   * First room row a split-screen half shows: as far down as the kid's feet need. A half shows all
   * but ten of the room's rows, which are almost always ceiling or sky.
   */
  private cropFor(s: Session, p: number): number {
    const e = s.engine;
    const kid = e.actors[e.egoOf(p)];
    const spare = SCENE_H - HALF_H;
    if (kid.room !== s.viewRoom(p)) return spare >> 1;
    return Math.max(0, Math.min(spare, kid.y * 2 + LINE - HALF_H));
  }

  /** Draw the room player `p` is looking at into `scene`, from room row `scrollY`. */
  private drawScene(s: Session, p: number, dst: Surface, scene: Rect, scrollY: number): Omit<View, 'shared' | 'area' | 'statusY'> {
    const e = s.engine;
    const room = s.viewRoom(p);
    const view = { room, scene, scrollX: 0, scrollY, actors: [] as ActorBox[] };
    const lr = e.loadedRoom(room);
    if (!lr) return view;
    const lights = s.lightsOn(p);
    const bg = this.background(lr.room, e.visibleObjects(room), lights);
    const roomW = lr.room.width * 8;
    const scrollX = roomW <= scene.w ? -((scene.w - roomW) >> 1) : Math.max(0, Math.min(roomW - scene.w, s.camera(p) - (scene.w >> 1)));
    view.scrollX = scrollX;
    const shown = (rx: number, ry: number) => rx >= 0 && rx < roomW && ry >= 0 && ry < SCENE_H && rx >= scrollX && rx < scrollX + scene.w && ry >= scrollY && ry < scrollY + scene.h;
    const at = (rx: number, ry: number) => (scene.y + ry - scrollY) * dst.w + scene.x + rx - scrollX;
    for (let ry = scrollY; ry < scrollY + scene.h; ry++) for (let rx = scrollX; rx < scrollX + scene.w; rx++) if (shown(rx, ry)) dst.px[at(rx, ry)] = bg.surface.px[ry * roomW + rx];
    // Actors, back to front. Foreground tiles hide an actor only when its walk box has a mask
    // (ScummVM drawActorCostume's zbuf): a kid on the path in front of the fence is drawn whole, and
    // only one standing behind it is hidden.
    const actors = e.actors.filter((a) => a.id > 0 && a.visible && a.costume && a.room === room && a.animId !== 0xffff).sort((a, b) => a.y - b.y);
    for (const a of actors) {
      const tmp = surface(64, 96, 0xff);
      const ax = a.x * 8 - (a.facing === 90 ? 8 : 0);
      const ay = (a.y - a.elevation) * 2;
      const behind = !!lr.room.boxes[a.walkbox]?.mask;
      drawCostume(this.rom, { set: e.costumeSet, costume: a.costume, anim: a.animId, pos: a.animPos, flipped: a.facing === 90, lightsOn: lights }, tmp, 32, 80, null);
      const box = { actor: a.id, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let y = 0; y < tmp.h; y++)
        for (let x = 0; x < tmp.w; x++) {
          const c = tmp.px[y * tmp.w + x];
          if (c === 0xff) continue;
          const rx = ax - 32 + x;
          const ry = ay - 80 + y;
          if (!shown(rx, ry) || (behind && bg.front[ry * roomW + rx])) continue;
          dst.px[at(rx, ry)] = c;
          box.x0 = Math.min(box.x0, rx);
          box.y0 = Math.min(box.y0, ry);
          box.x1 = Math.max(box.x1, rx);
          box.y1 = Math.max(box.y1, ry);
        }
      if (box.x1 >= box.x0) view.actors.push(box);
    }
    return view;
  }
}
