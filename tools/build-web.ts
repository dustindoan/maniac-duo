// Bundle the browser client into dist/web.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/web', { recursive: true });
const res = await Bun.build({ entrypoints: ['src/web/main.ts'], outdir: 'dist/web', target: 'browser', minify: true, sourcemap: 'linked' });
if (!res.success) {
  for (const l of res.logs) console.error(l);
  process.exit(1);
}
cpSync('src/web/index.html', 'dist/web/index.html');
console.log('built dist/web:', res.outputs.map((o) => o.path.split('/').pop()).join(', '));
