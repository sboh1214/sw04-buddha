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
  runMarketMakerCycle,
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
import {
  bookDepth,
  botRisk,
  CONTRACT_TERMS,
  quoteLadder,
  type MarketJobData,
  type MarketMakerJobData,
  type Outcome,
} from '@buddha/shared';
import { MemoryObjectStorage } from '@buddha/storage';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessor } from './index.js';
import { finalizeMarket } from './market-finalize.js';
import { recallMarketMaker } from './market-maker-recall.js';
import { refreshMarketMaker } from './market-maker.js';
import { resolveMarket } from './market-resolve.js';
import { createEnqueueFinalize } from '../market-jobs.js';
import { createEnqueueMarketMaker, type EnqueueMarketMaker } from '../market-maker-jobs.js';
import { DEFAULT_JOB_OPTIONS } from '../queues.js';
import type { Publish } from '../realtime.js';

/*
 * #333 (ADR-0173, owner answers 333-2..333-4): the launch bundle C5 the owner chose (133-33) run
 * through the real operating service — order intake, matching, MM refresh, close, judgement and
 * dispute, confirmation, settlement, recall and #93 reconciliation on PostgreSQL, and the real
 * BullMQ producer and dispatcher for the retries. The helpers are copied from
 * market-maker-scenarios.test.ts (#131), which is left as it is with its own fixture and
 * expectations. Every expectation below follows from C5's values and the contract terms; a
 * failing one is a #333 failure to report (333-3), never an expectation to loosen.
 * Quality (spread, missing asks, elapsed time) is only observed — no threshold (ADR-0128 결정 4).
 */

// C5 by id from #71's versioned input artifact, schema-checked; no value is retyped here.
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
const C5 = candidatesSchema
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../docs/research/71-economic-simulation/results/inputs.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown,
  )
  .candidates.find((candidate) => candidate.id === 'C5');
if (!C5) throw new Error('#71 inputs.json has no candidate C5');

const SETTINGS = {
  budgetCoin: C5.budgetCoin,
  maxLossCoin: C5.maxLossCoin,
  b: C5.b,
  levels: C5.levels,
  quantity: C5.quantity,
  safetyTicks: C5.safetyTicks,
};
const LIMITS = {
  maxLoss: C5.maxLossCoin,
  reduceAtBp: C5.reduceAtBp,
  haltAtBp: C5.haltAtBp,
  reduceRatioBp: C5.reduceRatioBp,
};
const PROTECTION_TICKS = C5.protectionTicks;
// 333-4: wallets as in the #131 fixtures, so the MM settings are what is exercised; S and the
// population are #71's (ADR-0128 결정 4). Not C5's S.
const WALLET_COIN = 100_000n;
// What C5's bot posts at an even book (d = 0): a fill of up to the smaller first level's
// quantity takes that level alone, at the reference price itself, so price protection (a width
// from that reference) cannot cut it. The sizes the scenarios trade are checked against it.
const OPENING = quoteLadder(0, SETTINGS, CONTRACT_TERMS);
const FIRST_LEVEL_QTY = Math.min(OPENING.yesBids[0]?.qty ?? 0, OPENING.noBids[0]?.qty ?? 0);
const PAYOUT = BigInt(CONTRACT_TERMS.payoutCoin);
const VOID_PAYOUT = PAYOUT / 2n;
const logger = pino({ level: 'silent' });

