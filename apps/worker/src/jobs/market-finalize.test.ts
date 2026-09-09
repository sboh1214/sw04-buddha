/**
 * market.finalize integration test (PLAN M5 AC 3, PLAN 5.5 확정) against the docker `test`
 * profile: the database through the packages/db harness, Redis through TEST_REDIS_URL. Skips
 * when either is unset, exactly like ledger-audit.test.ts.
 *
 * Holders are built the way admin-markets.controller.test.ts builds them for the void: a
 * position row plus the balance debit and TRADE_BUY ledger row a real buy would have written,
 * so the ledger explains the position and the audit (PLAN 5.6) can be run on the result.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createPosition,
  createUser,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import { marketChannel, userChannel, type Outcome } from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, type Publish } from '../realtime.js';
import { runLedgerAudit } from './ledger-audit.js';
import { finalizeDueMarkets, finalizeMarket } from './market-finalize.js';

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

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;

/**
 * apps/api/src/test/ledger.ts, copied: the worker must not import apps/api (PLAN 4.1). One
 * account's ledger as the suites read it (id ascending). Listed by (created_at, id) the rows
 * come out in that same order, every balance_after_p is the previous one plus its own amount,
 * and the sum is the balance row. A payout stamped before the buy it follows (transaction-start
 * `now()`, or a clock read before the balance lock) breaks the first of these.
 */
