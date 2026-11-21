import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The notification e2e fixture's boundary (#53, ADR-0157; e2e/notification-fixture-worker.mjs):
 * the child validates the database URLs — the correction fixture's rule, a local test profile or
 * the repository's disposable CI service — before it imports anything of the database or connects,
 * and never prints a URL.
 */

const WORKER = fileURLToPath(new URL('../../e2e/notification-fixture-worker.mjs', import.meta.url));

function env(port = '5433', database = 'buddha_e2e_fixture'): Partial<NodeJS.ProcessEnv> {
  return {
    DATABASE_URL: `postgres://buddha_app@localhost:${port}/${database}`,
    DATABASE_MIGRATE_URL: `postgres://buddha_migrate@localhost:${port}/${database}`,
  };
}

const run = (urls: Partial<NodeJS.ProcessEnv>, args: string[] = ['notification-fixture-worker']) =>
  spawnSync(process.execPath, [WORKER, ...args], {
    env: { ...process.env, ...urls, CI: '', GITHUB_ACTIONS: '' },
    encoding: 'utf8',
    timeout: 5_000,
  });

describe('notification E2E fixture database boundary', () => {
  it.each([
    env('5432', 'buddha'),
    { ...env(), DATABASE_URL: `${env().DATABASE_URL ?? ''}?host=remote.example&port=5432` },
    { ...env(), DATABASE_MIGRATE_URL: 'postgres://buddha_app@localhost:5433/buddha_e2e_fixture' },
  ])('refuses a development, remote or mismatched database before importing it (%#)', (urls) => {
    const result = run(urls);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refuses a development, remote, or mismatched owner database');
    expect(result.stderr).not.toContain('postgres://');
  });

  it('refuses to run without its parent, still before importing the database', () => {
    const result = run(env());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a parent IPC channel');
    expect(result.stderr).not.toContain('postgres://');
  });

  it('starts nothing when run or imported without its argument', () => {
    const result = run(env(), []);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('imports the database only after the check, and connects with the app URL alone', () => {
    const source = readFileSync(WORKER, 'utf8');
    const checked = source.indexOf('const urls = correctionFixtureUrls();');
    const imported = source.indexOf("import('@buddha/db')");
    expect(checked).toBeGreaterThan(0);
    expect(imported).toBeGreaterThan(checked);
    expect(source).not.toMatch(/^import .*@buddha\/db/m);
    expect(source).toContain('createDb(urls.appUrl,');
    expect(source).not.toContain('urls.migrateUrl');
    // The tests' type through the real write path, never an INSERT of its own.
    expect(source).toContain('createTestNotification(db,');
    expect(source).not.toMatch(/INSERT INTO/i);
  });
});
