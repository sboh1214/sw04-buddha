import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SIGNUP_BONUS_P, maxLossP } from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  adminActions,
  balances,
  categories,
  chargePackages,
  ledgerEntries,
  marketEvents,
  markets,
  priceTicks,
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

function seedSpawnOptions(options: { admin?: boolean; clockShiftMs?: number } = {}) {
  const urls = testDbUrls();
  if (!urls) throw new Error('TEST_DATABASE_URL is not set');
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: urls.appUrl };
  // On the child only: nothing reads it from the runner's environment, so turbo's strict env
  // mode has nothing to declare.
  if (options.clockShiftMs) env.SEED_TEST_CLOCK_SHIFT_MS = String(options.clockShiftMs);
  if (options.admin ?? true) {
    env.SEED_ADMIN_EMAIL = ADMIN_EMAIL;
    env.SEED_ADMIN_PASSWORD = ADMIN_PASSWORD;
  } else {
    // Empty, not deleted: `loadRootEnv()` fills only variables that are absent, and the root
    // .env sets both, so a deleted variable would come back from the file. An empty value is
    // what a deploy without an admin configured looks like to the seed (`if (email && ...)`).
    env.SEED_ADMIN_EMAIL = '';
    env.SEED_ADMIN_PASSWORD = '';
  }
  return {
    cwd: packageRoot,
    encoding: 'utf8' as const,
    // A child parked on a lock must not outlive the test that parked it.
    timeout: 55_000,
    env,
  };
}

/**
 * `--import tsx` compiles the CLI. The optional second one shifts the CHILD's own `Date`, so a
 * case can prove which clock a seeded instant came from. An absolute file URL because node
 * resolves a relative `--import` against the cwd, which `seedSpawnOptions` sets to the package
 * root.
 */
const CLOCK_SHIM = new URL('./test/fake-clock.mjs', import.meta.url).href;
function seedArgs(clockShiftMs = 0): string[] {
  return clockShiftMs
    ? ['--import', 'tsx', '--import', CLOCK_SHIM, 'src/seed.ts']
    : ['--import', 'tsx', 'src/seed.ts'];
}

function runSeed(options: { admin?: boolean; clockShiftMs?: number } = {}): string {
  return execFileSync(process.execPath, seedArgs(options.clockShiftMs), seedSpawnOptions(options));
}

/** M3 design 2 / PLAN 13 M3: 12 open markets, 2-3 per category. */
const EXPECTED_MARKETS: Record<string, string[]> = {
  economy: [
    'bok-october-rate-cut-2026',
    'cpi-september-2026-above-2pct',
    'krw-usd-yearend-2026-above-1400',
  ],
  weather: [
    'seoul-first-snow-before-nov-20-2026',
    'seoul-october-2026-rain-above-50mm',
    'seoul-november-2026-below-minus-5',
  ],
  tech: ['korea-telco-6g-trial-2026', 'samsung-trifold-korea-launch-2026'],
  entertainment: ['november-2026-korean-film-3m-in-2-weeks', 'melon-last-week-2026-domestic-no1'],
  culture: ['national-museum-2026-visitors-above-4m', 'korea-new-books-2026-more-than-2025'],
};

/**
 * Absolute close instants (UTC): each sits at or before its rule's own cutoff, so trading
 * stops before the outcome is public no matter when the first seed ran. Kept in step with the
 * content by hand — this is the one field a drift in seed.ts would not show in the copy.
 */
