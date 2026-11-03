import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ALL_CATEGORY_SLUGS,
  AUTH_USER_NAME,
  AUTO_NICKNAME_PATTERN,
  CATEGORY_SLUGS,
  SEED_ADMIN_GRANT_REASON,
  SUBCATEGORY_SLUGS,
  missingRuleItems,
  tagKey,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  adminActions,
  balances,
  categories,
  chargePackages,
  ledgerEntries,
  marketEvents,
  marketSources,
  marketTags,
  markets,
  phoneVerifications,
  priceTicks,
  profiles,
  releaseSettings,
  tags,
  user,
} from './schema/index.js';
import { SEED_MARKETS, SEED_RULE_NO_DELAY_NO, type SeedMarket } from './seed-markets.js';
import { createUser } from './test/factories.js';
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
const SECOND_EMAIL = 'seed-admin-2@test.local';
const SECOND_PASSWORD = 'seed-admin-5678';

interface SeedOptions {
  admin?: boolean;
  /** SEED_SECOND_ADMIN_* as well (default), like CI and the e2e runner. */
  second?: boolean;
  /** SEED_ADMIN_* exactly as given, in place of `admin`'s. */
  firstEnv?: { email: string; password: string };
  /** SEED_SECOND_ADMIN_* exactly as given, in place of `second`. */
  secondEnv?: { email: string; password: string };
  clockShiftMs?: number;
}

function seedSpawnOptions(options: SeedOptions = {}) {
  const urls = testDbUrls();
  if (!urls) throw new Error('TEST_DATABASE_URL is not set');
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: urls.appUrl };
  // On the child only: nothing reads it from the runner's environment, so turbo's strict env
  // mode has nothing to declare.
  if (options.clockShiftMs) env.SEED_TEST_CLOCK_SHIFT_MS = String(options.clockShiftMs);
  // Empty, not deleted: `loadRootEnv()` fills only variables that are absent, and the root
  // .env sets them, so a deleted variable would come back from the file. An empty value is
  // what a deploy without that admin configured looks like to the seed (`if (email && ...)`).
  const admin = options.admin ?? true;
  const second = admin && (options.second ?? true);
  env.SEED_ADMIN_EMAIL = options.firstEnv?.email ?? (admin ? ADMIN_EMAIL : '');
  env.SEED_ADMIN_PASSWORD = options.firstEnv?.password ?? (admin ? ADMIN_PASSWORD : '');
  env.SEED_SECOND_ADMIN_EMAIL = options.secondEnv?.email ?? (second ? SECOND_EMAIL : '');
  env.SEED_SECOND_ADMIN_PASSWORD = options.secondEnv?.password ?? (second ? SECOND_PASSWORD : '');
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

function runSeed(options: SeedOptions = {}): string {
  return execFileSync(process.execPath, seedArgs(options.clockShiftMs), seedSpawnOptions(options));
}

