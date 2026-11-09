import { randomUUID } from 'node:crypto';
import {
  CONTRACT_TERMS,
  LEDGER_BURN_TYPES,
  LEDGER_MINT_TYPES,
  MARKET_SCAN_BATCH_MAX,
  RECONCILIATION_SYSTEM_PAUSE_NOTE,
  type MarketStatusEvent,
  type ReconciliationFinding,
  type ReconciliationSource,
} from '@buddha/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isHumanAccountSql, isHumanAccountTypeSql } from './account-types.js';
import type { Db } from './client.js';
import { checkMarketSettlementBooks } from './market-settlement.js';
import { transitionMarket } from './market-transitions.js';
import { lockReconciliationUserKey } from './reconciliation-holds.js';
import {
  auditFailures,
  balances,
  ledgerAccounts,
  marketPauses,
  markets,
  positions,
  positionSettlements,
  profiles,
  reconciliationHolds,
  reconciliationRecoveries,
  reconciliationResults,
  user,
} from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;
export type ReconciliationResultRow = typeof reconciliationResults.$inferSelect;
export type ReconciliationHoldRow = typeof reconciliationHolds.$inferSelect;
export interface ReconciliationOptions {
  source: ReconciliationSource;
  actorId?: string;
}
export interface ReconciliationRun {
  result: ReconciliationResultRow;
  hold: ReconciliationHoldRow | null;
  /** Publish only after the caller commits. Audits never cancel orders or publish a book. */
  statusEvent: MarketStatusEvent | null;
}
export type ReconciliationAccountTarget = { userId: string } | { accountId: number };
export const reconciliationMarketKey = (id: string) => `market:${id}`;
export const reconciliationUserKey = (id: string) => `user:${id}`;

export async function activeReconciliationHold(reader: Reader, targetKey: string) {
  const [hold] = await reader
    .select()
    .from(reconciliationHolds)
    .where(
      and(eq(reconciliationHolds.targetKey, targetKey), isNull(reconciliationHolds.recoveredAt)),
    );
  return hold ?? null;
}
export async function latestReconciliationResult(reader: Reader, targetKey: string) {
  const [result] = await reader
    .select()
    .from(reconciliationResults)
    .where(eq(reconciliationResults.targetKey, targetKey))
    .orderBy(desc(reconciliationResults.id))
    .limit(1);
  return result ?? null;
}

/** Account-only lock, never followed by a market lock. The intake rechecks its hold after this. */
export async function lockReconciliationUser(tx: Tx, userId: string): Promise<void> {
  await lockReconciliationUserKey(tx, userId);
  await tx.execute(sql`SELECT b.account_id FROM balances b JOIN ledger_accounts a ON a.id=b.account_id
    WHERE a.kind='user' AND a.owner_id=${userId} FOR UPDATE OF b`);
}

