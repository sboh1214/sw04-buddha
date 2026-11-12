import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  clockTimestamp,
  decideMarketDispute,
  lockAdminRoles,
  lockMarket,
  readLiveBook,
  readMarketMakerRiskSnapshot,
  readMarketMakerRuntime,
  readPublicJudgementDelay,
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  schema,
  submitMarketDispute,
  type Db,
} from '@buddha/db';
import {
  checkOrderInvariants,
  closeMarketEarly,
  closeTestMarket,
  connectTestDb,
  createCorrectedMarket,
  createJudgementDelay,
  createMarketPause,
  createOpenedMarket,
  createProvisionalMarket,
  createUser,
  hasTestDb,
  ledgerSupply,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  resolveMarketNow,
  setReleaseSetting,
  type PlaceTestOrderInput,
  type TestDb,
} from '@buddha/db/test';
import { bookDepth, botRisk, CONTRACT_TERMS, type Outcome } from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeMarket } from './market-finalize.js';
import { recallMarketMaker } from './market-maker-recall.js';
import { refreshMarketMaker } from './market-maker.js';
import { resolveMarket } from './market-resolve.js';
import type { EnqueueMarketMaker } from '../market-maker-jobs.js';
import type { Publish } from '../realtime.js';

// Consume #71's versioned input artifact, with runtime validation. Importing its executable
// model would couple this service proof to the simulation and cross the worker's TS root.
const inputCoin = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(BigInt);
const candidatesSchema = z.object({
  candidates: z
    .array(
      z
        .object({
          id: z.string(),
          startCoin: inputCoin,
          budgetCoin: inputCoin,
          maxLossCoin: inputCoin,
          b: z.number().positive(),
          levels: z.number().int().positive(),
          quantity: z.number().int().positive(),
          safetyTicks: z.number().int().nonnegative(),
          protectionTicks: z.number().int().min(1).max(98),
          reduceAtBp: z.number().int().min(0).max(10000),
          haltAtBp: z.number().int().min(0).max(10000),
          reduceRatioBp: z.number().int().min(0).max(5000),
        })
        .strict(),
    )
    .nonempty(),
});
const CANDIDATES = candidatesSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../docs/research/71-economic-simulation/results/inputs.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as unknown,
).candidates;

// Small functional fixtures, not a release choice. #133's approved values must be rerun for #149.
// The nearly flat curve isolates inventory accumulation from a moving price; #71 compares b.
const SETTINGS = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const LIMITS = {
  maxLoss: SETTINGS.maxLossCoin,
  reduceAtBp: 7000,
  haltAtBp: 9000,
  reduceRatioBp: 5000,
};
const logger = pino({ level: 'silent' });

// Optional local evidence, never a performance assertion or a continuous-time outage estimate.
interface Observation {
  scenario: string;
  settings?: typeof SETTINGS;
  limits?: typeof LIMITS;
  protectionTicks?: number;
  checkpoints: number;
  openSamples: number;
  openMissingAskSamples: number;
  minPostedSpreadCoin: number | null;
  maxPostedSpreadCoin: number | null;
  maxHeldLossCoin: bigint;
  maxReservedLossCoin: bigint;
  orders: number;
  requestedQty: number;
  filledQty: number;
  maxOrderElapsedMs: number;
  cycles: number;
  maxCycleElapsedMs: number;
}
const observations: Observation[] = [];
let observed: Observation;