function expectLedgerChain(entries: LedgerRow[], finalBalanceP: bigint): void {
  const listed = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  expect(
    listed.map((entry) => entry.id),
    '(created_at, id) order disagrees with commit order',
  ).toEqual(entries.map((entry) => entry.id));
  let running = 0n;
  for (const entry of entries) {
    running += entry.amountP;
    expect(entry.balanceAfterP, `${entry.type} #${String(entry.id)}`).toBe(running);
  }
  expect(running, 'ledger sum vs balance row').toBe(finalBalanceP);
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestInfra)('market.finalize (integration)', () => {
  let t: TestDb;
  let redis: Redis;
  let publish: Publish;

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
  });

  /** A market whose dispute window closed `ago` ms ago (default one minute), result `result`. */
  async function resolving(
    result: Outcome = 'YES',
    disputeUntil = new Date(Date.now() - MINUTE_MS),
  ) {
    return createMarket(t.db, {
      status: 'resolving',
      closeAt: new Date(disputeUntil.getTime() - DAY_MS - MINUTE_MS),
      resolvedResult: result,
      resolvedAt: new Date(disputeUntil.getTime() - DAY_MS),
      disputeUntil,
    });
  }

  /**
   * A holder as a buy would have left it: the position row, the balance debited by its cost
   * and the TRADE_BUY ledger row that explains the debit. Without the last two the audit
   * would flag the account and the payout's chain would have nothing to follow.
   */
  async function hold(input: {
    userId: string;
    marketId: string;
    outcome: Outcome;
    qty: number;
    costBasisP: bigint;
    realizedPnlP?: bigint;
    settled?: boolean;
  }) {
    const position = await createPosition(t.db, input);
    if (input.costBasisP === 0n) return position;
    const [balance] = await t.db
      .update(schema.balances)
      .set({ availableP: sql`${schema.balances.availableP} - ${input.costBasisP}` })
      .where(eq(schema.balances.userId, input.userId))
      .returning();
    await t.db.insert(schema.ledgerEntries).values({
      userId: input.userId,
      type: 'TRADE_BUY',
      amountP: -input.costBasisP,
      balanceAfterP: balance!.availableP,
      refType: 'fill',
      refId: '0',
    });
    return position;
  }

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  async function eventsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
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
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
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

  it('pays the winning holders, closes out every row and settles the market (M5 AC 3)', async () => {
    const market = await resolving('YES');
    // alice: YES 10 for 500P → paid 1,000P, realised +500.
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });
    // bob: NO 5 for 300P → nothing, realised −300.
    const bob = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisP: 300n });
    // carol sold her YES contracts before the close: an unsettled row at qty 0 with a realised
    // gain. Closed out like the others, but there is nothing to pay and no balance event.
    const carol = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({
      userId: carol,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      costBasisP: 0n,
      realizedPnlP: 120n,
    });
    // dave's row is already settled (the idempotency marker): never touched, never paid.
    const dave = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({
      userId: dave,
      marketId: market.id,
      outcome: 'YES',
      qty: 3,
      costBasisP: 0n,
      settled: true,
    });
    // A holder in another market is untouched.
    const other = await createMarket(t.db, { status: 'closed' });
    await hold({ userId: alice, marketId: other.id, outcome: 'YES', qty: 2, costBasisP: 90n });

    const subscriber = await subscribeTo([
      marketChannel(market.id),
      userChannel(alice),
      userChannel(bob),
      userChannel(carol),
      userChannel(dave),
    ]);
    try {
      const result = await finalizeMarket(t.db, market.id, publish);
      expect(result.outcome).toBe('settled');
      if (result.outcome !== 'settled') return;
      expect(result).toMatchObject({
        marketId: market.id,
        positions: 3,
        settledAccounts: 3,
        paidAccounts: 1,
        paidP: 1_000n,
      });

      // --- alice: +1,000P, one SETTLEMENT_PAYOUT row, the chain intact, realised +500 ------
      const aliceBalance = await balanceOf(alice);
      expect(aliceBalance.availableP).toBe(10_000n - 500n - 90n + 1_000n);
      const aliceLedger = await ledgerOf(alice);
      const payouts = aliceLedger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
      expect(payouts).toHaveLength(1);
      expect(payouts[0]).toMatchObject({
        amountP: 1_000n,
        balanceAfterP: aliceBalance.availableP,
        refType: 'market',
        refId: market.id,
        memo: `정산 지급: ${market.title}`,
        // Stamped with the account's own post-lock instant, which the balance row carries too.
        createdAt: aliceBalance.updatedAt,
      });
      expectLedgerChain(aliceLedger, aliceBalance.availableP);
      const aliceYes = await positionOf(alice, market.id, 'YES');
      expect(aliceYes).toMatchObject({
        qty: 0,
        costBasisP: 0n,
        realizedPnlP: 500n,
        settled: true,
        version: 2,
        updatedAt: result.settledAt,
      });
      // The other market's row is not this settlement's business.
      expect(await positionOf(alice, other.id, 'YES')).toMatchObject({
        qty: 2,
        costBasisP: 90n,
        settled: false,
        version: 1,
      });

      // --- bob: nothing paid, realised −cost, row closed out ------------------------------
      expect((await balanceOf(bob)).availableP).toBe(10_000n - 300n);
      expect((await ledgerOf(bob)).map((entry) => entry.type)).toEqual(['BONUS', 'TRADE_BUY']);
      expect(await positionOf(bob, market.id, 'NO')).toMatchObject({
        qty: 0,
        costBasisP: 0n,
        realizedPnlP: -300n,
        settled: true,
        version: 2,
      });

      // --- carol: closed out, realised untouched, nothing paid ---------------------------
      expect((await balanceOf(carol)).availableP).toBe(10_000n);
      expect(await positionOf(carol, market.id, 'YES')).toMatchObject({
        qty: 0,
        realizedPnlP: 120n,
        settled: true,
        version: 2,
      });

      // --- dave: the already-settled row is skipped entirely -----------------------------
      expect((await balanceOf(dave)).availableP).toBe(10_000n);
      expect(await positionOf(dave, market.id, 'YES')).toMatchObject({ qty: 3, version: 1 });

      // --- market ------------------------------------------------------------------------
      const row = await marketRow(market.id);
      const [event] = await eventsOf(market.id);
      expect(event).toMatchObject({
        type: 'finalized',
        actorId: null,
        payload: {
          result: 'YES',
          settledAccounts: 3,
          paidAccounts: 1,
          paidP: '1000',
          positions: 3,
        },
        createdAt: result.settledAt,
      });
      expect(row).toMatchObject({
        status: 'settled',
        settledAt: result.settledAt,
        updatedAt: result.settledAt,
        statusEventId: event!.id,
        resolvedResult: 'YES',
        disputeUntil: market.disputeUntil,
      });
      expect(result.statusEventId).toBe(event!.id);
      expect(result.settledAt.getTime()).toBeGreaterThanOrEqual(market.disputeUntil!.getTime());

      // --- published after COMMIT (PLAN 8) -----------------------------------------------
      await waitForMessages(subscriber.of(marketChannel(market.id)), 1, 'market:status');
      await waitForMessages(subscriber.of(userChannel(alice)), 2, "alice's events");
      await waitForMessages(subscriber.of(userChannel(bob)), 1, "bob's events");
      await waitForMessages(subscriber.of(userChannel(carol)), 1, "carol's events");
      await sleep(100);
      const ts = result.settledAt.toISOString();
      expect(subscriber.of(marketChannel(market.id))).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'settled',
          resolvedResult: 'YES',
          disputeUntil: market.disputeUntil!.toISOString(),
          statusEventId: String(event!.id),
          ts,
        },
      ]);
      expect(subscriber.of(userChannel(alice))).toEqual([
        {
          type: 'user:balance',
          availableP: aliceBalance.availableP.toString(),
          lockedP: '0',
          ledgerEntryId: String(payouts[0]!.id),
          ts: aliceBalance.updatedAt.toISOString(),
        },
        {
          type: 'user:position',
          marketId: market.id,
          outcome: 'YES',
          qty: 0,
          costBasisP: '0',
          realizedPnlP: '500',
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
          costBasisP: '0',
          realizedPnlP: '-300',
          settled: true,
          version: 2,
          ts,
        },
      ]);
      expect(subscriber.of(userChannel(carol))).toEqual([
        expect.objectContaining({ type: 'user:position', outcome: 'YES', realizedPnlP: '120' }),
      ]);
      expect(subscriber.of(userChannel(dave))).toEqual([]);

      // --- the books still balance (PLAN 5.6): every payout has its ledger row -----------
      const audit = await runLedgerAudit(t.db);
      expect(audit.checked).toBe(6); // four holders + the two markets' creators
      expect(audit.mismatches).toEqual([]);
      expect(audit.recorded).toBe(0);
    } finally {
      await subscriber.quit();
    }
  });

  it('pays NO holders when the result is NO', async () => {
    const market = await resolving('NO');
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });
    const bob = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'NO', qty: 5, costBasisP: 300n });

    const result = await finalizeMarket(t.db, market.id, publish);
    expect(result).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidP: 500n });
    expect((await balanceOf(alice)).availableP).toBe(9_500n);
    expect((await balanceOf(bob)).availableP).toBe(10_000n - 300n + 500n);
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      realizedPnlP: -500n,
      settled: true,
    });
    expect(await positionOf(bob, market.id, 'NO')).toMatchObject({
      realizedPnlP: 200n,
      settled: true,
    });
    expectLedgerChain(await ledgerOf(bob), 10_200n);
  });

  it('re-run: a second finalize is skipped and pays nothing twice (M5 AC 3 멱등)', async () => {
    const market = await resolving('YES');
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });
    const first = await finalizeMarket(t.db, market.id, publish);
    expect(first.outcome).toBe('settled');

    const subscriber = await subscribeTo([marketChannel(market.id), userChannel(alice)]);
    try {
      // The delayed job's retry, a duplicate scan, or a manual run: all find `settled`.
      await expect(finalizeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_resolving',
      });
      await expect(finalizeDueMarkets(t.db, publish)).resolves.toEqual({
        settled: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      expect((await balanceOf(alice)).availableP).toBe(10_500n);
      const ledger = await ledgerOf(alice);
      expect(ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT')).toHaveLength(1);
      expectLedgerChain(ledger, 10_500n);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ version: 2 });
      expect(await eventsOf(market.id)).toHaveLength(1);
      await sleep(100);
      expect(subscriber.of(marketChannel(market.id))).toEqual([]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);
    } finally {
      await subscriber.quit();
    }
  });

  it('skips a market whose dispute window is still open (a stale job after a result change)', async () => {
    const market = await resolving('YES', new Date(Date.now() + MINUTE_MS));
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });

    await expect(finalizeMarket(t.db, market.id, publish)).resolves.toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_due',
    });
    await expect(finalizeDueMarkets(t.db, publish)).resolves.toEqual({
      settled: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(await marketRow(market.id)).toMatchObject({
      status: 'resolving',
      settledAt: null,
      statusEventId: null,
      updatedAt: market.updatedAt,
    });
    expect((await balanceOf(alice)).availableP).toBe(9_500n);
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 10,
      settled: false,
      version: 1,
    });
    expect(await eventsOf(market.id)).toEqual([]);
  });

  it('skips a resolving market with no dispute deadline at all', async () => {
    // Not reachable through the API (resolve writes both columns), but the guard is what
    // keeps a null from reading as "due" (`null > now` is false in JS, and that is not a check).
    const market = await createMarket(t.db, {
      status: 'resolving',
      resolvedResult: 'YES',
      disputeUntil: null,
    });
    await expect(finalizeMarket(t.db, market.id, publish)).resolves.toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_due',
    });
  });

  it.each(['draft', 'open', 'closed', 'settled', 'voided'] as const)(
    'skips a %s market: only a proposed result can be finalized',
    async (status) => {
      const market = await createMarket(t.db, {
        status,
        resolvedResult: status === 'settled' ? 'YES' : null,
        disputeUntil: new Date(Date.now() - MINUTE_MS),
      });
      const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
      await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });

      await expect(finalizeMarket(t.db, market.id, publish)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_resolving',
      });
      expect((await marketRow(market.id)).status).toBe(status);
      expect((await balanceOf(alice)).availableP).toBe(9_500n);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({ qty: 10, settled: false });
    },
  );

  it('fails loudly — and rolls back — on a resolving market without a result', async () => {
    const market = await createMarket(t.db, {
      status: 'resolving',
      resolvedResult: null,
      disputeUntil: new Date(Date.now() - MINUTE_MS),
    });
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });

    await expect(finalizeMarket(t.db, market.id, publish)).rejects.toThrow(/without a result/);
    // Nothing settled as a loser by default: the row and the market are as they were.
    expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
      qty: 10,
      settled: false,
      version: 1,
    });
    expect((await marketRow(market.id)).status).toBe('resolving');
    expect(await eventsOf(market.id)).toEqual([]);
  });

  it('fails the whole settlement — and rolls back — when a winning holder has no balance row', async () => {
    // buddha_app keeps DELETE on `balances` (ledger-audit.test.ts), so a winner without a row
    // is reachable through a bug. The deliberate choice (market-finalize.ts) is all or
    // nothing: paying the other winners and leaving this row unsettled would be a partial
    // settlement nothing else understands. Whichever of the two the (user_id, outcome)
    // order visits first — alice's payout may already have been written when bob's lock
    // finds no row — the rollback leaves both exactly as they were.
    const market = await resolving('YES');
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });
    const bob = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: bob, marketId: market.id, outcome: 'YES', qty: 5, costBasisP: 250n });
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, bob));
    const aliceBefore = await balanceOf(alice);
    const aliceLedgerBefore = await ledgerOf(alice);

    const subscriber = await subscribeTo([
      marketChannel(market.id),
      userChannel(alice),
      userChannel(bob),
    ]);
    try {
      await expect(finalizeMarket(t.db, market.id, publish)).rejects.toThrow(/Balance not found/);

      expect(await balanceOf(alice)).toEqual(aliceBefore);
      expect(await ledgerOf(alice)).toEqual(aliceLedgerBefore);
      expect(await positionOf(alice, market.id, 'YES')).toMatchObject({
        qty: 10,
        costBasisP: 500n,
        settled: false,
        version: 1,
      });
      expect(await positionOf(bob, market.id, 'YES')).toMatchObject({
        qty: 5,
        costBasisP: 250n,
        settled: false,
        version: 1,
      });
      expect(await marketRow(market.id)).toMatchObject({
        status: 'resolving',
        settledAt: null,
        statusEventId: null,
        updatedAt: market.updatedAt,
      });
      expect(await eventsOf(market.id)).toEqual([]);

      // Nothing committed, so nothing to tell anyone.
      await sleep(100);
      expect(subscriber.of(marketChannel(market.id))).toEqual([]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);
      expect(subscriber.of(userChannel(bob))).toEqual([]);
    } finally {
      await subscriber.quit();
    }
  });

  it('rejects an unknown market id instead of skipping it', async () => {
    await expect(finalizeMarket(t.db, randomUUID(), publish)).rejects.toThrow(/not found/);
  });

  it('a holder of both outcomes: one payout row for the winning row, the balance event carries its id', async () => {
    const market = await resolving('YES');
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 4, costBasisP: 200n });
    await hold({ userId: alice, marketId: market.id, outcome: 'NO', qty: 6, costBasisP: 300n });

    const subscriber = await subscribeTo([userChannel(alice)]);
    try {
      const result = await finalizeMarket(t.db, market.id, publish);
      expect(result).toMatchObject({
        outcome: 'settled',
        positions: 2,
        settledAccounts: 1,
        paidAccounts: 1,
        paidP: 400n,
      });

      const balance = await balanceOf(alice);
      expect(balance.availableP).toBe(10_000n - 200n - 300n + 400n);
      const ledger = await ledgerOf(alice);
      const payouts = ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT');
      expect(payouts).toHaveLength(1);
      expect(payouts[0]!.amountP).toBe(400n);
      expectLedgerChain(ledger, balance.availableP);
      // The payout row is the account's newest ledger row: the key the client orders by.
      const newest = ledger.at(-1)!;
      expect(newest.id).toBe(payouts[0]!.id);

      expect(await positionsOf(market.id)).toEqual([
        expect.objectContaining({
          outcome: 'YES',
          qty: 0,
          costBasisP: 0n,
          realizedPnlP: 200n,
          settled: true,
          version: 2,
        }),
        expect.objectContaining({
          outcome: 'NO',
          qty: 0,
          costBasisP: 0n,
          realizedPnlP: -300n,
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
        availableP: balance.availableP.toString(),
        ledgerEntryId: String(newest.id),
        ts: balance.updatedAt.toISOString(),
      });
      expect(events[1]).toMatchObject({ outcome: 'YES', realizedPnlP: '200', settled: true });
      expect(events[2]).toMatchObject({ outcome: 'NO', realizedPnlP: '-300', settled: true });

      expect((await runLedgerAudit(t.db)).recorded).toBe(0);
    } finally {
      await subscriber.quit();
    }
  });

  it('the payout ledger row sorts after a trade of the same account that committed in between', async () => {
    // The instant of a payout is read after the account's balance lock, not after the market
    // lock (ADR-0027 addendum): a buy on ANOTHER market that lands between the two must come
    // first in `/me/ledger`'s (created_at, id) order. Reproduced by holding the market lock
    // in one transaction while a buy commits, then letting the finalize through.
    const market = await resolving('YES');
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: market.id, outcome: 'YES', qty: 10, costBasisP: 500n });
    const other = await createMarket(t.db);

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockTaken!: () => void;
    const lockTakenPromise = new Promise<void>((resolve) => (lockTaken = resolve));
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext((${market.id})::uuid::text))`);
      lockTaken();
      await lockHeld;
    });
    await lockTakenPromise;

    const finalize = finalizeMarket(t.db, market.id, publish);
    // Give the finalize time to queue on the advisory lock, then commit a buy elsewhere.
    await sleep(200);
    await hold({ userId: alice, marketId: other.id, outcome: 'NO', qty: 1, costBasisP: 40n });
    releaseLock();
    await holder;

    const result = await finalize;
    expect(result.outcome).toBe('settled');
    const balance = await balanceOf(alice);
    expect(balance.availableP).toBe(10_000n - 500n - 40n + 1_000n);
    const ledger = await ledgerOf(alice);
    expect(ledger.map((entry) => entry.type)).toEqual([
      'BONUS',
      'TRADE_BUY',
      'TRADE_BUY',
      'SETTLEMENT_PAYOUT',
    ]);
    expectLedgerChain(ledger, balance.availableP);
  });

  it('scan settles every due resolving market, each in its own transaction, and reports counts', async () => {
    const dueA = await resolving('YES', new Date(Date.now() - 2 * MINUTE_MS));
    const dueB = await resolving('NO', new Date(Date.now() - MINUTE_MS));
    const pending = await resolving('YES', new Date(Date.now() + MINUTE_MS));
    const closed = await createMarket(t.db, {
      status: 'closed',
      disputeUntil: new Date(Date.now() - MINUTE_MS),
    });
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: dueA.id, outcome: 'YES', qty: 1, costBasisP: 50n });
    await hold({ userId: alice, marketId: dueB.id, outcome: 'NO', qty: 2, costBasisP: 60n });
    await hold({ userId: alice, marketId: pending.id, outcome: 'YES', qty: 3, costBasisP: 70n });

    await expect(finalizeDueMarkets(t.db, publish)).resolves.toEqual({
      settled: 2,
      skipped: 0,
      failed: 0,
      failures: [],
    });

    expect((await marketRow(dueA.id)).status).toBe('settled');
    expect((await marketRow(dueB.id)).status).toBe('settled');
    expect((await marketRow(pending.id)).status).toBe('resolving');
    expect(await marketRow(closed.id)).toMatchObject({ status: 'closed', statusEventId: null });
    // Oldest deadline first: dueA's event has the smaller id.
    const [eventA] = await eventsOf(dueA.id);
    const [eventB] = await eventsOf(dueB.id);
    expect(eventA!.id).toBeLessThan(eventB!.id);

    const balance = await balanceOf(alice);
    expect(balance.availableP).toBe(10_000n - 50n - 60n - 70n + 100n + 200n);
    const ledger = await ledgerOf(alice);
    expect(
      ledger.filter((entry) => entry.type === 'SETTLEMENT_PAYOUT').map((e) => e.amountP),
    ).toEqual([100n, 200n]);
    expectLedgerChain(ledger, balance.availableP);
    expect(await positionOf(alice, pending.id, 'YES')).toMatchObject({ qty: 3, settled: false });

    await expect(finalizeDueMarkets(t.db, publish)).resolves.toEqual({
      settled: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await runLedgerAudit(t.db)).recorded).toBe(0);
  });

  it('scan: a market whose settlement fails is reported, and the markets due after it still settle', async () => {
    // The poisoned market has the EARLIER deadline, so it is the first candidate of this run
    // and of every later one — the position from which, before the per-market catch, it
    // stopped the safety net at itself for good.
    const poisoned = await resolving('YES', new Date(Date.now() - 2 * MINUTE_MS));
    const healthy = await resolving('NO', new Date(Date.now() - MINUTE_MS));
    const alice = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: alice, marketId: poisoned.id, outcome: 'YES', qty: 4, costBasisP: 200n });
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, alice));
    const bob = (await createUser(t.db, { balanceP: 10_000n })).user.id;
    await hold({ userId: bob, marketId: healthy.id, outcome: 'NO', qty: 2, costBasisP: 60n });

    const subscriber = await subscribeTo([
      marketChannel(poisoned.id),
      marketChannel(healthy.id),
      userChannel(alice),
      userChannel(bob),
    ]);
    try {
      await expect(finalizeDueMarkets(t.db, publish)).resolves.toEqual({
        settled: 1,
        skipped: 0,
        failed: 1,
        failures: [
          {
            marketId: poisoned.id,
            message: expect.stringMatching(/Balance not found/) as string,
            err: expect.any(Error) as Error,
          },
        ],
      });

      // The poisoned market: rolled back, still resolving, nobody paid, nothing announced.
      expect(await marketRow(poisoned.id)).toMatchObject({
        status: 'resolving',
        settledAt: null,
        statusEventId: null,
      });
      expect(await eventsOf(poisoned.id)).toEqual([]);
      expect(await positionOf(alice, poisoned.id, 'YES')).toMatchObject({
        qty: 4,
        settled: false,
        version: 1,
      });

      // The healthy market after it: settled as if the poisoned one were not there.
      expect((await marketRow(healthy.id)).status).toBe('settled');
      expect((await balanceOf(bob)).availableP).toBe(10_000n - 60n + 200n);
      expect(await positionOf(bob, healthy.id, 'NO')).toMatchObject({ settled: true, version: 2 });

      await waitForMessages(subscriber.of(marketChannel(healthy.id)), 1, 'healthy market status');
      await waitForMessages(subscriber.of(userChannel(bob)), 2, "bob's events");
      await sleep(100);
      expect(subscriber.of(marketChannel(poisoned.id))).toEqual([]);
      expect(subscriber.of(userChannel(alice))).toEqual([]);

      // A minute later: the poisoned market is still first, still fails, is still reported —
      // and still does not throw.
      await expect(finalizeDueMarkets(t.db, publish)).resolves.toMatchObject({
        settled: 0,
        skipped: 0,
        failed: 1,
        failures: [{ marketId: poisoned.id }],
      });
    } finally {
      await subscriber.quit();
    }
  });
});
