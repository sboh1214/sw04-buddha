import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { correctionFixtureUrls } from '../../e2e/reconciliation-correction-fixture';

function env(port = '5433', database = 'buddha_e2e_fixture'): Partial<NodeJS.ProcessEnv> {
  return {
    DATABASE_URL: `postgres://buddha_app@localhost:${port}/${database}`,
    DATABASE_MIGRATE_URL: `postgres://buddha_migrate@localhost:${port}/${database}`,
  };
}
describe('correction E2E incident fixture database boundary', () => {
  it.each([
    env('5432', 'buddha'),
    { ...env(), DATABASE_URL: `${env().DATABASE_URL}?host=remote.example&port=5432` },
  ])('refuses a direct native child before importing or connecting to the DB (%#)', (urls) => {
    const worker = fileURLToPath(
      new URL('../../e2e/reconciliation-correction-worker.mjs', import.meta.url),
    );
    const result = spawnSync(process.execPath, [worker, 'correction-fixture-worker'], {
      env: { ...process.env, ...urls, CI: '', GITHUB_ACTIONS: '' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refuses a development, remote, or mismatched owner database');
    expect(result.stderr).not.toContain('postgres://');
  });
  it('allows only the local test profile or the explicit disposable GitHub Actions service', () => {
    expect(correctionFixtureUrls(env()).database).toBe('buddha_e2e_fixture');
    expect(
      correctionFixtureUrls({ ...env('5432', 'buddha'), CI: 'true', GITHUB_ACTIONS: 'true' })
        .database,
    ).toBe('buddha');
  });
  it.each([
    {},
    env('5432', 'buddha'),
    { ...env('5432', 'buddha'), CI: 'true' },
    { ...env('5432', 'buddha'), GITHUB_ACTIONS: 'true' },
    env('5433', 'buddha'),
    { ...env(), DATABASE_URL: 'postgres://buddha_app@remote.example:5433/buddha_e2e_fixture' },
    { ...env(), DATABASE_MIGRATE_URL: 'postgres://buddha_migrate@localhost:5433/buddha_m93_other' },
    { ...env(), DATABASE_MIGRATE_URL: 'postgres://buddha_app@localhost:5433/buddha_e2e_fixture' },
    { ...env(), DATABASE_MIGRATE_URL: 'https://buddha_migrate@localhost:5433/buddha_e2e_fixture' },
    ...['host=remote.example', 'port=5432', 'user=another_role'].flatMap((override) => [
      { ...env(), DATABASE_URL: `${env().DATABASE_URL}?${override}` },
      { ...env(), DATABASE_MIGRATE_URL: `${env().DATABASE_MIGRATE_URL}?${override}` },
    ]),
  ])('refuses a missing, development, remote or mismatched database (%#)', (urls) => {
    expect(() => correctionFixtureUrls(urls)).toThrow();
  });
});
