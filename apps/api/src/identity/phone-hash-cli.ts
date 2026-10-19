// CLI entry (docs/OPERATIONS.md): the keyed hash of a mobile number for an operator's hand edit
// (ADR-0069 #57-3, owner decision 2026-10-18, ADR-0071). On the deployed host, inside the running
// api container, which has the deployment's PHONE_HASH_KEY:
//
//   sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql
//
// and locally `corepack pnpm --filter api run phone-hash [--psql]` after a build (the .env's key,
// or the development key outside production). Numbers come on stdin, one per line — typed, so
// they stay out of the shell history and the process list — and only the hashes go to stdout
// (phone-hash-operator.ts). The key itself is never printed. The environment is checked as the
// API checks it (`loadEnv`): production refuses to run without a valid PHONE_HASH_KEY.
import { createInterface } from 'node:readline';
import { DEV_PHONE_HASH_KEY, loadEnv, phoneHashKey } from '../config/env.js';
import {
  PHONE_HASH_CLI_USAGE,
  describeEnvError,
  phoneHashCliFormat,
  phoneHashCliLine,
} from './phone-hash-operator.js';

const format = phoneHashCliFormat(process.argv.slice(2));
if (format === null) {
  console.error(`[phone-hash] ${PHONE_HASH_CLI_USAGE}`);
  process.exit(2);
}

let key: string;
try {
  key = phoneHashKey(loadEnv());
} catch (error) {
  for (const line of describeEnvError(error)) console.error(`[phone-hash] ${line}`);
  process.exit(1);
}
if (key === DEV_PHONE_HASH_KEY) {
  console.error(
    '[phone-hash] PHONE_HASH_KEY is unset: hashing with the development key, which matches ' +
      'nothing a deployment stores',
  );
}

let failed = false;
let printed = 0;
for await (const line of createInterface({ input: process.stdin, terminal: false })) {
  const result = phoneHashCliLine(key, line, format);
  if (result === null) continue;
  if (!result.ok) {
    console.error(`[phone-hash] ${result.error}`);
    // In the psql form a wrong line is typed again; in the plain form it fails the run.
    if (format === 'hash') failed = true;
    continue;
  }
  for (const out of result.lines) console.log(out);
  printed += 1;
  if (format === 'psql') break;
}
process.exit(failed || printed === 0 ? 1 : 0);