interface AccountBook {
  accountId: number;
  kind: string;
  ownerId: string | null;
  marketId: string | null;
  missing: boolean;
  available: bigint;
  locked: bigint;
  carried: bigint;
  sum: bigint;
  expectedLock: bigint;
  cursor: number;
}
async function accountBook(tx: Tx, accountId: number): Promise<AccountBook> {
  const { rows } = await tx.execute<{
    id: string;
    kind: string;
    owner_id: string | null;
    market_id: string | null;
    missing: boolean;
    available: string;
    locked: string;
    carried: string;
    total: string;
    expected: string;
    cursor: string;
  }>(sql`SELECT a.id::text, a.kind::text, a.owner_id, a.market_id, b.account_id IS NULL AS missing,
      coalesce(b.available_coin,0)::text AS available, coalesce(b.locked_coin,0)::text AS locked,
      coalesce(b.ledger_coin,0)::text AS carried,
      (SELECT coalesce(sum(CASE WHEN e.to_account_id=a.id THEN e.amount_coin ELSE -e.amount_coin END),0)
       FROM ledger_entries e WHERE e.to_account_id=a.id OR e.from_account_id=a.id)::text AS total,
      (SELECT coalesce(max(e.id),0) FROM ledger_entries e WHERE e.to_account_id=a.id OR e.from_account_id=a.id)::text AS cursor,
      (SELECT coalesce(sum(o.protected_limit_price::bigint*(o.qty-o.filled_qty)),0) FROM orders o
       WHERE o.user_id=a.owner_id AND o.status IN ('open','partially_filled') AND o.side='buy'
         AND (a.kind='user' OR (a.kind='market_maker_funds' AND o.market_id=a.market_id)))::text AS expected
    FROM ledger_accounts a LEFT JOIN balances b ON b.account_id=a.id WHERE a.id=${accountId}`);
  const row = rows[0];
  if (!row) throw new Error(`Ledger account ${accountId} not found`);
  return {
    accountId,
    kind: row.kind,
    ownerId: row.owner_id,
    marketId: row.market_id,
    missing: row.missing,
    available: BigInt(row.available),
    locked: BigInt(row.locked),
    carried: BigInt(row.carried),
    sum: BigInt(row.total),
    expectedLock: BigInt(row.expected),
    cursor: Number(row.cursor),
  };
}
function compare(
  findings: ReconciliationFinding[],
  code: ReconciliationFinding['code'],
  expected: bigint | number | string,
  actual: bigint | number | string,
  detail?: string,
) {
  if (String(expected) !== String(actual))
    findings.push({
      code,
      expected: String(expected),
      actual: String(actual),
      ...(detail ? { detail } : {}),
    });
}
function checkAccount(book: AccountBook, findings: ReconciliationFinding[]) {
  const detail = String(book.accountId);
  if (book.missing)
    findings.push({ code: 'balance_missing', expected: 'present', actual: 'missing', detail });
  compare(findings, 'account_balance', book.sum, book.available + book.locked, detail);
  compare(findings, 'account_ledger_copy', book.sum, book.carried, detail);
  compare(findings, 'coin_lock', book.expectedLock, book.locked, detail);
  for (const [name, amount] of [
    ['available', book.available],
    ['locked', book.locked],
    ['ledger', book.carried],
  ] as const)
    if (amount < 0n)
      findings.push({
        code: 'negative_coin',
        expected: '>=0',
        actual: String(amount),
        detail: `${detail}:${name}`,
      });
}
function bookFacts(book: AccountBook): Record<string, unknown> {
  return {
    accountId: String(book.accountId),
    kind: book.kind,
    availableCoin: String(book.available),
    lockedCoin: String(book.locked),
    ledgerCoin: String(book.carried),
    ledgerSumCoin: String(book.sum),
    expectedLockedCoin: String(book.expectedLock),
  };
}

async function saveResult(
  tx: Tx,
  input: Omit<typeof reconciliationResults.$inferInsert, 'id' | 'passed' | 'version'>,
): Promise<ReconciliationResultRow> {
  const [result] = await tx
    .insert(reconciliationResults)
    .values({ ...input, passed: input.findings.length === 0 })
    .returning();
  if (!result) throw new Error('Reconciliation result was not recorded');
  if (!result.passed)
    await tx.insert(auditFailures).values({
      kind: `${result.scope}_reconciliation_mismatch`,
      createdAt: result.checkedAt,
      payload: {
        resultId: String(result.id),
        scope: result.scope,
        targetKey: result.targetKey,
        marketId: result.marketId,
        userId: result.userId,
        accountId: result.accountId === null ? null : String(result.accountId),
        findings: result.findings,
      },
    });
  return result;
}

