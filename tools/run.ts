// Boot the game headless and log what happens: `bun tools/run.ts [frames] [--skip]`
import { loadRom } from '../src/rom/rom';
import { Session } from '../src/engine/session';
const rom = loadRom(new Uint8Array(await Bun.file('rom/Maniac Mansion (USA).nes').arrayBuffer()));
const frames = Number(process.argv[2] ?? 2000);
const s = new Session(rom, { kids: ['bernard', 'michael'], skipIntro: process.argv.includes('--skip') });
const e = s.engine;
let last = '';
for (let f = 0; f < frames; f++) {
  try {
    s.step();
  } catch (err) {
    console.log(`frame ${f}: ERROR ${(err as Error).message}`);
    break;
  }
  const rooms = e.ctxs.map((c) => `${c.id}:${c.room}${c.cutscene ? '*' : ''}`).join(' ');
  const msgs = [0, 1, 2].map((p) => (p ? s.messagesFor(p) : e.ctxs[0].msg.text ? [e.ctxs[0].msg.text] : []).join('|')).join(' / ');
  const kids = [5, 4, 3].map((k) => `${e.nameOf(k)}@${e.actors[k].room}:${e.actors[k].x},${e.actors[k].y}`).join(' ');
  const line = `ctx[${rooms}] ready=${s.ready} ${kids} msg: ${msgs}`;
  if (line !== last) console.log(`f${f}: ${line}`);
  last = line;
}
console.log('slots:', e.slots.map((sl, i) => sl.number ? `${i}:${sl.kind}${sl.number}@${sl.pc.toString(16)}${sl.paused ? 'P' + sl.delay : ''}${sl.frozen ? 'F' : ''}${sl.running ? 'R' : ''} c${sl.ctx}` : '').filter(Boolean).join('  '));
console.log('cursor/userPut', e.ctxs.map((c) => `${c.id}:${c.userPut}/${c.cutscene}`).join(' '), 'vars110/111', e.vars[110], e.vars[111]);
