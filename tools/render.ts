// Renders rooms (with their initially visible objects) to PNGs in out/.
import { loadRom, type ObjectDef, type Room } from '../src/rom/rom';
import { compose, drawBackground, drawCostume, toRGBA, costumeAnimLength } from '../src/gfx/nes';
import { encodePNG } from './png';

const rom = loadRom(new Uint8Array(await Bun.file('rom/Maniac Mansion (USA).nes').arrayBuffer()));
const state = (o: number) => rom.objectFlags[o] >> 4;
const owner = (o: number) => rom.objectFlags[o] & 0x0f;

// drawRoomObject: an object draws if its state has the "intrinsic" bit and its parent chain is satisfied.
function visible(room: Room): ObjectDef[] {
  const byIndex = room.objects;
  const out: ObjectDef[] = [];
  for (let i = byIndex.length - 1; i >= 0; i--) {
    const o = byIndex[i];
    if (owner(o.id) !== 0x0f || !(state(o.id) & 8)) continue;
    let cur = o;
    let ok = true;
    while (cur.parent) {
      const p = byIndex[cur.parent - 1];
      if ((state(p.id) & 8) !== cur.parentState) { ok = false; break; }
      cur = p;
    }
    if (ok) out.push(o);
  }
  return out;
}

const which = process.argv.slice(2).map(Number);
for (const room of rom.rooms) {
  if (!room || (which.length && !which.includes(room.id))) continue;
  const bg = drawBackground(rom, room, compose(room, visible(room)), true);
  await Bun.write(`out/room${String(room.id).padStart(2, '0')}.png`, encodePNG(bg.surface.w, bg.surface.h, toRGBA(bg.surface), 2));
}
// Costume sheet: each costume, anims 0..23 first frame.
const { surface } = await import('../src/gfx/nes');
const sheet = surface(24 * 32, 25 * 48, 0x0f);
for (let c = 0; c < 25; c++)
  for (let a = 0; a < 24; a++)
    if (costumeAnimLength(rom, c, a) > 0) drawCostume(rom, { set: 0, costume: c, anim: a, pos: 0, flipped: false, lightsOn: true }, sheet, a * 32 + 16, c * 48 + 40, null);
await Bun.write('out/costumes.png', encodePNG(sheet.w, sheet.h, toRGBA(sheet), 2));
console.log('ok');
