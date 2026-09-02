// Starts the standalone server, refusing to serve a build whose static assets do not
// match: `.next/standalone/**` is excluded from the Turbo cache (docs/DECISIONS.md
// ADR-0016), so after a cache hit `.next/BUILD_ID` can be newer than the standalone copy.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const standalone = path.join(appRoot, '.next', 'standalone', 'apps', 'web');
const server = path.join(standalone, 'server.js');
const hint = 'run `pnpm turbo run build --filter=web --force` to rebuild the standalone output';

if (!existsSync(server)) {
  console.error(`standalone server not found at ${server}; ${hint}`);
  process.exit(1);
}

const buildId = readFileSync(path.join(appRoot, '.next', 'BUILD_ID'), 'utf8').trim();
const standaloneBuildId = readFileSync(path.join(standalone, '.next', 'BUILD_ID'), 'utf8').trim();
if (buildId !== standaloneBuildId) {
  console.error(
    `standalone output is stale (BUILD_ID ${standaloneBuildId} != ${buildId}); ${hint}`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [server], { stdio: 'inherit', cwd: standalone });
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
