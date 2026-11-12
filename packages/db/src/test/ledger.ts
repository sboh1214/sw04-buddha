/**
 * Ledger test helpers (#116, ADR-0109; ADR-0107 결정 2 #73 7항: DB 팩토리는 새 원장 모델의 시험
 * 도우미를 쓴다). Every one moves Coin through `recordLedgerEntry`, as production does — no test
 * writes a balance or an entry around it, and no test-only ledger type exists — except
 * `withLedgerGuardsOff`, the one door for a test that must break the books on purpose (the ledger
 * audit's mismatch cases). Coin comes to a person's account by its start grant (`createUser`'s
 * `balanceCoin`), goes out as pair-mint collateral (`mintTestPairs`, the real pair mint of
 * contracts.ts; `spendCoin`, one leg alone), and comes to the 운영 마켓메이커's funds through the
 * treasury (`fundMarketMakerFunds`).
 */
import { randomUUID } from 'node:crypto';
import { pairPrices, type Outcome } from '@buddha/shared';
import { asc, eq, isNull, or, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../client.js';
import { applyPairMintFill, lockForOrder, lockOrderHolders } from '../contracts.js';
import {
  findLedgerAccount,
  ledgerEntryForAccount,
  ledgerKeys,
  recordLedgerEntry,
  type LedgerAccountRef,
  type LedgerEntryInput,
  type RecordLedgerEntryResult,
} from '../ledger.js';
import * as schema from '../schema/index.js';
import { balances, ledgerEntries, markets } from '../schema/index.js';
import { mintTreasury } from '../treasury.js';
import { readMarketMakerConfig } from '../market-liquidity.js';
import { lockMarket } from '../tx-helpers.js';
import {
  createApprovalRequest,
  createMarket,
  createMarketMakerAccount,
  createUser,
  setReleaseSetting,
} from './factories.js';
import { createFillRecord, priceAndQtyOf } from './orders.js';
import { testDbUrls } from './harness.js';

/** One event as a person's ledger shows it: signed from its side, its total after. */
export interface AccountLedgerRow {
  id: number;
  type: (typeof ledgerEntries.$inferSelect)['type'];
  amountCoin: bigint;
  balanceAfterCoin: bigint;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: Date;
}

/**
 * The events of a ledger account in order — by id, the chain's (migration 0060 follows it, not
 * the clock) — as that account sees them (`ledgerEntryForAccount`). A person's by account id; []
 * when it has no ledger account.
 */
export async function ledgerOf(
  db: Db,
  owner: string | LedgerAccountRef,
): Promise<AccountLedgerRow[]> {
  const ref: LedgerAccountRef = typeof owner === 'string' ? { kind: 'user', userId: owner } : owner;
  const account = await findLedgerAccount(db, ref);
  if (!account) return [];
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(
      or(eq(ledgerEntries.fromAccountId, account.id), eq(ledgerEntries.toAccountId, account.id)),
    )
    .orderBy(asc(ledgerEntries.id));
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    ...ledgerEntryForAccount(row, account.id),
    refType: row.refType,
    refId: row.refId,
    memo: row.memo,
    createdAt: row.createdAt,
  }));
}

/**
 * The books in four sums: Coin minted (events with no from-account), Coin burned (no to-account),
 * Coin held (every ledger account's available + locked) and Coin carried (every ledger account's
 * ledger total, `ledger_coin`). Conservation is `carriedCoin === mintedCoin - burnedCoin`, and
 * `heldCoin` the same while no account's total left its ledger (#116, #93's totals).
 */
export async function ledgerSupply(
  db: Db,
): Promise<{ mintedCoin: bigint; burnedCoin: bigint; heldCoin: bigint; carriedCoin: bigint }> {
  const [minted] = await db
    .select({ sum: sql<string>`coalesce(sum(${ledgerEntries.amountCoin}), 0)::text` })
    .from(ledgerEntries)
    .where(isNull(ledgerEntries.fromAccountId));
  const [burned] = await db
    .select({ sum: sql<string>`coalesce(sum(${ledgerEntries.amountCoin}), 0)::text` })
    .from(ledgerEntries)
    .where(isNull(ledgerEntries.toAccountId));
  const [held] = await db
    .select({
      sum: sql<string>`coalesce(sum(${balances.availableCoin} + ${balances.lockedCoin}), 0)::text`,
      carried: sql<string>`coalesce(sum(${balances.ledgerCoin}), 0)::text`,
    })
    .from(balances);
  return {
    mintedCoin: BigInt(minted!.sum),
    burnedCoin: BigInt(burned!.sum),
    heldCoin: BigInt(held!.sum),
    carriedCoin: BigInt(held!.carried),
  };
}

