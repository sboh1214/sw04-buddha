import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SIGNUP_BONUS_P } from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  balances,
  chargePackages,
  ledgerEntries,
  profiles,
  user,
} from './schema/index.js';
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

function seedSpawnOptions() {
  const urls = testDbUrls();
  if (!urls) throw new Error('TEST_DATABASE_URL is not set');
  return {
    cwd: packageRoot,
    encoding: 'utf8' as const,
    // A child parked on a lock must not outlive the test that parked it.
    timeout: 55_000,
    env: {
      ...process.env,
      DATABASE_URL: urls.appUrl,
      SEED_ADMIN_EMAIL: ADMIN_EMAIL,
      SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  };
}

const SEED_ARGS = ['--import', 'tsx', 'src/seed.ts'];

function runSeed(): string {
  return execFileSync(process.execPath, SEED_ARGS, seedSpawnOptions());
}

/** The same CLI, not awaited: for running two seeds at once. Rejects on a non-zero exit. */
function startSeed(): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, SEED_ARGS, seedSpawnOptions());
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

  it('gives the admin the sign-up bonus like every account (migration 0004, Q-M2-2)', async () => {
    // The admin is a `user` row like any other, so the trigger's bonus lands on it too. The
    // seed leaves it there: pre-0004 accounts of every kind keep their 0, and a zero operator
    // account would need an owner decision plus an offset entry or a trigger exemption.
    runSeed();
    const { id } = await adminState();
    async function wallet() {
      const [balance] = await t.db.select().from(balances).where(eq(balances.userId, id));
      const entries = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, id))
        .orderBy(ledgerEntries.id);
      return { balance, entries: entries.map((entry) => [entry.type, entry.amountP]) };
    }
    const first = await wallet();
    expect(first.balance).toMatchObject({ availableP: SIGNUP_BONUS_P, lockedP: 0n });
    expect(first.entries).toEqual([['BONUS', SIGNUP_BONUS_P]]);
    // Re-running touches neither the balance nor the ledger.
    runSeed();
    expect(await wallet()).toEqual(first);
  });

  it('seeds once when two seeds race on an empty database', async () => {
    // `charge_packages` has no natural key, so two seeds that both pass the existence check
    // both insert. To make the race certain rather than likely, hold the table lock while the
    // two children boot: both park on it (or, with the advisory lock, one parks on that) at
    // exactly the check-then-insert step, and releasing it lets them go at the same moment.
    let runs: Promise<unknown>[] = [];
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`lock table charge_packages in access exclusive mode`);
      runs = [startSeed(), startSeed()];
      // Two node + tsx boots take a few seconds, far more on a loaded runner: wait for both
      // sessions to be parked on a lock (same role, so pg_stat_activity shows their wait).
      // Inside a transaction Postgres freezes pg_stat_activity at its first read, so every
      // look has to discard that snapshot first.
      for (let attempt = 0; attempt < 450; attempt++) {
        await tx.execute(sql`select pg_stat_clear_snapshot()`);
        const { rows } = await tx.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting
          from pg_stat_activity
          where application_name = 'buddha-seed' and wait_event_type = 'Lock'
        `);
        if (rows[0]?.waiting === 2) return;
        await sleep(100);
      }
      throw new Error('the two seeds never reached the lock');
    });
    const outcomes = await Promise.allSettled(runs);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    expect(await t.db.select().from(chargePackages)).toHaveLength(5);
    expect(await t.db.select().from(user).where(eq(user.email, ADMIN_EMAIL))).toHaveLength(1);
    expect(await adminState()).toMatchObject({ role: 'admin' });
  }, 60_000);
});