const EXPECTED_CLOSE_AT: Record<string, string> = {
  'bok-october-rate-cut-2026': '2026-10-21T14:59:59.000Z',
  'cpi-september-2026-above-2pct': '2026-09-30T14:59:59.000Z',
  'krw-usd-yearend-2026-above-1400': '2026-12-29T14:59:59.000Z',
  'seoul-first-snow-before-nov-20-2026': '2026-11-19T15:00:00.000Z',
  'seoul-october-2026-rain-above-50mm': '2026-10-31T14:59:59.000Z',
  'seoul-november-2026-below-minus-5': '2026-11-30T14:59:59.000Z',
  'korea-telco-6g-trial-2026': '2026-12-31T14:59:59.000Z',
  'samsung-trifold-korea-launch-2026': '2026-12-31T14:59:59.000Z',
  'november-2026-korean-film-3m-in-2-weeks': '2026-12-13T14:59:59.000Z',
  'melon-last-week-2026-domestic-no1': '2026-12-27T14:59:59.000Z',
  'national-museum-2026-visitors-above-4m': '2026-12-31T14:59:59.000Z',
  'korea-new-books-2026-more-than-2025': '2026-12-31T14:59:59.000Z',
};

/** The same CLI, not awaited: for running two seeds at once. Rejects on a non-zero exit. */
function startSeed(): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, seedArgs(), seedSpawnOptions());
}