export interface SpendCoinOptions {
  /** The market whose collateral takes it. Default: a new open market. */
  marketId?: string;
}

/**
 * Takes `amountCoin` out of a person's available Coin as one pair-mint leg with no pair: a fill
 * record (`createFillRecord`: the person's YES buy at the price × qty `priceAndQtyOf` makes of
 * the amount, against the 운영 마켓메이커's resting NO buy) and its YES PAIR_MINT_COLLATERAL into
 * the market's collateral — the leg migration 0062 binds to that fill — and no NO leg, lock or
 * position: collateral without contracts, which only a test makes (no production path records one
 * leg alone: contract-writes.test.ts). For a test that needs a person to have spent Coin — a
 * refund's shortfall, a closure's balance — and nothing of the trade itself; the person then has a
 * fill on the market (`hasMarketFill`). Throws for an amount no price × qty makes. Returns the
 * event.
 */
export async function spendCoin(
  db: Db,
  userId: string,
  amountCoin: bigint,
  options: SpendCoinOptions = {},
) {
  const marketId = options.marketId ?? (await createMarket(db)).id;
  const { fill } = await createFillRecord(db, {
    marketId,
    incomingOwnerId: userId,
    restingOwnerId: await createMarketMakerAccount(db),
    ...priceAndQtyOf(amountCoin),
  });
  const fillId = String(fill.id);
  return db.transaction(async (tx) => {
    const done = await recordLedgerEntry(tx, {
      type: 'PAIR_MINT_COLLATERAL',
      amountCoin,
      from: { kind: 'user', userId },
      to: { kind: 'market_collateral', marketId },
      refType: 'fill',
      refId: fillId,
      idempotencyKey: ledgerKeys.fillLeg(fillId, 'YES'),
    });
    return done.entry;
  });
}

/**
 * Legacy, already-open/arbitrary-capital fixture. Production initial funding goes through
 * prepareMarketMakerOpening + the common opening. Old tests of fills, settlement and corruption
 * need pre-0069 capital at a chosen amount (sometimes several allocations); only the TEST owner
 * can bypass the new INSERT binding for that historical row. The treasury mint is still a real
 * two-admin issuance and all Coin moves through recordLedgerEntry. Never imported by runtime.
 */
export async function fundMarketMakerFunds(
  db: Db,
  marketId: string,
  amountCoin: bigint,
): Promise<string> {
  const owner = await createMarketMakerAccount(db);
  await fundTestTreasury(db, amountCoin);
  const requestId = randomUUID();
  await recordLegacyMarketMakerCapitalForTest({
    type: 'BOT_ALLOCATION',
    amountCoin,
    from: { kind: 'treasury' },
    to: { kind: 'market_maker_funds', marketId },
    marketId,
    refType: 'approval_request',
    refId: requestId,
    idempotencyKey: ledgerKeys.approvalRequest(requestId),
  });
  return owner;
}

/** Owner-only pre-0069 capital, preserving the chain and all existing ledger guards. */
export async function recordLegacyMarketMakerCapitalForTest(
  input: LedgerEntryInput & { type: 'TREASURY_MINT' | 'BOT_ALLOCATION' },
): Promise<RecordLedgerEntryResult> {
  return withLedgerGuardsOff(
    async (client) => {
      const owner = drizzle({ client, schema, casing: 'snake_case' });
      return recordLedgerEntry(owner as unknown as Parameters<typeof recordLedgerEntry>[0], input);
    },
    { capital: true },
  );
}

/** Explicit TEST-stage settings and real approved funds for a normal opening. Never fills
 * existing/invalid setting rows or repairs damaged books. A test of an unmet prerequisite calls
 * createScheduledMarket directly and prepares only the prerequisites that it actually wants.
 */
export async function prepareMarketMakerOpening(db: Db, marketId: string): Promise<void> {
  const config = await readMarketMakerConfig(db, marketId);
  if (!config) throw new Error('Opening fixture needs explicit liquidity settings');
  await createMarketMakerAccount(db);
  const adminId = (await createUser(db, { role: 'admin' })).user.id;
  for (const [key, value] of [
    ['market_maker.reduce_at_bp', 7000],
    ['market_maker.halt_at_bp', 9000],
    ['market_maker.reduce_ratio_bp', 5000],
  ] as const) {
    const [existing] = await db
      .select({ key: schema.releaseSettings.key })
      .from(schema.releaseSettings)
      .where(eq(schema.releaseSettings.key, key));
    if (!existing) await setReleaseSetting(db, { key, value, status: 'test', adminId });
  }
  const account = await findLedgerAccount(db, { kind: 'treasury' });
  const [balance] = account
    ? await db.select().from(balances).where(eq(balances.accountId, account.id))
    : [];
  if (account && !balance) throw new Error('Opening fixture treasury is missing its balance');
  const missing = config.budgetCoin - (balance?.availableCoin ?? 0n);
  if (missing > 0n) await fundTestTreasury(db, missing);
}