/** Failure persistence is separate from passing observations. A legacy pause is imported lazily. */
async function keepHold(
  tx: Tx,
  result: ReconciliationResultRow,
  legacyPauseId: string | null = null,
): Promise<ReconciliationHoldRow | null> {
  let hold: ReconciliationHoldRow | null | undefined = await activeReconciliationHold(
    tx,
    result.targetKey,
  );
  const scope = result.scope === 'market' ? 'market' : 'account';
  if (result.scope === 'supply' || (scope === 'account' && result.userId === null)) return null;
  if (!hold && (!result.passed || legacyPauseId !== null)) {
    [hold] = await tx
      .insert(reconciliationHolds)
      .values({
        scope,
        targetKey: result.targetKey,
        marketId: result.marketId,
        userId: result.userId,
        failureResultId: result.passed ? null : result.id,
        legacyPauseId,
        startedAt: result.checkedAt,
      })
      .returning();
  } else if (hold && !result.passed) {
    [hold] = await tx
      .update(reconciliationHolds)
      .set({ failureResultId: result.id })
      .where(eq(reconciliationHolds.id, hold.id))
      .returning();
  }
  return hold ?? null;
}

export async function runMarketReconciliation(
  tx: Tx,
  marketId: string,
  options: ReconciliationOptions,
): Promise<ReconciliationRun> {
  await lockMarket(tx, marketId);
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  if (!market) throw new Error(`Market ${marketId} not found`);
  const accounts = await tx
    .select()
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.marketId, marketId))
    .orderBy(asc(ledgerAccounts.id));
  if (accounts.length)
    await tx
      .select()
      .from(balances)
      .where(
        inArray(
          balances.accountId,
          accounts.map((a) => a.id),
        ),
      )
      .orderBy(asc(balances.accountId))
      .for('update');
  const holdings = await tx
    .select()
    .from(positions)
    .where(eq(positions.marketId, marketId))
    .orderBy(asc(positions.userId), asc(positions.outcome))
    .for('update');
  const records = await tx
    .select()
    .from(positionSettlements)
    .where(eq(positionSettlements.marketId, marketId));
  const findings: ReconciliationFinding[] = [];
  const books: AccountBook[] = [];
  // Closure and market writers serialize on this market lock. Read the current profiles here,
  // without adding a profile row lock after assets (admin role changes take the opposite order).
  // A market-maker intentionally has no profile; closed people with zero/retired holdings are valid.
  const positiveOwners = [...new Set(holdings.filter((p) => p.qty > 0).map((p) => p.userId))];
  const people = positiveOwners.length
    ? await tx
        .select({ id: user.id, profileId: profiles.userId, closedAt: profiles.closedAt })
        .from(user)
        .leftJoin(profiles, eq(profiles.userId, user.id))
        .where(and(inArray(user.id, positiveOwners), isHumanAccountTypeSql(user.accountType)))
    : [];
  const closedOwners = new Set(
    people.filter((p) => p.profileId === null || p.closedAt !== null).map((p) => p.id),
  );
  for (const account of accounts) {
    const book = await accountBook(tx, account.id);
    books.push(book);
    checkAccount(book, findings);
  }
  const { rows: locks } = await tx.execute<{
    owner: string;
    outcome: string;
    held: string;
    expected: string;
  }>(sql`
    WITH sells AS (SELECT user_id,outcome,sum(qty-filled_qty) AS expected FROM orders WHERE market_id=${marketId}
      AND status IN ('open','partially_filled') AND side='sell' GROUP BY user_id,outcome),
    held AS (SELECT user_id,outcome,locked_qty FROM positions WHERE market_id=${marketId})
    SELECT coalesce(p.user_id,s.user_id) AS owner,coalesce(p.outcome,s.outcome)::text AS outcome,
      coalesce(p.locked_qty,0)::text AS held,coalesce(s.expected,0)::text AS expected
    FROM held p FULL JOIN sells s ON s.user_id=p.user_id AND s.outcome=p.outcome
    WHERE coalesce(p.locked_qty,0)<>coalesce(s.expected,0)`);
  for (const row of locks)
    compare(findings, 'contract_lock', row.expected, row.held, `${row.owner}:${row.outcome}`);
  const { rows: botOrders } = await tx.execute<{
    count: string;
  }>(sql`SELECT count(*)::text AS count FROM orders o
    JOIN "user" u ON u.id=o.user_id WHERE o.market_id=${marketId} AND o.status IN ('open','partially_filled')
    AND NOT ${isHumanAccountSql(sql`u.id`)}`);
  if (Number(botOrders[0]!.count) > 0 && !accounts.some((a) => a.kind === 'market_maker_funds'))
    findings.push({ code: 'market_maker_account_missing', expected: 'present', actual: 'missing' });
  let yes = 0n,
    no = 0n;
  for (const p of holdings) {
    if (p.qty > 0 && closedOwners.has(p.userId))
      findings.push({
        code: 'closed_position_holder',
        expected: '0',
        actual: String(p.qty),
        detail: `${p.userId}:${p.outcome}`,
      });
    if (p.qty === 0 && p.costBasisCoin !== 0n)
      findings.push({
        code: 'empty_position_cost',
        expected: '0',
        actual: String(p.costBasisCoin),
        detail: `${p.userId}:${p.outcome}`,
      });
    if (p.outcome === 'YES') yes += BigInt(p.qty);
    else no += BigInt(p.qty);
    if (p.settled && (p.qty !== 0 || p.costBasisCoin !== 0n))
      findings.push({
        code: 'retired_position',
        expected: '0',
        actual: String(p.qty),
        detail: p.userId,
      });
  }
  const collateral = books.find((b) => b.kind === 'market_collateral');
  if (market.status === 'settling' || market.status === 'settled') {
    try {
      // Same permanent-claim/payout equation as #126. Live locks are checked against their
      // orders above; a held market must be allowed to pass before approval releases them.
      await checkMarketSettlementBooks(
        tx,
        market,
        holdings,
        records,
        market.status === 'settled',
        true,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(`Market ${marketId} settlement:`))
        throw error;
      findings.push({ code: 'settlement_books', expected: 'reconciled', actual: error.message });
    }
  } else {
    compare(findings, 'pair_supply', yes, no);
    compare(
      findings,
      'pair_collateral',
      yes * BigInt(CONTRACT_TERMS.payoutCoin),
      (collateral?.available ?? 0n) + (collateral?.locked ?? 0n),
    );
    compare(findings, 'unexpected_settlement_records', 0, records.length);
    const { rows } = await tx.execute<{
      principal: string;
    }>(sql`SELECT coalesce(sum(CASE WHEN type='PAIR_MINT_COLLATERAL' THEN amount_coin
      WHEN type='PAIR_BURN_RETURN' THEN -amount_coin ELSE 0 END),0)::text AS principal FROM ledger_entries WHERE market_id=${marketId}`);
    compare(findings, 'pair_ledger', yes * BigInt(CONTRACT_TERMS.payoutCoin), rows[0]!.principal);
  }
  if (market.status === 'settled') {
    const { rows } = await tx.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM orders WHERE market_id=${marketId} AND status IN ('open','partially_filled')`,
    );
    compare(findings, 'settled_live_orders', 0, rows[0]!.count);
  }
  const { rows: cursorRows } = await tx.execute<{ cursor: string }>(
    sql`SELECT coalesce(max(id),0)::text AS cursor FROM ledger_entries WHERE market_id=${marketId}`,
  );
  const at = await clockTimestamp(tx);
  const result = await saveResult(tx, {
    scope: 'market',
    targetKey: reconciliationMarketKey(marketId),
    marketId,
    accountId: null,
    userId: null,
    source: options.source,
    actorId: options.actorId ?? null,
    checkedAt: at,
    ledgerCursor: Number(cursorRows[0]!.cursor),
    findings,
    facts: {
      yesQty: String(yes),
      noQty: String(no),
      accounts: books.map(bookFacts),
      // A correction may repair Coin only after independently rechecking the claims and locks.
      // Keep the original obligation as immutable evidence, including already-paid positions.
      requiredCollateralCoin: String(
        market.resolvedResult !== null &&
          (market.status === 'settling' || market.status === 'settled')
          ? holdings
              .filter((p) => !p.settled)
              .reduce(
                (sum, p) =>
                  sum +
                  BigInt(p.qty) *
                    BigInt(
                      market.resolvedResult === 'VOID'
                        ? 50
                        : market.resolvedResult === p.outcome
                          ? 100
                          : 0,
                    ),
                0n,
              )
          : yes * BigInt(CONTRACT_TERMS.payoutCoin),
      ),
      status: market.status,
    },
  });
  const [legacy] = await tx
    .select({ id: marketPauses.id })
    .from(marketPauses)
    .where(
      and(
        eq(marketPauses.marketId, marketId),
        eq(marketPauses.reason, 'ledger_failure'),
        sql`(${marketPauses.endedAt} IS NULL OR ${marketPauses.endKind}='closed_at_close')`,
        sql`NOT EXISTS (SELECT 1 FROM ${reconciliationRecoveries} r WHERE r.legacy_pause_id=${marketPauses.id})`,
      ),
    )
    .limit(1);
  let hold: ReconciliationHoldRow | null | undefined = await keepHold(
    tx,
    result,
    legacy?.id ?? null,
  );
  let statusEvent: MarketStatusEvent | null = null;
  if (!result.passed && market.status === 'open') {
    const pauseId = randomUUID();
    const eventId = await transitionMarket(tx, {
      marketId,
      from: 'open',
      to: 'paused',
      type: 'paused',
      actorId: null,
      at,
      payload: { pauseId, reason: 'ledger_failure', resultPublishedAt: null },
    });
    await tx.insert(marketPauses).values({
      id: pauseId,
      marketId,
      reason: 'ledger_failure',
      note: RECONCILIATION_SYSTEM_PAUSE_NOTE,
      pausedAt: at,
      pausedBy: null,
      pauseEventId: eventId,
      resultPublishedAt: null,
    });
    // Bind the system pause too, so a scheduled close before approval can later be recovered.
    if (hold && !hold.legacyPauseId) {
      [hold] = await tx
        .update(reconciliationHolds)
        .set({ legacyPauseId: pauseId })
        .where(eq(reconciliationHolds.id, hold.id))
        .returning();
    }
    statusEvent = {
      type: 'market:status',
      marketId,
      status: 'paused',
      resolvedResult: market.resolvedResult,
      statusEventId: String(eventId),
      ts: at.toISOString(),
    };
  }
  return { result, hold: hold ?? null, statusEvent };
}

export async function runAccountReconciliation(
  tx: Tx,
  target: ReconciliationAccountTarget,
  options: ReconciliationOptions,
): Promise<ReconciliationRun> {
  let account =
    'accountId' in target
      ? (await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, target.accountId)))[0]
      : (
          await tx
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.kind, 'user'), eq(ledgerAccounts.ownerId, target.userId)))
        )[0];
  if (account?.marketId) return runMarketReconciliation(tx, account.marketId, options);
  const userId =
    'userId' in target ? target.userId : account?.kind === 'user' ? account.ownerId : null;
  if (userId) {
    const [person] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), isHumanAccountTypeSql(user.accountType)));
    if (!person) throw new Error(`Human account ${userId} not found`);
    await lockReconciliationUser(tx, userId);
    [account] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.kind, 'user'), eq(ledgerAccounts.ownerId, userId)));
  } else if (account) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('reconciliation:account'), hashtext(${String(account.id)}))`,
    );
    await tx.select().from(balances).where(eq(balances.accountId, account.id)).for('update');
  } else throw new Error('Ledger account not found');
  const findings: ReconciliationFinding[] = [];
  const book = account ? await accountBook(tx, account.id) : null;
  if (book) checkAccount(book, findings);
  else findings.push({ code: 'ledger_account_missing', expected: 'present', actual: 'missing' });
  const at = await clockTimestamp(tx);
  const result = await saveResult(tx, {
    scope: 'account',
    targetKey: userId ? reconciliationUserKey(userId) : `account:${account!.id}`,
    accountId: account?.id ?? null,
    userId: userId ?? null,
    marketId: null,
    source: options.source,
    actorId: options.actorId ?? null,
    checkedAt: at,
    ledgerCursor: book?.cursor ?? 0,
    findings,
    facts: book ? bookFacts(book) : { userId },
  });
  return { result, hold: await keepHold(tx, result), statusEvent: null };
}

