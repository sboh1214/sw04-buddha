/**
 * market.finalize integration test (PLAN M5 AC 3, ADR-0046 정산 단계; resolved → settling →
 * settled, ADR-0093 decision 1 items 1 and 14) against the docker `test` profile: the database
 * through the packages/db harness, Redis through TEST_REDIS_URL. Skips when either is unset,
 * exactly like ledger-audit.test.ts.
 *
 * Holders are made by #118's pair mint (`mintTestPairs`: two buy locks and one
 * `applyPairMintFill`): the person's position and the 운영 마켓메이커's opposite one, each buyer's
 * Coin moved into the market's collateral account by a PAIR_MINT_COLLATERAL event — so the
 * collateral holds unsettled pairs × 100 to pay from, and the audit (PLAN 5.6) can be run on the
 * result.
 */
import { randomUUID } from 'node:crypto';
import {
  closeDb,
  createDb,
  ledgerKeys,
  lockForOrder,
  lockLedgerAccounts,
  marketMakerAccountId,
  recordLedgerEntry,
  releaseForOrder,
  schema,
  settleMarketPositions,
  type Db,
  type LedgerAccountRef,
} from '@buddha/db';
import {
  ledgerOf as accountLedgerOf,
  connectTestDb,
  createMarket,
  createPosition,
  createProvisionalMarket,
  createSettlementStep,
  createUser,
  fundMarketMakerFunds,
  hasTestDb,
  ledgerAccountBalance,
  marketStatsOf,
  mintTestPairs,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
  resolveMarketNow,
  testDbUrls,
  withLedgerGuardsOff,
  type AccountLedgerRow,
  type TestDb,
} from '@buddha/db/test';
import {
  MARKET_STATUSES,
  SETTLEMENT_STEP_ERROR_MAX,
  marketChannel,
  userChannel,
  type MarketResult,
  type Outcome,
} from '@buddha/shared';
import { DrizzleQueryError, and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, createPublisherRedis, type Publish } from '../realtime.js';
import { runLedgerAudit } from './ledger-audit.js';
import { closeMarket } from './market-close.js';
import { finalizeDueMarkets, finalizeMarket, type FinalizeResult } from './market-finalize.js';

// hasTestDb() loads the root .env first, so TEST_REDIS_URL is visible after it.
const hasTestInfra = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `received` holds `count` messages (bounded), so a lost publish fails loudly. */
async function waitForMessages(received: unknown[], count: number, what: string): Promise<void> {
  const started = Date.now();
  while (received.length < count) {
    if (Date.now() - started > 5_000) {
      throw new Error(`${what}: ${String(received.length)} of ${String(count)} received`);
    }
    await sleep(20);
  }
}

/**
 * apps/api/src/test/ledger.ts, copied: the worker must not import apps/api (PLAN 4.1). One
 * person's ledger as the suites read it (`ledgerOf` of @buddha/db/test: each event signed from
 * the account's side, its total after it); for one account the id is commit order. Listed by
 * (created_at, id) the rows come out in id order, every total after is the previous one plus its
 * own amount, and the sum is the balance row. A payout stamped before the pair mint it follows
 * (transaction-start `now()`, or a clock read before the balance lock) breaks the first of these.
 */
