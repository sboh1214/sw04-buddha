import {
  deliverReconciliationNotices,
  RECONCILIATION_NOTICES_FAILED_LOG,
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  schema,
  selectDueMarketReconciliationIds,
  selectReconciliationAccountTargets,
  type Db,
} from '@buddha/db';
import { marketChannel, notificationEvent, userChannel } from '@buddha/shared';
import { asc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Publish } from '../realtime.js';
import { messageOf } from './scan.js';

export type ReconciliationTarget =
  | { scope: 'market'; marketId: string }
  | { scope: 'account'; userId: string }
  | { scope: 'account'; accountId: number }
  | { scope: 'supply' };

type Source = 'scheduled' | 'manual';
type DbResult = Awaited<ReturnType<typeof runMarketReconciliation>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * JSON-safe facts about a completed check; the complete evidence stays in Postgres. Never who an
 * automatic pause's notices reached, nor how many (#54, ADR-0159; ADR-0064): `paused` is a boolean.
 */
export interface ReconciliationCheck {
  resultId: string;
  scope: DbResult['result']['scope'];
  targetKey: string;
  marketId: string | null;
  accountId: number | null;
  userId: string | null;
  passed: boolean;
  held: boolean;
  paused: boolean;
  checkedAt: string;
  findings: DbResult['result']['findings'];
}

export interface ReconciliationFailure {
  target: string;
  message: string;
  err: unknown;
}

export interface ReconciliationBatch {
  /** Completed checks, including supply. A failed transaction has no completed check. */
  checked: number;
  passed: number;
  mismatched: number;
  /** Active holds after these checks. A clean check never releases a hold. */
  held: number;
  paused: number;
  scopes: { market: number; account: number; supply: number };
  failed: number;
  failures: ReconciliationFailure[];
  mismatches: ReconciliationCheck[];
}

function targetKey(target: ReconciliationTarget): string {
  switch (target.scope) {
    case 'market':
      return `market:${target.marketId}`;
    case 'account':
      return 'userId' in target ? `user:${target.userId}` : `account:${String(target.accountId)}`;
    case 'supply':
      return 'supply';
  }
}

/** The DB operation of one target; an account of a market is checked as its market (db). */
function runTarget(tx: Tx, target: ReconciliationTarget, source: Source): Promise<DbResult> {
  switch (target.scope) {
    case 'market':
      return runMarketReconciliation(tx, target.marketId, { source });
    case 'account':
      return runAccountReconciliation(
        tx,
        'userId' in target ? { userId: target.userId } : { accountId: target.accountId },
        { source },
      );
    case 'supply':
      return runSupplyReconciliation(tx, { source });
  }
}

/**
 * One shared worker/manual path. All snapshot reads, holds and automatic pauses belong to the
 * DB operation's transaction. Only after it commits may its status event reach subscribers.
 * A ledger pause preserves orders and locks, so this operation emits no book/balance event.
 *
 * An automatic pause (OPEN → PAUSED, `ledger_failure`) also tells the market's watchers and
 * holders `market_paused` (#54 B′, ADR-0159; 54-5): `deliverReconciliationNotices`, the
 * transaction's last statements, inside a savepoint that a failed notice rolls back alone — the
 * pause commits, those notices are lost, and the fixed line RECONCILIATION_NOTICES_FAILED_LOG is
 * logged after COMMIT, never with the error, an id or a count (54-6). After COMMIT `market:status`,
 * then the inbox signal `user:notification` at the run's instant to each member told. The check
 * names nobody told and counts nobody (ADR-0064).
 */