export async function runSupplyReconciliation(
  tx: Tx,
  options: ReconciliationOptions,
): Promise<ReconciliationRun> {
  // One statement is one MVCC snapshot, so a concurrent transfer cannot split the two totals.
  const { rows } = await tx.execute<{
    minted: string;
    burned: string;
    held: string;
    carried: string;
    cursor: string;
  }>(sql`
    SELECT (SELECT coalesce(sum(amount_coin),0) FROM ledger_entries WHERE type::text IN (${sql.join(
      LEDGER_MINT_TYPES.map((type) => sql`${type}`),
      sql`, `,
    )}))::text AS minted,
      (SELECT coalesce(sum(amount_coin),0) FROM ledger_entries WHERE type::text IN (${sql.join(
        LEDGER_BURN_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )}))::text AS burned,
      (SELECT coalesce(sum(available_coin+locked_coin),0) FROM balances)::text AS held,
      (SELECT coalesce(sum(ledger_coin),0) FROM balances)::text AS carried,
      (SELECT coalesce(max(id),0) FROM ledger_entries)::text AS cursor`);
  const row = rows[0]!;
  const expected = BigInt(row.minted) - BigInt(row.burned);
  const findings: ReconciliationFinding[] = [];
  compare(findings, 'supply_balance', expected, row.held);
  compare(findings, 'supply_ledger_copy', expected, row.carried);
  const result = await saveResult(tx, {
    scope: 'supply',
    targetKey: 'supply',
    marketId: null,
    accountId: null,
    userId: null,
    source: options.source,
    actorId: options.actorId ?? null,
    checkedAt: await clockTimestamp(tx),
    ledgerCursor: Number(row.cursor),
    findings,
    facts: {
      mintedCoin: row.minted,
      burnedCoin: row.burned,
      heldCoin: row.held,
      ledgerCoin: row.carried,
    },
  });
  return { result, hold: null, statusEvent: null };
}

