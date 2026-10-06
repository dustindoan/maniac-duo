import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { VIEW_W } from '../src/engine/engine';
import { runRoute } from '../src/engine/route';
import { Session } from '../src/engine/session';
import { compose, drawBackground, drawCostume, surface } from '../src/gfx/nes';
import { BORDER, HALF_H, SCENE_H, TEXT_H, ViewRenderer } from '../src/gfx/view';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('view', () => {
  /** Player 1's kid: costume pixels over foreground tiles, and how many of those the half-screen hides. */
  const fenceOverlap = (steps: string) => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, steps);
    const e = d.e;
    const a = e.actors[e.egoOf(1)];
    const room = e.loadedRoom(a.room)!.room;
    const roomW = room.width * 8;
    const { front } = drawBackground(rom(), room, compose(room, []), true);
    const half = surface(256, HALF_H);
    const view = new ViewRenderer(rom()).drawHalf(d.s, 1, half, 0, '');
    const sprite = surface(64, 96, 0xff);
    drawCostume(rom(), { set: e.costumeSet, costume: a.costume, anim: a.animId, pos: a.animPos, flipped: a.facing === 90, lightsOn: d.s.lightsOn(1) }, sprite, 32, 80, null);
    const left = a.x * 8 - (a.facing === 90 ? 8 : 0) - 32;
    const top = (a.y - a.elevation) * 2 - 80;
    let overlap = 0;
    let hidden = 0;
    for (let y = 0; y < sprite.h; y++)
      for (let x = 0; x < sprite.w; x++) {
        const c = sprite.px[y * sprite.w + x];
        const rx = left + x;
        const ry = top + y;
        const sx = rx - view.scrollX;
        if (c === 0xff || ry < 0 || ry >= SCENE_H || rx < 0 || rx >= roomW || sx < 0 || sx >= VIEW_W || !front[ry * roomW + rx]) continue;
        overlap++;
        if (half.px[(TEXT_H + ry) * half.w + BORDER + sx] !== c) hidden++;
      }
    return { room: a.room, mask: room.boxes[a.walkbox].mask, overlap, hidden };
  };

  test('a kid in front of the fence is drawn over it', () => {
    const r = fenceOverlap('1 walk 80,120');
    expect(r).toMatchObject({ room: 44, mask: 0 });
    expect(r.overlap).toBeGreaterThan(0);
    expect(r.hidden).toBe(0);
  });

  test('a taken key no longer lies on the pulled door mat', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    const r = new ViewRenderer(rom());
    // The key's spot on the porch as player 1 sees it, with Bernard stepped away from it.
    const spot = () => {
      runRoute(d, '1 walk 16,120');
      expect(d.e.ctxs[1].room).toBe(1);
      const half = surface(256, HALF_H);
      const view = r.drawHalf(d.s, 1, half, 0, '');
      const key = d.e.loadedRoom(1)!.objs.find((o) => o?.number === 55)!;
      const px: number[] = [];
      for (let y = key.y; y < key.y + key.height; y++) for (let x = key.x; x < key.x + key.width; x++) px.push(half.px[(TEXT_H + y) * half.w + BORDER + x - view.scrollX]);
      return px;
    };
    runRoute(d, '1 go to 258\n1 pull door mat');
    const onMat = spot();
    runRoute(d, '1 get key');
    expect(d.has(1, 'key')).toBe(true);
    expect(spot()).not.toEqual(onMat);
  });

  test('a kid behind the fence is hidden by it', () => {
    const r = fenceOverlap('1 walk 80,94');
    expect(r).toMatchObject({ room: 44, mask: 1 });
    expect(r.overlap).toBeGreaterThan(0);
    expect(r.hidden).toBe(r.overlap);
  });
});
