// Renders sounds to WAV files in out/, through the same driver and APU the game uses:
//   bun tools/sound.ts 55 13      # sound 55 (music) and sound 13 (an effect)
// Music loops, so it stops after `SECONDS` (or MM_SOUND_SECONDS).
import { loadRom } from '../src/rom/rom';
import { Apu } from '../src/sound/apu';
import { SoundDriver } from '../src/sound/driver';

const RATE = 44100;
const SECONDS = Number(process.env.MM_SOUND_SECONDS ?? 30);
const rom = loadRom(new Uint8Array(await Bun.file(process.env.MM_ROM ?? 'rom/Maniac Mansion (USA).nes').arrayBuffer()));

for (const arg of process.argv.slice(2)) {
  const n = Number(arg);
  const d = new SoundDriver(rom.sounds);
  const apu = new Apu(RATE);
  d.start(n);
  if (!d.status(n)) {
    console.log(`sound ${n}: nothing to play`);
    continue;
  }
  const samples: number[] = [];
  for (let f = 0; f < SECONDS * 60 && d.status(n); f++) {
    d.begin();
    d.tick();
    for (const w of d.out.flat()) apu.apply(w);
    for (let i = 0; i < RATE / 60; i++) samples.push(apu.sample());
  }
  const file = `out/sound${n}.wav`;
  await Bun.write(file, wav(samples));
  console.log(`sound ${n}: ${(samples.length / RATE).toFixed(1)} s -> ${file}`);
}

function wav(samples: number[]): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}
