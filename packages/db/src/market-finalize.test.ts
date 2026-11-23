import { randomUUID } from 'node:crypto';
import {
  SETTLEMENT_STEP_ERROR_MAX,
  type MarketResult,
  type MarketSettlementRetryActionPayload,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  recordSettlementFailure,
  retrySettlingMarket,
  settledMarketEvents,
  settlementRetryErrorKind,
  settleSettlingMarket,
  type SettlementProgress,
} from './market-finalize.js';
import { closeDb, createDb } from './client.js';
import { errorMessageOf, sqlStateOf } from './error-message.js';
import { settleMarketPositions } from './market-settlement.js';
import {
  adminActions,
  balances,
  ledgerEntries,
  marketEvents,
  markets,
  marketSettlementSteps,
  notifications,
  positionSettlements,
  reconciliationHolds,
  reconciliationResults,
} from './schema/index.js';
import { createMarket, createSettlementStep, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { mintTestPairs } from './test/ledger.js';
import { TransactionBusyError } from './transaction-retry.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/** A pause long enough for a transaction to queue on the market lock. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('errorMessageOf and the retry error split (#145, ADR-0163; Q-B)', () => {
  it('leads a driver error with its SQLSTATE, as the worker’s scan did', () => {
    const driver = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    expect(errorMessageOf(driver)).toBe('40P01 deadlock detected');
    const wrapped = new Error('Failed query: update "positions"', { cause: driver });
    expect(errorMessageOf(wrapped)).toBe(
      '40P01 deadlock detected — Failed query: update "positions"',
    );
    expect(errorMessageOf('plain')).toBe('plain');
    expect(sqlStateOf(wrapped)).toBe('40P01');
    expect(sqlStateOf(new Error('x'))).toBeUndefined();
  });

  it('answers busy for a lock wait, a timeout or a lost connection before the attempt, and never after it', () => {
    const driver = (code: string) => Object.assign(new Error(`e ${code}`), { code });
    const notStarted: SettlementProgress = {};
    for (const code of ['57014', '55P03', '40P01', '08006', '08003', '57P01']) {
      expect(settlementRetryErrorKind(driver(code), notStarted), code).toBe('busy');
      expect(
        settlementRetryErrorKind(new Error('Failed query', { cause: driver(code) }), notStarted),
        code,
      ).toBe('busy');
    }
    expect(settlementRetryErrorKind(new TransactionBusyError(), notStarted)).toBe('busy');
    expect(
      settlementRetryErrorKind(new Error('Connection terminated unexpectedly'), notStarted),
    ).toBe('busy');
    expect(
      settlementRetryErrorKind(Object.assign(new Error('reset'), { code: 'ECONNRESET' }), {}),
    ).toBe('busy');
    // node-postgres's own code-less timeouts: the client's read timeout (wrapped by drizzle, as a
    // lock wait ends in practice) and pg-pool's checkout timeout.
    expect(
      settlementRetryErrorKind(
        new Error('Failed query: SELECT pg_advisory_xact_lock', {
          cause: new Error('Query read timeout'),
        }),
        notStarted,
      ),
    ).toBe('busy');
    expect(
      settlementRetryErrorKind(new Error('timeout exceeded when trying to connect'), notStarted),
    ).toBe('busy');
    for (const err of [driver('23505'), driver('22P02'), new Error('Market x not found'), 'x']) {
      expect(settlementRetryErrorKind(err, notStarted)).toBe('other');
    }
    // Once the attempt began, every throw is that attempt's, recorded as such.
    for (const err of [driver('57014'), new Error('boom')]) {
      expect(settlementRetryErrorKind(err, { started: true })).toBe('attempted');
    }
  });
});

