import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  readMarketLiquidityHistory,
  readMarketMakerConfig,
  setMarketLiquidity,
} from './market-liquidity.js';
import { openScheduledMarket } from './market-open.js';
import {
  balances,
  ledgerEntries,
  marketEvents,
  marketLiquidityVersions,
  markets,
} from './schema/index.js';
import {
  createMarket,
  createMarketInReview,
  createOpenedMarket,
  createScheduledMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { prepareMarketMakerOpening } from './test/ledger.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';
import { waitForLockWaiter } from './test/wait.js';

const SETTINGS = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
describe.skipIf(!hasTestDb())('market liquidity versions (#72)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function draft() {
    const { user } = await createUser(t.db, { role: 'admin' });
    const market = await createMarket(t.db, { status: 'draft', createdBy: user.id });
    return { market, actorId: user.id };
  }
  const save = (
    marketId: string,
    actorId: string,
    baseVersion: number | null = null,
    settings = SETTINGS,
  ) =>
    t.db.transaction((tx) =>
      setMarketLiquidity(tx, {
        marketId,
        actorId,
        baseVersion,
        settings,
        reason: '유동성 설정 변경',
      }),
    );
  const marketOf = async (id: string) =>
    (await t.db.select().from(markets).where(eq(markets.id, id)))[0]!;
  async function open(id: string) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const [market] = await tx.select().from(markets).where(eq(markets.id, id)).for('update');
      return openScheduledMarket(tx, {
        market: market!,
        now: await clockTimestamp(tx),
        actorId: null,
        source: 'job',
      });
    });
  }

  it('keeps legacy configuration absent and appends complete versions without moving Coin', async () => {
    const { market, actorId } = await draft();
    expect(await readMarketMakerConfig(t.db, market.id)).toBeNull();
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([]);
    const money = await t.db.select().from(balances);
    const first = await save(market.id, actorId);
    const second = await save(market.id, actorId, 1, { ...SETTINGS, b: 50.5 });
    expect(first).toMatchObject({ ...SETTINGS, version: 1, createdBy: actorId });
    expect(await readMarketMakerConfig(t.db, market.id)).toEqual(second);
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([second, first]);
    expect(await marketOf(market.id)).toMatchObject({
      currentLiquidityVersion: 2,
      openedLiquidityVersion: null,
      updatedAt: second.createdAt,
    });
    expect(await t.db.select().from(balances)).toEqual(money);
    expect(await t.db.select().from(ledgerEntries)).toEqual([]);
    expect(await t.db.select().from(marketEvents)).toEqual([]);
  });

  it('refuses missing market, nonadmin, a stale form and a no-op without consuming a version', async () => {
    const { market, actorId } = await draft();
    const { user } = await createUser(t.db);
    await expect(save(randomUUID(), actorId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(save(market.id, user.id)).rejects.toMatchObject({ code: 'forbidden' });
    await save(market.id, actorId);
    await expect(save(market.id, actorId)).rejects.toMatchObject({ code: 'stale' });
    await expect(save(market.id, actorId, 1)).rejects.toMatchObject({ code: 'unchanged' });
    expect(await readMarketLiquidityHistory(t.db, market.id)).toHaveLength(1);
  });

  it('serializes simultaneous forms with the same base version', async () => {
    const { market, actorId } = await draft();
    const results = await Promise.allSettled([
      save(market.id, actorId),
      save(market.id, actorId, null, { ...SETTINGS, b: 50 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ code: 'stale' });
    expect(await readMarketLiquidityHistory(t.db, market.id)).toHaveLength(1);
  });

  it('rechecks the role after waiting for a concurrent revocation', async () => {
    const { market, actorId } = await draft();
    const client = await t.db.$client.connect();
    let pending: ReturnType<typeof save> | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('buddha:admin_roles'))");
      await client.query("UPDATE profiles SET role='user' WHERE user_id=$1", [actorId]);
      pending = save(market.id, actorId);
      // Observe the waiter, rather than assuming it reached the role lock after a delay.
      const rejected = expect(pending).rejects.toMatchObject({ code: 'forbidden' });
      await waitForLockWaiter(client, 'liquidity writer waiting for revocation');
      await client.query('COMMIT');
      await rejected;
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pending?.catch(() => undefined);
    }
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([]);
  });

  it('reads the current version and history in a read-only transaction', async () => {
    const { market, actorId } = await draft();
    const first = await save(market.id, actorId);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      expect(await readMarketMakerConfig(tx, market.id)).toEqual(first);
      expect(await readMarketLiquidityHistory(tx, market.id)).toEqual([first]);
    });
  });

  it.each([
    { budgetCoin: 0n },
    { budgetCoin: 1_000_000_000_000_001n },
    { maxLossCoin: 0n },
    { maxLossCoin: 10_001n },
    { b: 0 },
    { b: Infinity },
    { b: NaN },
    { b: Number.MIN_VALUE },
    { b: Number.MAX_VALUE },
    { levels: 0 },
    { levels: Number.MAX_SAFE_INTEGER + 1 },
    { quantity: 1_000_001 },
    { safetyTicks: -1 },
    { safetyTicks: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid raw settings at the SQL boundary: %o', async (invalid) => {
    const { market, actorId } = await draft();
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(marketLiquidityVersions).values({
          marketId: market.id,
          version: 1,
          ...SETTINGS,
          ...invalid,
          reason: '원시 입력 검사',
          createdBy: actorId,
          createdAt: new Date(),
        });
        await tx
          .update(markets)
          .set({ currentLiquidityVersion: 1 })
          .where(eq(markets.id, market.id));
      }),
    ).rejects.toThrow();
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([]);
  });

  it('rolls back the pointer and version when the caller audit fails', async () => {
    const { market, actorId } = await draft();
    await expect(
      t.db.transaction(async (tx) => {
        await setMarketLiquidity(tx, {
          marketId: market.id,
          actorId,
          settings: SETTINGS,
          baseVersion: null,
          reason: '변경',
        });
        throw new Error('audit failed');
      }),
    ).rejects.toThrow('audit failed');
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([]);
    expect((await marketOf(market.id)).currentLiquidityVersion).toBeNull();
  });

  it('locks edits from REVIEW and permits a new version only after returning to DRAFT', async () => {
    const { market } = await createMarketInReview(t.db);
    await expect(
      save(market.id, market.createdBy, 1, { ...SETTINGS, b: 50 }),
    ).rejects.toMatchObject({ code: 'non_draft' });
    await expect(
      t.db.transaction((tx) =>
        tx.insert(marketLiquidityVersions).values({
          marketId: market.id,
          version: 2,
          ...SETTINGS,
          b: 50,
          reason: '우회',
          createdBy: market.createdBy,
          createdAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
    await t.db.update(markets).set({ status: 'draft' }).where(eq(markets.id, market.id));
    expect((await save(market.id, market.createdBy, 1, { ...SETTINGS, b: 50 })).version).toBe(2);
  });

  it('pins the current version at the open without publishing configuration or another event', async () => {
    const { market } = await createScheduledMarket(t.db);
    await prepareMarketMakerOpening(t.db, market.id);
    const config = await readMarketMakerConfig(t.db, market.id);
    const result = await open(market.id);
    expect(result.opened).toBe(true);
    expect(await marketOf(market.id)).toMatchObject({
      currentLiquidityVersion: 1,
      openedLiquidityVersion: 1,
    });
    expect(await readMarketMakerConfig(t.db, market.id)).toEqual(config);
    const [event] = await t.db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.id, (await marketOf(market.id)).statusEventId!));
    expect(Object.keys(event!.payload!).sort()).toEqual(['closeAt', 'openAt', 'source']);
    expect(await open(market.id)).toEqual({ opened: false, reason: 'not_scheduled' });
    await expect(
      t.db.update(markets).set({ openedLiquidityVersion: null }).where(eq(markets.id, market.id)),
    ).rejects.toThrow();
    await expect(
      t.db.update(markets).set({ currentLiquidityVersion: null }).where(eq(markets.id, market.id)),
    ).rejects.toThrow();
  });

  it('does not open an old scheduled market with no explicit settings or backfill opened ones', async () => {
    const scheduled = await createMarket(t.db, { status: 'scheduled' });
    expect(await open(scheduled.id)).toEqual({ opened: false, reason: 'liquidity_missing' });
    const old = await createMarket(t.db, { status: 'open' });
    expect(await readMarketMakerConfig(t.db, old.id)).toBeNull();
    expect(old.openedLiquidityVersion).toBeNull();
    await expect(
      t.db.update(markets).set({ openedLiquidityVersion: 1 }).where(eq(markets.id, old.id)),
    ).rejects.toThrow();
  });

  it('keeps immutable rows even for the owner and exposes SELECT/INSERT only to the app', async () => {
    const { market, actorId } = await draft();
    await save(market.id, actorId);
    const owner = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await owner.connect();
    try {
      await expect(
        owner.query('UPDATE market_liquidity_versions SET b=50 WHERE market_id=$1', [market.id]),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(
        owner.query('DELETE FROM market_liquidity_versions WHERE market_id=$1', [market.id]),
      ).rejects.toMatchObject({ code: '23000' });
    } finally {
      await owner.end();
    }
    await expect(t.db.update(marketLiquidityVersions).set({ b: 50 })).rejects.toThrow();
    await expect(t.db.delete(marketLiquidityVersions)).rejects.toThrow();
    const privileges = await t.db.execute<{ privilege_type: string }>(
      sql`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='buddha_app' AND table_name='market_liquidity_versions' ORDER BY privilege_type`,
    );
    expect(privileges.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('rejects raw orphan versions, nonexistent pointers and versions by nonadmins', async () => {
    const { market, actorId } = await draft();
    const { user } = await createUser(t.db);
    const raw = {
      marketId: market.id,
      version: 1,
      ...SETTINGS,
      reason: '원시 입력',
      createdBy: actorId,
      createdAt: new Date(),
    };
    await expect(
      t.db.transaction((tx) => tx.insert(marketLiquidityVersions).values(raw)),
    ).rejects.toThrow();
    await expect(
      t.db.transaction((tx) =>
        tx.insert(marketLiquidityVersions).values({ ...raw, createdBy: user.id }),
      ),
    ).rejects.toThrow();
    await expect(
      t.db.update(markets).set({ currentLiquidityVersion: 1 }).where(eq(markets.id, market.id)),
    ).rejects.toThrow();
    expect(await readMarketLiquidityHistory(t.db, market.id)).toEqual([]);
  });

  it('keeps a versioned opened market frozen even if a raw writer changes its status back', async () => {
    const { market } = await createOpenedMarket(t.db);
    await t.db.update(markets).set({ status: 'draft' }).where(eq(markets.id, market.id));
    await expect(save(market.id, market.createdBy, 1, { ...SETTINGS, b: 50 })).rejects.toThrow();
    expect(await readMarketLiquidityHistory(t.db, market.id)).toHaveLength(1);
  });
});