export async function reconcileTarget(
  db: Db,
  target: ReconciliationTarget,
  publish: Publish,
  logger: Logger,
  source: Source = 'scheduled',
): Promise<ReconciliationCheck> {
  const done = await db.transaction(async (tx) => {
    const run = await runTarget(tx, target, source);
    // #54 B′ (54-5·54-6): an automatic pause's notices, the transaction's last statements.
    const delivered = await deliverReconciliationNotices(tx, run.systemPause);
    return { ...run, delivered };
  });
  // The fixed line alone: no error message, id or count (54-6, ADR-0064).
  if (done.delivered.failed) logger.warn(RECONCILIATION_NOTICES_FAILED_LOG);
  if (done.statusEvent !== null) {
    await publish(marketChannel(done.statusEvent.marketId), done.statusEvent);
  }
  const paused = done.systemPause;
  if (paused !== null) {
    await Promise.all(
      done.delivered.notified.map((userId) =>
        publish(userChannel(userId), notificationEvent(paused.at)),
      ),
    );
  }
  const { result, hold } = done;
  return {
    resultId: String(result.id),
    scope: result.scope,
    targetKey: result.targetKey,
    marketId: result.marketId,
    accountId: result.accountId,
    userId: result.userId,
    passed: result.passed,
    held: hold !== null,
    paused: done.statusEvent !== null,
    checkedAt: result.checkedAt.toISOString(),
    findings: result.findings,
  };
}

function batch(): ReconciliationBatch {
  return {
    checked: 0,
    passed: 0,
    mismatched: 0,
    held: 0,
    paused: 0,
    scopes: { market: 0, account: 0, supply: 0 },
    failed: 0,
    failures: [],
    mismatches: [],
  };
}

/** One transaction failure does not prevent the other targets or the supply check from running. */
async function collect(
  into: ReconciliationBatch,
  db: Db,
  target: ReconciliationTarget,
  publish: Publish,
  logger: Logger,
  source: Source,
): Promise<ReconciliationCheck | null> {
  try {
    const checked = await reconcileTarget(db, target, publish, logger, source);
    into.checked += 1;
    into.scopes[checked.scope] += 1;
    into.passed += Number(checked.passed);
    into.held += Number(checked.held);
    into.paused += Number(checked.paused);
    if (!checked.passed) {
      into.mismatched += 1;
      into.mismatches.push(checked);
    }
    return checked;
  } catch (err) {
    into.failed += 1;
    into.failures.push({ target: targetKey(target), message: messageOf(err), err });
    return null;
  }
}

/**
 * Per-minute: unexamined, changed, or last-failed markets. The DB selector owns the cursor
 * rule and bounded fair order; each check re-reads the market under its own lock.
 */
export async function reconcileDueMarkets(
  db: Db,
  publish: Publish,
  logger: Logger,
): Promise<ReconciliationBatch> {
  const due = await selectDueMarketReconciliationIds(db);
  const result = batch();
  for (const marketId of due) {
    await collect(result, db, { scope: 'market', marketId }, publish, logger, 'scheduled');
  }
  return result;
}

/**
 * 04:00 KST: every person's account (including missing ones), treasury and each market's
 * system accounts, then supply. Market accounts are routed by the DB helper before taking
 * balance locks. Manual `all` also checks markets with no system account, once each.
 */
export async function reconcileLedger(
  db: Db,
  publish: Publish,
  logger: Logger,
  options: { source?: Source; allMarkets?: boolean } = {},
): Promise<ReconciliationBatch> {
  const source = options.source ?? 'scheduled';
  const targets = await selectReconciliationAccountTargets(db);
  const result = batch();
  const checkedMarkets = new Set<string>();
  for (const target of targets) {
    const checked = await collect(
      result,
      db,
      { scope: 'account', ...target },
      publish,
      logger,
      source,
    );
    if (checked?.marketId !== null && checked?.marketId !== undefined) {
      checkedMarkets.add(checked.marketId);
    }
  }
  if (options.allMarkets) {
    const markets = await db
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .orderBy(asc(schema.markets.id));
    for (const { id: marketId } of markets) {
      if (!checkedMarkets.has(marketId)) {
        await collect(result, db, { scope: 'market', marketId }, publish, logger, source);
      }
    }
  }
  await collect(result, db, { scope: 'supply' }, publish, logger, source);
  return result;
}

/** Keep job storage and routine logs small; full mismatch evidence is in the immutable result. */
export function reconciliationBatchSummary(result: ReconciliationBatch) {
  const { mismatches: _mismatches, failures, ...summary } = result;
  return {
    ...summary,
    failures: failures.map(({ target, message }) => ({ target, message })),
  };
}
