import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { MARKET_MAKER_CONTROL_KIND, type MarketMakerControlChange } from '@buddha/shared';
import {
  applyMarketMakerControl,
  prepareMarketMakerControlRequest,
} from './market-maker-control.js';
import { runMarketMakerCycle } from './market-maker-cycle.js';
import {
  readMarketMakerRuntime,
  requestMarketMakerRefresh,
  recordMarketMakerRun,
} from './market-maker-runtime.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import { recordLedgerEntry } from './ledger.js';
import { clockTimestamp, lockAdminRoles, lockMarket } from './tx-helpers.js';
import {
  approvalRequests,
  balances,
  ledgerEntries,
  marketLiquidityVersions,
  marketMakerControls,
  marketMakerRuntime,
  markets,
  orders,
  profiles,
} from './schema/index.js';
import {
  createApprovalRequest,
  createMarketPause,
  createOpenedMarket,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { fundTestTreasury, ledgerAccountBalance, ledgerSupply } from './test/ledger.js';
import {
  openOrderIntake,
  placeTestOrder,
  passMarketClose,
  closeTestMarket,
} from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';

const settings = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
describe.skipIf(!hasTestDb())('approval-bound maker controls (#130)', () => {
  let t: TestDb;
  let asker: string;
  let decider: string;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    asker = (await createUser(t.db, { role: 'admin' })).user.id;
    decider = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId: asker });
  });
  const opened = async () =>
    (await createOpenedMarket(t.db, { liquiditySettings: settings })).market;
  const run = (marketId: string) => t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
  async function request(marketId: string, change: MarketMakerControlChange) {
    return t.db.transaction(async (tx) => {
      const config = (await readMarketMakerConfig(tx, marketId))!;
      const runtime = (await readMarketMakerRuntime(tx, marketId))!;
      const payload = await prepareMarketMakerControlRequest(tx, marketId, asker, {
        expectedAccountId: asker,
        baseVersion: config.version,
        baseControlGeneration: runtime.controlGeneration.toString(),
        reason: '요청 근거',
        change,
      });
      return createApprovalRequest(tx as unknown as TestDb['db'], {
        kind: MARKET_MAKER_CONTROL_KIND,
        targetType: 'market',
        targetId: marketId,
        requestedBy: asker,
        reason: '요청 근거',
        payload,
      });
    });
  }
  async function approve(id: string, by = decider) {
    return t.db.transaction(async (tx) => {
      const [r] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      await lockMarket(tx, r!.targetId!);
      await lockAdminRoles(tx, 'shared');
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: by,
          decisionReason: '독립 검토 완료',
          decidedAt: await clockTimestamp(tx),
        })
        .where(eq(approvalRequests.id, id));
      return applyMarketMakerControl(tx, { approvalId: id });
    });
  }
  const increase = (amount = '1000'): MarketMakerControlChange => ({
    action: 'increase',
    additionalCoin: amount,
    demand: {
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
      independentParticipants: '독립 참여 근거',
      bidirectionalTrading: '양방향 거래 근거',
      actualDemand: '실제 수요 근거',
    },
  });
  const state = async (marketId: string) => ({
    runtime: await readMarketMakerRuntime(t.db, marketId),
    config: await readMarketMakerConfig(t.db, marketId),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
    orders: await t.db.select().from(orders).orderBy(orders.id),
    ledger: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
    controls: await t.db.select().from(marketMakerControls).orderBy(marketMakerControls.approvalId),
  });

  it('stops only maker orders atomically, conserves assets and permits an explicit independent resume', async () => {
    const market = await opened();
    await run(market.id);
    const human = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const humanOrder = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: human,
      outcome: 'YES',
      limitPriceCoin: 1,
      qty: 1,
    });
    expect(humanOrder.kind).toBe('placed');
    const supply = await ledgerSupply(t.db);
    const before = await t.db.select().from(ledgerEntries);
    const r = await request(market.id, { action: 'stop' });
    const result = await approve(r.id);
    expect(result).toMatchObject({
      outcome: 'applied',
      bookChanged: true,
      refreshRequested: false,
    });
    expect(result.cancelledOrderIds).toHaveLength(2);
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: false,
      controlGeneration: 2n,
      reason: 'operator_stopped',
    });
    expect(
      (
        await t.db
          .select()
          .from(orders)
          .where(and(eq(orders.marketId, market.id), eq(orders.status, 'open')))
      ).map((o) => o.userId),
    ).toEqual([human]);
    expect(await ledgerSupply(t.db)).toEqual(supply);
    expect(await t.db.select().from(ledgerEntries)).toEqual(before);
    const resume = await request(market.id, { action: 'resume' });
    await approve(resume.id);
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: true,
      controlGeneration: 3n,
      state: 'waiting',
    });
    expect(await t.db.select().from(marketMakerControls)).toHaveLength(2);
  });

  it('changes only approved settings through a new immutable version without resetting capital or open binding', async () => {
    const market = await opened();
    const before = await ledgerSupply(t.db);
    const r = await request(market.id, {
      action: 'settings',
      settings: { maxLossCoin: '4000', levels: 2, quantity: 4, safetyTicks: 2 },
    });
    await approve(r.id);
    expect(await readMarketMakerConfig(t.db, market.id)).toMatchObject({
      version: 2,
      budgetCoin: 10_000n,
      maxLossCoin: 4000n,
      b: settings.b,
      quantity: 4,
    });
    expect((await t.db.select().from(markets).where(eq(markets.id, market.id)))[0]).toMatchObject({
      currentLiquidityVersion: 2,
      openedLiquidityVersion: 1,
      status: 'open',
    });
    expect(await t.db.select().from(marketLiquidityVersions)).toHaveLength(2);
    expect(await ledgerSupply(t.db)).toEqual(before);
  });

  it('transfers exactly the fixed additional capital once, preserving issue totals and evidence', async () => {
    const market = await opened();
    await fundTestTreasury(t.db, 2000n);
    const before = await ledgerSupply(t.db);
    const oldFunds = await ledgerAccountBalance(t.db, {
      kind: 'market_maker_funds',
      marketId: market.id,
    });
    const r = await request(market.id, increase());
    const result = await approve(r.id);
    expect(result.execution).toMatchObject({
      action: 'increase',
      additionalCoin: 1000n,
      afterVersion: 2,
    });
    expect(await readMarketMakerConfig(t.db, market.id)).toMatchObject({
      budgetCoin: 11_000n,
      maxLossCoin: 5000n,
    });
    expect(
      await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toMatchObject({ availableCoin: oldFunds!.availableCoin + 1000n });
    expect(await ledgerSupply(t.db)).toEqual(before);
    const snapshot = await state(market.id);
    expect(
      await t.db.transaction((tx) => applyMarketMakerControl(tx, { approvalId: r.id })),
    ).toMatchObject({ outcome: 'duplicate', bookChanged: false, refreshRequested: false });
    expect(await state(market.id)).toEqual(snapshot);
  });

  it('retains a treasury-insufficient request pending and can approve the same fixed amount after actual issuance', async () => {
    const market = await opened();
    const r = await request(market.id, increase());
    const before = await state(market.id);
    await expect(approve(r.id)).rejects.toMatchObject({ code: 'insufficient_treasury' });
    expect(await state(market.id)).toEqual(before);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.id)))[0]?.status,
    ).toBe('pending');
    await fundTestTreasury(t.db, 1000n);
    await approve(r.id);
    expect((await t.db.select().from(marketMakerControls))[0]?.additionalCoin).toBe(1000n);
  });

  it('allows ordinary worker generation changes but rejects stale control/config bases', async () => {
    const market = await opened();
    const a = await request(market.id, { action: 'stop' });
    const b = await request(market.id, { action: 'stop' });
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    await run(market.id);
    await approve(a.id);
    const before = await state(market.id);
    await expect(approve(b.id)).rejects.toMatchObject({ code: 'stale' });
    expect(await state(market.id)).toEqual(before);
  });

  it('serializes simultaneous approvals to one execution and never duplicates the transfer', async () => {
    const market = await opened();
    await fundTestTreasury(t.db, 1000n);
    const r = await request(market.id, increase());
    const results = await Promise.allSettled([approve(r.id), approve(r.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await t.db.select().from(marketMakerControls)).toHaveLength(1);
    expect(
      await t.db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, r.id)),
    ).toHaveLength(1);
  });

  it('waits for the market lock and then rejects a now-stale queued control', async () => {
    const market = await opened();
    const r = await request(market.id, { action: 'stop' });
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      locked();
      await wait;
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: decider,
          decisionReason: '먼저 승인',
          decidedAt: await clockTimestamp(tx),
        })
        .where(eq(approvalRequests.id, r.id));
      return applyMarketMakerControl(tx, { approvalId: r.id });
    });
    await acquired;
    const second = approve(r.id).catch((e: unknown) => e);
    try {
      await waitForLockWaiter(t.db.$client, 'queued approval');
    } finally {
      release();
    }
    await first;
    expect(await second).toBeInstanceOf(Error);
    expect(await t.db.select().from(marketMakerControls)).toHaveLength(1);
  });

  it('requires the requester and decider to remain different current administrators', async () => {
    const market = await opened();
    const r = await request(market.id, { action: 'stop' });
    await expect(approve(r.id, asker)).rejects.toBeDefined();
    await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, asker));
    await expect(approve(r.id)).rejects.toMatchObject({ code: 'requester' });
    expect(await t.db.select().from(marketMakerControls)).toEqual([]);
  });

  it('allows only stop while normally paused and refuses every financial/control execution during a ledger hold', async () => {
    const market = await opened();
    const r = await request(market.id, { action: 'stop' });
    await createMarketPause(t.db, { marketId: market.id, by: asker, reason: 'basis_change' });
    await approve(r.id);
    await expect(request(market.id, { action: 'resume' })).rejects.toMatchObject({ code: 'state' });
    const other = await opened();
    const heldRequest = await request(other.id, { action: 'stop' });
    await createMarketPause(t.db, { marketId: other.id, by: asker, reason: 'ledger_failure' });
    const before = await state(other.id);
    await expect(approve(heldRequest.id)).rejects.toMatchObject({ code: 'held' });
    expect(await state(other.id)).toEqual(before);
  });

  it('refuses resume with missing stages and rejects approval-only/raw resume/extra allocation bypasses', async () => {
    const market = await opened();
    const r = await request(market.id, { action: 'stop' });
    await expect(
      t.db
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: decider,
          decisionReason: '누락 실행',
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, r.id)),
    ).rejects.toBeDefined();
    await approve(r.id);
    const resume = await request(market.id, { action: 'resume' });
    await setReleaseSetting(t.db, {
      adminId: asker,
      key: 'market_maker.reduce_at_bp',
      value: null,
      status: 'undecided',
    });
    await expect(approve(resume.id)).rejects.toMatchObject({ code: 'settings' });
    await expect(
      t.db
        .update(marketMakerRuntime)
        .set({ desiredEnabled: true })
        .where(eq(marketMakerRuntime.marketId, market.id)),
    ).rejects.toBeDefined();
    await fundTestTreasury(t.db, 1000n);
    await expect(
      t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'BOT_ALLOCATION',
          from: { kind: 'treasury' },
          to: { kind: 'market_maker_funds', marketId: market.id },
          marketId: market.id,
          amountCoin: 1n,
          refType: 'approval_request',
          refId: resume.id,
          idempotencyKey: 'unapproved-raw',
        }),
      ),
    ).rejects.toBeDefined();
  });

  it('rolls an executed stop back when a later statement fails, with prior orders and capital unchanged', async () => {
    const market = await opened();
    await run(market.id);
    const r = await request(market.id, { action: 'stop' });
    const before = await state(market.id);
    await expect(
      t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        await lockAdminRoles(tx, 'shared');
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: decider,
            decisionReason: 'rollback',
            decidedAt: await clockTimestamp(tx),
          })
          .where(eq(approvalRequests.id, r.id));
        await applyMarketMakerControl(tx, { approvalId: r.id });
        await tx.execute(sql`SELECT 1/0`);
      }),
    ).rejects.toBeDefined();
    expect(await state(market.id)).toEqual(before);
  });
  it('refuses a later same-transaction hold and rolls back the completed control and cancelled orders', async () => {
    const market = await opened();
    await run(market.id);
    const r = await request(market.id, { action: 'stop' });
    const before = await state(market.id);
    await expect(
      t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        await lockAdminRoles(tx, 'shared');
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: decider,
            decisionReason: 'hold race',
            decidedAt: await clockTimestamp(tx),
          })
          .where(eq(approvalRequests.id, r.id));
        await applyMarketMakerControl(tx, { approvalId: r.id });
        await createMarketPause(tx as unknown as TestDb['db'], {
          marketId: market.id,
          by: asker,
          reason: 'ledger_failure',
        });
      }),
    ).rejects.toBeDefined();
    expect(await state(market.id)).toEqual(before);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.id)))[0]?.status,
    ).toBe('pending');
  });

  it('does not let a late retry-exhaustion result disable a separately approved resume', async () => {
    const market = await opened();
    const old = (await readMarketMakerRuntime(t.db, market.id))!;
    const stop = await request(market.id, { action: 'stop' });
    await approve(stop.id);
    const resume = await request(market.id, { action: 'resume' });
    await approve(resume.id);
    const before = await readMarketMakerRuntime(t.db, market.id);
    const late = await t.db.transaction((tx) =>
      recordMarketMakerRun(tx, {
        marketId: market.id,
        generation: old.generation,
        controlGeneration: old.controlGeneration,
        outcome: 'error',
        error: 'late old attempt',
        retryExhausted: true,
        startedAt: old.createdAt,
      }),
    );
    expect(late?.stale).toBe(true);
    expect(await readMarketMakerRuntime(t.db, market.id)).toEqual(before);
  });

  it('rejects forged aggregate evidence and preserves pending status and every asset', async () => {
    const market = await opened();
    await fundTestTreasury(t.db, 1000n);
    const valid = await request(market.id, increase());
    const payload = valid.payload as { demandSnapshot: Record<string, unknown> };
    const forged = await createApprovalRequest(t.db, {
      kind: MARKET_MAKER_CONTROL_KIND,
      targetType: 'market',
      targetId: market.id,
      requestedBy: asker,
      payload: { ...payload, demandSnapshot: { ...payload.demandSnapshot, fillCount: '1' } },
    });
    const before = await state(market.id);
    await expect(approve(forged.id)).rejects.toBeDefined();
    expect(await state(market.id)).toEqual(before);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, forged.id)))[0]
        ?.status,
    ).toBe('pending');
  });
  it('rejects a control after terminal close and leaves recall and settlement work untouched', async () => {
    const market = await opened();
    const r = await request(market.id, { action: 'stop' });
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    const before = await state(market.id);
    await expect(approve(r.id)).rejects.toMatchObject({ code: 'state' });
    expect(await state(market.id)).toEqual(before);
  });

  it('captures exact human pair-mint legs and does not append later fills to fixed demand evidence', async () => {
    const market = await opened();
    const a = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const b = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: a,
      outcome: 'NO',
      limitPriceCoin: 60,
      qty: 2,
    });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: b,
      outcome: 'YES',
      limitPriceCoin: 40,
      qty: 2,
    });
    const to = await t.db.transaction((tx) => clockTimestamp(tx));
    const change = increase();
    if (change.action !== 'increase') throw new Error('increase fixture');
    change.demand.to = to.toISOString();
    const r = await request(market.id, change);
    expect(r.payload).toMatchObject({
      demandSnapshot: {
        fillCount: '1',
        humanHumanFillCount: '1',
        humanMakerFillCount: '0',
        distinctHumanAccounts: '2',
        humanBuyQty: '4',
        humanBuyCoin: '200',
        humanSellQty: '0',
      },
    });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: a,
      outcome: 'NO',
      limitPriceCoin: 60,
      qty: 1,
    });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: b,
      outcome: 'YES',
      limitPriceCoin: 40,
      qty: 1,
    });
    await fundTestTreasury(t.db, 1000n);
    await approve(r.id);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.id)))[0]?.payload,
    ).toEqual(r.payload);
  });
});