export interface MintTestPairsInput {
  marketId: string;
  /** The YES holder (a person, or the 운영 마켓메이커 — then its 마켓메이커 자금 pays). */
  yesHolderId: string;
  /** The NO holder, likewise. */
  noHolderId: string;
  qty: number;
  /** What the YES buyer pays per pair, 1..99; the NO buyer pays the rest of 100. Default 50. */
  yesPriceCoin?: number;
}

/**
 * Mints pairs the real way (#118, contracts.ts): the fill record first (`createFillRecord`: the
 * YES holder's IOC buy filled against the NO holder's resting GTC buy, one pair-mint fill — the
 * row migration 0062 binds the two events to), then in one transaction both buyers' accounts
 * locked (`lockOrderHolders`), each buyer's lock of its price × qty (`lockForOrder`, as the intake
 * takes it) and one `applyPairMintFill` at limits equal to the prices — each buyer's collateral
 * moved into the market's collateral account (PAIR_MINT_COLLATERAL, 100 per pair between the two)
 * and each one's position (qty and cost added). So the collateral holds exactly unsettled pairs ×
 * 100, which a settlement test pays out of, and both holders have a fill on the market
 * (`hasMarketFill`). The holders must hold the Coin, be two owners, not both non-person accounts
 * and neither an admin (`orders_refuse_admin_owner`). Returns the fill id the two events refer to.
 *
 * Pairs as minted while the market traded: the fill processings refuse a market not OPEN (마감 뒤
 * 막음, #120), so on a market in any other status (a settlement test's RESOLVED or SETTLING, a
 * PROVISIONAL one) it sets the status to OPEN for the mint and back before COMMIT, under the
 * market's lock — a raw write no trigger or CHECK on the status alone refuses (a PROVISIONAL
 * market with a dispute hold or a pending correction would, loudly).
 */
export async function mintTestPairs(db: Db, input: MintTestPairsInput): Promise<string> {
  const prices = pairPrices(input.yesPriceCoin ?? 50);
  const { fill } = await createFillRecord(db, {
    marketId: input.marketId,
    incomingOwnerId: input.yesHolderId,
    restingOwnerId: input.noHolderId,
    priceCoin: prices.YES,
    qty: input.qty,
  });
  const fillId = String(fill.id);
  const legs: [Outcome, string][] = [
    ['YES', input.yesHolderId],
    ['NO', input.noHolderId],
  ];
  await db.transaction(async (tx) => {
    // The market before any balance row, as every processing takes it.
    await lockMarket(tx, input.marketId);
    const [market] = await tx
      .select({ status: markets.status })
      .from(markets)
      .where(eq(markets.id, input.marketId))
      .for('update');
    if (!market) throw new Error(`mintTestPairs: market ${input.marketId} does not exist`);
    const setStatus = (status: typeof market.status) =>
      tx.update(markets).set({ status }).where(eq(markets.id, input.marketId));
    if (market.status !== 'open') await setStatus('open');
    // Both owners' accounts first, ascending, as a processing must (`lockOrderHolders`).
    await lockOrderHolders(tx, input.marketId, [input.yesHolderId, input.noHolderId]);
    for (const [outcome, ownerId] of legs) {
      const locked = await lockForOrder(tx, {
        marketId: input.marketId,
        ownerId,
        lock: { kind: 'coin', amountCoin: BigInt(prices[outcome]) * BigInt(input.qty) },
      });
      if (!locked.locked) throw new Error(`mintTestPairs: ${outcome} buyer ${locked.reason}`);
    }
    await applyPairMintFill(tx, {
      marketId: input.marketId,
      fillId,
      qty: input.qty,
      yesPriceCoin: prices.YES,
      yes: { ownerId: input.yesHolderId, limitPriceCoin: prices.YES },
      no: { ownerId: input.noHolderId, limitPriceCoin: prices.NO },
    });
    if (market.status !== 'open') await setStatus(market.status);
  });
  return fillId;
}

/** A person's account's balance row (by its owner), or undefined. */
export async function balanceOf(db: Db, userId: string) {
  const [row] = await db.select().from(balances).where(eq(balances.userId, userId));
  return row;
}

/** A ledger account's balance row, or undefined when it does not exist. */
export async function ledgerAccountBalance(db: Db, ref: LedgerAccountRef) {
  const account = await findLedgerAccount(db, ref);
  if (!account) return undefined;
  const [row] = await db.select().from(balances).where(eq(balances.accountId, account.id));
  return row;
}

