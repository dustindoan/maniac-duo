// Local development: build the client, then run the relay with the local ROM available to ?devrom pages.
import { mkdirSync } from 'node:fs';
await import('./build-web');
mkdirSync('data', { recursive: true });
const { createServer } = await import('../src/server/main');
const port = Number(process.env.PORT ?? 8787);
createServer({ port, dbPath: 'data/dev.sqlite', devRomPath: process.env.MANIAC_DEV_ROM ?? 'rom/Maniac Mansion (USA).nes' });
console.log(`dev server on http://localhost:${port}/?devrom`);
