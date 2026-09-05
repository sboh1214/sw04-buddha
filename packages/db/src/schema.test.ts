import { SIGNUP_BONUS_P } from '@buddha/shared';
import { eq, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditFailures, balances, ledgerEntries, markets, profiles, user } from './schema/index.js';
import { createCategory, createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

/**
 * Postgres SQLSTATE. drizzle-orm 0.45 wraps driver errors in DrizzleQueryError and keeps the
 * node-postgres error (with `.code`) in `cause`; `db.execute` throws it bare.
 */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

describe.skipIf(!hasTestDb())('schema (integration, docker test profile)', () => {
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

  it('inserting a user row creates profile + balance through the trigger (PLAN 10.4)', async () => {
    await t.db.insert(user).values({ id: 'u-trigger', name: 'x', email: 'trigger@test.local' });
    const profile = await t.db.query.profiles.findFirst({
      where: eq(profiles.userId, 'u-trigger'),
    });
    const balance = await t.db.query.balances.findFirst({
      where: eq(balances.userId, 'u-trigger'),
    });
    expect(profile?.nickname).toMatch(/^예측가_[23456789A-HJ-NP-Z]{4}$/);
    expect(profile?.role).toBe('user');
    // Migration 0004: the sign-up bonus lands in the same transaction, with its ledger entry.
    expect(balance?.availableP).toBe(SIGNUP_BONUS_P);
    expect(balance?.lockedP).toBe(0n);
    const bonus = await t.db.query.ledgerEntries.findFirst({
      where: eq(ledgerEntries.userId, 'u-trigger'),
    });
    expect(bonus).toMatchObject({
      type: 'BONUS',
      amountP: SIGNUP_BONUS_P,
      balanceAfterP: SIGNUP_BONUS_P,
      memo: '가입 보너스',
    });
  });

  it('createUser applies nickname/role/balance and keeps the ledger invariant', async () => {
    const {
      user: u,
      profile,
      balance,
    } = await createUser(t.db, {
      nickname: '팩토리유저',
      role: 'admin',
      balanceP: 10_000n,
    });
    expect(profile.userId).toBe(u.id);
    expect(profile.nickname).toBe('팩토리유저');
    expect(profile.role).toBe('admin');
    expect(balance.availableP).toBe(10_000n);
    expect(balance.lockedP).toBe(0n);
    const [sum] = await t.db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountP}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, u.id));
    expect(BigInt(sum!.total)).toBe(10_000n);
  });

  it('round-trips bigint amounts beyond 2^53 exactly', async () => {
    const big = 2n ** 53n + 1n;
    const { user: u } = await createUser(t.db, { balanceP: big });
    const row = await t.db.query.balances.findFirst({ where: eq(balances.userId, u.id) });
    expect(row?.availableP).toBe(big);
  });

  it('rejects negative balances via CHECK', async () => {
    const { user: u } = await createUser(t.db);
    await expect(
      t.db.update(balances).set({ availableP: -1n }).where(eq(balances.userId, u.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('enforces unique nicknames', async () => {
    await createUser(t.db, { nickname: '중복닉' });
    await expect(createUser(t.db, { nickname: '중복닉' })).rejects.toSatisfy(
      (e) => sqlState(e) === '23505',
    );
  });

  it('createMarket initialises LMSR state and relations resolve', async () => {
    const category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const market = await createMarket(t.db, { categoryId: category.id, initialProbBp: 7000 });
    expect(market.status).toBe('open');
    expect(market.lastPrice).toBe(70);
    expect(market.qNo).toBe('0.0000000000');
    expect(Number(market.qYes)).toBeCloseTo(1000 * Math.log(0.7 / 0.3), 6);
    expect(market.reserveP).toBe(69_315n);
    const withCategory = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { category: true, creator: { with: { profile: true } } },
    });
    expect(withCategory?.category.slug).toBe('economy');
    expect(withCategory?.creator.profile?.role).toBe('admin');
  });

  it('rejects out-of-range prices via CHECK', async () => {
    const market = await createMarket(t.db);
    await expect(
      t.db.update(markets).set({ lastPrice: 100 }).where(eq(markets.id, market.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
    await expect(
      t.db.update(markets).set({ initialProbBp: 10_000 }).where(eq(markets.id, market.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('createMarket factory rejects initialProbBp outside 1..9999 before writing', async () => {
    await expect(createMarket(t.db, { initialProbBp: 10_000 })).rejects.toThrow(RangeError);
  });

  it('$onUpdate refreshes updated_at through the ORM', async () => {
    const { profile } = await createUser(t.db);
    await new Promise((r) => setTimeout(r, 5));
    const [updated] = await t.db
      .update(profiles)
      .set({ nickname: '새닉네임' })
      .where(eq(profiles.userId, profile.userId))
      .returning();
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(profile.updatedAt.getTime());
  });

  describe('timestamptz precision (migration 0005)', () => {
    it('round-trips a shared now() through a JS Date, which every keyset cursor relies on', async () => {
      // One statement, so all three rows carry a single transaction `now()`. While the columns
      // kept microseconds, the Date read back here was strictly older than the stored value,
      // and a cursor built from it skipped the whole group — page 2 of a listing came back
      // empty (@buddha/shared encodeKeyset compares `created_at < cursor OR = cursor AND ...`).
      await t.db
        .insert(auditFailures)
        .values([1, 2, 3].map((n) => ({ kind: 'ledger_balance_mismatch', payload: { n } })));

      const rows = await t.db.select().from(auditFailures);
      expect(rows).toHaveLength(3);
      const stamp = rows[0]!.createdAt;
      expect(rows.map((row) => row.createdAt.getTime())).toEqual([
        stamp.getTime(),
        stamp.getTime(),
        stamp.getTime(),
      ]);

      // The Date is an exact representation, so the rows still match the timestamp they
      // reported — and no row is stranded between `stamp` and its true stored value.
      const matched = await t.db
        .select()
        .from(auditFailures)
        .where(eq(auditFailures.createdAt, stamp));
      expect(matched).toHaveLength(3);
      const older = await t.db
        .select()
        .from(auditFailures)
        .where(lt(auditFailures.createdAt, stamp));
      expect(older).toHaveLength(0);
    });
  });

  describe('buddha_app privileges (PLAN 6.4)', () => {
    it('can INSERT and SELECT ledger_entries but not UPDATE or DELETE', async () => {
      const { user: u } = await createUser(t.db, { balanceP: 500n });
      const rows = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, u.id))
        .orderBy(ledgerEntries.id);
      // The trigger's sign-up BONUS, then the factory's correction down to 500P.
      expect(rows.map((row) => row.type)).toEqual(['BONUS', 'ADMIN_ADJUST']);
      await expect(
        t.db.update(ledgerEntries).set({ memo: 'x' }).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(ledgerEntries).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });

    it('cannot UPDATE/DELETE market_events or admin_actions, can on other tables', async () => {
      const { rows } = await t.db.execute<{ table: string; privilege: string }>(sql`
        SELECT table_name AS "table", privilege_type AS privilege
        FROM information_schema.role_table_grants
        WHERE grantee = 'buddha_app' AND table_schema = 'public'
          AND table_name IN ('ledger_entries', 'market_events', 'admin_actions', 'balances')
        ORDER BY 1, 2`);
      const grants = Object.groupBy(rows, (r) => r.table);
      const privs = (table: string) => grants[table]?.map((r) => r.privilege).sort() ?? [];
      expect(privs('ledger_entries')).toEqual(['INSERT', 'SELECT']);
      expect(privs('market_events')).toEqual(['INSERT', 'SELECT']);
      expect(privs('admin_actions')).toEqual(['INSERT', 'SELECT']);
      expect(privs('balances')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('cannot create tables', async () => {
      await expect(t.db.execute(sql`CREATE TABLE should_fail (id int)`)).rejects.toSatisfy(
        (e) => sqlState(e) === '42501',
      );
    });
  });
});
