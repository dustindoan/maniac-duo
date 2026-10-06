// Run a route file and print progress: bun tools/route.ts test/route.txt
import { loadRom } from '../src/rom/rom';
import { Session } from '../src/engine/session';
import { Driver } from '../src/engine/driver';
import { RouteError, runRoute } from '../src/engine/route';

const rom = loadRom(new Uint8Array(await Bun.file(process.env.MM_ROM ?? 'rom/Maniac Mansion (USA).nes').arrayBuffer()));
const d = new Driver(new Session(rom, { kids: ['bernard', 'michael'], skipIntro: true }));
const show = (p: number) => `P${p}@${d.room(p)} inv=[${d.inventory(p)}]`;
try {
  runRoute(d, await Bun.file(process.argv[2] ?? 'test/route.txt').text(), (s) =>
    console.log(`${String(s.line).padStart(3)} ${s.text.padEnd(42)} ${show(1)} ${show(2)} f${d.frames}${s.output.length ? '  "' + s.output.join(' // ').replace(/\n/g, ' ') + '"' : ''}`),
  );
  console.log(`route complete, ${d.won ? 'GAME WON' : 'not won'} after ${d.frames} frames`);
} catch (err) {
  console.log(`FAILED ${(err as Error).message}  ${show(1)} ${show(2)}`);
  if (err instanceof RouteError) console.log(d.log.slice(-6).map((l) => `  [f${l.frame} P${l.player} r${l.room}] ${l.text}`).join('\n'));
  process.exit(1);
}
