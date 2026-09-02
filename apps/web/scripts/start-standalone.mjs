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

// The standalone server.js binds process.env.HOSTNAME (Next default 0.0.0.0). This local runner
// binds loopback unless WEB_HOST says otherwise, mirroring API_HOST, so `pnpm --filter web start`
// does not expose the /api/* rewrite on the LAN. An inherited HOSTNAME is deliberately overridden:
// RHEL-family shells export the machine name and Docker the container id, neither of which is a
// bind address we want. A future deploy image must run server.js directly with HOSTNAME=0.0.0.0
// (as Next's reference Dockerfile does) rather than through this script.
const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  cwd: standalone,
  env: { ...process.env, HOSTNAME: process.env.WEB_HOST || 'localhost' },
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
