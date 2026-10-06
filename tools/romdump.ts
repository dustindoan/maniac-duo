// Prints a summary of the ROM's rooms, objects and scripts.
import { loadRom } from '../src/rom/rom';
const rom = loadRom(new Uint8Array(await Bun.file(process.argv[2] || 'rom/Maniac Mansion (USA).nes').arrayBuffer()));
const txt = (b: Uint8Array) => Array.from(b, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : `\\x${c.toString(16)}`)).join('');
const only = process.argv[3] ? Number(process.argv[3]) : null;
for (const room of rom.rooms) {
  if (!room || (only !== null && room.id !== only)) continue;
  console.log(`room ${room.id}: ${room.width}x${room.height} tileset=${room.tileset} objs=${room.objects.length} boxes=${room.boxes.length} entry=${room.entryScript} exit=${room.exitScript} mask=${!!room.mask}`);
  for (const o of room.objects)
    console.log(`  obj ${o.id} "${txt(o.name)}" @${o.x},${o.y} ${o.width}x${o.height / 8} parent=${o.parent}/${o.parentState} walk=${o.walkX / 8},${o.walkY / 2} dir=${o.actorDir} cls=${o.classByte} verbs=${o.verbs.map(([v]) => v).join(',')} img=${o.image ? 'y' : 'n'}`);
}
console.log('scripts', rom.scripts.filter(Boolean).length, 'preps', rom.prepositions, 'flags', rom.objectFlags.length);