export interface LedgerGuardsOffOptions {
  /**
   * Also lets `ledger_entries` take a row that does not follow its accounts (no chain check, no
   * COMMIT check, no binding of a fill event to its fill — migration 0062) — for a test that
   * forges an event. Default: only a balance may be changed alone.
   */
  entries?: boolean;
  /** Only the new #129 binding, for an explicitly historical capital fixture. */
  capital?: boolean;
}

/**
 * Runs `tamper` on a migrate-role connection, in one transaction with migration 0060's guards of
 * the books switched off — the UPDATE check that a balance's total moves only with its ledger
 * total (`balances_keep_ledger_gap`) and the COMMIT check that the ledger total is its ledger's
 * (and, with `entries`, the INSERT and COMMIT checks of an event, its fill binding too) — then
 * switches them on again and commits. The one way a test breaks the books on purpose (the ledger
 * audit's mismatches, an account whose total left its ledger): the app role holds no INSERT or
 * DELETE of `balances`, a total changed alone is refused at once, and a ledger total changed
 * without an event never commits. ALTER TABLE locks the tables until the commit, so nothing else
 * writes Coin meanwhile.
 */
export async function withLedgerGuardsOff<T>(
  tamper: (client: Client) => Promise<T>,
  options: LedgerGuardsOffOptions = {},
): Promise<T> {
  const urls = testDbUrls();
  if (!urls) throw new Error('withLedgerGuardsOff needs the test database');
  const client = new Client({ connectionString: urls.migrateUrl });
  await client.connect();
  const triggers: [string, string][] =
    options.capital && !options.entries
      ? []
      : [
          ['balances', 'balances_keep_ledger_gap'],
          ['balances', 'balances_follow_ledger'],
        ];
  if (options.entries) {
    triggers.push(['ledger_entries', 'ledger_entries_check']);
    triggers.push(['ledger_entries', 'ledger_entries_fill_binding']);
    triggers.push(['ledger_entries', 'ledger_entries_reconciliation_binding']);
    triggers.push(['ledger_entries', 'ledger_entries_restore_cursor']);
    triggers.push(['ledger_entries', 'ledger_entries_follow_balances']);
  }
  if (options.capital) triggers.push(['ledger_entries', 'ledger_entries_market_maker_binding']);
  try {
    await client.query('BEGIN');
    try {
      for (const [table, trigger] of triggers) {
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      }
      const result = await tamper(client);
      // An event inserted meanwhile queued `ledger_entries_closed_account`'s deferred check, and
      // a table with a pending trigger event takes no ALTER: run it now, before the switch.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const [table, trigger] of triggers) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** Owner-only incident fixture in the configured TEST database: leave the immutable ledger and
 * its copy untouched, changing only actual available Coin. Never use on a development database.
 */
export async function damageActualCoinForTest(accountId: number, deltaCoin: bigint): Promise<void> {
  await withLedgerGuardsOff(async (client) => {
    const changed = await client.query(
      'UPDATE balances SET available_coin=available_coin+$1 WHERE account_id=$2',
      [String(deltaCoin), accountId],
    );
    if (changed.rowCount !== 1) throw new Error('Incident fixture account not found');
  });
}

/** A real two-admin approved treasury issuance, with its permanent #129 binding. */
export async function fundTestTreasury(db: Db, amountCoin: bigint): Promise<void> {
  const requestedBy = (await createUser(db, { role: 'admin' })).user.id;
  const by = (await createUser(db, { role: 'admin' })).user.id;
  await db.transaction(async (tx) => {
    const request = await createApprovalRequest(tx as unknown as Db, {
      kind: 'treasury_issue',
      targetType: 'treasury',
      targetId: 'treasury',
      payload: { amountCoin: String(amountCoin) },
      requestedBy,
      decision: { status: 'approved', by },
    });
    await mintTreasury(tx, { approvalId: request.id });
  });
}

/** A pre-0065 unbound correction entry, or an owner-created corruption incident. Only TEST
 * migrate credentials and the owner's explicit disabled-guard transaction may make this fixture.
 * Production/app callers must use the actual two-admin correction path.
 */
export async function recordLegacyCorrectionForTest(
  input: Omit<LedgerEntryInput, 'type'>,
): Promise<void> {
  await withLedgerGuardsOff(
    async (client) => {
      const owner = drizzle({ client, schema, casing: 'snake_case' });
      await recordLedgerEntry(owner as unknown as Parameters<typeof recordLedgerEntry>[0], {
        ...input,
        type: 'RECONCILIATION_CORRECTION',
      });
    },
    { entries: true },
  );
}