function expectLedgerChain(entries: AccountLedgerRow[], finalBalanceCoin: bigint): void {
  const committed = [...entries].sort((a, b) => a.id - b.id);
  const listed = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  expect(
    listed.map((entry) => entry.id),
    '(created_at, id) order disagrees with commit order',
  ).toEqual(committed.map((entry) => entry.id));
  let running = 0n;
  for (const entry of committed) {
    running += entry.amountCoin;
    expect(entry.balanceAfterCoin, `${entry.type} #${String(entry.id)}`).toBe(running);
  }
  expect(running, 'ledger sum vs balance row').toBe(finalBalanceCoin);
}

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestInfra)('market.finalize (integration)', () => {
  let t: TestDb;
  let redis: Redis;
  let publish: Publish;
  /** What `finalizeMarket` logs — only a failure record that could not be written. */
  let logs: Record<string, unknown>[];
  let logger: Logger;

  beforeAll(async () => {
    t = await connectTestDb();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    publish = createPublisher(redis, pino({ level: 'silent' }));
  });
  afterAll(async () => {
    await redis?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    logs = [];
    logger = pino(
      { level: 'debug' },
      { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    );
  });

  /**
   * A market confirmed `result` at `resolvedAt` (default a minute ago), as the worker's
   * confirmation leaves it (#152): `resolved`, and one `pending` row per settlement step (the
   * factory writes them, unless `settlementSteps: false`). `status: 'settling'` is the same market
   * once the worker's resolved → settling committed (a run whose steps then failed).
   */
  async function resolved(
    result: MarketResult = 'YES',
    resolvedAt = new Date(Date.now() - MINUTE_MS),
    options: { settlementSteps?: boolean; status?: 'resolved' | 'settling' } = {},
  ) {
    const provisional = await createProvisionalMarket(t.db, {
      result,
      publishedAt: new Date(resolvedAt.getTime() - 2 * MINUTE_MS),
      disputeWindowMinutes: 1,
    });
    const confirmed = await resolveMarketNow(t.db, provisional.market.id, { at: resolvedAt });
    if (options.settlementSteps === false) {
      await t.db
        .delete(schema.marketSettlementSteps)
        .where(eq(schema.marketSettlementSteps.marketId, confirmed.market.id));
    }
    if (options.status === 'settling') {
      await t.db
        .update(schema.markets)
        .set({ status: 'settling' })
        .where(eq(schema.markets.id, confirmed.market.id));
    }
    return marketRow(confirmed.market.id);
  }

  /**
   * A holder as a pair mint leaves it (#118, `mintTestPairs`): `qty` pairs between this person and
   * the 운영 마켓메이커, the person's side bought for `costBasisCoin` (a whole Coin per contract) and the
   * other side for the rest of 100 per pair out of the market's 마켓메이커 자금 (funded here by a
   * 금고 발행 and a 봇 배정) — both paid into the market's collateral, which then holds the qty ×
   * 100 the winning side is paid. So the 운영 마켓메이커 holds the opposite position, and is
   * settled (and paid into its 마켓메이커 자금) like any holder. A row that holds nothing to pay
   * for — qty 0, cost 0, or already settled — is the position alone.
   */
  async function hold(input: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    qty: number;
    costBasisCoin: bigint;
    realizedPnlCoin?: bigint;
    settled?: boolean;
  }) {
    if (input.qty === 0 || input.costBasisCoin === 0n || input.settled) {
      return createPosition(t.db, input);
    }
    const qty = BigInt(input.qty);
    const price = input.costBasisCoin / qty;
    if (price * qty !== input.costBasisCoin || price < 1n || price > 99n) {
      throw new Error(`hold: ${String(input.costBasisCoin)} is not a 1..99 price × ${String(qty)}`);
    }
    const maker = await fundMarketMakerFunds(
      t.db,
      input.marketId,
      qty * 100n - input.costBasisCoin,
    );
    const yes = input.outcome === 'YES';
    await mintTestPairs(t.db, {
      marketId: input.marketId,
      yesHolderId: yes ? input.userId : maker,
      noHolderId: yes ? maker : input.userId,
      qty: input.qty,
      yesPriceCoin: Number(yes ? price : 100n - price),
    });
    return positionOf(input.userId, input.marketId, input.outcome);
  }

  /** The 운영 마켓메이커's id (the account `hold` pairs with; made by the first `hold`). */
  async function makerId(): Promise<string> {
    const id = await marketMakerAccountId(t.db);
    if (id === null) throw new Error('no 운영 마켓메이커 account yet');
    return id;
  }

  /** A market's collateral and its 마켓메이커 자금, as ledger account refs. */
  const collateralOf = (marketId: string): LedgerAccountRef => ({
    kind: 'market_collateral',
    marketId,
  });
  const fundsOf = (marketId: string): LedgerAccountRef => ({
    kind: 'market_maker_funds',
    marketId,
  });

  /** A ledger account's available Coin; 0 when no event named it yet. */
  async function coinOf(ref: LedgerAccountRef): Promise<bigint> {
    return (await ledgerAccountBalance(t.db, ref))?.availableCoin ?? 0n;
  }

  /** What the coin step throws when the collateral cannot pay every winner. */
  const shortOf = (marketId: string, owedCoin: bigint) =>
    `Market ${marketId} settlement: collateral does not match the remaining ${String(owedCoin)} Coin payout`;

  /**
   * Makes a short collateral whole the way #93's 대사 정정 will: a 금고 발행 into the treasury,
   * then a RECONCILIATION_CORRECTION from it into the market's collateral (ADR-0107 결정 2 #73
   * 10항), both under one made-up approval request and audit failure (no rows: nothing reads
   * them back).
   */
  async function correctCollateral(marketId: string, amountCoin: bigint) {
    const requestId = randomUUID();
    await t.db.transaction(async (tx) => {
      await lockLedgerAccounts(tx, [{ kind: 'treasury' }, collateralOf(marketId)]);
      await recordLedgerEntry(tx, {
        type: 'TREASURY_MINT',
        amountCoin,
        from: null,
        to: { kind: 'treasury' },
        refType: 'approval_request',
        refId: requestId,
        idempotencyKey: ledgerKeys.approvalRequest(requestId),
      });
      await recordLedgerEntry(tx, {
        type: 'RECONCILIATION_CORRECTION',
        amountCoin,
        from: { kind: 'treasury' },
        to: collateralOf(marketId),
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: ledgerKeys.approvalRequest(requestId),
      });
    });
  }

  /** Simulates a collateral error without inventing contracts outside the pair ledger. */
  async function drainCollateral(marketId: string, amountCoin: bigint) {
    await t.db.transaction((tx) =>
      recordLedgerEntry(tx, {
        type: 'RECONCILIATION_CORRECTION',
        amountCoin,
        from: collateralOf(marketId),
        to: { kind: 'treasury' },
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: ledgerKeys.approvalRequest(randomUUID()),
      }),
    );
  }

  async function recordsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.positionSettlements)
      .where(eq(schema.positionSettlements.marketId, marketId))
      .orderBy(asc(schema.positionSettlements.userId), asc(schema.positionSettlements.outcome));
  }

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  async function eventsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(
        and(
          eq(schema.marketEvents.marketId, marketId),
          inArray(schema.marketEvents.type, ['settling', 'finalized']),
        ),
      )
      .orderBy(asc(schema.marketEvents.id));
  }

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row!;
  }

  async function ledgerOf(userId: string) {
    return accountLedgerOf(t.db, userId);
  }

  async function stepsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId))
      .orderBy(asc(schema.marketSettlementSteps.step));
  }

  async function positionsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.marketId, marketId))
      .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome));
  }

  async function positionOf(userId: string, marketId: string, outcome: Outcome) {
    const [row] = await t.db
      .select()
      .from(schema.positions)
      .where(
        and(
          eq(schema.positions.userId, userId),
          eq(schema.positions.marketId, marketId),
          eq(schema.positions.outcome, outcome),
        ),
      );
    return row!;
  }

  /** One subscriber over several channels; each channel's messages land in their own array. */
  async function subscribeTo(channels: string[]) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received = new Map<string, Record<string, unknown>[]>(channels.map((c) => [c, []]));
    subscriber.on('message', (channel: string, message: string) => {
      received.get(channel)?.push(JSON.parse(message) as Record<string, unknown>);
    });
    await subscriber.subscribe(...channels);
    return {
      of: (channel: string) => received.get(channel)!,
      quit: () => subscriber.quit(),
    };
  }

  /**
   * `t.db` with seams between the transactions of one `finalizeMarket`: the first is
   * resolved → settling (`startSettling`, opened for every market), the second runs the steps
   * and, only once that has rejected, the third records the attempt (`recordStepFailure`).
   * `beforeSteps` runs right before the second opens — resolved → settling has committed and
   * released the market lock. `beforeRecord` runs right before the third — the rollback has
   * released it, so another writer gets in exactly there, and a rejection from it is the
   * record's own transaction failing. `inserts` counts the INSERTs the record issues, so
   * "records nothing" is told apart from "the upsert's guard kept the row". The rest is `t.db`.
   */
  function seamed(hooks: {
    beforeSteps?: () => Promise<void>;
    beforeRecord?: () => Promise<void>;
  }) {
    const seam = { db: t.db, inserts: 0 };
    let opened = 0;
    const transaction: Db['transaction'] = async (run, config) => {
      opened += 1;
      if (opened === 1) return t.db.transaction(run, config);
      if (opened === 2) {
        await hooks.beforeSteps?.();
        return t.db.transaction(run, config);
      }
      await hooks.beforeRecord?.();
      return t.db.transaction(
        (tx) =>
          run(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop === 'insert') seam.inserts += 1;
                return Reflect.get(target, prop, receiver) as unknown;
              },
            }),
          ),
        config,
      );
    };
    seam.db = new Proxy(t.db, {
      get: (target, prop, receiver) =>
        prop === 'transaction' ? transaction : (Reflect.get(target, prop, receiver) as unknown),
    });
    return seam;
  }

  /**
   * A collateralised pair whose collateral was incorrectly moved out: the market cannot pay
   * its 1,000 Coin, so the coin step throws while
   * it runs (see the rollback test below) and the record goes on `coin`. Returns the account and
   * the step's message; `correctCollateral(marketId, 1_000n)` makes it payable.
   */
  async function poisonedWinner(marketId: string) {
    const userId = (await createUser(t.db, { balanceCoin: 500n })).user.id;
    await hold({ userId, marketId, outcome: 'YES', qty: 10, costBasisCoin: 500n });
    await drainCollateral(marketId, 1_000n);
    return { userId, message: shortOf(marketId, 1_000n) };
  }

  it('pays the winning holders, closes out every row and settles the market (M5 AC 3)', async () => {
    const market = await resolved('YES');
    // alice: YES 10 for 500 Coin → paid 1,000 Coin, realised +500.
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    // bob: NO 5 for 300 Coin → nothing, realised −300.
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisCoin: 300n });
    // carol sold her YES contracts before the close: an unsettled row at qty 0 with a realised
    // gain. Closed out like the others, but there is nothing to pay and no balance event.
    const carol = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: carol,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      costBasisCoin: 0n,
      realizedPnlCoin: 120n,
    });
    // dave's row is already settled (the idempotency marker): never touched, never paid.
    const dave = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: dave,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      costBasisCoin: 0n,
      settled: true,
    });
    // A holder in another market is untouched.
    const other = await createMarket(t.db, { status: 'closed' });
    await hold({ userId: alice, marketId: other.id, outcome: 'YES', qty: 2, costBasisCoin: 90n });
    // The other side of alice's and bob's pairs: the 운영 마켓메이커's NO 10 (for 500) and YES 5
    // (for 200), out of its 마켓메이커 자금. The collateral holds the 15 pairs × 100.
    const maker = await makerId();
    expect(await coinOf(collateralOf(market.id))).toBe(1_500n);
    expect(await coinOf(fundsOf(market.id))).toBe(0n);

    const subscriber = await subscribeTo([
      marketChannel(market.id),
      userChannel(alice),
      userChannel(bob),
      userChannel(carol),
      userChannel(dave),
      userChannel(maker),
    ]);
    try {
      const result = await finalizeMarket(t.db, market.id, publish, logger);
      expect(result.outcome).toBe('settled');
      if (result.outcome !== 'settled') return;
      // alice's, bob's, carol's and the 운영 마켓메이커's two rows; alice and the 운영 마켓메이커
      // (its YES 5) paid.
      expect(result).toMatchObject({
        marketId: market.id,
        positions: 6,
        settledAccounts: 5,
        paidAccounts: 2,
        paidCoin: 1_500n,
      });

      // --- alice: +1,000 Coin, one SETTLEMENT_PAYOUT row, the chain intact, realised +500 --
      const aliceBalance = await balanceOf(alice);
      expect(aliceBalance.availableCoin).toBe(10_000n - 500n - 90n + 1_000n);
      const aliceLedger = await ledgerOf(alice);
      const payouts = aliceLedger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
      expect(payouts).toHaveLength(1);
      expect(payouts[0]).toMatchObject({
        amountCoin: 1_000n,
        balanceAfterCoin: aliceBalance.availableCoin,
        refType: 'market',
        refId: market.id,
        memo: `정산 지급: ${market.title}`,
        // Stamped with the step's post-lock instant, which the balance row carries too.
        createdAt: aliceBalance.updatedAt,
      });
      // From the market's collateral, keyed by the settlement key (#116).
      const [payout] = await t.db
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.id, payouts[0]!.id));
      expect(payout).toMatchObject({
        type: 'SETTLEMENT_PAYOUT',
        marketId: market.id,
        idempotencyKey: ledgerKeys.settlement(market.id, 1, alice, 'YES'),
      });
      expectLedgerChain(aliceLedger, aliceBalance.availableCoin);
      const aliceYes = await positionOf(alice, market.id, 'YES');
      expect(aliceYes).toMatchObject({
        qty: 0,
        costBasisCoin: 0n,
        realizedPnlCoin: 500n,
        settled: true,
        version: 2,
        updatedAt: result.settledAt,
      });
      // The other market's row is not this settlement's business.
      expect(await positionOf(alice, other.id, 'YES')).toMatchObject({
        qty: 2,
        costBasisCoin: 90n,
        settled: false,
        version: 1,
      });

      // --- bob: nothing paid, realised −cost, row closed out ------------------------------
      expect((await balanceOf(bob)).availableCoin).toBe(10_000n - 300n);
      // The factory's starting Coin (the start grant, #70), the pair mint.
      expect((await ledgerOf(bob)).map((entry) => entry.type)).toEqual([
        'START_GRANT',
        'PAIR_MINT_COLLATERAL',
      ]);
      expect(await positionOf(bob, market.id, 'NO')).toMatchObject({
        qty: 0,
        costBasisCoin: 0n,
        realizedPnlCoin: -300n,
        settled: true,
        version: 2,
      });

      // --- carol: closed out, realised untouched, nothing paid ---------------------------
      expect((await balanceOf(carol)).availableCoin).toBe(10_000n);
      expect(await positionOf(carol, market.id, 'YES')).toMatchObject({
        qty: 0,
        realizedPnlCoin: 120n,
        settled: true,
        version: 2,
      });

      // --- dave: the already-settled row is skipped entirely -----------------------------
      expect((await balanceOf(dave)).availableCoin).toBe(10_000n);
      expect(await positionOf(dave, market.id, 'YES')).toMatchObject({ qty: 0, version: 1 });

      // --- the 운영 마켓메이커: its rows closed out, its YES 5 paid into its 마켓메이커 자금 ----
      expect(await positionOf(maker, market.id, 'YES')).toMatchObject({
        qty: 0,
        realizedPnlCoin: 300n,
        settled: true,
      });
      expect(await positionOf(maker, market.id, 'NO')).toMatchObject({
        qty: 0,
        realizedPnlCoin: -500n,
        settled: true,
      });
      expect(await coinOf(fundsOf(market.id))).toBe(500n);
      // Every pair paid out: the collateral is empty (the other market's is not touched).
      expect(await coinOf(collateralOf(market.id))).toBe(0n);
      expect(await coinOf(collateralOf(other.id))).toBe(200n);

      // --- market: resolved → settling → settled, the worker the actor of both ----------
      const row = await marketRow(market.id);
      const [settling, event, ...more] = await eventsOf(market.id);
      expect(more).toEqual([]);
      expect(settling).toMatchObject({
        type: 'settling',
        actorId: null,
        fromStatus: 'resolved',
        toStatus: 'settling',
        payload: { source: 'job' },
      });
      expect(settling!.createdAt.getTime()).toBeLessThanOrEqual(result.settledAt.getTime());
      expect(event).toMatchObject({
        type: 'finalized',
        actorId: null,
        fromStatus: 'settling',
        toStatus: 'settled',
        payload: {
          result: 'YES',
          settledAccounts: 5,
          paidAccounts: 2,
          paidCoin: '1500',
          positions: 6,
        },
        createdAt: result.settledAt,
      });
      expect(row).toMatchObject({
        status: 'settled',
        settledAt: result.settledAt,
        updatedAt: result.settledAt,
        statusEventId: event!.id,
        resolvedResult: 'YES',
        resolvedAt: market.resolvedAt,
      });
      expect(result.statusEventId).toBe(event!.id);
      expect(result.settledAt.getTime()).toBeGreaterThanOrEqual(market.resolvedAt!.getTime());

      // --- the coin step (ADR-0046): done in the same transaction, at the same instant ----
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'done',
          attempts: 1,
          completedAt: result.settledAt,
          lastError: null,
          updatedAt: result.settledAt,
        }),
      ]);

      // --- published after COMMIT (PLAN 8) -----------------------------------------------
      await waitForMessages(subscriber.of(marketChannel(market.id)), 2, 'market:status');
      await waitForMessages(subscriber.of(userChannel(alice)), 2, "alice's events");
      await waitForMessages(subscriber.of(userChannel(bob)), 1, "bob's events");
      await waitForMessages(subscriber.of(userChannel(carol)), 1, "carol's events");
      await sleep(100);
      const ts = result.settledAt.toISOString();
      expect(subscriber.of(marketChannel(market.id))).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'settling',
          resolvedResult: 'YES',
          statusEventId: String(settling!.id),
          ts: settling!.createdAt.toISOString(),
        },
        {
          type: 'market:status',
          marketId: market.id,
          status: 'settled',
          resolvedResult: 'YES',
          statusEventId: String(event!.id),
          ts,
        },
      ]);
      expect(subscriber.of(userChannel(alice))).toEqual([
        {
          type: 'user:balance',
          availableCoin: aliceBalance.availableCoin.toString(),
          lockedCoin: '0',
          ledgerEntryId: String(payouts[0]!.id),
          ts: aliceBalance.updatedAt.toISOString(),
        },
        {
          type: 'user:position',
          marketId: market.id,
          outcome: 'YES',
          qty: 0,
          costBasisCoin: '0',
          realizedPnlCoin: '500',
          settled: true,
          version: 2,
          ts,
        },
      ]);
      expect(subscriber.of(userChannel(bob))).toEqual([
        {
          type: 'user:position',
          marketId: market.id,
          outcome: 'NO',
          qty: 0,
          costBasisCoin: '0',
          realizedPnlCoin: '-300',
          settled: true,
          version: 2,
          ts,
        },
      ]);
      expect(subscriber.of(userChannel(carol))).toEqual([
        expect.objectContaining({ type: 'user:position', outcome: 'YES', realizedPnlCoin: '120' }),
      ]);
      expect(subscriber.of(userChannel(dave))).toEqual([]);
      // The 운영 마켓메이커 has no client: nothing is published to it.
      expect(subscriber.of(userChannel(maker))).toEqual([]);

      const records = await recordsOf(market.id);
      expect(records).toHaveLength(4);
      expect(records.find((record) => record.userId === alice)).toMatchObject({
        qty: 10,
        costBasisCoin: 500n,
        payoutCoin: 1_000n,
        settlementPnlCoin: 500n,
        result: 'YES',
        judgementVersion: 1,
      });
      expect(records.find((record) => record.userId === bob)).toMatchObject({
        qty: 5,
        costBasisCoin: 300n,
        payoutCoin: 0n,
        settlementPnlCoin: -300n,
        ledgerEntryId: null,
      });
      // --- the books still balance (PLAN 5.6): every payout has its ledger row -----------
      const audit = await runLedgerAudit(t.db);
      // Four holders, the two markets' creators, the treasury, and each market's collateral and
      // 마켓메이커 자금.
      expect(audit.checked).toBe(13);
      expect(audit.mismatches).toEqual([]);
      expect(audit.recorded).toBe(0);
    } finally {
      await subscriber.quit();
    }
  });

  it('commits resolved → settling and publishes it before the steps run, then settles (ADR-0093 decision 1 item 1)', async () => {
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const subscriber = await subscribeTo([marketChannel(market.id)]);
    // What another connection sees between the two transactions: the settling transition is
    // committed and announced while no step has run yet.
    const between: {
      row?: typeof schema.markets.$inferSelect;
      events?: (typeof schema.marketEvents.$inferSelect)[];
      steps?: (typeof schema.marketSettlementSteps.$inferSelect)[];
      position?: typeof schema.positions.$inferSelect;
      published?: Record<string, unknown>[];
    } = {};
    const seam = seamed({
      beforeSteps: async () => {
        between.row = await marketRow(market.id);
        between.events = await eventsOf(market.id);
        between.steps = await stepsOf(market.id);
        between.position = await positionOf(alice, market.id, 'YES');
        await waitForMessages(subscriber.of(marketChannel(market.id)), 1, 'settling status');
        between.published = [...subscriber.of(marketChannel(market.id))];
      },
    });
    try {
      const result = await finalizeMarket(seam.db, market.id, publish, logger);
      expect(result.outcome).toBe('settled');
      if (result.outcome !== 'settled') return;

      const [settling] = between.events!;
      expect(between.events).toEqual([
        expect.objectContaining({
          type: 'settling',
          // The worker acted (decision 1 item 1: an automatic edge).
          actorId: null,
          fromStatus: 'resolved',
          toStatus: 'settling',
          payload: { source: 'job' },
        }),
      ]);
      expect(between.row).toMatchObject({
        status: 'settling',
        statusEventId: settling!.id,
        updatedAt: settling!.createdAt,
        resolvedResult: 'YES',
        settledAt: null,
      });
      expect(between.steps).toEqual([
        expect.objectContaining({ step: 'coin', status: 'pending', attempts: 0 }),
      ]);
      expect(between.position).toMatchObject({ qty: 10, settled: false, version: 1 });
      expect(between.published).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'settling',
          resolvedResult: 'YES',
          statusEventId: String(settling!.id),
          ts: settling!.createdAt.toISOString(),
        },
      ]);

      // Then the step transaction: settling → settled, a second event after the first.
      const events = await eventsOf(market.id);
      expect(events).toEqual([
        settling,
        expect.objectContaining({
          type: 'finalized',
          actorId: null,
          fromStatus: 'settling',
          toStatus: 'settled',
          createdAt: result.settledAt,
        }),
      ]);
      expect(await marketRow(market.id)).toMatchObject({
        status: 'settled',
        statusEventId: events[1]!.id,
        settledAt: result.settledAt,
      });
      expect(result.settledAt.getTime()).toBeGreaterThanOrEqual(settling!.createdAt.getTime());
      await waitForMessages(subscriber.of(marketChannel(market.id)), 2, 'settled status');
      expect(subscriber.of(marketChannel(market.id)).map((event) => event.status)).toEqual([
        'settling',
        'settled',
      ]);
    } finally {
      await subscriber.quit();
    }
  });

  it('settles a market already settling (a run whose steps failed) without a second settling event', async () => {
    const market = await resolved('NO', undefined, { status: 'settling' });
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisCoin: 300n });
    const subscriber = await subscribeTo([marketChannel(market.id)]);
    try {
      const result = await finalizeMarket(t.db, market.id, publish, logger);
      expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidCoin: 500n });
      expect(await eventsOf(market.id)).toEqual([
        expect.objectContaining({ type: 'finalized', fromStatus: 'settling', toStatus: 'settled' }),
      ]);
      expect((await marketRow(market.id)).status).toBe('settled');
      await waitForMessages(subscriber.of(marketChannel(market.id)), 1, 'settled status');
      await sleep(100);
      expect(subscriber.of(marketChannel(market.id))).toEqual([
        expect.objectContaining({ status: 'settled', resolvedResult: 'NO' }),
      ]);
    } finally {
      await subscriber.quit();
    }
  });

  it('pays NO holders when the result is NO', async () => {
    const market = await resolved('NO');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisCoin: 300n });

    const result = await finalizeMarket(t.db, market.id, publish, logger);
    // bob, and the 운영 마켓메이커's NO 10 (the other side of alice's pairs).
    expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 2, paidCoin: 1_500n });
    expect(await coinOf(fundsOf(market.id))).toBe(1_000n);
    expect((await balanceOf(alice)).availableCoin).toBe(9_500n);
    expect((await balanceOf(bob)).availableCoin).toBe(10_000n - 300n + 500n);
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      realizedPnlCoin: -500n,
      settled: true,
    });
    expect(await positionOf(bob, market.id, 'NO')).toMatchObject({
      realizedPnlCoin: 200n,
      settled: true,
    });
    expectLedgerChain(await ledgerOf(bob), 10_200n);
  });

  it('pays a holder whose total left its ledger and settles the market, the gap kept (#73 10항)', async () => {
    // ADR-0107 결정 2 #73 10항: an account mismatch refuses that account's new orders only, and
    // its settlement payout still lands — the market's one payout transaction does not stall in
    // SETTLING on it. The payout moves the buckets and the ledger total together (migration 0060),
    // so the gap an owner-level write left stays for #93's 대사 정정 and the audit.
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'YES', qty: 5, costBasisCoin: 250n });
    await withLedgerGuardsOff((client) =>
      client.query('update balances set available_coin = available_coin + 25 where user_id = $1', [
        alice,
      ]),
    );

    const result = await finalizeMarket(t.db, market.id, publish, logger);
    expect(result).toMatchObject({ outcome: 'settled', paidCoin: 1_500n });
    expect((await marketRow(market.id)).status).toBe('settled');
    expect(await balanceOf(alice)).toMatchObject({
      availableCoin: 10_000n - 500n + 25n + 1_000n,
      ledgerCoin: 10_000n - 500n + 1_000n,
    });
    expectLedgerChain(await ledgerOf(alice), 10_500n);
    expect((await balanceOf(bob)).availableCoin).toBe(10_000n - 250n + 500n);
    const audit = await runLedgerAudit(t.db);
    expect(audit.mismatches).toEqual([
      expect.objectContaining({ userId: alice, differenceCoin: 25n, ledgerCoinMismatch: false }),
    ]);
  });

  it('pays out even when every publish fails (the transaction has committed)', async () => {
    // The settlement twin of market-close's swallow case, and the one that matters most: this
    // is the money path, and it publishes 1 + 2N events. A throw here would put a settlement
    // that already paid into the failed set, and its retry would find `settled` and skip.
    //
    // The client is the production factory's, so what is pinned is the DEPLOYED option set: on
    // the shared BullMQ connection these publishes would not fail at all — they would never
    // settle, and this whole `await` would park with the scan behind it (realtime.ts).
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const dead = createPublisherRedis('redis://127.0.0.1:1', pino({ level: 'silent' }));
    const warns: unknown[] = [];
    const publishLogger = pino(
      { level: 'warn' },
      { write: (line: string) => warns.push(JSON.parse(line)) },
    );
    try {
      const result = await finalizeMarket(
        t.db,
        market.id,
        createPublisher(dead, publishLogger),
        logger,
      );
      expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidCoin: 1_000n });
      expect((await balanceOf(alice)).availableCoin).toBe(10_000n - 500n + 1_000n);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 0, settled: true });
      // One warn per event that could not go out: the two statuses (settling, settled), the
      // balance and the position.
      expect(warns).toHaveLength(4);
      expect(warns.every((line) => (line as { msg: string }).msg === 'realtime publish failed'));
      // The step is done: a publish after COMMIT is not part of it.
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({ step: 'coin', status: 'done', attempts: 1 }),
      ]);
    } finally {
      dead.disconnect();
    }
  });

  it('re-run: a second finalize is skipped and pays nothing twice (M5 AC 3 멱등)', async () => {
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const first = await finalizeMarket(t.db, market.id, publish, logger);
    expect(first.outcome).toBe('settled');
    const stepsAfterFirst = await stepsOf(market.id);

    const subscriber = await subscribeTo([marketChannel(market.id), userChannel(alice)]);
    try {
      // The judgement's job retried, a duplicate, the scan, or a manual run: all find `settled`.
      await expect(finalizeMarket(t.db, market.id, publish, logger)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_settling',
      });
      await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toEqual({
        settled: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      expect((await balanceOf(alice)).availableCoin).toBe(10_500n);
      const ledger = await ledgerOf(alice);
      expect(ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT')).toHaveLength(1);
      expectLedgerChain(ledger, 10_500n);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ version: 2 });
      // settling and finalized from the first run, nothing from the second.
      expect(await eventsOf(market.id)).toHaveLength(2);
      // The skip happens before the step rows: the done row is exactly as the first run left it.
      expect(await stepsOf(market.id)).toEqual(stepsAfterFirst);
      await sleep(100);
      expect(subscriber.of(marketChannel(market.id))).toEqual([]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);
    } finally {
      await subscriber.quit();
    }
  });

  // Every status but the two a settlement picks up: `resolved` goes to `settling` first.
  it.each(MARKET_STATUSES.filter((status) => status !== 'resolved' && status !== 'settling'))(
    'skips a %s market: only a judged (resolved or settling) market is settled',
    async (status) => {
      // A PROVISIONAL market has its published result (migration 0055, #152), a settled one too.
      const market = await createMarket(t.db, {
        status,
        resolvedResult: status === 'settled' || status === 'provisional' ? 'YES' : null,
      });
      const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
      await hold({
        userId: alice,
        marketId: market.id,
        outcome: 'YES',
        qty: 10,
        costBasisCoin: 500n,
      });
      const stepsBefore = await stepsOf(market.id);

      await expect(finalizeMarket(t.db, market.id, publish, logger)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_settling',
      });
      expect((await marketRow(market.id)).status).toBe(status);
      expect(await eventsOf(market.id)).toEqual([]);
      expect((await balanceOf(alice)).availableCoin).toBe(9_500n);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 10, settled: false });
      // A skip is not an attempt: no step row is written or touched (a settled market keeps its
      // done row; the others have none).
      expect(await stepsOf(market.id)).toEqual(stepsBefore);
      expect(stepsBefore).toHaveLength(status === 'settled' ? 1 : 0);
    },
  );

  it('fails loudly — and rolls back — on a settling market without a result, and records it', async () => {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: null });
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });

    await expect(finalizeMarket(t.db, market.id, publish, logger)).rejects.toThrow(
      `Market ${market.id} is settling without a result`,
    );
    // Nothing settled as a loser by default: the row and the market are as they were.
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 10,
      settled: false,
      version: 1,
    });
    expect((await marketRow(market.id)).status).toBe('settling');
    expect(await eventsOf(market.id)).toEqual([]);
    // The throw came before any step started, so the first step that is not done carries it.
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        step: 'coin',
        status: 'failed',
        attempts: 1,
        completedAt: null,
        lastError: `Market ${market.id} is settling without a result`,
      }),
    ]);
    expect(logs).toEqual([]);
  });

  it('VOID pays both outcomes 50 Coin, preserves cost and PnL records, and publishes each person once', async () => {
    const market = await resolved('VOID');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 300n,
    });
    await hold({ userId: alice, marketId: market.id, outcome: 'NO', qty: 5, costBasisCoin: 300n });
    const before = await balanceOf(alice);
    const maker = await makerId();
    const published: { channel: string; event: unknown }[] = [];
    const result = await finalizeMarket(
      t.db,
      market.id,
      (channel, event) => {
        published.push({ channel, event });
        return Promise.resolve();
      },
      logger,
    );
    expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 2, paidCoin: 1_500n });
    expect((await balanceOf(alice)).availableCoin).toBe(before.availableCoin + 750n);
    expect(await coinOf(fundsOf(market.id))).toBe(750n);
    expect(await coinOf(collateralOf(market.id))).toBe(0n);
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 0,
      costBasisCoin: 0n,
      settled: true,
      realizedPnlCoin: 200n,
    });
    expect(await positionOf(alice, market.id, 'NO')).toMatchObject({
      qty: 0,
      costBasisCoin: 0n,
      settled: true,
      realizedPnlCoin: -50n,
    });
    const records = await recordsOf(market.id);
    expect(records).toHaveLength(4);
    expect(records.filter((row) => row.userId === alice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'YES',
          qty: 10,
          costBasisCoin: 300n,
          payoutCoin: 500n,
          settlementPnlCoin: 200n,
          result: 'VOID',
        }),
        expect.objectContaining({
          outcome: 'NO',
          qty: 5,
          costBasisCoin: 300n,
          payoutCoin: 250n,
          settlementPnlCoin: -50n,
          result: 'VOID',
        }),
      ]),
    );
    const humanEvents = published.filter((item) => item.channel === userChannel(alice));
    expect(humanEvents).toHaveLength(3);
    expect(humanEvents[0]?.event).toMatchObject({ type: 'user:balance', availableCoin: '10150' });
    expect(published.filter((item) => item.channel === userChannel(maker))).toEqual([]);
    const balance = await balanceOf(alice);
    const ledger = await ledgerOf(alice);
    await expect(finalizeMarket(t.db, market.id, publish, logger)).resolves.toMatchObject({
      outcome: 'skipped',
    });
    await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toMatchObject({
      settled: 0,
      failed: 0,
    });
    expect(await balanceOf(alice)).toEqual(balance);
    expect(await ledgerOf(alice)).toEqual(ledger);
    expect(await recordsOf(market.id)).toEqual(records);
    expect((await runLedgerAudit(t.db)).mismatches).toEqual([]);
  });

  it('a failing step rolls the settlement back and is recorded, the market left settling; once fixed, a rerun settles (ADR-0046, ADR-0093 item 14)', async () => {
    // A collateral short of the payout after an incorrect correction is reachable only
    // through a bug or an incorrect operational action. The deliberate
    // choice (market-finalize.ts) is all or nothing: paying alice and leaving bob's row
    // unsettled would be a partial settlement nothing else understands. The collateral is
    // checked before the first payout, and the rollback leaves both exactly as they were.
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: bob,
      marketId: market.id,
      outcome: 'YES',
      qty: 5,
      costBasisCoin: 250n,
    });
    await drainCollateral(market.id, 500n);
    const message = shortOf(market.id, 1_500n);
    const aliceBefore = await balanceOf(alice);
    const aliceLedgerBefore = await ledgerOf(alice);
    const [stepBefore] = await stepsOf(market.id);

    const subscriber = await subscribeTo([
      marketChannel(market.id),
      userChannel(alice),
      userChannel(bob),
    ]);
    try {
      await expect(finalizeMarket(t.db, market.id, publish, logger)).rejects.toThrow(message);

      expect(await balanceOf(alice)).toEqual(aliceBefore);
      expect(await coinOf(collateralOf(market.id))).toBe(1_000n);
      expect(await ledgerOf(alice)).toEqual(aliceLedgerBefore);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
        qty: 10,
        costBasisCoin: 500n,
        settled: false,
        version: 1,
      });
      expect(await positionOf(bob, market.id, 'YES')).toMatchObject({
        qty: 5,
        costBasisCoin: 250n,
        settled: false,
        version: 1,
      });
      // resolved → settling committed in its own transaction before the steps, so the rollback
      // leaves the market there: 지급 중, with nothing paid (ADR-0093 decision 1 item 14).
      const [settling, ...rest] = await eventsOf(market.id);
      expect(rest).toEqual([]);
      expect(settling).toMatchObject({
        type: 'settling',
        actorId: null,
        fromStatus: 'resolved',
        toStatus: 'settling',
      });
      expect(await marketRow(market.id)).toMatchObject({
        status: 'settling',
        settledAt: null,
        statusEventId: settling!.id,
        updatedAt: settling!.createdAt,
      });

      // The attempt, written in a transaction of its own after the rollback (D6): why the
      // market stays `settling` is readable without the worker's logs.
      const [failedStep] = await stepsOf(market.id);
      expect(failedStep).toMatchObject({
        step: 'coin',
        status: 'failed',
        attempts: 1,
        completedAt: null,
        lastError: message,
        createdAt: stepBefore!.createdAt,
      });
      expect(failedStep!.updatedAt.getTime()).toBeGreaterThan(stepBefore!.updatedAt.getTime());
      expect(logs).toEqual([]);

      // Only the settling transition committed, so it is all anyone is told.
      await waitForMessages(subscriber.of(marketChannel(market.id)), 1, 'settling status');
      await sleep(100);
      expect(subscriber.of(marketChannel(market.id))).toEqual([
        expect.objectContaining({ status: 'settling', statusEventId: String(settling!.id) }),
      ]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);
      expect(subscriber.of(userChannel(bob))).toEqual([]);

      // The collateral is made whole (#93's 대사 정정); the next run (the job's retry, or the
      // scan) settles it all.
      await correctCollateral(market.id, 500n);
      const result = await finalizeMarket(t.db, market.id, publish, logger);
      expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 2, paidCoin: 1_500n });
      if (result.outcome !== 'settled') return;
      // The rerun starts from `settling`: no second settling event.
      expect(await eventsOf(market.id)).toEqual([
        settling,
        expect.objectContaining({ type: 'finalized', fromStatus: 'settling', toStatus: 'settled' }),
      ]);
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'done',
          attempts: 2,
          completedAt: result.settledAt,
          // Kept after the success: the history of the step, not its state.
          lastError: message,
        }),
      ]);
      expect((await balanceOf(bob)).availableCoin).toBe(10_000n - 250n + 500n);
      expectLedgerChain(await ledgerOf(bob), 10_250n);
      expectLedgerChain(await ledgerOf(alice), 10_500n);
      expect(await coinOf(collateralOf(market.id))).toBe(0n);
      expect((await runLedgerAudit(t.db)).recorded).toBe(0);
    } finally {
      await subscriber.quit();
    }
  });

  it('settles a resolved market with no step row, and writes the coin row done', async () => {
    // The confirmation writes the rows (#152), so this is a market confirmed outside that path (a
    // row lost to a bug, a hand fix): a missing row counts as pending rather than blocking for
    // good.
    const market = await resolved('YES', undefined, { settlementSteps: false });
    expect(await stepsOf(market.id)).toEqual([]);
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });

    const result = await finalizeMarket(t.db, market.id, publish, logger);
    expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidCoin: 1_000n });
    if (result.outcome !== 'settled') return;
    expect(await stepsOf(market.id)).toEqual([
      {
        marketId: market.id,
        step: 'coin',
        status: 'done',
        attempts: 1,
        completedAt: result.settledAt,
        lastError: null,
        createdAt: result.settledAt,
        updatedAt: result.settledAt,
      },
    ]);
    expect((await balanceOf(alice)).availableCoin).toBe(10_500n);
  });

  it('reconciles a done coin step, records failure without reopening it, and retries without another payout', async () => {
    const market = await resolved('YES', undefined, { settlementSteps: false, status: 'settling' });
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    // A previously committed coin step; only the transition remains.
    const paid = await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
    await createSettlementStep(t.db, {
      marketId: market.id,
      status: 'done',
      attempts: 1,
      completedAt: paid.at,
    });
    const before = {
      balance: await balanceOf(alice),
      ledger: await ledgerOf(alice),
      records: await recordsOf(market.id),
    };
    // Extra collateral must block SETTLED even though all step rows say done.
    await correctCollateral(market.id, 1n);
    const message = shortOf(market.id, 0n);
    await expect(finalizeMarket(t.db, market.id, publish, logger)).rejects.toThrow(message);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        status: 'done',
        completedAt: paid.at,
        attempts: 2,
        lastError: message,
      }),
    ]);
    expect((await marketRow(market.id)).status).toBe('settling');
    await drainCollateral(market.id, 1n);
    const published: string[] = [];
    await expect(
      finalizeMarket(
        t.db,
        market.id,
        (channel) => {
          published.push(channel);
          return Promise.resolve();
        },
        logger,
      ),
    ).resolves.toMatchObject({
      outcome: 'settled',
      positions: 2,
      settledAccounts: 2,
      paidAccounts: 1,
      paidCoin: 1_000n,
    });
    expect(published).toEqual([marketChannel(market.id)]);
    expect(await balanceOf(alice)).toEqual(before.balance);
    expect(await ledgerOf(alice)).toEqual(before.ledger);
    expect(await recordsOf(market.id)).toEqual(before.records);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        status: 'done',
        completedAt: paid.at,
        attempts: 2,
        lastError: message,
      }),
    ]);
  });

  it('a false done marker cannot retire or pay unprocessed holdings', async () => {
    const market = await resolved('YES', undefined, { status: 'settling', settlementSteps: false });
    const alice = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 2, costBasisCoin: 60n });
    const completedAt = new Date();
    await createSettlementStep(t.db, {
      marketId: market.id,
      status: 'done',
      attempts: 1,
      completedAt,
    });
    const message = `Market ${market.id} settlement: unsettled positions remain`;
    for (let attempt = 2; attempt <= 3; attempt++) {
      await expect(finalizeMarket(t.db, market.id, publish, logger)).rejects.toThrow(message);
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({
          status: 'done',
          completedAt,
          attempts: attempt,
          lastError: message,
        }),
      ]);
    }
    expect((await marketRow(market.id)).status).toBe('settling');
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 2, settled: false });
    expect((await balanceOf(alice)).availableCoin).toBe(940n);
    expect(await recordsOf(market.id)).toEqual([]);
  });

  it('pays a legacy market with a NULL judgement version once under concurrent finalize jobs', async () => {
    const market = await createMarket(t.db, {
      status: 'resolved',
      resolvedResult: 'VOID',
      resolvedAt: new Date(),
      judgementVersion: null,
    });
    const alice = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 2, costBasisCoin: 60n });
    const results = await Promise.all([
      finalizeMarket(t.db, market.id, publish, logger),
      finalizeMarket(t.db, market.id, publish, logger),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['settled', 'skipped']);
    expect((await balanceOf(alice)).availableCoin).toBe(1_040n);
    const records = await recordsOf(market.id);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.judgementVersion === null)).toBe(true);
    const payouts = (await ledgerOf(alice)).filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
    expect(payouts).toHaveLength(1);
    const [entry] = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, payouts[0]!.id));
    expect(entry?.idempotencyKey).toBe(ledgerKeys.settlement(market.id, null, alice, 'YES'));
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({ status: 'done', attempts: 1 }),
    ]);
  });

  it('rejects an unknown market id instead of skipping it, and records nothing', async () => {
    const marketId = randomUUID();
    await expect(finalizeMarket(t.db, marketId, publish, logger)).rejects.toThrow(/not found/);
    // No market, nowhere to record: no row (the FK would refuse one), no logged record failure.
    expect(await stepsOf(marketId)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('records a database error by its SQLSTATE and driver message, not by the SQL that failed', async () => {
    // drizzle-orm throws every failed query as DrizzleQueryError ("Failed query: <sql>\nparams:
    // …") and keeps the driver error in `cause`: the step must say why, not what ran. A BEFORE
    // UPDATE trigger stands in for a lost deadlock on the coin step's position UPDATE. It is
    // DDL, so it goes through the owner role, and it is dropped whatever happens — `reset()`
    // truncates, it would not.
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const owner = createDb(testDbUrls()!.migrateUrl, {
      max: 1,
      applicationName: 'buddha-test-owner',
    });
    try {
      await owner.execute(
        sql.raw(`CREATE FUNCTION finalize_test_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = 'deadlock_detected'; END $$`),
      );
      await owner.execute(
        sql.raw(`CREATE TRIGGER finalize_test_deadlock BEFORE UPDATE ON positions
          FOR EACH ROW EXECUTE FUNCTION finalize_test_deadlock()`),
      );

      const err = await finalizeMarket(t.db, market.id, publish, logger).catch((e: unknown) => e);
      // The job still fails with the ORIGINAL error: the wrapper, the driver error inside it.
      expect(err).toBeInstanceOf(DrizzleQueryError);
      const { message, cause } = err as DrizzleQueryError;
      expect(message).toMatch(/^Failed query: update "positions"/);
      expect(cause).toMatchObject({ code: '40P01', message: 'deadlock detected' });
      const [step] = await stepsOf(market.id);
      expect(step).toMatchObject({
        step: 'coin',
        status: 'failed',
        attempts: 1,
        completedAt: null,
      });
      expect(step!.lastError).toBe(
        `40P01 deadlock detected — ${message}`.slice(0, SETTLEMENT_STEP_ERROR_MAX),
      );

      // The scan reports it the same way (scan.ts `messageOf`) and the attempt is counted.
      const scan = await finalizeDueMarkets(t.db, publish, logger);
      expect(scan).toMatchObject({ settled: 0, failed: 1, failures: [{ marketId: market.id }] });
      expect(scan.failures[0]!.message).toMatch(
        /^40P01 deadlock detected — Failed query: update "positions"/,
      );
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({ status: 'failed', attempts: 2 }),
      ]);
    } finally {
      await owner.execute(sql.raw('DROP TRIGGER IF EXISTS finalize_test_deadlock ON positions'));
      await owner.execute(sql.raw('DROP FUNCTION IF EXISTS finalize_test_deadlock()'));
      await closeDb(owner);
    }
    expect((await marketRow(market.id)).status).toBe('settling');
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ settled: false, version: 1 });
    expect(logs).toEqual([]);
  });

  it('refuses a remaining contract lock before paying and retries after release (#126)', async () => {
    // ADR-0107 결정 4 #178 row: a lock left at settlement is refused before any payout.
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisCoin: 300n });
    const sell = { kind: 'contracts', outcome: 'YES', qty: 4 } as const;
    const locked = await t.db.transaction((tx) =>
      lockForOrder(tx, { marketId: market.id, ownerId: alice, lock: sell }),
    );
    expect(locked).toMatchObject({ locked: true, position: { qty: 10, lockedQty: 4 } });
    const before = {
      alice: { balance: await balanceOf(alice), ledger: await ledgerOf(alice) },
      bob: { balance: await balanceOf(bob), ledger: await ledgerOf(bob) },
      collateral: await coinOf(collateralOf(market.id)),
      positions: await positionsOf(market.id),
    };
    expect(before.collateral).toBe(1_500n); // fifteen pairs × 100

    const err = await finalizeMarket(t.db, market.id, publish, logger).catch((e: unknown) => e);
    const message = `Market ${market.id} settlement: contract locks remain`;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(message);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        step: 'coin',
        status: 'failed',
        attempts: 1,
        completedAt: null,
        lastError: message,
      }),
    ]);

    // Nobody paid, nothing closed out, the collateral whole, the lock still held.
    for (const [userId, was] of [
      [alice, before.alice],
      [bob, before.bob],
    ] as const) {
      expect(await balanceOf(userId)).toEqual(was.balance);
      expect(await ledgerOf(userId)).toEqual(was.ledger);
    }
    expect(await coinOf(collateralOf(market.id))).toBe(before.collateral);
    expect(await positionsOf(market.id)).toEqual(before.positions);
    expect(await marketRow(market.id)).toMatchObject({ status: 'settling', settledAt: null });

    // Once the lock is released (#93's recovery of a held market, or #178's cancel — before the
    // close, or of a leftover in a market closed before #120, ADR-0115 10-14), a rerun settles
    // and pays. The close expires every other market's resting sell (#120): the next case.
    await t.db.transaction((tx) =>
      releaseForOrder(tx, { marketId: market.id, ownerId: alice, lock: sell }),
    );
    await finalizeMarket(t.db, market.id, publish, logger);
    expect(await marketRow(market.id)).toMatchObject({ status: 'settled' });
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 0,
      lockedQty: 0,
      settled: true,
    });
    expect((await balanceOf(alice)).availableCoin).toBe(
      before.alice.balance.availableCoin + 1_000n,
    );
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({ step: 'coin', status: 'done', attempts: 2 }),
    ]);
    expect((await runLedgerAudit(t.db)).recorded).toBe(0);
    expect(logs).toEqual([]);
  });

  it('settles a market whose resting sell the close expired: no lock is left at settlement (#120)', async () => {
    // ADR-0112 결과 5 '#120' '대기 매도가 잡은 SETTLING': the close at close_at ends the resting sell
    // 만료 and gives its `locked_qty` back, so the step's qty-0 UPDATE meets no lock.
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId: admin });
    // With statistics as a row holds them (#121): neither the close nor the settlement moves one.
    const market = await createMarket(t.db, {
      createdBy: admin,
      lastPrice: 64,
      volumeCoin: 640n,
      tradeCount: 3,
      traderCount: 2,
    });
    const stats = await marketStatsOf(t.db, market.id);
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: alice, noHolderId: bob, qty: 5 });
    const sell = await placeTestOrder(t.db, {
      ownerId: alice,
      marketId: market.id,
      side: 'sell',
      limitPriceCoin: 70,
      qty: 2,
    });
    expect(sell).toMatchObject({ kind: 'placed', order: { status: 'open' } });
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 5, lockedQty: 2 });
    await passMarketClose(t.db, market.id);
    expect(await closeMarket(t.db, market.id, publish)).toMatchObject({
      outcome: 'closed',
      expiredOrders: 1,
    });
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 5, lockedQty: 0 });

    await createProvisionalMarket(t.db, { marketId: market.id, result: 'YES' });
    await resolveMarketNow(t.db, market.id);
    const before = (await balanceOf(alice)).availableCoin;
    await finalizeMarket(t.db, market.id, publish, logger);
    expect(await marketRow(market.id)).toMatchObject({ status: 'settled' });
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 0,
      lockedQty: 0,
      settled: true,
    });
    expect((await balanceOf(alice)).availableCoin).toBe(before + 500n);
    expect((await runLedgerAudit(t.db)).recorded).toBe(0);
    expect(logs).toEqual([]);
    expect(await marketStatsOf(t.db, market.id)).toEqual(stats);
  });

  it('records nothing when another run settled the market between the rollback and the record', async () => {
    // The rollback releases the market lock and the record takes it again, so the job's retry or
    // the scan can settle the market in between (here: the collateral corrected, then a run). The
    // record re-reads the status under the lock and finds `settled`: it issues no INSERT, and the
    // done row stays exactly as that run finished it.
    const market = await resolved('YES');
    const alice = await poisonedWinner(market.id);
    const other: { result?: FinalizeResult } = {};
    const seam = seamed({
      beforeRecord: async () => {
        await correctCollateral(market.id, 1_000n);
        other.result = await finalizeMarket(t.db, market.id, publish, logger);
      },
    });

    await expect(finalizeMarket(seam.db, market.id, publish, logger)).rejects.toThrow(
      alice.message,
    );
    const settled = other.result;
    expect(settled).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidCoin: 1_000n });
    if (settled?.outcome !== 'settled') return;
    expect(seam.inserts).toBe(0);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        step: 'coin',
        status: 'done',
        attempts: 1,
        completedAt: settled.settledAt,
        lastError: null,
        updatedAt: settled.settledAt,
      }),
    ]);
    expect(await marketRow(market.id)).toMatchObject({
      status: 'settled',
      settledAt: settled.settledAt,
    });
    expect((await balanceOf(alice.userId)).availableCoin).toBe(1_000n);
    expect(logs).toEqual([]);
  });

  it('keeps a done step done while exposing a subsequent failure', async () => {
    // A completed step cannot be reopened by the failure recorder. Its error must still be
    // visible while the market remains settling.
    const market = await resolved('YES');
    const alice = await poisonedWinner(market.id);
    const written: (typeof schema.marketSettlementSteps.$inferSelect)[] = [];
    const seam = seamed({
      beforeRecord: async () => {
        written.push(
          ...(await t.db
            .update(schema.marketSettlementSteps)
            .set({ status: 'done', attempts: 1, completedAt: new Date(Date.now() - MINUTE_MS) })
            .where(eq(schema.marketSettlementSteps.marketId, market.id))
            .returning()),
        );
      },
    });

    await expect(finalizeMarket(seam.db, market.id, publish, logger)).rejects.toThrow(
      alice.message,
    );
    // The error is recorded without losing the payment completion marker.
    expect(seam.inserts).toBe(1);
    expect(written).toHaveLength(1);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        status: 'done',
        completedAt: written[0]!.completedAt,
        attempts: 2,
        lastError: alice.message,
      }),
    ]);
    expect((await marketRow(market.id)).status).toBe('settling');
    expect(logs).toEqual([]);
  });

  it('records a failure before any step even when all steps are already done', async () => {
    // A broken market invariant must remain visible even when every payment step is done.
    const market = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: null,
      settlementSteps: false,
    });
    const done = await createSettlementStep(t.db, {
      marketId: market.id,
      status: 'done',
      attempts: 1,
      completedAt: new Date(Date.now() - MINUTE_MS),
    });
    const seam = seamed({});

    await expect(finalizeMarket(seam.db, market.id, publish, logger)).rejects.toThrow(
      `Market ${market.id} is settling without a result`,
    );
    expect(seam.inserts).toBe(1);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({
        status: 'done',
        completedAt: done.completedAt,
        attempts: 2,
        lastError: `Market ${market.id} is settling without a result`,
      }),
    ]);
    expect(logs).toEqual([]);
  });

  it('rethrows the original error when the record itself fails, and logs that once', async () => {
    // Best effort: the record's own transaction failing (here it cannot even open) must not
    // replace the settlement's error — that one is what the job and the scan report.
    const market = await resolved('YES');
    const alice = await poisonedWinner(market.id);
    const stepsBefore = await stepsOf(market.id);
    const seam = seamed({
      beforeRecord: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    });

    await expect(finalizeMarket(seam.db, market.id, publish, logger)).rejects.toThrow(
      alice.message,
    );
    expect(logs).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'settlement step failure not recorded',
        marketId: market.id,
        step: 'coin',
        cause: alice.message,
        err: expect.objectContaining({ message: 'Connection terminated unexpectedly' }) as unknown,
      }),
    ]);
    expect(await stepsOf(market.id)).toEqual(stepsBefore);
    expect((await marketRow(market.id)).status).toBe('settling');
  });

  it('a holder of both outcomes: one payout row for the winning row, the balance event carries its id', async () => {
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 4, costBasisCoin: 200n });
    await hold({ userId: alice, marketId: market.id, outcome: 'NO', qty: 6, costBasisCoin: 300n });

    const subscriber = await subscribeTo([userChannel(alice)]);
    try {
      const result = await finalizeMarket(t.db, market.id, publish, logger);
      // alice's two rows and the 운영 마켓메이커's NO 4 and YES 6 (paid 600 into its funds).
      expect(result).toMatchObject({
        outcome: 'settled',
        positions: 4,
        settledAccounts: 2,
        paidAccounts: 2,
        paidCoin: 1_000n,
      });

      const balance = await balanceOf(alice);
      expect(balance.availableCoin).toBe(10_000n - 200n - 300n + 400n);
      const ledger = await ledgerOf(alice);
      const payouts = ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
      expect(payouts).toHaveLength(1);
      expect(payouts[0]!.amountCoin).toBe(400n);
      expectLedgerChain(ledger, balance.availableCoin);
      // The payout row is the account's newest ledger row: the key the client orders by.
      const newest = ledger.at(-1)!;
      expect(newest.id).toBe(payouts[0]!.id);

      expect((await positionsOf(market.id)).filter((row) => row.userId === alice)).toEqual([
        expect.objectContaining({
          outcome: 'YES',
          qty: 0,
          costBasisCoin: 0n,
          realizedPnlCoin: 200n,
          settled: true,
          version: 2,
        }),
        expect.objectContaining({
          outcome: 'NO',
          qty: 0,
          costBasisCoin: 0n,
          realizedPnlCoin: -300n,
          settled: true,
          version: 2,
        }),
      ]);

      await waitForMessages(subscriber.of(userChannel(alice)), 3, "alice's events");
      await sleep(100);
      const events = subscriber.of(userChannel(alice));
      // ONE balance event (the account's last state), then both rows in (user_id, outcome)
      // order — YES before NO, the enum's order.
      expect(events.map((event) => event.type)).toEqual([
        'user:balance',
        'user:position',
        'user:position',
      ]);
      expect(events[0]).toMatchObject({
        availableCoin: balance.availableCoin.toString(),
        ledgerEntryId: String(newest.id),
        ts: balance.updatedAt.toISOString(),
      });
      expect(events[1]).toMatchObject({ outcome: 'YES', realizedPnlCoin: '200', settled: true });
      expect(events[2]).toMatchObject({ outcome: 'NO', realizedPnlCoin: '-300', settled: true });

      expect((await runLedgerAudit(t.db)).recorded).toBe(0);
    } finally {
      await subscriber.quit();
    }
  });

  it('the payout ledger row sorts after a trade of the same account that committed in between', async () => {
    // The instant of a payout is read after the step's ledger account locks, not after the market
    // lock (ADR-0027 addendum): a pair mint on ANOTHER market that lands between the two must
    // come first in `/me/ledger`'s (created_at, id) order. Reproduced by holding the market lock
    // in one transaction while a pair mint commits, then letting the finalize through. The lock is
    // taken once resolved → settling has committed (the seam), so what queues on it is the step
    // transaction, already begun — the one whose clock reads are under test.
    const market = await resolved('YES');
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({
      userId: alice,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 500n,
    });
    const other = await createMarket(t.db);

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockTaken!: () => void;
    const lockTakenPromise = new Promise<void>((resolve) => (lockTaken = resolve));
    const held: { holder?: Promise<void> } = {};
    const seam = seamed({
      beforeSteps: async () => {
        held.holder = t.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext((${market.id})::uuid::text))`);
          lockTaken();
          await lockHeld;
        });
        await lockTakenPromise;
      },
    });

    const finalize = finalizeMarket(seam.db, market.id, publish, logger);
    await lockTakenPromise;
    // Give the step transaction time to queue on the advisory lock, then commit a pair elsewhere.
    await sleep(200);
    await hold({ userId: alice, marketId: other.id, outcome: 'NO', qty: 1, costBasisCoin: 40n });
    releaseLock();
    await held.holder;

    const result = await finalize;
    expect(result.outcome).toBe('settled');
    const balance = await balanceOf(alice);
    expect(balance.availableCoin).toBe(10_000n - 500n - 40n + 1_000n);
    const ledger = await ledgerOf(alice);
    expect(ledger.map((entry) => entry.type)).toEqual([
      'START_GRANT',
      'PAIR_MINT_COLLATERAL',
      'PAIR_MINT_COLLATERAL',
      'SETTLEMENT_PAYOUT',
    ]);
    expectLedgerChain(ledger, balance.availableCoin);
  });

  it('scan settles every resolved and settling market, judged longest ago first, and leaves the rest alone', async () => {
    // Created in the opposite order of their judgements: the scan orders by `resolved_at`. The
    // later one is already `settling` (a run whose steps failed); the earlier one is still
    // `resolved` (its job was lost) and goes to `settling` first.
    const later = await resolved('NO', new Date(Date.now() - MINUTE_MS), { status: 'settling' });
    const earlier = await resolved('YES', new Date(Date.now() - 2 * MINUTE_MS));
    const closed = await createMarket(t.db, {
      status: 'closed',
      closeAt: new Date(Date.now() - MINUTE_MS),
    });
    // Judged but not confirmed: nothing settles a provisional result (#152).
    const provisional = await createMarket(t.db, {
      status: 'provisional',
      closeAt: new Date(Date.now() - 2 * MINUTE_MS),
      resolvedResult: 'YES',
      resolvedAt: new Date(Date.now() - 3 * MINUTE_MS),
    });
    const settled = await createMarket(t.db, {
      status: 'settled',
      resolvedResult: 'YES',
      settledAt: new Date(Date.now() - MINUTE_MS),
    });
    const cancelled = await createMarket(t.db, { status: 'cancelled' });
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: alice, marketId: earlier.id, outcome: 'YES', qty: 1, costBasisCoin: 50n });
    await hold({ userId: alice, marketId: later.id, outcome: 'NO', qty: 2, costBasisCoin: 60n });
    await hold({ userId: alice, marketId: closed.id, outcome: 'YES', qty: 3, costBasisCoin: 60n });
    await hold({
      userId: alice,
      marketId: provisional.id,
      outcome: 'YES',
      qty: 4,
      costBasisCoin: 80n,
    });

    await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toEqual({
      settled: 2,
      skipped: 0,
      failed: 0,
      failures: [],
    });

    expect((await marketRow(earlier.id)).status).toBe('settled');
    expect((await marketRow(later.id)).status).toBe('settled');
    expect(await eventsOf(earlier.id)).toEqual([
      expect.objectContaining({ type: 'settling', fromStatus: 'resolved', toStatus: 'settling' }),
      expect.objectContaining({ type: 'finalized', fromStatus: 'settling', toStatus: 'settled' }),
    ]);
    expect(await eventsOf(later.id)).toEqual([
      expect.objectContaining({ type: 'finalized', fromStatus: 'settling', toStatus: 'settled' }),
    ]);
    for (const [market, status] of [
      [closed, 'closed'],
      [provisional, 'provisional'],
      [settled, 'settled'],
      [cancelled, 'cancelled'],
    ] as const) {
      expect(await marketRow(market.id)).toMatchObject({ status, statusEventId: null });
      expect(await eventsOf(market.id)).toEqual([]);
    }
    // Judged longest ago first: the earlier market settled first.
    const [, finalizedEarlier] = await eventsOf(earlier.id);
    const [finalizedLater] = await eventsOf(later.id);
    expect(finalizedEarlier!.id).toBeLessThan(finalizedLater!.id);
    for (const market of [earlier, later]) {
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({ step: 'coin', status: 'done', attempts: 1 }),
      ]);
    }
    expect(await stepsOf(closed.id)).toEqual([]);
    expect(await stepsOf(provisional.id)).toEqual([]);

    const balance = await balanceOf(alice);
    expect(balance.availableCoin).toBe(10_000n - 50n - 60n - 60n - 80n + 100n + 200n);
    const ledger = await ledgerOf(alice);
    expect(
      ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT').map((e) => e.amountCoin),
    ).toEqual([100n, 200n]);
    expectLedgerChain(ledger, balance.availableCoin);
    expect(await positionOf(alice, closed.id, 'YES')).toMatchObject({ qty: 3, settled: false });
    expect(await positionOf(alice, provisional.id, 'YES')).toMatchObject({
      qty: 4,
      settled: false,
    });

    await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toEqual({
      settled: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await runLedgerAudit(t.db)).recorded).toBe(0);
  });

  it('scan: a market whose settlement fails is reported and recorded, and the markets after it still settle', async () => {
    // The poisoned market was judged EARLIER, so it is the first candidate of this run and of
    // every later one — the position from which, before the per-market catch, it stopped the
    // safety net at itself for good.
    const poisoned = await resolved('YES', new Date(Date.now() - 2 * MINUTE_MS));
    const healthy = await resolved('NO', new Date(Date.now() - MINUTE_MS));
    // alice's YES 4 was never collateralised: the collateral cannot pay its 400 Coin.
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await createPosition(t.db, {
      userId: alice,
      marketId: poisoned.id,
      outcome: 'YES',
      qty: 4,
      costBasisCoin: 200n,
    });
    const message = `Market ${poisoned.id} settlement: contract supply does not match pair collateral`;
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await hold({ userId: bob, marketId: healthy.id, outcome: 'NO', qty: 2, costBasisCoin: 60n });

    const subscriber = await subscribeTo([
      marketChannel(poisoned.id),
      marketChannel(healthy.id),
      userChannel(alice),
      userChannel(bob),
    ]);
    try {
      await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toEqual({
        settled: 1,
        skipped: 0,
        failed: 1,
        failures: [
          {
            marketId: poisoned.id,
            message,
            err: expect.any(Error) as Error,
          },
        ],
      });

      // The poisoned market: its steps rolled back, left `settling` (its resolved → settling
      // committed first), nobody paid — and the attempt recorded on its step.
      const poisonedEvents = await eventsOf(poisoned.id);
      expect(poisonedEvents).toEqual([
        expect.objectContaining({ type: 'settling', fromStatus: 'resolved', toStatus: 'settling' }),
      ]);
      expect(await marketRow(poisoned.id)).toMatchObject({
        status: 'settling',
        settledAt: null,
        statusEventId: poisonedEvents[0]!.id,
      });
      expect(await positionOf(alice, poisoned.id, 'YES')).toMatchObject({
        qty: 4,
        settled: false,
        version: 1,
      });
      expect(await stepsOf(poisoned.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'failed',
          attempts: 1,
          completedAt: null,
          lastError: message,
        }),
      ]);

      // The healthy market after it: settled as if the poisoned one were not there.
      expect((await marketRow(healthy.id)).status).toBe('settled');
      expect((await balanceOf(bob)).availableCoin).toBe(10_000n - 60n + 200n);
      expect(await positionOf(bob, healthy.id, 'NO')).toMatchObject({ settled: true, version: 2 });
      expect(await stepsOf(healthy.id)).toEqual([
        expect.objectContaining({ step: 'coin', status: 'done', attempts: 1, lastError: null }),
      ]);

      await waitForMessages(subscriber.of(marketChannel(healthy.id)), 2, 'healthy market status');
      await waitForMessages(subscriber.of(marketChannel(poisoned.id)), 1, 'poisoned settling');
      await waitForMessages(subscriber.of(userChannel(bob)), 2, "bob's events");
      await sleep(100);
      expect(subscriber.of(marketChannel(healthy.id)).map((event) => event.status)).toEqual([
        'settling',
        'settled',
      ]);
      // The poisoned market's payout started (지급 중) and stays there: all it announced.
      expect(subscriber.of(marketChannel(poisoned.id))).toEqual([
        expect.objectContaining({ status: 'settling' }),
      ]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);

      // A minute later: the poisoned market, `settling` now, is still first, still fails, is
      // still reported — still does not throw — and each attempt is counted on its step (no
      // retry cap, D6). Its resolved → settling is not repeated.
      await expect(finalizeDueMarkets(t.db, publish, logger)).resolves.toMatchObject({
        settled: 0,
        skipped: 0,
        failed: 1,
        failures: [{ marketId: poisoned.id }],
      });
      expect(await stepsOf(poisoned.id)).toEqual([
        expect.objectContaining({ status: 'failed', attempts: 2 }),
      ]);
      expect(await eventsOf(poisoned.id)).toEqual(poisonedEvents);
      expect(logs).toEqual([]);
    } finally {
      await subscriber.quit();
    }
  });
});