describe.skipIf(!hasTestDb())('the shared payout core (#145, ADR-0163; integration)', () => {
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

  /** A SETTLING market with two holders of three pairs, its `coin` step pending. */
  async function settlingMarket(result: MarketResult | null = 'YES') {
    const market = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: result,
      judgementVersion: null,
    });
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 3,
      yesPriceCoin: 60,
    });
    return { market, yes, no };
  }

  /** A failed market reconciliation's hold on the market: the payout refuses until recovered. */
  async function holdLedger(marketId: string) {
    await t.db.transaction(async (tx) => {
      const at = await clockTimestamp(tx);
      const [failure] = await tx
        .insert(reconciliationResults)
        .values({
          scope: 'market',
          targetKey: `market:${marketId}`,
          marketId,
          accountId: null,
          userId: null,
          source: 'manual',
          actorId: null,
          passed: false,
          checkedAt: at,
          ledgerCursor: 0,
          findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
          facts: {},
        })
        .returning();
      await tx.insert(reconciliationHolds).values({
        scope: 'market',
        targetKey: `market:${marketId}`,
        marketId,
        userId: null,
        failureResultId: failure!.id,
        startedAt: at,
      });
    });
  }

  const marketOf = async (id: string) =>
    (await t.db.select().from(markets).where(eq(markets.id, id)))[0]!;
  const stepOf = async (id: string) =>
    (
      await t.db.select().from(marketSettlementSteps).where(eq(marketSettlementSteps.marketId, id))
    )[0];
  const retriesOf = (id: string) =>
    t.db
      .select()
      .from(adminActions)
      .where(and(eq(adminActions.targetId, id), eq(adminActions.type, 'market_settlement_retry')))
      .orderBy(asc(adminActions.createdAt));
  const finalizedOf = (id: string) =>
    t.db
      .select()
      .from(marketEvents)
      .where(and(eq(marketEvents.marketId, id), eq(marketEvents.type, 'finalized')));
  const settledNoticesOf = (userIds: string[]) =>
    t.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'market_settled'),
          sql`${notifications.userId} IN (${sql.join(
            userIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
  const books = async (id: string) => ({
    entries: await t.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.marketId, id))
      .orderBy(asc(ledgerEntries.id)),
    balances: await t.db.select().from(balances).orderBy(asc(balances.accountId)),
    records: await t.db
      .select()
      .from(positionSettlements)
      .where(eq(positionSettlements.marketId, id))
      .orderBy(asc(positionSettlements.outcome)),
  });

  /** The operator retry's transaction as the API runs it: lock, then the db retry body. */
  const retry = (marketId: string, progress: SettlementProgress = {}, actionId = randomUUID()) =>
    t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const admin = adminIdOf.get(marketId)!;
      const attempt = await retrySettlingMarket(
        tx,
        { marketId, adminId: admin, reason: '복구 승인 뒤 다시 지급', actionId },
        progress,
      );
      return attempt;
    });
  const adminIdOf = new Map<string, string>();
  async function withAdmin(marketId: string) {
    adminIdOf.set(marketId, (await createUser(t.db, { role: 'admin' })).user.id);
    return adminIdOf.get(marketId)!;
  }

  it.each(['YES', 'NO', 'VOID'] as const)(
    'settles a %s market, the notices last, the events built for publishing',
    async (result) => {
      const { market, yes, no } = await settlingMarket(result);
      const progress: SettlementProgress = {};
      const done = await t.db.transaction((tx) => settleSettlingMarket(tx, market.id, progress));
      expect(done.outcome).toBe('settled');
      if (done.outcome !== 'settled') return;
      expect(done).toMatchObject({ positions: 2, settledAccounts: 2, paidCoin: 300n, result });
      expect(progress.running).toBeUndefined();
      const after = await marketOf(market.id);
      expect(after.status).toBe('settled');
      expect(after.statusEventId).toBe(done.statusEventId);
      const [finalized] = await finalizedOf(market.id);
      expect(finalized).toMatchObject({ actorId: null, id: done.statusEventId });
      expect((await stepOf(market.id))!).toMatchObject({ status: 'done', attempts: 1 });
      const notices = await settledNoticesOf([yes, no]);
      expect(notices).toHaveLength(2);
      for (const notice of notices) {
        expect(notice.createdAt.getTime()).toBeGreaterThanOrEqual(finalized!.createdAt.getTime());
      }
      expect([...done.notified].sort()).toEqual([yes, no].sort());

      const events = settledMarketEvents(done);
      expect(events.status).toEqual({
        type: 'market:status',
        marketId: market.id,
        status: 'settled',
        resolvedResult: result,
        statusEventId: String(done.statusEventId),
        ts: done.settledAt.toISOString(),
      });
      const types = events.user.map(([, event]) => event.type);
      const paid = result === 'VOID' ? 2 : 1;
      // Balances first (winners only), then every closed-out row, then the inbox signals.
      expect(types).toEqual([
        ...Array<string>(paid).fill('user:balance'),
        'user:position',
        'user:position',
        'user:notification',
        'user:notification',
      ]);
    },
  );

  it('skips a market that is not settling and writes nothing', async () => {
    for (const status of ['settled', 'resolved', 'closed'] as const) {
      const market = await createMarket(t.db, { status, resolvedResult: 'YES' });
      const before = await stepOf(market.id);
      const skipped = await t.db.transaction((tx) => settleSettlingMarket(tx, market.id, {}));
      expect(skipped).toEqual({ outcome: 'skipped', marketId: market.id, reason: 'not_settling' });
      expect((await marketOf(market.id)).status).toBe(status);
      expect(await stepOf(market.id)).toEqual(before);
    }
  });

  describe('recordSettlementFailure', () => {
    it('records the worker’s attempt as before: failed, attempts + 1, the error cut', async () => {
      const { market } = await settlingMarket();
      await holdLedger(market.id);
      const progress: SettlementProgress = {};
      const err = await t.db
        .transaction((tx) => settleSettlingMarket(tx, market.id, progress))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(errorMessageOf(err)).toMatch(/ledger/i);
      expect(progress.running).toBe('coin');
      const recorded = await recordSettlementFailure(t.db, market.id, progress.running, err);
      expect(recorded).toEqual({
        outcome: 'failed',
        step: { status: 'failed', attempts: 1, lastError: errorMessageOf(err) },
      });
      expect(await retriesOf(market.id)).toEqual([]);
      expect((await marketOf(market.id)).status).toBe('settling');

      const long = await recordSettlementFailure(
        t.db,
        market.id,
        undefined,
        new Error('x'.repeat(SETTLEMENT_STEP_ERROR_MAX + 500)),
      );
      expect(long).toMatchObject({ outcome: 'failed', step: { status: 'failed', attempts: 2 } });
      expect((await stepOf(market.id))!.lastError).toHaveLength(SETTLEMENT_STEP_ERROR_MAX);
    });

    it('keeps a done step done after a reconciliation failure, only the error and count move', async () => {
      const market = await createMarket(t.db, {
        status: 'settling',
        resolvedResult: 'YES',
        settlementSteps: false,
      });
      const completedAt = new Date(Date.now() - 60_000);
      await createSettlementStep(t.db, {
        marketId: market.id,
        status: 'done',
        attempts: 1,
        completedAt,
      });
      const recorded = await recordSettlementFailure(
        t.db,
        market.id,
        'coin',
        new Error('reconcile'),
      );
      expect(recorded).toEqual({
        outcome: 'failed',
        step: { status: 'done', attempts: 2, lastError: 'reconcile' },
      });
      expect((await stepOf(market.id))!.completedAt).toEqual(completedAt);
    });

    it('with the operator’s retry writes the action and the step at one instant', async () => {
      const { market } = await settlingMarket();
      const admin = await withAdmin(market.id);
      const actionId = randomUUID();
      const recorded = await recordSettlementFailure(t.db, market.id, 'coin', new Error('boom'), {
        adminId: admin,
        reason: '다시 시도',
        actionId,
      });
      expect(recorded).toEqual({
        outcome: 'failed',
        step: { status: 'failed', attempts: 1, lastError: 'boom' },
      });
      const [action] = await retriesOf(market.id);
      expect(action).toMatchObject({
        id: actionId,
        adminId: admin,
        targetType: 'market',
        targetId: market.id,
        payload: { reason: '다시 시도', outcome: 'failed', error: 'boom' },
      });
      expect(action!.createdAt).toEqual((await stepOf(market.id))!.updatedAt);
    });

    it('with a retry on a market no longer settling writes the action only', async () => {
      const market = await createMarket(t.db, { status: 'settled', resolvedResult: 'NO' });
      const admin = await withAdmin(market.id);
      const before = await stepOf(market.id);
      const recorded = await recordSettlementFailure(t.db, market.id, undefined, 'x', {
        adminId: admin,
        reason: '다시 시도',
        actionId: randomUUID(),
      });
      expect(recorded).toEqual({ outcome: 'failed', step: null });
      expect(await retriesOf(market.id)).toHaveLength(1);
      expect(await stepOf(market.id)).toEqual(before);
    });

    it('tells a lost COMMIT acknowledgement by the request’s settled row: nothing more written (Q-C)', async () => {
      const { market } = await settlingMarket();
      await withAdmin(market.id);
      const actionId = randomUUID();
      // The settled branch committed, its acknowledgement lost: the same request records next.
      const attempt = await retry(market.id, {}, actionId);
      expect(attempt.outcome).toBe('settled');
      const step = await stepOf(market.id);
      const recorded = await recordSettlementFailure(t.db, market.id, 'coin', new Error('?'), {
        adminId: adminIdOf.get(market.id)!,
        reason: '다시 시도',
        actionId,
      });
      expect(recorded).toEqual({
        outcome: 'settled',
        statusEventId: (await marketOf(market.id)).statusEventId,
      });
      const retries = await retriesOf(market.id);
      expect(retries.map((row) => row.payload)).toEqual([
        { reason: '복구 승인 뒤 다시 지급', outcome: 'settled' },
      ]);
      expect(await stepOf(market.id)).toEqual(step);
    });
  });

  describe('retrySettlingMarket (145-7, 145-14)', () => {
    it('pays a settling market once, its settled row before the payout’s events and notices', async () => {
      const { market, yes, no } = await settlingMarket();
      await withAdmin(market.id);
      const progress: SettlementProgress = {};
      const attempt = await retry(market.id, progress);
      expect(attempt.outcome).toBe('settled');
      expect(progress.started).toBe(true);
      if (attempt.outcome !== 'settled') return;
      expect((await marketOf(market.id)).status).toBe('settled');
      const [action] = await retriesOf(market.id);
      const payload: MarketSettlementRetryActionPayload = {
        reason: '복구 승인 뒤 다시 지급',
        outcome: 'settled',
      };
      expect(action!.payload).toEqual(payload);
      const [finalized] = await finalizedOf(market.id);
      // The transition is the payout's: the operator is the action of the same transaction.
      expect(finalized!.actorId).toBeNull();
      expect(action!.createdAt.getTime()).toBeLessThanOrEqual(finalized!.createdAt.getTime());
      const notices = await settledNoticesOf([yes, no]);
      expect(notices).toHaveLength(2);
      for (const notice of notices) {
        expect(notice.createdAt.getTime()).toBeGreaterThanOrEqual(action!.createdAt.getTime());
      }
    });

    it('refuses a market that is not settling and writes nothing', async () => {
      for (const status of ['settled', 'resolved', 'closed', 'provisional'] as const) {
        const market = await createMarket(t.db, { status, resolvedResult: 'YES' });
        await withAdmin(market.id);
        const progress: SettlementProgress = {};
        expect(await retry(market.id, progress)).toEqual({ outcome: 'not_settling' });
        expect(progress.started).toBeUndefined();
        expect(await retriesOf(market.id)).toEqual([]);
      }
      // An unknown market reads the same (the API answers 404 before it).
      expect(
        await t.db.transaction((tx) =>
          retrySettlingMarket(
            tx,
            { marketId: randomUUID(), adminId: 'x', reason: 'r', actionId: randomUUID() },
            {},
          ),
        ),
      ).toEqual({ outcome: 'not_settling' });
    });

    it('rolls back a held payout, then records the attempt with the step; nothing paid', async () => {
      const { market } = await settlingMarket();
      await holdLedger(market.id);
      const admin = await withAdmin(market.id);
      const before = await books(market.id);
      const progress: SettlementProgress = {};
      const actionId = randomUUID();
      const err = await retry(market.id, progress, actionId).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      expect(settlementRetryErrorKind(err, progress)).toBe('attempted');
      // The settled row rolled back with the payout.
      expect(await retriesOf(market.id)).toEqual([]);
      const recorded = await recordSettlementFailure(t.db, market.id, progress.running, err, {
        adminId: admin,
        reason: '복구 승인 뒤 다시 지급',
        actionId,
      });
      expect(recorded).toMatchObject({
        outcome: 'failed',
        step: { status: 'failed', attempts: 1 },
      });
      const [action] = await retriesOf(market.id);
      expect(action!.payload).toMatchObject({ outcome: 'failed', error: errorMessageOf(err) });
      expect(await books(market.id)).toEqual(before);
      expect((await marketOf(market.id)).status).toBe('settling');
    });

    it('records a settling market without a result as a failed attempt (the worker’s own case)', async () => {
      const market = await createMarket(t.db, {
        status: 'settling',
        resolvedResult: null,
        judgementVersion: null,
      });
      const admin = await withAdmin(market.id);
      const progress: SettlementProgress = {};
      const err = await retry(market.id, progress).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(errorMessageOf(err)).toMatch(/without a result/);
      expect(progress.started).toBe(true);
      expect(
        await recordSettlementFailure(t.db, market.id, progress.running, err, {
          adminId: admin,
          reason: 'r',
          actionId: randomUUID(),
        }),
      ).toMatchObject({ outcome: 'failed', step: { status: 'failed', attempts: 1 } });
    });

    it('never pays twice: a done coin step only reconciles and settles, and a second retry is refused (N01 §10)', async () => {
      const { market, yes, no } = await settlingMarket();
      await withAdmin(market.id);
      // The coin step paid and committed; its completion reconciliation failed (ADR-0118 결정 8).
      const first = await t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        return settleMarketPositions(tx, market.id);
      });
      await t.db
        .update(marketSettlementSteps)
        .set({ status: 'done', attempts: 1, completedAt: first.at, lastError: 'reconcile failed' })
        .where(eq(marketSettlementSteps.marketId, market.id));
      const paid = await books(market.id);
      expect(paid.records).toHaveLength(2);

      const attempt = await retry(market.id);
      expect(attempt.outcome).toBe('settled');
      if (attempt.outcome !== 'settled') return;
      expect(attempt.settled.settlements).toEqual([]);
      expect((await marketOf(market.id)).status).toBe('settled');
      // Balances, ledger rows and payout records are as the first payout left them.
      expect(await books(market.id)).toEqual(paid);
      expect((await stepOf(market.id))!).toMatchObject({ status: 'done', attempts: 1 });

      expect(await retry(market.id)).toEqual({ outcome: 'not_settling' });
      expect(await books(market.id)).toEqual(paid);
      expect(await retriesOf(market.id)).toHaveLength(1);
      expect(await settledNoticesOf([yes, no])).toHaveLength(2);
    });

    it('serializes two concurrent retries: one pays, the other is refused (one row, one payout)', async () => {
      const { market, yes, no } = await settlingMarket();
      await withAdmin(market.id);
      const outcomes = await Promise.all([retry(market.id), retry(market.id)]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['not_settling', 'settled']);
      expect(await retriesOf(market.id)).toHaveLength(1);
      expect(await finalizedOf(market.id)).toHaveLength(1);
      const { entries, records } = await books(market.id);
      expect(records).toHaveLength(2);
      expect(entries.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT')).toHaveLength(1);
      expect(await settledNoticesOf([yes, no])).toHaveLength(2);
    });

    it('classes a real lock wait that times out before the attempt as busy, nothing written (Q-B)', async () => {
      const { market } = await settlingMarket();
      const admin = await withAdmin(market.id);
      const before = await books(market.id);
      // The API's handle with a short bound: pg's client-side read timeout fires before the
      // server's statement_timeout of the same length, so the wait ends with a code-less error.
      const short = createDb(testDbUrls()!.appUrl, { max: 1, queryTimeoutMs: 500 });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const holder = t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        locked();
        await gate;
      });
      try {
        await holding;
        const progress: SettlementProgress = {};
        const err = await short
          .transaction(async (tx) => {
            await lockMarket(tx, market.id);
            return retrySettlingMarket(
              tx,
              { marketId: market.id, adminId: admin, reason: 'r', actionId: randomUUID() },
              progress,
            );
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toBeDefined();
        expect(progress.started).toBeUndefined();
        expect(settlementRetryErrorKind(err, progress)).toBe('busy');
      } finally {
        release();
        await holder;
        await closeDb(short);
      }
      expect(await retriesOf(market.id)).toEqual([]);
      expect(await books(market.id)).toEqual(before);
    });

    it('waits for a run holding the market lock and then finds it settled (the worker first)', async () => {
      const { market } = await settlingMarket();
      await withAdmin(market.id);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let ran!: () => void;
      const settledInside = new Promise<void>((resolve) => (ran = resolve));
      const worker = t.db.transaction(async (tx) => {
        const done = await settleSettlingMarket(tx, market.id, {});
        ran();
        await gate;
        return done;
      });
      await settledInside;
      const progress: SettlementProgress = {};
      const operator = retry(market.id, progress);
      const scan = t.db.transaction((tx) => settleSettlingMarket(tx, market.id, {}));
      // Let both transactions queue on the advisory lock, then commit the worker's.
      await sleep(200);
      expect(progress.started).toBeUndefined();
      release();
      expect((await worker).outcome).toBe('settled');
      expect(await operator).toEqual({ outcome: 'not_settling' });
      expect(await scan).toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_settling',
      });
      expect(progress.started).toBeUndefined();
      expect(await retriesOf(market.id)).toEqual([]);
      expect(await finalizedOf(market.id)).toHaveLength(1);
    });
  });
});