describe.skipIf(!hasTestDb())('db:seed (integration, docker test profile)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
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

  it('leaves a catalogue an admin emptied on purpose alone', async () => {
    // Deletion is a real DELETE (A-M2-8), so an admin who takes every package off sale leaves
    // the table as empty as a fresh database. Their actions are logged, and that log is what
    // tells the next deploy's seed not to reopen sales at the default prices.
    runSeed();
    const seeded = await t.db.select().from(chargePackages);
    expect(seeded).toHaveLength(5);
    const { id: adminId } = await adminState();
    for (const pack of seeded) {
      await t.db.insert(adminActions).values({
        adminId,
        type: 'charge_package_delete',
        targetType: 'charge_package',
        targetId: pack.id,
        payload: { amountP: pack.amountP.toString(), priceKrw: pack.priceKrw },
      });
    }
    await t.db.delete(chargePackages);

    const output = runSeed();
    expect(output).toContain('emptied by an admin');
    expect(await t.db.select().from(chargePackages)).toHaveLength(0);
  });

  describe('markets (M3 design 2, PLAN 13 M3)', () => {
    /** The database's own clock, so a bound on a seeded instant compares like with like. */
    async function dbNow(): Promise<number> {
      const result = await t.db.execute<{ ms: string }>(
        sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`,
      );
      return Number(result.rows[0]?.ms);
    }

    async function marketState() {
      const rows = await t.db
        .select({
          id: markets.id,
          slug: markets.slug,
          title: markets.title,
          rules: markets.rules,
          category: categories.slug,
          status: markets.status,
          mechanism: markets.mechanism,
          initialProbBp: markets.initialProbBp,
          liquidityB: markets.liquidityB,
          reserveP: markets.reserveP,
          lastPrice: markets.lastPrice,
          openAt: markets.openAt,
          closeAt: markets.closeAt,
          createdAt: markets.createdAt,
          createdBy: markets.createdBy,
        })
        .from(markets)
        .innerJoin(categories, eq(categories.id, markets.categoryId))
        .orderBy(asc(markets.slug));
      const ticks = await t.db.select().from(priceTicks).orderBy(asc(priceTicks.id));
      const events = await t.db.select().from(marketEvents).orderBy(asc(marketEvents.id));
      return { rows, ticks, events };
    }

    it('creates the 12 open markets with their open tick and created/opened events', async () => {
      // Both ends read from the database, like the instants they bound: a runner-clock window
      // would be the very comparison this seed stopped making (ADR-0027, A-M3-30).
      const before = await dbNow();
      runSeed();
      const after = await dbNow();
      const { id: adminId } = await adminState();
      const { rows, ticks, events } = await marketState();

      expect(rows).toHaveLength(12);
      const bySlug = Object.groupBy(rows, (row) => row.category);
      for (const [category, slugs] of Object.entries(EXPECTED_MARKETS)) {
        expect(bySlug[category]?.map((row) => row.slug).sort()).toEqual([...slugs].sort());
      }
      for (const row of rows) {
        expect(row.status).toBe('open');
        expect(row.mechanism).toBe('lmsr');
        expect(row.createdBy).toBe(adminId);
        expect(row.rules.length).toBeGreaterThan(20);
        // ADR-0027: the reserve is the true worst case for (p0, b), not 100·b·ln 2.
        expect(row.reserveP).toBe(maxLossP(row.initialProbBp / 10_000, Number(row.liquidityB)));
        expect(row.lastPrice).toBe(Math.round(row.initialProbBp / 100));
        expect(row.openAt!.getTime()).toBeGreaterThanOrEqual(before);
        expect(row.openAt!.getTime()).toBeLessThanOrEqual(after);
        // Read after the seed lock, so it cannot precede the transaction's own `now()`.
        expect(row.openAt!.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
        // Absolute, not seed time + N days: the rules name fixed cutoffs.
        expect(row.closeAt.toISOString()).toBe(EXPECTED_CLOSE_AT[row.slug]);

        const tick = ticks.filter((tickRow) => tickRow.marketId === row.id);
        expect(tick).toHaveLength(1);
        expect(tick[0]).toMatchObject({ trigger: 'open', pYesBp: row.initialProbBp });
        expect(tick[0]!.ts.getTime()).toBe(row.openAt!.getTime());

        const history = events.filter((event) => event.marketId === row.id);
        expect(history.map((event) => event.type)).toEqual(['created', 'opened']);
        for (const event of history) {
          expect(event.actorId).toBe(adminId);
          expect(event.payload).toEqual({ source: 'seed' });
        }
      }
      expect(ticks).toHaveLength(12);
      expect(events).toHaveLength(24);
    });

    it('takes the market instants from the database, not from the runner (ADR-0027)', async () => {
      // The one case that can tell the two clocks apart: the child runs an hour ahead of the
      // database. `open_at` and the open tick must not move — a runner-clock value would land
      // an hour in the future, sorting the opening tick after every trade made in that hour
      // and drawing the initial probability as a reset partway along the chart.
      const shift = 60 * 60 * 1000;
      runSeed({ clockShiftMs: shift });
      const after = await dbNow();
      const { rows, ticks } = await marketState();

      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(row.openAt!.getTime()).toBeLessThanOrEqual(after);
        expect(row.openAt!.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
      }
      for (const tick of ticks) expect(tick.ts.getTime()).toBeLessThanOrEqual(after);

      // And the shim really was in the child: better-auth's own columns follow the runner on
      // every real sign-up, so the seeded admin keeps that clock deliberately (A-M3-30).
      const [admin] = await t.db
        .select({ createdAt: user.createdAt })
        .from(user)
        .where(eq(user.email, ADMIN_EMAIL));
      expect(admin!.createdAt.getTime()).toBeGreaterThan(after + shift / 2);
    });

    it('is idempotent: a second run adds no market, tick or event', async () => {
      runSeed();
      const first = await marketState();
      const output = runSeed();
      expect(output).toContain('already exists');
      expect(output).toContain('markets: 0 inserted, 12 already existed');
      expect(await marketState()).toEqual(first);
    });

    it('never mentions sports or elections (PLAN 0.2)', async () => {
      runSeed();
      const { rows } = await marketState();
      const categoryRows = await t.db.select().from(categories);
      const text = [
        ...rows.flatMap((row) => [row.slug, row.title, row.rules]),
        ...categoryRows.flatMap((row) => [row.slug, row.nameKo]),
      ].join(' ');
      for (const banned of ['스포츠', '선거', 'sport', 'election']) {
        expect(text).not.toContain(banned);
      }
    });

    it('skips the markets when no admin is configured', async () => {
      const output = runSeed({ admin: false });
      expect(output).toContain('admin skipped');
      expect(output).toContain('markets skipped (no admin)');
      expect(await t.db.select().from(markets)).toHaveLength(0);
      expect(await t.db.select().from(categories)).toHaveLength(5);
    });
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
    // Each market is a check-then-insert under the same lock: 12, not 24, and one tick each.
    expect(await t.db.select().from(markets)).toHaveLength(12);
    expect(await t.db.select().from(priceTicks)).toHaveLength(12);
    expect(await t.db.select().from(marketEvents)).toHaveLength(24);
  }, 60_000);
});
