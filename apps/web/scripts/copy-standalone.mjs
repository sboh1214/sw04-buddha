// Copies public/ and .next/static into the standalone output so that
// `node .next/standalone/apps/web/server.js` can serve them (Next does not copy these itself).
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const standalone = path.join(appRoot, '.next', 'standalone', 'apps', 'web');

if (!existsSync(standalone)) {
  console.error(`standalone output not found: ${standalone} (is output: "standalone" set?)`);
  process.exit(1);
}

const publicDir = path.join(appRoot, 'public');
if (existsSync(publicDir)) {
  cpSync(publicDir, path.join(standalone, 'public'), { recursive: true });
}
cpSync(path.join(appRoot, '.next', 'static'), path.join(standalone, '.next', 'static'), {
  recursive: true,
});
console.log(`copied public/ and .next/static into ${standalone}`);