describe.skipIf(!hasTestDb())('eight operating MM service scenarios (#131)', () => {
  let t: TestDb;
  let adminId: string;
  const publish = vi.fn<Publish>().mockResolvedValue(undefined);
  const enqueue = vi.fn<EnqueueMarketMaker>().mockResolvedValue(undefined);
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
    if (process.env.MM_SCENARIO_OBSERVATIONS === '1') {
      process.stdout.write(
        `MM_SCENARIO_OBSERVATIONS=${JSON.stringify(observations, (_, value: unknown) =>
          typeof value === 'bigint' ? String(value) : value,
        )}\n`,
      );
    }
  });
  beforeEach(async ({ task }) => {
    observed = {
      scenario: task.name,
      checkpoints: 0,
      openSamples: 0,
      openMissingAskSamples: 0,
      minPostedSpreadCoin: null,
      maxPostedSpreadCoin: null,
      maxHeldLossCoin: 0n,
      maxReservedLossCoin: 0n,
      orders: 0,
      requestedQty: 0,
      filledQty: 0,
      maxOrderElapsedMs: 0,
      cycles: 0,
      maxCycleElapsedMs: 0,
    };
    observations.push(observed);
    await t.reset();
    publish.mockClear();
    enqueue.mockClear();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  async function setup(settings = SETTINGS, limits = LIMITS, protectionTicks = 98) {
    Object.assign(observed, { settings, limits, protectionTicks });
    const people: string[] = [];
    for (let i = 0; i < 4; i++)
      people.push((await createUser(t.db, { balanceCoin: 100_000n })).user.id);
    // The factory creates explicit test treasury funding and approved review records; opening,
    // allocation, runtime, matching, worker, payout and recall below are production functions.
    for (const [key, value] of [
      ['market_maker.reduce_at_bp', limits.reduceAtBp],
      ['market_maker.halt_at_bp', limits.haltAtBp],
      ['market_maker.reduce_ratio_bp', limits.reduceRatioBp],
    ] as const)
      await setReleaseSetting(t.db, { adminId, key, value, status: 'test' });
    const { market } = await createOpenedMarket(t.db, {
      liquiditySettings: settings,
      priceProtectionTicks: protectionTicks,
    });
    const supply = await ledgerSupply(t.db);
    const cycle = async () => {
      const start = performance.now();
      const result = await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
      observed.cycles++;
      observed.maxCycleElapsedMs = Math.max(observed.maxCycleElapsedMs, performance.now() - start);
      return result;
    };
    const state = async () => {
      const snapshot = await readMarketMakerRiskSnapshot(t.db, market.id);
      expect(snapshot.kind).toBe('ready');
      if (snapshot.kind !== 'ready') throw new Error('Missing scenario risk snapshot');
      return {
        snapshot,
        risk: botRisk(snapshot.book, snapshot.liveOrders, limits, CONTRACT_TERMS),
      };
    };
    const checkpoint = async () => {
      expect(await checkOrderInvariants(t.db)).toEqual([]);
      expect(await ledgerSupply(t.db)).toEqual(supply);
      const bad = await t.db
        .select({ id: schema.balances.accountId })
        .from(schema.balances)
        .where(sql`${schema.balances.availableCoin}<0 OR ${schema.balances.lockedCoin}<0`);
      expect(bad).toEqual([]);
      const { risk } = await state();
      expect(risk.worstLoss).toBeLessThanOrEqual(settings.maxLossCoin);
      expect(risk.reservedWorstLoss).toBeLessThanOrEqual(settings.maxLossCoin);
      observed.checkpoints++;
      if (risk.worstLoss > observed.maxHeldLossCoin) observed.maxHeldLossCoin = risk.worstLoss;
      if (risk.reservedWorstLoss > observed.maxReservedLossCoin)
        observed.maxReservedLossCoin = risk.reservedWorstLoss;
      const [current] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id));
      if (current?.status === 'open' && current.closeAt > new Date()) {
        observed.openSamples++;
        // Physical posted book only: no owner-specific holding eligibility or SLA inference.
        const depth = bookDepth(await readLiveBook(t.db, market.id));
        if (depth.some((side) => side.bestAskCoin === null)) observed.openMissingAskSamples++;
        for (const side of depth) {
          if (side.bestAskCoin === null || side.bestBidCoin === null) continue;
          const spread = side.bestAskCoin - side.bestBidCoin;
          observed.minPostedSpreadCoin = Math.min(observed.minPostedSpreadCoin ?? spread, spread);
          observed.maxPostedSpreadCoin = Math.max(observed.maxPostedSpreadCoin ?? spread, spread);
        }
      }
      return risk;
    };
    const order = async (input: Omit<PlaceTestOrderInput, 'marketId'>) => {
      const terms = { ...input, marketId: market.id, requestId: input.requestId ?? randomUUID() };
      const start = performance.now();
      const placed = await placeTestOrder(t.db, terms);
      observed.maxOrderElapsedMs = Math.max(observed.maxOrderElapsedMs, performance.now() - start);
      expect(placed.kind).toBe('placed');
      if (placed.kind !== 'placed') throw new Error(`Unexpected intake ${placed.kind}`);
      observed.orders++;
      observed.requestedQty += terms.qty ?? 1;
      observed.filledQty += placed.order.filledQty;
      await checkpoint();
      const rows = await t.db
        .select()
        .from(schema.ledgerEntries)
        .orderBy(asc(schema.ledgerEntries.id));
      const fills = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
      expect(await placeTestOrder(t.db, terms)).toEqual({ kind: 'replayed', order: placed.order });
      expect(
        await t.db.select().from(schema.ledgerEntries).orderBy(asc(schema.ledgerEntries.id)),
      ).toEqual(rows);
      expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(fills);
      return placed;
    };
    const buy = (outcome: Outcome, qty: number, person = 0) =>
      order({
        ownerId: people[person]!,
        outcome,
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: 99,
        qty,
      });
    const finishAudit = async () => {
      const result = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      expect(result.result.passed, JSON.stringify(result.result)).toBe(true);
      expect(result.hold).toBeNull();
      for (const userId of people) {
        const row = await t.db.transaction((tx) =>
          runAccountReconciliation(tx, { userId }, { source: 'manual' }),
        );
        expect(row.result.passed).toBe(true);
        expect(row.hold).toBeNull();
      }
      expect(
        (await t.db.transaction((tx) => runSupplyReconciliation(tx, { source: 'manual' }))).result
          .passed,
      ).toBe(true);
      await checkpoint();
    };
    await cycle();
    await checkpoint();
    return { market, people, cycle, state, checkpoint, order, buy, finishAudit };
  }

  it('balanced small buys keep collateral, locks and every result conserved through burns', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) {
      expect((await s.buy('YES', 2, 0)).order.filledQty).toBe(2);
      await s.cycle();
      await s.checkpoint();
      expect((await s.buy('NO', 2, 1)).order.filledQty).toBe(2);
      await s.cycle();
      await s.checkpoint();
    }
    const { snapshot } = await s.state();
    expect(snapshot.book.yesQty).toBe(0);
    expect(snapshot.book.noQty).toBe(0);
    expect(
      (
        await t.db
          .select()
          .from(schema.ledgerEntries)
          .where(eq(schema.ledgerEntries.type, 'PAIR_BURN_RETURN'))
      ).length,
    ).toBeGreaterThan(0);
    await s.finishAudit();
  });

  it.each(CANDIDATES)(
    'replays #71 $id curve/ladder/risk settings through the real operating service',
    async (candidate) => {
      const s = await setup(
        {
          budgetCoin: candidate.budgetCoin,
          maxLossCoin: candidate.maxLossCoin,
          b: candidate.b,
          levels: candidate.levels,
          quantity: candidate.quantity,
          safetyTicks: candidate.safetyTicks,
        },
        {
          maxLoss: candidate.maxLossCoin,
          reduceAtBp: candidate.reduceAtBp,
          haltAtBp: candidate.haltAtBp,
          reduceRatioBp: candidate.reduceRatioBp,
        },
        candidate.protectionTicks,
      );
      // Wallets deliberately have enough test funds: this isolates service behavior for each
      // candidate's MM settings; the S/population tradeoff remains #71's separate simulation.
      for (const [outcome, person] of [
        ['YES', 0],
        ['NO', 1],
        ['YES', 2],
        ['NO', 3],
      ] as const) {
        expect((await s.buy(outcome, 1, person)).order.filledQty).toBe(1);
        await s.cycle();
        await s.checkpoint();
      }
      await s.finishAudit();
    },
  );

  it('one-way actual fills cross normal/reduce/halt without changing stage settings or L', async () => {
    const s = await setup();
    const stages = new Set<string>();
    for (let i = 0; i < 50; i++) {
      stages.add((await s.state()).risk.stage);
      await s.buy('YES', 10);
      await s.cycle();
      await s.checkpoint();
      if ((await s.state()).risk.stage === 'halt') break;
    }
    stages.add((await s.state()).risk.stage);
    expect(stages).toEqual(new Set(['normal', 'reduce', 'halt']));
    const before = await s.state();
    expect((await s.buy('YES', 100)).order.filledQty).toBe(0);
    expect((await s.state()).snapshot.book).toEqual(before.snapshot.book);
    // The opposite direction can still reduce the accumulated risk and release paired assets.
    expect((await s.buy('NO', 2, 1)).order.filledQty).toBeGreaterThan(0);
    expect((await s.state()).risk.worstLoss).toBeLessThan(before.risk.worstLoss);
    await s.finishAudit();
  }, 60_000);

  it.each([1, 20])(
    'a whale split into %i submissions cannot evade the common cumulative limit',
    async (parts) => {
      const s = await setup();
      let filled = 0;
      for (let i = 0; i < parts; i++) {
        filled += (await s.buy('YES', 200 / parts)).order.filledQty;
        await s.cycle();
        await s.checkpoint();
      }
      expect(filled).toBeGreaterThan(0);
      expect((await s.state()).risk.worstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
      // Different refresh opportunities may fill different quantities/prices; safety is shared.
      await s.finishAudit();
    },
  );

  it('news-time committed fills survive a real pause and no later order fills', async () => {
    const s = await setup();
    await s.buy('YES', 3);
    const before = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
    await createMarketPause(t.db, { marketId: s.market.id, reason: 'early_result' });
    const refused = await placeTestOrder(t.db, {
      marketId: s.market.id,
      ownerId: s.people[1]!,
      qty: 10,
      limitPriceCoin: 99,
      timeInForce: 'ioc',
    });
    expect(refused.kind).toBe('placed');
    if (refused.kind === 'placed') expect(refused.order.filledQty).toBe(0);
    await s.cycle();
    expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(before);
    await s.finishAudit();
  });

  it('stale quotes accept concurrent directions only against the latest locked assets', async () => {
    const s = await setup();
    await s.buy('YES', 2, 0);
    await s.cycle();
    await s.buy('NO', 2, 1);
    await s.cycle();
    const generation = (await readMarketMakerRuntime(t.db, s.market.id))!.completedGeneration;
    // Deliberately withhold the worker while four actual transactions race. These committed
    // results are checked together after all settle, not against a torn mid-transaction read.
    const directions = [
      {
        ownerId: s.people[0]!,
        outcome: 'YES' as const,
        side: 'sell' as const,
        limitPriceCoin: 1,
        qty: 2,
      },
      {
        ownerId: s.people[1]!,
        outcome: 'NO' as const,
        side: 'sell' as const,
        limitPriceCoin: 1,
        qty: 2,
      },
      {
        ownerId: s.people[2]!,
        outcome: 'YES' as const,
        side: 'buy' as const,
        limitPriceCoin: 99,
        qty: 20,
      },
      {
        ownerId: s.people[3]!,
        outcome: 'NO' as const,
        side: 'buy' as const,
        limitPriceCoin: 99,
        qty: 20,
      },
    ];
    const requests = directions.map((x) => ({
      ...x,
      marketId: s.market.id,
      timeInForce: 'ioc' as const,
      requestId: randomUUID(),
    }));
    let checkedTransactions = 0;
    const checkedDb = new Proxy(t.db, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
        return (callback: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const value = await callback(tx);
            // The intake still holds the market lock: inspect each transaction's own final
            // assets before COMMIT, so another fill cannot hide a transient limit breach.
            const snapshot = await readMarketMakerRiskSnapshot(tx, s.market.id);
            expect(snapshot.kind).toBe('ready');
            if (snapshot.kind !== 'ready') throw new Error('Missing locked risk snapshot');
            const risk = botRisk(snapshot.book, snapshot.liveOrders, LIMITS, CONTRACT_TERMS);
            expect(risk.worstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
            expect(risk.reservedWorstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
            // ledgerSupply only SELECTs; adapt its pooled-reader type to this transaction.
            const supply = await ledgerSupply(tx as unknown as Db);
            expect(supply.heldCoin).toBe(supply.carriedCoin);
            expect(supply.carriedCoin).toBe(supply.mintedCoin - supply.burnedCoin);
            expect(
              await tx
                .select({ id: schema.balances.accountId })
                .from(schema.balances)
                .where(sql`${schema.balances.availableCoin}<0 OR ${schema.balances.lockedCoin}<0`),
            ).toEqual([]);
            checkedTransactions++;
            return value;
          });
      },
    });
    const results = await Promise.all(requests.map((x) => placeTestOrder(checkedDb, x)));
    expect(checkedTransactions).toBe(4);
    expect(results.every((x) => x.kind === 'placed')).toBe(true);
    const runtime = (await readMarketMakerRuntime(t.db, s.market.id))!;
    expect(runtime.completedGeneration).toBe(generation);
    expect(runtime.generation).toBeGreaterThan(generation);
    await s.checkpoint();
    const fills = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
    expect(
      (await Promise.all(requests.map((x) => placeTestOrder(t.db, x)))).every(
        (x) => x.kind === 'replayed',
      ),
    ).toBe(true);
    expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(fills);
    await Promise.all([s.cycle(), s.cycle()]);
    await s.finishAudit();
  });

  it('human-to-human fills preserve the funded MM inventory, capital and dirty generation', async () => {
    const s = await setup();
    const before = (await s.state()).snapshot.book;
    const runtime = await readMarketMakerRuntime(t.db, s.market.id);
    await s.order({
      ownerId: s.people[0]!,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 51,
      qty: 2,
    });
    const trade = await s.order({
      ownerId: s.people[1]!,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 49,
      qty: 2,
    });
    expect(trade.order.filledQty).toBe(2);
    expect((await s.state()).snapshot.book).toEqual(before);
    expect(await readMarketMakerRuntime(t.db, s.market.id)).toEqual(runtime);
    await s.finishAudit();
  });

  it('a partial human fill stops at the next own order without touching later MM liquidity', async () => {
    const s = await setup();
    const before = (await s.state()).snapshot.book;
    await s.order({
      ownerId: s.people[1]!,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 51,
      qty: 1,
    });
    await s.order({
      ownerId: s.people[0]!,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 51,
      qty: 1,
    });
    const result = await s.order({
      ownerId: s.people[0]!,
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 60,
      qty: 4,
    });
    expect(result.order).toMatchObject({
      filledQty: 1,
      status: 'cancelled',
      cancelReason: 'self_trade',
    });
    expect((await s.state()).snapshot.book).toEqual(before);
    await s.finishAudit();
  });

  it('cancels a market with no human fill, releases reservations and recalls the original capital', async () => {
    const s = await setup();
    await s.order({
      ownerId: s.people[0]!,
      outcome: 'YES',
      side: 'buy',
      qty: 2,
      limitPriceCoin: 1,
    });
    expect(await t.db.select().from(schema.fills)).toEqual([]);
    expect((await readLiveBook(t.db, s.market.id)).length).toBeGreaterThan(0);
    await passMarketClose(t.db, s.market.id);
    await closeTestMarket(t.db, s.market.id);
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, s.market.id));
    expect(market).toMatchObject({ status: 'cancelled', resolvedResult: null });
    expect(await readLiveBook(t.db, s.market.id)).toEqual([]);
    await Promise.all([
      recallMarketMaker(t.db, s.market.id, logger),
      recallMarketMaker(t.db, s.market.id, logger),
    ]);
    const recalls = await t.db.select().from(schema.marketMakerRecalls);
    expect(recalls).toHaveLength(1);
    expect(recalls[0]!.amountCoin).toBe(SETTINGS.budgetCoin);
    expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
    await s.finishAudit();
  });

  it('keeps a delayed source CLOSED with its public next review, then settles the eventual YES', async () => {
    const s = await setup();
    await s.buy('YES', 2);
    await passMarketClose(t.db, s.market.id);
    await closeTestMarket(t.db, s.market.id);
    // Move only the fixture's schedule as elapsed time would; production delay never edits it.
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('buddha.rule_supplement', ${s.market.id}, true)`);
      await tx
        .update(schema.markets)
        .set({
          eventDeadline: new Date(Date.now() - 45_000),
          scheduledJudgementAt: new Date(Date.now() - 30_000),
        })
        .where(eq(schema.markets.id, s.market.id));
    });
    const { delay } = await createJudgementDelay(t.db, { marketId: s.market.id, by: adminId });
    const [market] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, s.market.id));
    expect(market).toMatchObject({ status: 'closed', resolvedResult: null });
    expect(await readPublicJudgementDelay(t.db, market!)).toMatchObject({
      reason: delay.reason,
      nextReviewAt: delay.nextReviewAt,
    });
    expect(await resolveMarket(t.db, s.market.id, publish, () => Promise.resolve())).toMatchObject({
      outcome: 'skipped',
      reason: 'not_provisional',
    });
    expect(await finalizeMarket(t.db, s.market.id, publish, logger)).toMatchObject({
      outcome: 'skipped',
    });
    expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
    await s.finishAudit();
    await createProvisionalMarket(t.db, {
      marketId: s.market.id,
      result: 'YES',
      disputeWindowMinutes: 1,
    });
    await resolveMarketNow(t.db, s.market.id);
    expect(await finalizeMarket(t.db, s.market.id, publish, logger)).toMatchObject({
      outcome: 'settled',
    });
    const [settled] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, s.market.id));
    expect(settled).toMatchObject({ status: 'settled', resolvedResult: 'YES' });
    const [claim] = await t.db
      .select()
      .from(schema.positionSettlements)
      .where(eq(schema.positionSettlements.userId, s.people[0]!));
    expect(claim!.payoutCoin).toBe(200n);
    await recallMarketMaker(t.db, s.market.id, logger);
    expect(await t.db.select().from(schema.marketMakerRecalls)).toHaveLength(1);
    await s.finishAudit();
  });

  it.each(['dismiss', 'accept'] as const)(
    'holds payment for a real dispute, then follows %s to the final version',
    async (decision) => {
      const s = await setup();
      await s.buy('YES', 2);
      await closeMarketEarly(t.db, s.market.id, {
        humanFill: false,
        pause: { reason: 'early_result' },
      });
      await createProvisionalMarket(t.db, {
        marketId: s.market.id,
        result: 'YES',
        disputeWindowMinutes: 1,
      });
      const submitted = await t.db.transaction(async (tx) => {
        await lockMarket(tx, s.market.id);
        const [market] = await tx
          .select()
          .from(schema.markets)
          .where(eq(schema.markets.id, s.market.id))
          .for('update');
        await tx
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.userId, s.people[0]!))
          .for('key share');
        return submitMarketDispute(tx, {
          market: market!,
          userId: s.people[0]!,
          judgementVersion: market!.judgementVersion!,
          links: ['https://example.com/scenario-evidence'],
          reason: '원문 결과를 재확인해야 합니다.',
          now: await clockTimestamp(tx),
        });
      });
      expect(submitted.created).toBe(true);
      if (!submitted.created) throw new Error('Dispute was refused');
      // The deadline elapses. A pending dispute must still block real confirmation and payout.
      await t.db
        .update(schema.markets)
        .set({ disputeDeadline: new Date(Date.now() - 1_000) })
        .where(eq(schema.markets.id, s.market.id));
      const held = () => resolveMarket(t.db, s.market.id, publish, () => Promise.resolve());
      expect(await held()).toMatchObject({ outcome: 'skipped', reason: 'held' });
      expect(await finalizeMarket(t.db, s.market.id, publish, logger)).toMatchObject({
        outcome: 'skipped',
      });
      expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
      await s.finishAudit();
      const decided = await t.db.transaction(async (tx) => {
        await lockMarket(tx, s.market.id);
        const [market] = await tx
          .select()
          .from(schema.markets)
          .where(eq(schema.markets.id, s.market.id))
          .for('update');
        await lockAdminRoles(tx, 'shared');
        const [dispute] = await tx
          .select()
          .from(schema.marketDisputes)
          .where(eq(schema.marketDisputes.id, submitted.dispute.id))
          .for('update');
        return decideMarketDispute(tx, {
          market: market!,
          dispute: dispute!,
          adminId,
          decision,
          reason: '원문과 판정 근거를 검토했습니다.',
          now: await clockTimestamp(tx),
        });
      });
      expect(decided.decided).toBe(true);
      if (decision === 'accept') {
        expect(await held()).toMatchObject({ outcome: 'skipped', reason: 'held' });
        await createCorrectedMarket(t.db, { marketId: s.market.id, result: 'NO' });
        expect(await held()).toMatchObject({ outcome: 'skipped', reason: 'not_due' });
        await resolveMarketNow(t.db, s.market.id);
      } else {
        expect(await held()).toMatchObject({ outcome: 'resolved', resolvedResult: 'YES' });
      }
      await Promise.all([
        finalizeMarket(t.db, s.market.id, publish, logger),
        finalizeMarket(t.db, s.market.id, publish, logger),
      ]);
      const [market] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, s.market.id));
      expect(market).toMatchObject({
        status: 'settled',
        resolvedResult: decision === 'accept' ? 'NO' : 'YES',
      });
      const [claim] = await t.db
        .select()
        .from(schema.positionSettlements)
        .where(eq(schema.positionSettlements.userId, s.people[0]!));
      expect(claim!.payoutCoin).toBe(decision === 'accept' ? 0n : 200n);
      await recallMarketMaker(t.db, s.market.id, logger);
      await s.finishAudit();
    },
  );

  it.each(['YES', 'NO', 'VOID'] as const)(
    'closes and settles operating holdings %s exactly once, then recalls once',
    async (result) => {
      const s = await setup();
      await s.buy('YES', 3);
      await s.cycle();
      await s.buy('NO', 1, 1);
      // Compare every stored field by its key; PostgreSQL does not promise physical row order.
      const claims = await t.db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.marketId, s.market.id))
        .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome));
      const fills = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
      await passMarketClose(t.db, s.market.id);
      await Promise.all([
        closeTestMarket(t.db, s.market.id),
        s.cycle(),
        placeTestOrder(t.db, {
          marketId: s.market.id,
          ownerId: s.people[2]!,
          qty: 50,
          limitPriceCoin: 99,
          timeInForce: 'ioc',
        }),
      ]);
      expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(fills);
      expect(await readLiveBook(t.db, s.market.id)).toEqual([]);
      await s.checkpoint();
      await createProvisionalMarket(t.db, {
        marketId: s.market.id,
        result,
        disputeWindowMinutes: 1,
      });
      await resolveMarketNow(t.db, s.market.id);
      // Fail after the real payout callback wrote its rows but before COMMIT. The initial
      // settling transition may commit; payout/retirement must roll back as one unit.
      let injected = false;
      const failing = new Proxy(t.db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
          return (callback: Parameters<Db['transaction']>[0]) =>
            target.transaction(async (tx) => {
              const value = await callback(tx);
              const payouts = await tx
                .select({ id: schema.ledgerEntries.id })
                .from(schema.ledgerEntries)
                .where(eq(schema.ledgerEntries.type, 'SETTLEMENT_PAYOUT'));
              if (!injected && payouts.length) {
                injected = true;
                throw new Error('scenario before COMMIT');
              }
              return value;
            });
        },
      });
      await expect(finalizeMarket(failing, s.market.id, publish, logger)).rejects.toThrow(
        'scenario before COMMIT',
      );
      expect(injected).toBe(true);
      expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
      expect(
        await t.db
          .select()
          .from(schema.positions)
          .where(eq(schema.positions.marketId, s.market.id))
          .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome)),
      ).toEqual(claims);
      expect(
        await t.db
          .select()
          .from(schema.ledgerEntries)
          .where(eq(schema.ledgerEntries.type, 'SETTLEMENT_PAYOUT')),
      ).toEqual([]);
      await s.checkpoint();
      await Promise.all([
        finalizeMarket(t.db, s.market.id, publish, logger),
        finalizeMarket(t.db, s.market.id, publish, logger),
      ]);
      const settled = await t.db
        .select()
        .from(schema.positionSettlements)
        .where(eq(schema.positionSettlements.marketId, s.market.id))
        .orderBy(asc(schema.positionSettlements.userId), asc(schema.positionSettlements.outcome));
      const [finalMarket] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, s.market.id));
      expect(finalMarket).toMatchObject({ status: 'settled', resolvedResult: result });
      expect(settled).toHaveLength(claims.filter((p) => p.qty > 0).length);
      for (const claim of settled) {
        const original = claims.find(
          (p) => p.userId === claim.userId && p.outcome === claim.outcome,
        )!;
        expect(claim.payoutCoin).toBe(
          BigInt(original.qty) *
            BigInt(result === 'VOID' ? 50 : result === claim.outcome ? 100 : 0),
        );
      }
      const before = await t.db
        .select()
        .from(schema.ledgerEntries)
        .orderBy(asc(schema.ledgerEntries.id));
      await finalizeMarket(t.db, s.market.id, publish, logger);
      expect(
        await t.db.select().from(schema.ledgerEntries).orderBy(asc(schema.ledgerEntries.id)),
      ).toEqual(before);
      await Promise.all([
        recallMarketMaker(t.db, s.market.id, logger),
        recallMarketMaker(t.db, s.market.id, logger),
      ]);
      expect(await t.db.select().from(schema.marketMakerRecalls)).toHaveLength(1);
      const recalled = await t.db
        .select()
        .from(schema.ledgerEntries)
        .orderBy(asc(schema.ledgerEntries.id));
      await recallMarketMaker(t.db, s.market.id, logger);
      expect(
        await t.db.select().from(schema.ledgerEntries).orderBy(asc(schema.ledgerEntries.id)),
      ).toEqual(recalled);
      expect(
        await t.db
          .select()
          .from(schema.positionSettlements)
          .where(eq(schema.positionSettlements.marketId, s.market.id))
          .orderBy(asc(schema.positionSettlements.userId), asc(schema.positionSettlements.outcome)),
      ).toEqual(settled);
      await s.finishAudit();
    },
  );
});
