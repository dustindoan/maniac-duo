// Disassemble scripts: `bun tools/disasm.ts script 1 2 4`, `bun tools/disasm.ts room 1` (entry/exit + object verbs)
import { loadRom } from '../src/rom/rom';
import { disassemble } from '../src/engine/bytecode';
const rom = loadRom(new Uint8Array(await Bun.file('rom/Maniac Mansion (USA).nes').arrayBuffer()));
const [kind, ...ids] = process.argv.slice(2);
const txt = (b: Uint8Array) => String.fromCharCode(...b);
const VERBS: Record<number, string> = { 1: 'Open', 2: 'Close', 3: 'Give', 4: 'TurnOn', 5: 'TurnOff', 6: 'Fix', 7: 'NewKid', 8: 'Unlock', 9: 'Push', 10: 'Pull', 11: 'Use', 12: 'Read', 13: 'WalkTo', 14: 'PickUp', 15: 'WhatIs', 16: '?16', 255: 'Default' };
const list = ids.length ? ids.map(Number) : kind === 'script' ? rom.scripts.map((_, i) => i) : rom.rooms.map((_, i) => i);
for (const id of list) {
  if (kind === 'script') {
    const code = rom.scripts[id];
    if (!code) continue;
    console.log(`\n=== script ${id}`);
    console.log(disassemble(code).join('\n'));
  } else {
    const room = rom.rooms[id];
    if (!room) continue;
    console.log(`\n=== room ${id}`);
    if (room.entryScript) console.log('-- entry\n' + disassemble(room.raw, room.entryScript).join('\n'));
    if (room.exitScript) console.log('-- exit\n' + disassemble(room.raw, room.exitScript, room.entryScript > room.exitScript ? room.entryScript : room.raw.length).join('\n'));
    for (const o of room.objects) {
      console.log(`-- object ${o.id} "${txt(o.name)}"`);
      const starts = o.verbs.map(([, off]) => off).sort((a, b) => a - b);
      for (const [v, off] of o.verbs) {
        const end = starts.find((s) => s > off) ?? (o.code.length);
        console.log(`  [${VERBS[v] ?? v}] @${off}`);
        console.log(disassemble(o.code, off, Math.min(end, o.code.length)).map((l) => '    ' + l).join('\n'));
      }
    }
  }
}
