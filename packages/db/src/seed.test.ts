import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, profiles, user } from './schema/index.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

/**
 * `pnpm db:seed` against the docker `test` profile database (PLAN 14). seed.ts is a CLI entry
 * point (top-level await, its own pool), so this spawns it the way a deploy does with
 * DATABASE_URL pinned to the test database — `loadRootEnv()` never overrides a value that is
 * already set, so the child can never reach the dev database.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_EMAIL = 'seed-admin@test.local';
const ADMIN_PASSWORD = 'seed-admin-1234';

function runSeed(): string {
  const urls = testDbUrls();
  if (!urls) throw new Error('TEST_DATABASE_URL is not set');
  return execFileSync(process.execPath, ['--import', 'tsx', 'src/seed.ts'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: urls.appUrl,
      SEED_ADMIN_EMAIL: ADMIN_EMAIL,
      SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  });
}

describe.skipIf(!hasTestDb())('db:seed (integration, docker test profile)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function adminState() {
    const [row] = await t.db
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, ADMIN_EMAIL));
    if (!row) throw new Error('the seed did not create the admin user');
    const [credential] = await t.db
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, row.id), eq(account.providerId, 'credential')));
    const [profile] = await t.db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.userId, row.id));
    return { ...row, password: credential?.password, role: profile?.role };
  }

  it('creates a verified admin with a credential account', async () => {
    runSeed();
    const state = await adminState();
    expect(state).toMatchObject({ emailVerified: true, role: 'admin' });
    expect(state.password).toBeTruthy();
  });

  it('verifies an address that was registered before the seed ran (ADR-0024)', async () => {
    // Exactly what POST /api/v1/auth/register leaves behind: a user row, unverified, and no
    // credential. Without the verification below the seeded password is refused with 403
    // EMAIL_NOT_VERIFIED, so the bootstrap would report success and produce an unusable admin.
    await t.db.insert(user).values({
      id: randomUUID(),
      name: ADMIN_EMAIL,
      email: ADMIN_EMAIL,
      emailVerified: false,
    });
    const output = runSeed();
    expect(output).toContain('verified');

    const state = await adminState();
    expect(state).toMatchObject({ emailVerified: true, role: 'admin' });
    expect(state.password).toBeTruthy();
  });

  it('never resets the password of an existing credential', async () => {
    runSeed();
    const before = await adminState();
    runSeed();
    expect(await adminState()).toMatchObject({ password: before.password, role: 'admin' });
  });
});