// Optional local evidence, never a performance assertion or a continuous-time outage estimate.
interface Observation {
  scenario: string;
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

describe.skipIf(!hasTestDb())(
  'the chosen launch bundle C5 through the operating service (#333)',
  () => {
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
          `MM_LAUNCH_VALUE_OBSERVATIONS=${JSON.stringify(
            { candidate: C5, observations },
            (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
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

    /** ADR-0128 결정 2's mandatory checks at a stable point, for the given markets' risk. */
    async function invariants(supply: Awaited<ReturnType<typeof ledgerSupply>>) {
      // Collateral = unsettled pairs × 100, ledger supply only through mint/burn, fills = orders.
      expect(await checkOrderInvariants(t.db)).toEqual([]);
      expect(await ledgerSupply(t.db)).toEqual(supply);
      const bad = await t.db
        .select({ id: schema.balances.accountId })
        .from(schema.balances)
        .where(sql`${schema.balances.availableCoin}<0 OR ${schema.balances.lockedCoin}<0`);
      expect(bad).toEqual([]);
    }

    /** The #93 reconciliation of every market, of each person and of the supply: pass, no hold. */
    async function reconcile(marketIds: string[], people: string[]) {
      for (const marketId of marketIds) {
        const result = await t.db.transaction((tx) =>
          runMarketReconciliation(tx, marketId, { source: 'manual' }),
        );
        expect(result.result.passed, JSON.stringify(result.result)).toBe(true);
        expect(result.hold).toBeNull();
      }
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
    }

    async function setup() {
      const people: string[] = [];
      for (let i = 0; i < 4; i++)
        people.push((await createUser(t.db, { balanceCoin: WALLET_COIN })).user.id);
      // The factory creates explicit test treasury funding and approved review records; opening,
      // allocation, runtime, matching, worker, payout and recall below are production functions.
      for (const [key, value] of [
        ['market_maker.reduce_at_bp', LIMITS.reduceAtBp],
        ['market_maker.halt_at_bp', LIMITS.haltAtBp],
        ['market_maker.reduce_ratio_bp', LIMITS.reduceRatioBp],
      ] as const)
        await setReleaseSetting(t.db, { adminId, key, value, status: 'test' });
      const { market } = await createOpenedMarket(t.db, {
        liquiditySettings: SETTINGS,
        priceProtectionTicks: PROTECTION_TICKS,
      });
      const supply = await ledgerSupply(t.db);
      const cycle = async () => {
        const start = performance.now();
        const result = await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
        observed.cycles++;
        observed.maxCycleElapsedMs = Math.max(
          observed.maxCycleElapsedMs,
          performance.now() - start,
        );
        return result;
      };
      const state = async () => {
        const snapshot = await readMarketMakerRiskSnapshot(t.db, market.id);
        expect(snapshot.kind).toBe('ready');
        if (snapshot.kind !== 'ready') throw new Error('Missing scenario risk snapshot');
        return {
          snapshot,
          risk: botRisk(snapshot.book, snapshot.liveOrders, LIMITS, CONTRACT_TERMS),
        };
      };
      const checkpoint = async () => {
        await invariants(supply);
        // Held and reserved risk ≤ L (C5's maxLossCoin).
        const { risk } = await state();
        expect(risk.worstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
        expect(risk.reservedWorstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
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
        observed.maxOrderElapsedMs = Math.max(
          observed.maxOrderElapsedMs,
          performance.now() - start,
        );
        expect(placed.kind).toBe('placed');
        if (placed.kind !== 'placed') throw new Error(`Unexpected intake ${placed.kind}`);
        observed.orders++;
        observed.requestedQty += terms.qty ?? 1;
        observed.filledQty += placed.order.filledQty;
        await checkpoint();
        // The same request ID is processed once: a resend returns the order and changes nothing.
        const rows = await t.db
          .select()
          .from(schema.ledgerEntries)
          .orderBy(asc(schema.ledgerEntries.id));
        const fills = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
        expect(await placeTestOrder(t.db, terms)).toEqual({
          kind: 'replayed',
          order: placed.order,
        });
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
        await reconcile([market.id], people);
        await checkpoint();
      };
      await cycle();
      await checkpoint();
      return { market, people, supply, cycle, state, checkpoint, order, buy, finishAudit };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;

    const positionsOf = (marketId: string) =>
      t.db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.marketId, marketId))
        .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome));
    const settlementsOf = (marketId: string) =>
      t.db
        .select()
        .from(schema.positionSettlements)
        .where(eq(schema.positionSettlements.marketId, marketId))
        .orderBy(asc(schema.positionSettlements.userId), asc(schema.positionSettlements.outcome));
    const ledger = () =>
      t.db.select().from(schema.ledgerEntries).orderBy(asc(schema.ledgerEntries.id));

    /** Each settled claim pays its contracts × 100 / 0 (YES, NO) or × 50 (VOID), exactly once. */
    async function expectPaid(
      s: Setup,
      claims: Awaited<ReturnType<typeof positionsOf>>,
      result: 'YES' | 'NO' | 'VOID',
    ) {
      const [market] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, s.market.id));
      expect(market).toMatchObject({ status: 'settled', resolvedResult: result });
      const settled = await settlementsOf(s.market.id);
      expect(settled).toHaveLength(claims.filter((p) => p.qty > 0).length);
      for (const claim of settled) {
        const original = claims.find(
          (p) => p.userId === claim.userId && p.outcome === claim.outcome,
        )!;
        expect(claim.payoutCoin).toBe(
          BigInt(original.qty) *
            (result === 'VOID' ? VOID_PAYOUT : result === claim.outcome ? PAYOUT : 0n),
        );
      }
      // A later finalize changes nothing; the MM capital is recalled once, a repeat is a no-op.
      const before = await ledger();
      await finalizeMarket(t.db, s.market.id, publish, logger);
      expect(await ledger()).toEqual(before);
      await Promise.all([
        recallMarketMaker(t.db, s.market.id, logger),
        recallMarketMaker(t.db, s.market.id, logger),
      ]);
      expect(await t.db.select().from(schema.marketMakerRecalls)).toHaveLength(1);
      const recalled = await ledger();
      await recallMarketMaker(t.db, s.market.id, logger);
      expect(await ledger()).toEqual(recalled);
      expect(await settlementsOf(s.market.id)).toEqual(settled);
    }

    /** Trade both ways, burn pairs back to an even book, then leave holdings on both sides. */
    async function trade(s: Setup) {
      // One contract always fills from the first level of any C5 ladder (k = 1 is posted while the
      // bot is not halted, and a reference of its own price is inside the protection width).
      for (let i = 0; i < 4; i++) {
        expect((await s.buy('YES', 1, 0)).order.filledQty).toBe(1);
        await s.cycle();
        await s.checkpoint();
        expect((await s.buy('NO', 1, 1)).order.filledQty).toBe(1);
        await s.cycle();
        await s.checkpoint();
      }
      // Each YES the bot bought was paired with a NO it bought: the pairs are burned back.
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
      // The book is even again (d = 0), so C5's opening ladder is posted: 3 ≤ its first level.
      expect((await s.buy('YES', 3, 0)).order.filledQty).toBe(3);
      await s.cycle();
      expect((await s.buy('NO', 1, 1)).order.filledQty).toBe(1);
    }

    it('reads C5 from #71 inputs.json and posts an opening ladder the scenarios can trade', () => {
      expect(C5.id).toBe('C5');
      // The scenarios below buy at most 3 contracts at an even book; C5 posts `quantity` per
      // direction over at most `levels` prices, so its first level must hold them.
      expect(OPENING.yesBids.reduce((n, level) => n + level.qty, 0)).toBeLessThanOrEqual(
        C5.quantity,
      );
      expect(OPENING.yesBids.length).toBeLessThanOrEqual(C5.levels);
      expect(FIRST_LEVEL_QTY).toBeGreaterThanOrEqual(3);
    });

    it.each(['YES', 'NO', 'VOID'] as const)(
      'trades both ways, closes against a racing order and settles %s exactly once after a rolled-back attempt',
      async (result) => {
        const s = await setup();
        await trade(s);
        const claims = await positionsOf(s.market.id);
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
        // No fill after the close.
        expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(fills);
        expect(await readLiveBook(t.db, s.market.id)).toEqual([]);
        await s.checkpoint();
        await createProvisionalMarket(t.db, {
          marketId: s.market.id,
          result,
          disputeWindowMinutes: 1,
        });
        await resolveMarketNow(t.db, s.market.id);
        // Fail after the real payout callback wrote its rows but before COMMIT: payout and
        // retirement roll back as one unit, and the retry pays once.
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
                  throw new Error('launch values before COMMIT');
                }
                return value;
              });
          },
        });
        await expect(finalizeMarket(failing, s.market.id, publish, logger)).rejects.toThrow(
          'launch values before COMMIT',
        );
        expect(injected).toBe(true);
        expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
        expect(await positionsOf(s.market.id)).toEqual(claims);
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
        await expectPaid(s, claims, result);
        await s.finishAudit();
      },
    );

    it('cancels a market with no human fill, releases reservations and recalls C5’s A once', async () => {
      const s = await setup();
      // A bid at the lowest price rests: no MM ask is that low, so nothing fills.
      await s.order({
        ownerId: s.people[0]!,
        outcome: 'YES',
        side: 'buy',
        qty: 2,
        limitPriceCoin: CONTRACT_TERMS.priceMinCoin,
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
      // No fill: the bot's capital is untouched, so the recall is exactly C5's A.
      expect(recalls[0]!.amountCoin).toBe(C5.budgetCoin);
      expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
      await s.finishAudit();
    });

    it('keeps committed fills through an early_result pause and fills nothing after it', async () => {
      const s = await setup();
      expect((await s.buy('YES', 3)).order.filledQty).toBe(3);
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

    it('closes early on an early result and settles the early YES once', async () => {
      const s = await setup();
      expect((await s.buy('YES', 2)).order.filledQty).toBe(2);
      await s.cycle();
      expect((await s.buy('NO', 1, 1)).order.filledQty).toBe(1);
      const claims = await positionsOf(s.market.id);
      const fills = await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id));
      await closeMarketEarly(t.db, s.market.id, {
        humanFill: false,
        pause: { reason: 'early_result' },
      });
      const late = await placeTestOrder(t.db, {
        marketId: s.market.id,
        ownerId: s.people[2]!,
        qty: 5,
        limitPriceCoin: 99,
        timeInForce: 'ioc',
      });
      if (late.kind === 'placed') expect(late.order.filledQty).toBe(0);
      expect(await t.db.select().from(schema.fills).orderBy(asc(schema.fills.id))).toEqual(fills);
      await s.checkpoint();
      await createProvisionalMarket(t.db, {
        marketId: s.market.id,
        result: 'YES',
        disputeWindowMinutes: 1,
      });
      await resolveMarketNow(t.db, s.market.id);
      await Promise.all([
        finalizeMarket(t.db, s.market.id, publish, logger),
        finalizeMarket(t.db, s.market.id, publish, logger),
      ]);
      await expectPaid(s, claims, 'YES');
      await s.finishAudit();
    });

    it('keeps a delayed source CLOSED with its public next review, then settles the eventual YES', async () => {
      const s = await setup();
      expect((await s.buy('YES', 2)).order.filledQty).toBe(2);
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
      // Late is no reason to settle NO or pay anything.
      expect(
        await resolveMarket(t.db, s.market.id, publish, () => Promise.resolve()),
      ).toMatchObject({
        outcome: 'skipped',
        reason: 'not_provisional',
      });
      expect(await finalizeMarket(t.db, s.market.id, publish, logger)).toMatchObject({
        outcome: 'skipped',
      });
      expect(await t.db.select().from(schema.positionSettlements)).toEqual([]);
      await s.finishAudit();
      const claims = await positionsOf(s.market.id);
      await createProvisionalMarket(t.db, {
        marketId: s.market.id,
        result: 'YES',
        disputeWindowMinutes: 1,
      });
      await resolveMarketNow(t.db, s.market.id);
      expect(await finalizeMarket(t.db, s.market.id, publish, logger)).toMatchObject({
        outcome: 'settled',
      });
      const [claim] = await t.db
        .select()
        .from(schema.positionSettlements)
        .where(eq(schema.positionSettlements.userId, s.people[0]!));
      expect(claim!.payoutCoin).toBe(2n * PAYOUT);
      await expectPaid(s, claims, 'YES');
      await s.finishAudit();
    });

    it.each(['dismiss', 'accept'] as const)(
      'holds payment for a real dispute, then follows %s to the final version',
      async (decision) => {
        const s = await setup();
        expect((await s.buy('YES', 2)).order.filledQty).toBe(2);
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
        const claims = await positionsOf(s.market.id);
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
          // Acceptance alone pays nothing; the corrected NO waits for its own dispute window.
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
        await expectPaid(s, claims, decision === 'accept' ? 'NO' : 'YES');
        await s.finishAudit();
      },
    );

    // Like the test database under CI=true (harness.ts), a missing Redis fails instead of
    // skipping: the settlement retry is one of the flows #333 must run (333-2).
    describe.skipIf(!process.env.TEST_REDIS_URL && !process.env.CI)('real BullMQ retries', () => {
      beforeAll(() => {
        if (!process.env.TEST_REDIS_URL) throw new Error('TEST_REDIS_URL is required in CI');
      });
      /** A real queue, its events and a worker running the production dispatcher on `db`. */
      async function realQueue<T>(
        name: 'markets' | 'maker',
        db: Db,
        extra: Partial<Parameters<typeof createProcessor>[0]> = {},
      ) {
        const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
        const prefix = `test-launch-values-${randomUUID()}`;
        const queue = new Queue<T>(name, {
          connection,
          prefix,
          // The production attempts (3); only the wait between them is shortened.
          defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 10 } },
        });
        const events = new QueueEvents(name, { connection, prefix });
        const processor = createProcessor({
          db,
          auditDb: t.db,
          publish,
          enqueueMarketMaker: vi.fn().mockResolvedValue(undefined),
          enqueueFinalize: vi.fn().mockResolvedValue(undefined),
          enqueueMarketMakerRecall: vi.fn().mockResolvedValue(undefined),
          storage: new MemoryObjectStorage(),
          logger,
          ...extra,
        });
        const worker = new Worker(name, processor, { connection, prefix, concurrency: 1 });
        await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
        const close = async () => {
          await worker.close();
          await events.close();
          await queue.obliterate({ force: true });
          await queue.close();
          await connection.quit();
        };
        return { queue, close };
      }

      it('retries a settlement whose first two attempts fail before COMMIT and pays once on the third', async () => {
        const s = await setup();
        await trade(s);
        await passMarketClose(t.db, s.market.id);
        await closeTestMarket(t.db, s.market.id);
        await s.checkpoint();
        const claims = await positionsOf(s.market.id);
        await createProvisionalMarket(t.db, {
          marketId: s.market.id,
          result: 'YES',
          disputeWindowMinutes: 1,
        });
        // Two attempts fail after the real payout callback wrote its rows, before COMMIT; the
        // third (DEFAULT_JOB_OPTIONS.attempts) is let through.
        const failAttempts = DEFAULT_JOB_OPTIONS.attempts - 1;
        let failed = 0;
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
                if (failed < failAttempts && payouts.length) {
                  failed++;
                  throw new Error('launch values settlement before COMMIT');
                }
                return value;
              });
          },
        });
        const { queue, close } = await realQueue<MarketJobData>('markets', failing);
        try {
          // The dispute window elapses; the real confirmation registers `market.finalize` through
          // the production producer on the real queue.
          await t.db
            .update(schema.markets)
            .set({ disputeDeadline: new Date(Date.now() - 1_000) })
            .where(eq(schema.markets.id, s.market.id));
          expect(
            await resolveMarket(t.db, s.market.id, publish, createEnqueueFinalize(queue, logger)),
          ).toMatchObject({ outcome: 'resolved', resolvedResult: 'YES' });
          await vi.waitFor(
            async () => {
              const [market] = await t.db
                .select()
                .from(schema.markets)
                .where(eq(schema.markets.id, s.market.id));
              expect(market!.status).toBe('settled');
            },
            { timeout: 15_000, interval: 50 },
          );
          expect(failed).toBe(failAttempts);
          expect(await queue.getJobCountByTypes('failed')).toBe(0);
        } finally {
          await close();
        }
        await expectPaid(s, claims, 'YES');
        await s.finishAudit();
      }, 30_000);

      it('exhausts three maker attempts, stops only that C5 bot and leaves human trading available', async () => {
        const people: string[] = [];
        for (let i = 0; i < 2; i++)
          people.push((await createUser(t.db, { balanceCoin: WALLET_COIN })).user.id);
        for (const [key, value] of [
          ['market_maker.reduce_at_bp', LIMITS.reduceAtBp],
          ['market_maker.halt_at_bp', LIMITS.haltAtBp],
          ['market_maker.reduce_ratio_bp', LIMITS.reduceRatioBp],
        ] as const)
          await setReleaseSetting(t.db, { adminId, key, value, status: 'test' });
        const opened = () =>
          createOpenedMarket(t.db, {
            liquiditySettings: SETTINGS,
            priceProtectionTicks: PROTECTION_TICKS,
          });
        const market = (await opened()).market;
        const other = (await opened()).market;
        await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId: other.id }));
        const otherBefore = await readMarketMakerRuntime(t.db, other.id);
        const supply = await ledgerSupply(t.db);
        const before = await t.db.select().from(schema.balances).orderBy(schema.balances.accountId);
        let failedTransactions = 0;
        const failing = new Proxy(t.db, {
          get(target, key, receiver) {
            if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
            return (callback: Parameters<Db['transaction']>[0]) =>
              target.transaction(async (tx) => {
                const result: unknown = await callback(tx);
                if (
                  result !== null &&
                  typeof result === 'object' &&
                  'outcome' in result &&
                  result.outcome === 'ready'
                ) {
                  failedTransactions++;
                  throw new Error('injected before maker COMMIT');
                }
                return result;
              });
          },
        });
        const { queue, close } = await realQueue<MarketMakerJobData>('maker', failing);
        try {
          // The production producer as well as the real dispatcher: Redis retries provide
          // attemptsMade/opts; the test never supplies a fabricated final-attempt counter.
          await createEnqueueMarketMaker(queue, logger)(market.id, 1n);
          await vi.waitFor(
            async () => {
              expect(await queue.getJobCountByTypes('failed')).toBe(1);
            },
            { timeout: 10_000, interval: 20 },
          );
          const [job] = await queue.getJobs(['failed']);
          expect(job!.attemptsMade).toBe(DEFAULT_JOB_OPTIONS.attempts);
          expect(failedTransactions).toBe(DEFAULT_JOB_OPTIONS.attempts);
        } finally {
          await close();
        }
        expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
          desiredEnabled: false,
          state: 'stopped',
          reason: 'retry_exhausted',
          controlGeneration: 2n,
        });
        expect(await readMarketMakerRuntime(t.db, other.id)).toEqual(otherBefore);
        expect(
          await t.db.select().from(schema.orders).where(eq(schema.orders.marketId, market.id)),
        ).toEqual([]);
        expect(
          await t.db.select().from(schema.balances).orderBy(schema.balances.accountId),
        ).toEqual(before);
        expect(
          (
            await t.db
              .select()
              .from(schema.marketMakerRuns)
              .where(eq(schema.marketMakerRuns.marketId, market.id))
          ).filter((row) => row.outcome === 'error'),
        ).toHaveLength(DEFAULT_JOB_OPTIONS.attempts);
        // People still trade with each other in the stopped bot's market: a resting NO bid at 40
        // and a YES buy at 60 make 100 per pair; the reference is that bid's own 60, inside C5's
        // protection width.
        const first = await placeTestOrder(t.db, {
          marketId: market.id,
          ownerId: people[0]!,
          outcome: 'NO',
          limitPriceCoin: 40,
          qty: 2,
        });
        const second = await placeTestOrder(t.db, {
          marketId: market.id,
          ownerId: people[1]!,
          outcome: 'YES',
          limitPriceCoin: 60,
          qty: 2,
        });
        expect(first).toMatchObject({ kind: 'placed', order: { filledQty: 0 } });
        expect(second).toMatchObject({ kind: 'placed', order: { filledQty: 2 } });
        // Held and reserved risk ≤ L (C5's maxLossCoin) for both bots: the stopped one, and the
        // other one that still quotes.
        for (const id of [market.id, other.id]) {
          const snapshot = await readMarketMakerRiskSnapshot(t.db, id);
          expect(snapshot.kind).toBe('ready');
          if (snapshot.kind !== 'ready') throw new Error('Missing scenario risk snapshot');
          const risk = botRisk(snapshot.book, snapshot.liveOrders, LIMITS, CONTRACT_TERMS);
          expect(risk.worstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
          expect(risk.reservedWorstLoss).toBeLessThanOrEqual(SETTINGS.maxLossCoin);
        }
        await invariants(supply);
        await reconcile([market.id, other.id], people);
        await invariants(supply);
      }, 30_000);
    });
  },
);
