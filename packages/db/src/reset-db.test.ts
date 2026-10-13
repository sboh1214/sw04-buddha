import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * deploy/reset-db.sh (docs/RESET.md), run for real by bash against stand-ins for `docker`,
 * `findmnt` and `flock`, with its two host paths pointed into a temp directory. What it pins is
 * the owner's rule for the pre-reset dump (ADR-0048): deleted once every step has succeeded,
 * kept — and named — when any step after it fails. The script lives outside this package;
 * packages/db/turbo.json names it as an input of `test`.
 */

const SCRIPT = readFileSync(new URL('../../../deploy/reset-db.sh', import.meta.url), 'utf8');
const ROOT_LINE = 'ROOT=/data/buddha\n';
const DUMPS_LINE = 'DUMPS=/data\n';
const DUMP_PREFIX = 'buddha-pre-reset-';

/**
 * Logs every call to $CALLS, fails the one whose arguments contain $FAIL_ON, and answers
 * `pg_dump` with a few bytes so the dump file has something in it.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$CALLS"
if [ -n "\${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi
if [[ "$*" == *pg_dump* ]]; then printf 'PGDMP'; fi
exit 0
`;

/** The calls a whole run makes, in order (each a substring of one logged `docker` call). */
const STEPS = [
  'compose up -d --wait postgres redis',
  'compose run --rm --no-deps migrate test -f packages/db/dist/wipe-cli.js',
  'compose exec -T postgres pg_dump -U postgres -Fc buddha',
  'compose stop api worker',
  'compose run --rm --no-deps migrate node packages/db/dist/wipe-cli.js --yes',
  'compose exec -T redis redis-cli FLUSHALL',
  'compose run --rm migrate',
  'compose up -d --wait --wait-timeout 300',
  'compose ps',
];

let dir: string;
let dumps: string;
let calls: string;
let script: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reset-db-'));
  bin = join(dir, 'bin');
  dumps = join(dir, 'data');
  const root = join(dumps, 'buddha');
  mkdirSync(bin);
  mkdirSync(root, { recursive: true });
  calls = join(dir, 'calls.log');
  for (const [name, body] of [
    ['docker', DOCKER_STUB],
    ['findmnt', '#!/bin/sh\nexit 0\n'],
    ['flock', '#!/bin/sh\nexit 0\n'],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  // A failed replace would run the script against the real /data: refuse instead.
  expect(SCRIPT).toContain(ROOT_LINE);
  expect(SCRIPT).toContain(DUMPS_LINE);
  script = join(dir, 'reset-db.sh');
  writeFileSync(
    script,
    SCRIPT.replace(ROOT_LINE, `ROOT=${root}\n`).replace(DUMPS_LINE, `DUMPS=${dumps}\n`),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], failOn = ''): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CALLS: calls,
      FAIL_ON: failOn,
    },
  });
}

function loggedCalls(): string[] {
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
}

function dumpFiles(): string[] {
  return readdirSync(dumps)
    .filter((name) => name.startsWith(DUMP_PREFIX))
    .map((name) => join(dumps, name));
}

// The script only ever runs on the Linux host, and this harness is POSIX (a ':'-joined PATH for
// bash, file modes): skipped on a Windows checkout.
describe.skipIf(process.platform === 'win32')('deploy/reset-db.sh (ADR-0048)', () => {
  it('runs every step in order and deletes its dump once the last one has succeeded', () => {
    const result = run(['--yes']);
    expect(result.status, result.stderr).toBe(0);
    const logged = loggedCalls();
    expect(logged).toHaveLength(STEPS.length);
    STEPS.forEach((step, i) => {
      expect(logged[i]).toContain(step);
    });
    expect(dumpFiles()).toEqual([]);
    expect(result.stdout).toContain('deleted the pre-reset dump');
  });

  it.each([
    ['the wipe', 'wipe-cli.js --yes'],
    ['the Redis flush', 'FLUSHALL'],
    ['migrate + seed', 'compose run --rm migrate'],
    ['the restart', '--wait-timeout 300'],
  ])('keeps the dump, owner-only, and says where when %s fails', (_step, failOn) => {
    const result = run(['--yes'], failOn);
    expect(result.status).not.toBe(0);
    const files = dumpFiles();
    expect(files).toHaveLength(1);
    const [dump] = files as [string];
    expect(readFileSync(dump, 'utf8')).toBe('PGDMP');
    expect(statSync(dump).mode & 0o777).toBe(0o600);
    expect(result.stderr).toContain(`the pre-reset dump is kept at ${dump}`);
    // Stopped at the failure: nothing after it ran.
    expect(loggedCalls().at(-1)).toContain(failOn);
  });

  it('drops a dump that did not finish, before anything is stopped', () => {
    const result = run(['--yes'], 'pg_dump');
    expect(result.status).not.toBe(0);
    expect(dumpFiles()).toEqual([]);
    expect(result.stderr).toContain('nothing was changed');
    expect(loggedCalls().join('\n')).not.toContain('stop api worker');
  });

  it('leaves an earlier failed run’s dump alone and names it', () => {
    const earlier = join(dumps, `${DUMP_PREFIX}20261001-000000.dump`);
    writeFileSync(earlier, 'PGDMP');
    const result = run(['--yes']);
    expect(result.status, result.stderr).toBe(0);
    expect(dumpFiles()).toEqual([earlier]);
    expect(result.stdout).toContain(`an earlier run's dump is still on disk: ${earlier}`);
  });

  it('does nothing without --yes', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(loggedCalls()).toEqual([]);
    expect(dumpFiles()).toEqual([]);
  });
});