export async function selectDueMarketReconciliationIds(
  reader: Reader,
  options: { limit?: number } = {},
): Promise<string[]> {
  const limit = options.limit ?? MARKET_SCAN_BATCH_MAX;
  const { rows } = await reader.execute<{ id: string }>(sql`SELECT m.id FROM markets m
    LEFT JOIN LATERAL (SELECT r.id,r.passed,r.ledger_cursor,r.checked_at FROM reconciliation_results r
      WHERE r.target_key='market:'||m.id::text ORDER BY r.id DESC LIMIT 1) r ON true
    WHERE r.id IS NULL OR NOT r.passed OR EXISTS(SELECT 1 FROM ledger_entries e WHERE e.market_id=m.id AND e.id>r.ledger_cursor)
    ORDER BY r.checked_at ASC NULLS FIRST,m.id LIMIT ${limit}`);
  return rows.map((row) => row.id);
}
export async function selectReconciliationAccountTargets(
  reader: Reader,
): Promise<ReconciliationAccountTarget[]> {
  const people = await reader
    .select({ userId: user.id })
    .from(user)
    .where(isHumanAccountTypeSql(user.accountType))
    .orderBy(asc(user.id));
  const system = await reader.execute<{ id: string }>(
    sql`SELECT min(id)::text AS id FROM ledger_accounts WHERE kind<>'user' GROUP BY market_id ORDER BY min(id)`,
  );
  return [...people, ...system.rows.map((row) => ({ accountId: Number(row.id) }))];
}
