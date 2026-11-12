import {
  findLedgerAccount,
  recordMarketMakerRecallAttempt,
  recoverReconciliationHold,
  runMarketReconciliation,
  schema,
  selectPendingMarketMakerRecallIds,
  type Db,
} from '@buddha/db';
import {
  connectTestDb,
  createApprovalRequest,
  createMarketMakerAccount,
  mintTestPairs,
  createMarket,
  createUser,
  damageActualCoinForTest,
  fundMarketMakerFunds,
  hasTestDb,
  ledgerSupply,
  type TestDb,
} from '@buddha/db/test';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recallMarketMaker, recallPendingMarketMakers } from './market-maker-recall.js';
import { closeMarket } from './market-close.js';
import { finalizeMarket } from './market-finalize.js';
import { withMarketMakerRecall } from '../market-maker-recall-jobs.js';
import type { Publish } from '../realtime.js';

const logger = pino({ level: 'silent' });
describe.skipIf(!hasTestDb())('automatic terminal recall (#181)', () => {
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
  const attempts = () => t.db.select().from(schema.marketMakerRecallAttempts);
  const recalls = () => t.db.select().from(schema.marketMakerRecalls);
  const terminal = async () => {
    const m = await createMarket(t.db, { status: 'cancelled' });
    await fundMarketMakerFunds(t.db, m.id, 1_000n);
    return m;
  };
  const audit = (id: string) =>
    t.db.transaction((tx) => runMarketReconciliation(tx, id, { source: 'manual' }));

  it('commits cancellation before enqueue; the distinct job recalls exactly once even when a scan races', async () => {
    const m = await createMarket(t.db, { closeAt: new Date(Date.now() - 60_000) });
    await fundMarketMakerFunds(t.db, m.id, 1_000n);
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockImplementation(async (id: string) => {
      expect(id).toBe(m.id);
      expect(
        (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0]?.status,
      ).toBe('cancelled');
      expect(await recalls()).toEqual([]);
    });
    expect(await closeMarket(t.db, m.id, withMarketMakerRecall(publish, enqueue))).toMatchObject({
      outcome: 'cancelled',
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(m.id);
    const supply = await ledgerSupply(t.db);
    await Promise.all([
      recallMarketMaker(t.db, m.id, logger),
      recallPendingMarketMakers(t.db, logger),
    ]);
    expect(await recalls()).toHaveLength(1);
    expect(
      await t.db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.type, 'BOT_RECALL')),
    ).toHaveLength(1);
    expect(await attempts()).toMatchObject([{ attempts: 1, state: 'completed' }]);
    expect(await ledgerSupply(t.db)).toEqual(supply);
  });

  it('enqueues only after settlement commits and leaves payouts, terminal facts and public events unchanged by recall', async () => {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' });
    const bot = await createMarketMakerAccount(t.db);
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: bot,
      noHolderId: person,
      qty: 2,
      yesPriceCoin: 60,
    });
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockImplementation(async (id: string) => {
      expect(
        (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0]?.status,
      ).toBe('settled');
      expect(await t.db.select().from(schema.positionSettlements)).toHaveLength(2);
      expect(await recalls()).toEqual([]);
    });
    expect(
      await finalizeMarket(t.db, market.id, withMarketMakerRecall(publish, enqueue), logger),
    ).toMatchObject({ outcome: 'settled' });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(market.id);
    const payouts = await t.db.select().from(schema.positionSettlements);
    const state = await t.db.select().from(schema.markets);
    const publicCalls = publish.mock.calls.length;
    expect(await recallMarketMaker(t.db, market.id, logger)).toMatchObject({
      outcome: 'recalled',
      amountCoin: '1080',
    });
    expect(await t.db.select().from(schema.positionSettlements)).toEqual(payouts);
    expect(await t.db.select().from(schema.markets)).toEqual(state);
    expect(publish).toHaveBeenCalledTimes(publicCalls);
  });

  it('repairs a lost enqueue and completes unallocated cancellation without manufacturing a zero ledger/account', async () => {
    const m = await createMarket(t.db, { status: 'cancelled' });
    const accounts = await t.db.select().from(schema.ledgerAccounts);
    expect(await recallPendingMarketMakers(t.db, logger)).toMatchObject({ recalled: 1, failed: 0 });
    expect(await recalls()).toMatchObject([
      { marketId: m.id, amountCoin: 0n, fundsAccountId: null, ledgerEntryId: null },
    ]);
    expect(await t.db.select().from(schema.ledgerAccounts)).toEqual(accounts);
    expect(await recallPendingMarketMakers(t.db, logger)).toMatchObject({
      recalled: 0,
      pending: 0,
    });
  });

  it('records hold waiting without asset changes, rotates the scan, and proceeds only after actual two-admin recovery', async () => {
    const m = await terminal();
    const funds = (await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: m.id }))!;
    await damageActualCoinForTest(funds.id, -1n);
    const failed = await audit(m.id);
    await damageActualCoinForTest(funds.id, 1n);
    expect((await audit(m.id)).result.passed).toBe(true);
    const before = await t.db.select().from(schema.balances);
    expect(await recallMarketMaker(t.db, m.id, logger)).toMatchObject({
      outcome: 'unavailable',
      reason: 'ledger_hold',
    });
    expect(await attempts()).toMatchObject([
      { attempts: 1, state: 'waiting', reason: 'ledger_hold', lastFailureAt: null },
    ]);
    expect(await t.db.select().from(schema.balances)).toEqual(before);
    expect(await recalls()).toEqual([]);
    const other = await createMarket(t.db, { status: 'cancelled' });
    expect(await selectPendingMarketMakerRecallIds(t.db, 1)).toEqual([other.id]);
    const a = (await createUser(t.db, { role: 'admin' })).user.id;
    const b = (await createUser(t.db, { role: 'admin' })).user.id;
    const hold = failed.hold!;
    const approval = await createApprovalRequest(t.db, {
      kind: 'reconciliation_recovery',
      targetType: 'reconciliation_hold',
      targetId: hold.id,
      payload: { holdId: hold.id, failureResultId: String(hold.failureResultId) },
      requestedBy: a,
      decision: { status: 'approved', by: b },
    });
    await t.db.transaction((tx) =>
      recoverReconciliationHold(tx, {
        holdId: hold.id,
        failureResultId: hold.failureResultId,
        approvalId: approval.id,
        requestedBy: a,
        approverId: b,
      }),
    );
    expect(await recallPendingMarketMakers(t.db, logger)).toMatchObject({
      recalled: 2,
      pending: 0,
      failed: 0,
    });
    expect(await attempts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketId: m.id, state: 'completed', attempts: 2 }),
      ]),
    );
  });

  it('rolls back transfer and completion together, retains failure observation, and retries without repeating payout', async () => {
    const m = await terminal();
    const before = await t.db.select().from(schema.balances);
    const state = await t.db.select().from(schema.markets);
    let first = true;
    const broken = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return (run: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const value = await run(tx);
            if (first) {
              first = false;
              throw new Error('rollback after recall');
            }
            return value;
          });
      },
    });
    await expect(recallMarketMaker(broken, m.id, logger)).rejects.toThrow('rollback after recall');
    expect(await recalls()).toEqual([]);
    expect(await t.db.select().from(schema.balances)).toEqual(before);
    expect(await t.db.select().from(schema.markets)).toEqual(state);
    expect(await attempts()).toMatchObject([
      { attempts: 1, state: 'failed', reason: 'execution_failed' },
    ]);
    expect(await recallMarketMaker(t.db, m.id, logger)).toMatchObject({
      outcome: 'recalled',
      amountCoin: '1000',
    });
    expect(await attempts()).toMatchObject([
      { attempts: 2, state: 'completed', reason: null, lastFailureReason: 'execution_failed' },
    ]);
  });

  it('a lost COMMIT acknowledgement cannot replace completion with failure or count the transfer again', async () => {
    const m = await terminal();
    let first = true;
    const lost = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return async (run: Parameters<Db['transaction']>[0]) => {
          const result = await target.transaction(run);
          if (first) {
            first = false;
            throw new Error('lost COMMIT acknowledgement');
          }
          return result;
        };
      },
    });
    await expect(recallMarketMaker(lost, m.id, logger)).rejects.toThrow(
      'lost COMMIT acknowledgement',
    );
    expect(await attempts()).toMatchObject([
      { attempts: 1, state: 'completed', lastFailureAt: null },
    ]);
    expect(await recallMarketMaker(t.db, m.id, logger)).toMatchObject({ outcome: 'duplicate' });
    expect(await attempts()).toMatchObject([{ attempts: 1, state: 'completed' }]);
    expect(await recalls()).toHaveLength(1);
  });

  it('ignores older failure records and skips non-terminal/unknown jobs without creating observation rows', async () => {
    const m = await createMarket(t.db, { status: 'cancelled' });
    const at = new Date();
    await t.db.transaction((tx) =>
      recordMarketMakerRecallAttempt(tx, {
        marketId: m.id,
        state: 'waiting',
        reason: 'ledger_hold',
        lastAttemptAt: at,
      }),
    );
    await t.db.transaction((tx) =>
      recordMarketMakerRecallAttempt(tx, {
        marketId: m.id,
        state: 'failed',
        reason: 'execution_failed',
        lastAttemptAt: new Date(at.getTime() - 1),
      }),
    );
    expect(await attempts()).toMatchObject([{ attempts: 1, state: 'waiting' }]);
    const open = await createMarket(t.db);
    expect(await recallMarketMaker(t.db, open.id, logger)).toMatchObject({
      outcome: 'unavailable',
      reason: 'not_terminal',
    });
    expect(await attempts()).toHaveLength(1);
  });

  it('continues a repair scan after a failed transaction so one old market cannot block later work', async () => {
    const a = await terminal();
    const b = await terminal();
    let first = true;
    const broken = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return (run: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const result = await run(tx);
            if (first) {
              first = false;
              throw new Error('one failed transaction');
            }
            return result;
          });
      },
    });
    expect(await recallPendingMarketMakers(broken, logger)).toMatchObject({
      recalled: 1,
      failed: 1,
    });
    expect(await attempts()).toHaveLength(2);
    expect(await recallPendingMarketMakers(t.db, logger)).toMatchObject({ recalled: 1, failed: 0 });
    expect((await recalls()).map((r) => r.marketId).sort()).toEqual([a.id, b.id].sort());
  });
});
