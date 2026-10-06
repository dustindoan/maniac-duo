// Tests need your own ROM. Set MM_ROM or place it at rom/Maniac Mansion (USA).nes.
import { existsSync, readFileSync } from 'node:fs';
import { type Rom, loadRom } from '../src/rom/rom';

export const ROM_PATH = process.env.MM_ROM ?? 'rom/Maniac Mansion (USA).nes';
export const haveRom = existsSync(ROM_PATH);
let cached: Rom | null = null;
export function rom(): Rom {
  cached ??= loadRom(new Uint8Array(readFileSync(ROM_PATH)));
  return cached;
}