/** Both streams: the staleness report is a warning, and a warning goes to stderr. */
function runSeedIo(options: SeedOptions = {}): {
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, seedArgs(options.clockShiftMs), {
    ...seedSpawnOptions(options),
  });
  if (result.status !== 0) {
    throw new Error(`[db:seed] exited ${String(result.status)}
${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * M3 design 2 / PLAN 13 M3: 12 markets, 2-3 per top-level category — plus the two the second
 * level added (주택, 일자리), so 14, all drafts since #125. Keyed by the LEAF each market is
 * filed under; the parent is checked separately below, through the row's `parent_id`.
 */
const EXPECTED_MARKETS: Record<string, string[]> = {
  rates: ['bok-october-rate-cut-2026'],
  prices: ['cpi-september-2026-above-2pct'],
  fx: ['krw-usd-yearend-2026-above-1400'],
  housing: ['seoul-apartment-price-november-2026-up'],
  jobs: ['unemployment-october-2026-below-3pct'],
  rain: ['seoul-first-snow-before-nov-20-2026', 'seoul-october-2026-rain-above-50mm'],
  temperature: ['seoul-november-2026-below-minus-5'],
  devices: ['korea-telco-6g-trial-2026', 'samsung-trifold-korea-launch-2026'],
  movies: ['november-2026-korean-film-3m-in-2-weeks'],
  music: ['melon-last-week-2026-domestic-no1'],
  exhibitions: ['national-museum-2026-visitors-above-4m'],
  books: ['korea-new-books-2026-more-than-2025'],
};

/** Which top-level category each leaf above hangs under (shared `SUBCATEGORY_SLUGS`). */
const EXPECTED_PARENT: Record<string, string> = {
  rates: 'economy',
  prices: 'economy',
  fx: 'economy',
  housing: 'economy',
  jobs: 'economy',
  rain: 'weather',
  temperature: 'weather',
  devices: 'tech',
  movies: 'entertainment',
  music: 'entertainment',
  exhibitions: 'culture',
  books: 'culture',
};

const SEED_MARKET_COUNT = 14;

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
  'seoul-apartment-price-november-2026-up': '2026-11-30T14:59:59.000Z',
  'unemployment-october-2026-below-3pct': '2026-10-31T14:59:59.000Z',
};

/** The same CLI, not awaited: for running two seeds at once. Rejects on a non-zero exit. */
function startSeed(): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, seedArgs(), seedSpawnOptions());
}

/** The seed's own output; Windows and the CI runner disagree about the line ending. */
const NEWLINE = /\r?\n/;

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

  async function adminState(email = ADMIN_EMAIL) {
    const [row] = await t.db
      .select({
        id: user.id,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      })
      .from(user)
      .where(eq(user.email, email));
    if (!row) throw new Error(`the seed did not create ${email}`);
    const [credential] = await t.db
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, row.id), eq(account.providerId, 'credential')));
    const [profile] = await t.db
      .select({ role: profiles.role, nickname: profiles.nickname })
      .from(profiles)
      .where(eq(profiles.userId, row.id));
    return {
      ...row,
      password: credential?.password,
      role: profile?.role,
      nickname: profile?.nickname,
    };
  }

  /** The admin_grant / admin_revoke records, oldest first. */
  async function roleRecords() {
    return t.db
      .select({
        type: adminActions.type,
        adminId: adminActions.adminId,
        targetType: adminActions.targetType,
        targetId: adminActions.targetId,
        payload: adminActions.payload,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      .where(inArray(adminActions.type, ['admin_grant', 'admin_revoke']))
      .orderBy(asc(adminActions.createdAt), asc(adminActions.id));
  }

  /** What the admin screen's revoke leaves behind: the role reset and its record. */
  async function revoke(targetId: string, actorId: string) {
    await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, targetId));
    await t.db.insert(adminActions).values({
      adminId: actorId,
      type: 'admin_revoke',
      targetType: 'user',
      targetId,
      payload: { reason: '시험' },
    });
  }

  it('creates two verified admins with credentials and records each grant (#171)', async () => {
    runSeed();
    const first = await adminState();
    const second = await adminState(SECOND_EMAIL);
    // The trigger's auto nickname, kept: 관리자 is a reserved word the admin could not confirm at
    // its onboarding's nickname step (오너 결정 2026-10-19 (2차) 2). No name, no photo (3).
    for (const admin of [first, second]) {
      expect(admin).toMatchObject({
        emailVerified: true,
        role: 'admin',
        name: AUTH_USER_NAME,
        image: null,
      });
      expect(admin.nickname).toMatch(AUTO_NICKNAME_PATTERN);
    }
    expect(first.password).toBeTruthy();
    expect(second.password).toBeTruthy();
    // Each bootstrap admin records its own grant, the second strictly after the first.
    const records = await roleRecords();
    expect(records).toEqual([
      expect.objectContaining({
        type: 'admin_grant',
        adminId: first.id,
        targetType: 'user',
        targetId: first.id,
        payload: { reason: SEED_ADMIN_GRANT_REASON },
      }),
      expect.objectContaining({
        type: 'admin_grant',
        adminId: second.id,
        targetType: 'user',
        targetId: second.id,
        payload: { reason: SEED_ADMIN_GRANT_REASON },
      }),
    ]);
    expect(records[1]!.createdAt.getTime()).toBeGreaterThan(records[0]!.createdAt.getTime());
    // Not verified: the bootstrap admins verify at their first sign-in like every account
    // (ADR-0069 decision 4, #58; ADR-0070).
    expect(await t.db.select().from(phoneVerifications)).toEqual([]);
  });

  it('creates one admin when no second is configured', async () => {
    const output = runSeed({ second: false });
    expect(output).toContain('one admin only');
    expect(await adminState()).toMatchObject({ role: 'admin' });
    expect(await t.db.select().from(user).where(eq(user.email, SECOND_EMAIL))).toEqual([]);
    expect(await roleRecords()).toHaveLength(1);
  });

  /** Nothing at all is seeded: the checks run before the first write. */
  async function expectNothingSeeded() {
    expect(await t.db.select().from(user)).toEqual([]);
    expect(await t.db.select().from(categories)).toEqual([]);
    expect(await t.db.select().from(chargePackages)).toEqual([]);
  }

  // One case per spawn: each start of the seed CLI takes several seconds on a CI runner, and
  // the 30 s test budget (vitest.config.ts) is for up to two of them.
  it.each([
    { email: SECOND_EMAIL, password: '' },
    { email: '', password: SECOND_PASSWORD },
    { email: '  ', password: SECOND_PASSWORD },
    { email: SECOND_EMAIL, password: ' \t ' },
  ])(
    'fails before seeding anything when only one of SEED_SECOND_ADMIN_* is set (#171): %j',
    async (secondEnv) => {
      // Someone meant a second admin: seeding one only would leave no two-person approval, and
      // say so in a log line at best. Whitespace alone is empty, as terraform's validation has it.
      const result = spawnSync(process.execPath, seedArgs(), seedSpawnOptions({ secondEnv }));
      expect(result.status, JSON.stringify(secondEnv)).toBe(1);
      expect(result.stderr).toContain(
        'set both SEED_SECOND_ADMIN_EMAIL and SEED_SECOND_ADMIN_PASSWORD, or neither',
      );
      await expectNothingSeeded();
    },
  );

  it.each<[string, SeedOptions, string]>([
    // The first pair is both or neither as well: one alone is an admin someone meant.
    [
      'an admin email without a password',
      { firstEnv: { email: ADMIN_EMAIL, password: '' }, second: false },
      'SEED_ADMIN_PASSWORD is empty: set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither',
    ],
    [
      'a blank admin email',
      { firstEnv: { email: ' ', password: ADMIN_PASSWORD } },
      'SEED_ADMIN_EMAIL is empty: set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither',
    ],
    [
      'a blank admin password',
      { firstEnv: { email: ADMIN_EMAIL, password: '\t' } },
      'SEED_ADMIN_PASSWORD is empty: set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither',
    ],
    // A complete second with no first: no admin would be seeded, the second skipped.
    [
      'a second admin without a first',
      {
        firstEnv: { email: '', password: '' },
        secondEnv: { email: SECOND_EMAIL, password: SECOND_PASSWORD },
      },
      'SEED_SECOND_ADMIN_* is set but SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are not',
    ],
    // The same account twice, as better-auth compares addresses.
    [
      'the same account twice',
      { secondEnv: { email: ` ${ADMIN_EMAIL.toUpperCase()}`, password: SECOND_PASSWORD } },
      'SEED_SECOND_ADMIN_EMAIL must differ from SEED_ADMIN_EMAIL',
    ],
    [
      'a short second password',
      { secondEnv: { email: SECOND_EMAIL, password: 'short' } },
      'SEED_SECOND_ADMIN_PASSWORD must be 8-128 characters',
    ],
  ])(
    'fails before seeding anything on any other admin setting it cannot seed as given (#171): %s',
    async (_, options, message) => {
      const result = spawnSync(process.execPath, seedArgs(), seedSpawnOptions(options));
      expect({ options, status: result.status }).toEqual({ options, status: 1 });
      expect(result.stderr, JSON.stringify(options)).toContain(message);
      await expectNothingSeeded();
    },
  );

  it('creates and promotes nobody once an admin exists', async () => {
    // An admin from somewhere else (the admin screen): the seed leaves the accounts alone and
    // writes no record — and with no SEED_ADMIN_EMAIL admin, no market names a creator.
    await createUser(t.db, { role: 'admin' });
    const output = runSeed();
    expect(output).toContain('nobody created or promoted');
    expect(output).toContain('markets skipped');
    expect(
      await t.db
        .select()
        .from(user)
        .where(inArray(user.email, [ADMIN_EMAIL, SECOND_EMAIL])),
    ).toEqual([]);
    expect(await roleRecords()).toEqual([]);
    expect(await t.db.select().from(markets)).toEqual([]);
  });

  it('adds no second admin to an existing one: a later SEED_SECOND_ADMIN_* creates nobody', async () => {
    // The second is then granted on the admin screen instead.
    runSeed({ second: false });
    const output = runSeed();
    expect(output).toContain('nobody created or promoted');
    expect(await t.db.select().from(user).where(eq(user.email, SECOND_EMAIL))).toEqual([]);
    expect(await roleRecords()).toHaveLength(1);
  });

  it('never promotes a revoked seed admin again (#171)', async () => {
    runSeed();
    const first = await adminState();
    const second = await adminState(SECOND_EMAIL);
    // A third admin, so the revoke below is one the admin screen allows (two remain).
    await createUser(t.db, { role: 'admin' });
    await revoke(first.id, second.id);
    const before = await roleRecords();

    const output = runSeed();
    expect(output).toContain('nobody created or promoted');
    expect(await adminState()).toMatchObject({ role: 'user' });
    expect(await roleRecords()).toEqual(before);
    // The markets name the first admin as their creator, and it no longer holds the role.
    expect(output).toContain('markets skipped');
  });

  it('never promotes a revoked account, even when no admin is left', async () => {
    // Not reachable through the admin screen (a revoke leaves two admins), but the rule is the
    // seed's own: an account that lost the role does not get it back from a deploy.
    runSeed({ second: false });
    const first = await adminState();
    await revoke(first.id, first.id);

    const { stdout, stderr } = runSeedIo();
    expect(stderr).toContain('revoked once, not promoted again');
    expect(await adminState()).toMatchObject({ role: 'user' });
    // The second still bootstraps: it never held the role.
    expect(await adminState(SECOND_EMAIL)).toMatchObject({ role: 'admin' });
    expect(stdout).toContain('markets skipped');
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

  it('gives the admin no Coin at sign-up, like every account (migration 0031, #70)', async () => {
    // The admin is a `user` row like any other, and creating one grants nothing: a zero balance
    // and no ledger entry. Its start Coin comes like everyone's (ADR-0069 decision 4 #70: an
    // operator account gets it under the same conditions), once it verifies its number and
    // finishes the onboarding (#58) — the seed grants nothing either.
    runSeed();
    const { id } = await adminState();
    async function wallet() {
      const [balance] = await t.db.select().from(balances).where(eq(balances.userId, id));
      const entries = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, id))
        .orderBy(ledgerEntries.id);
      return { balance, entries: entries.map((entry) => [entry.type, entry.amountCoin]) };
    }
    const first = await wallet();
    expect(first.balance).toMatchObject({ availableCoin: 0n, lockedCoin: 0n });
    expect(first.entries).toEqual([]);
    // Re-running touches neither the balance nor the ledger.
    runSeed();
    expect(await wallet()).toEqual(first);
  });

  it('inserts the charge packages off sale (D9, #112)', async () => {
    // Paid charging is not offered at launch: the ladder is there for an admin to put on sale,
    // and the catalogue shows nothing until one does.
    runSeed();
    const seeded = await t.db.select().from(chargePackages);
    expect(seeded).toHaveLength(5);
    for (const pack of seeded) expect(pack.isActive).toBe(false);
  });

  it('writes no release setting value: every item starts undecided (#170)', async () => {
    // Values come only from an admin's change on the admin screen (owner decision 2026-10-13~14),
    // so after a dev setup or a reset every registered item is 미정 and nothing is recorded.
    runSeed();
    expect(await t.db.select().from(releaseSettings)).toEqual([]);
    const changes = await t.db
      .select()
      .from(adminActions)
      .where(eq(adminActions.type, 'release_setting_change'));
    expect(changes).toEqual([]);
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
        payload: { amountCoin: pack.amountCoin.toString(), priceKrw: pack.priceKrw },
      });
    }
    await t.db.delete(chargePackages);

    const output = runSeed();
    expect(output).toContain('emptied by an admin');
    expect(await t.db.select().from(chargePackages)).toHaveLength(0);
  });

  describe('categories (#17, ADR-0093 decision 2 #172 item 1)', () => {
    /** Every category row, by slug, as the operators' screens read it. */
    async function tree() {
      return t.db.select().from(categories).orderBy(asc(categories.slug));
    }

    it('starts a fresh database with the five top-level categories and their 21, by tens', async () => {
      const output = runSeed({ admin: false });
      expect(output).toContain('categories: 26 inserted, 0 already there');
      const rows = await tree();
      const bySlug = new Map(rows.map((row) => [row.slug, row]));
      expect(rows).toHaveLength(ALL_CATEGORY_SLUGS.length);
      CATEGORY_SLUGS.forEach((slug, index) => {
        expect(bySlug.get(slug), slug).toMatchObject({
          parentId: null,
          sortOrder: (index + 1) * 10,
          isActive: true,
        });
        SUBCATEGORY_SLUGS[slug].forEach((leaf, leafIndex) => {
          expect(bySlug.get(leaf), leaf).toMatchObject({
            parentId: bySlug.get(slug)!.id,
            sortOrder: (leafIndex + 1) * 10,
            isActive: true,
          });
        });
      });
    });

    it('leaves a category an admin renamed, reordered or hid as the admin left it', async () => {
      // Every deploy runs the seed (deploy/deploy.sh): before #17 it rewrote the name, the order
      // and the parent of every seed slug, which would undo the operators' work on each deploy.
      runSeed({ admin: false });
      const set = (slug: string, values: Partial<typeof categories.$inferInsert>) =>
        t.db.update(categories).set(values).where(eq(categories.slug, slug));
      await set('economy', { nameKo: '경제·금융' });
      await set('fx', { sortOrder: 40 });
      await set('rates', { sortOrder: 30 });
      await set('weather', { sortOrder: 5 });
      await set('typhoons', { isActive: false });
      await set('culture', { isActive: false });
      const before = await tree();

      const output = runSeed({ admin: false });
      expect(output).toContain('categories: 0 inserted, 26 already there');
      expect(await tree()).toEqual(before);
    });

    it('puts a missing seed category back, and skips one whose name a sibling took', async () => {
      // A seed slug can be missing from an existing tree only when the seed's list grows; deleted
      // here by hand to stand in for that. The operators' tree wins a name: their 'broadcast' is
      // already 방송 under 엔터테인먼트, so the seed's 'tv' is not made and the deploy goes on.
      runSeed({ admin: false });
      await t.db.delete(categories).where(inArray(categories.slug, ['food', 'tv']));
      const [entertainment] = await t.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, 'entertainment'));
      const [broadcast] = await t.db
        .insert(categories)
        .values({ slug: 'broadcast', nameKo: '방송', sortOrder: 50, parentId: entertainment!.id })
        .returning();

      const { stdout, stderr } = runSeedIo({ admin: false });
      expect(stdout).toContain('categories: 1 inserted, 24 already there');
      expect(stderr.split(NEWLINE).filter((line) => line.includes('category tv:'))).toHaveLength(1);
      const rows = await tree();
      const [culture] = rows.filter((row) => row.slug === 'culture');
      expect(rows.find((row) => row.slug === 'food')).toMatchObject({
        nameKo: '음식',
        parentId: culture!.id,
        sortOrder: 40,
      });
      expect(rows.find((row) => row.slug === 'tv')).toBeUndefined();
      expect(rows.find((row) => row.slug === 'broadcast')).toEqual(broadcast);
    });
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
          // 배경 and the rule items (#23); the sources are below.
          description: markets.description,
          yesCondition: markets.yesCondition,
          noCondition: markets.noCondition,
          eventDeadline: markets.eventDeadline,
          fallbackCondition: markets.fallbackCondition,
          longDelayDays: markets.longDelayDays,
          delayHandling: markets.delayHandling,
          category: categories.slug,
          status: markets.status,
          lastPrice: markets.lastPrice,
          volumeCoin: markets.volumeCoin,
          tradeCount: markets.tradeCount,
          statusEventId: markets.statusEventId,
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
      // #17: each market's tags in their order, and the tags themselves.
      const linked = await t.db
        .select({ slug: markets.slug, position: marketTags.position, name: tags.name })
        .from(marketTags)
        .innerJoin(markets, eq(markets.id, marketTags.marketId))
        .innerJoin(tags, eq(tags.id, marketTags.tagId))
        .orderBy(asc(markets.slug), asc(marketTags.position));
      const tagRows = await t.db.select().from(tags).orderBy(asc(tags.id));
      // #23: each market's sources, priority 0 the 1차 출처 and the 대체 출처 after it.
      const sources = await t.db
        .select({
          slug: markets.slug,
          priority: marketSources.priority,
          name: marketSources.name,
          url: marketSources.url,
        })
        .from(marketSources)
        .innerJoin(markets, eq(markets.id, marketSources.marketId))
        .orderBy(asc(markets.slug), asc(marketSources.priority));
      return { rows, ticks, events, linked, tagRows, sources };
    }

    /** 배경 and the rule-item columns a seed market is inserted with (#23, ADR-0097). */
    function storedRuleItems(seed: SeedMarket) {
      return {
        description: seed.description,
        yesCondition: seed.yesCondition,
        noCondition: seed.noCondition,
        eventDeadline: new Date(seed.eventDeadline),
        fallbackCondition: seed.fallbackCondition,
        longDelayDays: seed.longDelayDays,
        delayHandling: seed.delayHandling,
      };
    }

    /** Its `market_sources` rows (#23): priority 0 the 1차 출처, then the 대체 출처 in order. */
    function storedSources(seed: SeedMarket) {
      return [seed.primarySource, ...seed.fallbackSources].map((source, priority) => ({
        slug: seed.slug,
        priority,
        name: source.name,
        url: source.url,
      }));
    }

    it('creates the 14 markets as drafts with a created event, and no price or tick', async () => {
      // Drafts for a reviewer to check and open (N03 §2, #125), and no price before a fill
      // (N02 §5): the direct AMM's initial probability and opening tick are gone.
      runSeed();
      const { id: adminId } = await adminState();
      const { rows, ticks, events, sources } = await marketState();
      const seeds = new Map(SEED_MARKETS.map((seed) => [seed.slug, seed]));
      const sourcesBySlug = Object.groupBy(sources, (source) => source.slug);

      expect(rows).toHaveLength(SEED_MARKET_COUNT);
      const bySlug = Object.groupBy(rows, (row) => row.category);
      for (const [category, slugs] of Object.entries(EXPECTED_MARKETS)) {
        expect(bySlug[category]?.map((row) => row.slug).sort()).toEqual([...slugs].sort());
      }
      // Every market sits on a LEAF whose parent is the top-level category M3 filed it under:
      // the second level reorganised the tree without moving a market across parents.
      const parentOf = new Map<string, string | null>();
      const categoryRows = await t.db.select().from(categories);
      const byId = new Map(categoryRows.map((row) => [row.id, row]));
      for (const row of categoryRows) {
        parentOf.set(
          row.slug,
          row.parentId === null ? null : (byId.get(row.parentId)?.slug ?? null),
        );
      }
      for (const [leaf, parent] of Object.entries(EXPECTED_PARENT)) {
        expect(parentOf.get(leaf), leaf).toBe(parent);
      }
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'draft',
          openAt: null,
          lastPrice: null,
          volumeCoin: 0n,
          tradeCount: 0,
          createdBy: adminId,
        });
        // Every rule item as written (#23), and the sources in priority order.
        const seed = seeds.get(row.slug)!;
        expect(row, row.slug).toMatchObject(storedRuleItems(seed));
        const own = sourcesBySlug[row.slug] ?? [];
        expect(own, row.slug).toEqual(storedSources(seed));
        // Read back as the API reads them, none is missing: the reviewer can open the draft.
        expect(
          missingRuleItems({
            description: row.description,
            yesCondition: row.yesCondition,
            noCondition: row.noCondition,
            eventDeadline: row.eventDeadline?.toISOString() ?? null,
            primarySource: own.find((source) => source.priority === 0) ?? null,
            fallbackSources: own.filter((source) => source.priority > 0),
            fallbackCondition: row.fallbackCondition,
            longDelayDays: row.longDelayDays,
            delayHandling: row.delayHandling,
          }),
          row.slug,
        ).toEqual([]);
        // N03 §4: a late publication never makes it NO on its own.
        expect(row.delayHandling).toContain(SEED_RULE_NO_DELAY_NO);
        // Absolute, not seed time + N days: the rules name fixed cutoffs.
        expect(row.closeAt.toISOString()).toBe(EXPECTED_CLOSE_AT[row.slug]);

        const history = events.filter((event) => event.marketId === row.id);
        expect(history).toEqual([
          expect.objectContaining({
            type: 'created',
            actorId: adminId,
            payload: { source: 'seed' },
          }),
        ]);
        // The status key points at the event that put the row in `draft`.
        expect(row.statusEventId).toBe(history[0]!.id);
      }
      expect(ticks).toEqual([]);
      expect(events).toHaveLength(SEED_MARKET_COUNT);
    });

    it('takes the market instants from the database, not from the runner (ADR-0027)', async () => {
      // The one case that can tell the two clocks apart: the child runs an hour ahead of the
      // database. The rows and their events must not move — a runner-clock value would land an
      // hour in the future and sort them after whatever the API writes in that hour.
      const shift = 60 * 60 * 1000;
      runSeed({ clockShiftMs: shift });
      const after = await dbNow();
      const { rows, events } = await marketState();

      expect(rows).toHaveLength(SEED_MARKET_COUNT);
      for (const row of rows) expect(row.createdAt.getTime()).toBeLessThanOrEqual(after);
      for (const event of events) expect(event.createdAt.getTime()).toBeLessThanOrEqual(after);

      // And the shim really was in the child: better-auth's own columns follow the runner on
      // every real sign-up, so the seeded admin keeps that clock deliberately (A-M3-30).
      const [admin] = await t.db
        .select({ createdAt: user.createdAt })
        .from(user)
        .where(eq(user.email, ADMIN_EMAIL));
      expect(admin!.createdAt.getTime()).toBeGreaterThan(after + shift / 2);
    });

    it('reports a market whose cutoff has passed on every run, not only the one that inserts it', async () => {
      // The cutoffs are absolute, so the state arrives on its own date in an environment that
      // was seeded long before — and the seed never rewrites an existing row. That half used
      // to pass in silence: the warning was guarded on having just inserted the market.
      const slug = 'cpi-september-2026-above-2pct';
      // An admin opened this one (the trading gap allows it, #125) before its cutoff passed.
      const opened = 'seoul-october-2026-rain-above-50mm';
      runSeed();
      await t.db
        .update(markets)
        .set({ closeAt: sql`clock_timestamp() - interval '1 minute'` })
        .where(eq(markets.slug, slug));
      await t.db
        .update(markets)
        .set({ status: 'open', closeAt: sql`clock_timestamp() - interval '1 minute'` })
        .where(eq(markets.slug, opened));

      const { stdout, stderr } = runSeedIo();
      expect(stdout).toContain('markets: 0 inserted, 14 already existed');
      // Judged on THIS slug's own line, not on how many lines carry the wording: the other
      // cutoffs are absolute 2026 dates that pass on their own as the calendar advances
      // (the earliest, bok-october-rate-cut-2026, on 2026-10-21), and from then on the second
      // run legitimately reports them too. A market gets at most one line (seed.ts's
      // if / else if), so exactly one line names it.
      const mine = stderr.split(NEWLINE).filter((line) => line.includes(slug));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain('is already past');
      // A draft cannot be opened past its cutoff: the admin has to move it first.
      expect(mine[0]).toContain('cannot be opened');
      expect(mine[0]).toContain('수정');
      // An open one is the worker's to close.
      const openLine = stderr.split(NEWLINE).filter((line) => line.includes(opened));
      expect(openLine).toHaveLength(1);
      expect(openLine[0]).toContain('market.close');
      expect(openLine[0]).toContain('마감');
      // And both are untouched — the seed reports, it does not rewrite.
      const statuses = await t.db
        .select({ slug: markets.slug, status: markets.status })
        .from(markets)
        .where(sql`${markets.slug} in (${slug}, ${opened})`)
        .orderBy(asc(markets.slug));
      expect(statuses).toEqual([
        { slug, status: 'draft' },
        { slug: opened, status: 'open' },
      ]);
    });

    it('goes quiet once the close time is pushed forward (the Q-M3-4 copy refresh)', async () => {
      // The report judges the row, not the literal in seed.ts: an admin who moved the cutoff
      // has done the documented refresh and must not be told about it on every deploy.
      const slug = 'cpi-september-2026-above-2pct';
      runSeed();
      await t.db
        .update(markets)
        .set({ closeAt: sql`clock_timestamp() + interval '30 days'` })
        .where(eq(markets.slug, slug));

      expect(runSeedIo().stderr).not.toContain(slug);
    });

    it('asks for fresh copy BEFORE a cutoff passes, not only after (M6)', async () => {
      // The warning above only fires once the fixture is already broken; a developer who clones
      // the repo that week gets a home page of closed markets and no warning that it was
      // foreseeable. This is the same signal at a distance that can still be acted on.
      const slug = 'cpi-september-2026-above-2pct';
      runSeed();
      await t.db
        .update(markets)
        .set({ closeAt: sql`clock_timestamp() + interval '3 days'` })
        .where(eq(markets.slug, slug));

      const { stderr } = runSeedIo();
      // This slug's line only, for BOTH wordings: the other cutoffs are absolute dates in
      // 2026, so as the calendar advances they enter the same window and then pass, each on its
      // own — a count of either wording across the whole stream would be a test that fails on
      // a date rather than on a change. What this pins is that the market THIS case moved is
      // reported, and reported as approaching rather than as past (a market that is still open
      // must not be announced as one the worker is about to close), which stays true for good.
      const mine = stderr.split(NEWLINE).filter((line) => line.includes(slug));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain('within 14 days');
      expect(mine[0]).not.toContain('is already past');
    });

    it('is idempotent: a second run adds no market, tick, event or tag', async () => {
      runSeed();
      const first = await marketState();
      expect(first.linked.length).toBeGreaterThan(0);
      const output = runSeed();
      expect(output).toContain('already exists');
      expect(output).toContain('markets: 0 inserted, 14 already existed');
      expect(await marketState()).toEqual(first);
    });

    it('tags each market as listed, in order, one tag per name across markets (#17)', async () => {
      // The admin create path's way (ADR-0093 decision 2 #172 item 2): positions 1..n in the
      // order given, and a name several markets carry ('서울', '기상청', '통계청') is one tag.
      runSeed();
      const { linked, tagRows } = await marketState();
      const bySlug = Object.groupBy(linked, (row) => row.slug);
      for (const market of SEED_MARKETS) {
        expect(
          bySlug[market.slug]?.map((row) => [row.position, row.name]),
          market.slug,
        ).toEqual(market.tags.map((name, index) => [index + 1, name]));
      }
      const keys = new Set(SEED_MARKETS.flatMap((market) => market.tags.map(tagKey)));
      expect(tagRows).toHaveLength(keys.size);
      // The generated key is the shared `tagKey` of the stored name.
      for (const row of tagRows) expect(row.nameKey, row.name).toBe(tagKey(row.name));
    });

    it('links a tag that exists in the spelling it was made with, and makes the rest (#17)', async () => {
      // An operator made 'cpi' before the seed ran: the CPI market's 'CPI' is that tag, shown as
      // first spelled (#17: a tag keeps the spelling it was first made with).
      const [existing] = await t.db.insert(tags).values({ name: 'cpi' }).returning();
      runSeed();
      const { linked, tagRows } = await marketState();
      const cpi = linked.filter((row) => row.slug === 'cpi-september-2026-above-2pct');
      expect(cpi.map((row) => row.name)).toEqual(['물가', 'cpi', '통계청']);
      expect(tagRows.filter((row) => row.nameKey === 'cpi')).toEqual([existing]);
    });

    it('leaves the tags an admin gave a seed market as they are (#17)', async () => {
      // A re-seed never rewrites the tags of a market that has any: an operator replaced this
      // one's five with one of their own.
      runSeed();
      const [market] = await t.db
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.slug, 'korea-telco-6g-trial-2026'));
      await t.db.delete(marketTags).where(eq(marketTags.marketId, market!.id));
      const [ai] = await t.db.insert(tags).values({ name: 'AI' }).returning();
      await t.db.insert(marketTags).values({ marketId: market!.id, tagId: ai!.id, position: 1 });
      const before = await marketState();
      runSeed();
      const after = await marketState();
      expect(after).toEqual(before);
      expect(after.linked.filter((row) => row.slug === 'korea-telco-6g-trial-2026')).toEqual([
        { slug: 'korea-telco-6g-trial-2026', position: 1, name: 'AI' },
      ]);
    });

    it("gives a seed market with no tag at all the seed's tags, and leaves a tagged one alone (#17 AC 9)", async () => {
      // A database #174's 0048 wiped and seeded before #17 deployed has the 14 drafts and no
      // market_tags row (deleted here by hand to stand in for that). The next seed tags them, so
      // they can pass the open-items check — but a market an operator already tagged keeps its set.
      runSeed();
      const telco = 'korea-telco-6g-trial-2026';
      await t.db.delete(marketTags);
      const [market] = await t.db
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.slug, telco));
      const [ai] = await t.db.insert(tags).values({ name: 'AI' }).returning();
      await t.db.insert(marketTags).values({ marketId: market!.id, tagId: ai!.id, position: 1 });
      const before = await marketState();

      const { stdout } = runSeedIo();
      expect(stdout).toContain(
        "markets: 0 inserted, 14 already existed (13 of them given the seed's tags, 0 the seed's rule items), 0 skipped",
      );
      const tagged = stdout.split(NEWLINE).filter((line) => line.includes('(it had none)'));
      expect(tagged).toHaveLength(SEED_MARKET_COUNT - 1);
      expect(tagged.some((line) => line.includes(telco))).toBe(false);
      const after = await marketState();
      // Only the links change: the rows, their events and the tags (every one made by the first
      // run, never deleted) stay.
      expect(after.rows).toEqual(before.rows);
      expect(after.events).toEqual(before.events);
      expect(after.tagRows).toEqual(before.tagRows);
      const bySlug = Object.groupBy(after.linked, (row) => row.slug);
      for (const seed of SEED_MARKETS) {
        expect(
          bySlug[seed.slug]?.map((row) => [row.position, row.name]),
          seed.slug,
        ).toEqual(seed.slug === telco ? [[1, 'AI']] : seed.tags.map((name, i) => [i + 1, name]));
      }
      // And once only: the next run finds every market tagged.
      const again = await marketState();
      expect(runSeed()).toContain(
        "markets: 0 inserted, 14 already existed (0 of them given the seed's tags, 0 the seed's rule items)",
      );
      expect(await marketState()).toEqual(again);
    });

    it('gives no tags to a draft an admin cleared since #17, nor to a market past the draft', async () => {
      // Both without a market_tags row, as in the test above: the cleared draft has an admin record
      // whose snapshot names its (empty) tags, and the opened one changes tags on the record only.
      runSeed();
      await t.db.delete(marketTags);
      const [cleared, opened] = SEED_MARKETS.map((seed) => seed.slug);
      const [clearedRow] = await t.db
        .select({ id: markets.id, createdBy: markets.createdBy })
        .from(markets)
        .where(eq(markets.slug, cleared!));
      await t.db.insert(adminActions).values({
        adminId: clearedRow!.createdBy,
        type: 'market_update',
        targetType: 'market',
        targetId: clearedRow!.id,
        payload: { before: { tags: ['서울'] }, after: { tags: [] } },
      });
      await t.db.update(markets).set({ status: 'open' }).where(eq(markets.slug, opened!));

      const { stdout } = runSeedIo();
      expect(stdout).toContain(
        `markets: 0 inserted, 14 already existed (${SEED_MARKET_COUNT - 2} of them given the seed's tags, 0 the seed's rule items)`,
      );
      const linked = (await marketState()).linked;
      expect(linked.filter((row) => row.slug === cleared || row.slug === opened)).toEqual([]);
      expect(new Set(linked.map((row) => row.slug)).size).toBe(SEED_MARKET_COUNT - 2);
    });

    describe('rule items of a draft seeded before #23 (ADR-0097, ADR-0096 7-14)', () => {
      /** The market ids of `slugs`. */
      async function idsOf(slugs: readonly string[]): Promise<string[]> {
        const rows = await t.db
          .select({ id: markets.id })
          .from(markets)
          .where(inArray(markets.slug, [...slugs]));
        return rows.map((row) => row.id);
      }

      /**
       * What migration 0050 leaves of a market made before #23 deployed: `rules` and
       * `resolution_source` dropped with their text (D4), every rule item at its column default
       * and no source. 배경 is the `description` it already had. Done by hand after a fresh seed.
       */
      async function blankRuleItems(slugs: readonly string[]) {
        const ids = await idsOf(slugs);
        await t.db.delete(marketSources).where(inArray(marketSources.marketId, ids));
        await t.db
          .update(markets)
          .set({
            yesCondition: '',
            noCondition: '',
            eventDeadline: null,
            fallbackCondition: '',
            longDelayDays: null,
            delayHandling: '',
          })
          .where(inArray(markets.id, ids));
      }

      /** A market row apart from 배경 and the rule items: what the fill must not touch. */
      function withoutRuleItems(row: Awaited<ReturnType<typeof marketState>>['rows'][number]) {
        const {
          description: _description,
          yesCondition: _yesCondition,
          noCondition: _noCondition,
          eventDeadline: _eventDeadline,
          fallbackCondition: _fallbackCondition,
          longDelayDays: _longDelayDays,
          delayHandling: _delayHandling,
          ...rest
        } = row;
        return rest;
      }

      async function updatedAts(): Promise<Map<string, number>> {
        const rows = await t.db
          .select({ slug: markets.slug, updatedAt: markets.updatedAt })
          .from(markets);
        return new Map(rows.map((row) => [row.slug, row.updatedAt.getTime()]));
      }

      it('fills the items 0050 left blank, 배경 only where blank, and the tags on their own', async () => {
        // Every draft lost its items; five lost their tags as well, as in an environment #17
        // had not reached either. Of the 배경s, one is null, one blank and one an older seed's.
        runSeed();
        const slugs = SEED_MARKETS.map((seed) => seed.slug);
        await blankRuleItems(slugs);
        const [noBackground, blankBackground, oldBackground] = slugs;
        const OLD_BACKGROUND = '옛 시드의 설명을 묻는 시장입니다.';
        const setDescription = (slug: string, description: string | null) =>
          t.db.update(markets).set({ description }).where(eq(markets.slug, slug));
        await setDescription(noBackground!, null);
        await setDescription(blankBackground!, '  ');
        await setDescription(oldBackground!, OLD_BACKGROUND);
        const untagged = slugs.slice(-5);
        await t.db.delete(marketTags).where(inArray(marketTags.marketId, await idsOf(untagged)));
        const before = await marketState();

        // The child's clock an hour ahead: the fill's `updated_at` is the database's (ADR-0027).
        const startedAt = await dbNow();
        const { stdout } = runSeedIo({ clockShiftMs: 60 * 60 * 1000 });
        const readAt = await dbNow();
        const after = await marketState();
        expect(stdout).toContain(
          "markets: 0 inserted, 14 already existed (5 of them given the seed's tags, 14 the seed's rule items), 0 skipped",
        );
        const lines = stdout.split(NEWLINE);
        const both = lines.filter((line) =>
          line.includes("given the seed's tags (it had none) and rule items (they were blank)"),
        );
        expect(both).toHaveLength(untagged.length);
        for (const slug of untagged) expect(both.some((line) => line.includes(slug))).toBe(true);
        expect(
          lines.filter((line) => line.includes("given the seed's rule items (they were blank)")),
        ).toHaveLength(SEED_MARKET_COUNT - untagged.length);

        const sourcesBySlug = Object.groupBy(after.sources, (source) => source.slug);
        const linkedBySlug = Object.groupBy(after.linked, (row) => row.slug);
        const touchedAfter = await updatedAts();
        for (const seed of SEED_MARKETS) {
          expect(
            after.rows.find((row) => row.slug === seed.slug),
            seed.slug,
          ).toMatchObject({
            ...storedRuleItems(seed),
            description: seed.slug === oldBackground ? OLD_BACKGROUND : seed.description,
          });
          expect(sourcesBySlug[seed.slug], seed.slug).toEqual(storedSources(seed));
          expect(
            linkedBySlug[seed.slug]?.map((row) => [row.position, row.name]),
            seed.slug,
          ).toEqual(seed.tags.map((name, index) => [index + 1, name]));
          const touched = touchedAfter.get(seed.slug)!;
          expect(touched, seed.slug).toBeGreaterThanOrEqual(startedAt);
          expect(touched, seed.slug).toBeLessThanOrEqual(readAt);
        }
        // Nothing else of the rows, the same events and tags, and no record: what is filled is
        // what a fresh seed would have inserted (ADR-0096 7-14's way).
        expect(after.rows.map(withoutRuleItems)).toEqual(before.rows.map(withoutRuleItems));
        expect(after.events).toEqual(before.events);
        expect(after.tagRows).toEqual(before.tagRows);
        expect(
          await t.db.select().from(adminActions).where(eq(adminActions.targetType, 'market')),
        ).toEqual([]);

        // And once only: the next run finds every item and tag in place.
        expect(runSeed()).toContain(
          "markets: 0 inserted, 14 already existed (0 of them given the seed's tags, 0 the seed's rule items)",
        );
        expect(await marketState()).toEqual(after);
      }, 60_000);

      it('leaves a draft an admin set the items of since #23, one with any item, and an open market', async () => {
        runSeed();
        const slugs = SEED_MARKETS.map((seed) => seed.slug);
        await blankRuleItems(slugs);
        const [emptied, written, sourced, opened] = slugs;
        // Emptied on purpose since #23: the admin's record names the items in its snapshot.
        const [emptiedRow] = await t.db
          .select({ id: markets.id, createdBy: markets.createdBy })
          .from(markets)
          .where(eq(markets.slug, emptied!));
        await t.db.insert(adminActions).values({
          adminId: emptiedRow!.createdBy,
          type: 'market_update',
          targetType: 'market',
          targetId: emptiedRow!.id,
          payload: { before: { yesCondition: 'YES 조건.' }, after: { yesCondition: '' } },
        });
        // One item written, by whoever, and the market is no longer blank: a text, or a source.
        await t.db
          .update(markets)
          .set({ delayHandling: '운영자가 적은 처리입니다.' })
          .where(eq(markets.slug, written!));
        const [sourcedId] = await idsOf([sourced!]);
        await t.db
          .insert(marketSources)
          .values({ marketId: sourcedId!, priority: 0, name: '운영자가 적은 출처', url: '' });
        // Past the draft, its items change on the record only.
        await t.db.update(markets).set({ status: 'open' }).where(eq(markets.slug, opened!));
        const before = await marketState();

        const { stdout } = runSeedIo();
        const left = [emptied!, written!, sourced!, opened!];
        expect(stdout).toContain(
          `markets: 0 inserted, 14 already existed (0 of them given the seed's tags, ${String(
            SEED_MARKET_COUNT - left.length,
          )} the seed's rule items), 0 skipped`,
        );
        const after = await marketState();
        for (const slug of left) {
          expect(
            after.rows.find((row) => row.slug === slug),
            slug,
          ).toEqual(before.rows.find((row) => row.slug === slug));
          expect(
            after.sources.filter((source) => source.slug === slug),
            slug,
          ).toEqual(before.sources.filter((source) => source.slug === slug));
        }
        for (const seed of SEED_MARKETS.filter((market) => !left.includes(market.slug))) {
          expect(
            after.rows.find((row) => row.slug === seed.slug),
            seed.slug,
          ).toMatchObject(storedRuleItems(seed));
        }
      });

      it('leaves blank a draft an admin re-titled before #23, its tags to #17 as before', async () => {
        // A PATCH before #23 recorded the old `rules` and no rule item, so the title alone tells
        // that a draft asks another question, which the seed's items would contradict. Its tags
        // follow #17's own test (`adminSetTags`), unchanged: kept when it has some, given when it
        // has none and no record names them. A record from before #23 that kept the seed's title
        // does not stop the fill.
        runSeed();
        const slugs = SEED_MARKETS.map((seed) => seed.slug);
        await blankRuleItems(slugs);
        const [retitled, retitledUntagged, recorded] = SEED_MARKETS;
        const OLD_RULES = '운영자가 고친 옛 규칙입니다.';
        /** An admin's `market_update` record from before #23: the old `rules`, no rule item. */
        async function recordPre23(
          seed: SeedMarket,
          after: { title: string; tags?: readonly string[] },
        ) {
          const [row] = await t.db
            .select({ id: markets.id, createdBy: markets.createdBy })
            .from(markets)
            .where(eq(markets.slug, seed.slug));
          const tagsOf = (names?: readonly string[]) => (names ? { tags: [...names] } : {});
          await t.db.insert(adminActions).values({
            adminId: row!.createdBy,
            type: 'market_update',
            targetType: 'market',
            targetId: row!.id,
            payload: {
              before: { title: seed.title, rules: '옛 시드의 규칙입니다.', ...tagsOf(after.tags) },
              after: { title: after.title, rules: OLD_RULES, ...tagsOf(after.tags) },
            },
          });
          await t.db.update(markets).set({ title: after.title }).where(eq(markets.slug, seed.slug));
        }
        // Re-titled after #17 (the record names its tags), tags kept.
        await recordPre23(retitled!, {
          title: '운영자가 고친 다른 질문일까?',
          tags: retitled!.tags,
        });
        // Re-titled before #17 (no `tags` key), and no tag: a draft #17's fill would tag.
        await recordPre23(retitledUntagged!, { title: '운영자가 고친 또 다른 질문일까?' });
        await t.db
          .delete(marketTags)
          .where(inArray(marketTags.marketId, await idsOf([retitledUntagged!.slug])));
        // Edited before #23 with the seed's title kept: still the seed's question.
        await recordPre23(recorded!, { title: recorded!.title, tags: recorded!.tags });
        const before = await marketState();
        const touchedBefore = await updatedAts();

        const { stdout } = runSeedIo();
        expect(stdout).toContain(
          `markets: 0 inserted, 14 already existed (1 of them given the seed's tags, ${String(
            SEED_MARKET_COUNT - 2,
          )} the seed's rule items), 0 skipped`,
        );
        const lineOf = (slug: string) =>
          stdout.split(NEWLINE).filter((line) => line.includes(slug));
        expect(lineOf(retitled!.slug)).toEqual([expect.stringMatching(/already exists$/)]);
        expect(lineOf(retitledUntagged!.slug)).toEqual([
          expect.stringMatching(/given the seed's tags \(it had none\)$/),
        ]);
        const after = await marketState();
        const touchedAfter = await updatedAts();
        for (const seed of [retitled!, retitledUntagged!]) {
          // Its row as the admin left it — blank items, their title — written by nobody.
          expect(
            after.rows.find((row) => row.slug === seed.slug),
            seed.slug,
          ).toEqual(before.rows.find((row) => row.slug === seed.slug));
          expect(touchedAfter.get(seed.slug), seed.slug).toBe(touchedBefore.get(seed.slug));
          expect(after.sources.filter((source) => source.slug === seed.slug)).toEqual([]);
          // #17's fill alone: the tags it kept, or the seed's where it had none.
          expect(
            after.linked
              .filter((row) => row.slug === seed.slug)
              .map((row) => [row.position, row.name]),
            seed.slug,
          ).toEqual(seed.tags.map((name, index) => [index + 1, name]));
        }
        expect(after.rows.find((row) => row.slug === recorded!.slug)).toMatchObject({
          title: recorded!.title,
          ...storedRuleItems(recorded!),
        });
        expect(after.sources.filter((source) => source.slug === recorded!.slug)).toEqual(
          storedSources(recorded!),
        );

        // And on every run after: the re-titled drafts stay blank for their admin.
        expect(runSeed()).toContain(
          "markets: 0 inserted, 14 already existed (0 of them given the seed's tags, 0 the seed's rule items)",
        );
        expect(await marketState()).toEqual(after);
      }, 60_000);
    });

    it('skips a seed market whose category the operators kept out of the tree, with a warning', async () => {
      // The seed never fails on the operators' tree: their economy sub-category 'interest' is
      // already 금리, so the seed's 'rates' is not made, and the market filed under it is not
      // either. Deleted by hand before any market exists, to stand in for a seed slug added later.
      runSeed({ admin: false });
      await t.db.delete(categories).where(eq(categories.slug, 'rates'));
      const [economy] = await t.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, 'economy'));
      await t.db
        .insert(categories)
        .values({ slug: 'interest', nameKo: '금리', sortOrder: 50, parentId: economy!.id });

      const { stdout, stderr } = runSeedIo();
      expect(stdout).toContain(
        "markets: 13 inserted, 0 already existed (0 of them given the seed's tags, 0 the seed's rule items), 1 skipped (category not in the tree)",
      );
      const skipped = stderr
        .split(NEWLINE)
        .filter((line) => line.includes('market bok-october-rate-cut-2026:'));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain('category "rates" is not in the tree');
      const { rows } = await marketState();
      expect(rows).toHaveLength(SEED_MARKET_COUNT - 1);
      expect(rows.find((row) => row.slug === 'bok-october-rate-cut-2026')).toBeUndefined();
    });

    it('skips the markets when no admin is configured', async () => {
      const output = runSeed({ admin: false });
      expect(output).toContain('admin skipped');
      expect(output).toContain('markets skipped (no admin)');
      expect(await t.db.select().from(markets)).toHaveLength(0);
      // The tree needs no admin: five top-level rows and every leaf under them.
      const categoryRows = await t.db.select().from(categories);
      expect(categoryRows.filter((row) => row.parentId === null)).toHaveLength(5);
      expect(categoryRows).toHaveLength(5 + ALL_CATEGORY_SLUGS.length - CATEGORY_SLUGS.length);
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
    // The admins too: the second seed found them and recorded no grant of its own.
    expect(await roleRecords()).toHaveLength(2);
    // Each market is a check-then-insert under the same lock: 14, not 28, one event each.
    expect(await t.db.select().from(markets)).toHaveLength(SEED_MARKET_COUNT);
    expect(await t.db.select().from(marketEvents)).toHaveLength(SEED_MARKET_COUNT);
    // And each market's tags once, every shared tag one row (#17).
    expect(await t.db.select().from(marketTags)).toHaveLength(
      SEED_MARKETS.reduce((count, market) => count + market.tags.length, 0),
    );
    expect(await t.db.select().from(tags)).toHaveLength(
      new Set(SEED_MARKETS.flatMap((market) => market.tags.map(tagKey))).size,
    );
    // And each market's sources once (#23).
    expect(await t.db.select().from(marketSources)).toHaveLength(
      SEED_MARKETS.reduce((count, market) => count + 1 + market.fallbackSources.length, 0),
    );
  }, 60_000);
});
