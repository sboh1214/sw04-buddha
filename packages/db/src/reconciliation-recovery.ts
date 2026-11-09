import { RECONCILIATION_RECOVERY_APPROVAL_KIND, type ReconciliationRefusal } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { expireLockedOrders, lockMarketOrders, type ExpiredOrders } from './order-cancel.js';
import {
  activeReconciliationHold,
  latestReconciliationResult,
  lockReconciliationUser,
  reconciliationMarketKey,
  runAccountReconciliation,
  runMarketReconciliation,
  type ReconciliationHoldRow,
  type ReconciliationRun,
} from './reconciliation-audit.js';
import {
  approvalRequests,
  markets,
  reconciliationHolds,
  reconciliationRecoveries,
} from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class ReconciliationError extends Error {
  readonly code: ReconciliationRefusal;
  constructor(code: ReconciliationRefusal) {
    super(`Reconciliation recovery: ${code}`);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}
export interface ReconciliationRecoveryEvidence {
  holdId: string;
  failureResultId: number | null;
}
export interface RecoverReconciliationInput extends ReconciliationRecoveryEvidence {
  approvalId: string;
  requestedBy: string;
  approverId: string;
}

/** Lock the target first, then the hold. An API takes its admin-role/approval locks after this. */
export async function lockReconciliationHold(
  tx: Tx,
  holdId: string,
): Promise<ReconciliationHoldRow | null> {
  const [known] = await tx
    .select()
    .from(reconciliationHolds)
    .where(eq(reconciliationHolds.id, holdId));
  if (!known) return null;
  if (known.marketId) {
    await lockMarket(tx, known.marketId);
    await tx.select().from(markets).where(eq(markets.id, known.marketId)).for('update');
    // Includes every current market account and every live order owner in ascending account id.
    await lockMarketOrders(tx, known.marketId);
  } else if (known.userId) await lockReconciliationUser(tx, known.userId);
  const [held] = await tx
    .select()
    .from(reconciliationHolds)
    .where(eq(reconciliationHolds.id, holdId))
    .for('update');
  return held ?? null;
}

async function validateEvidence(
  tx: Tx,
  hold: ReconciliationHoldRow | null,
  input: RecoverReconciliationInput,
  paused: boolean,
): Promise<ReconciliationHoldRow> {
  if (!hold) throw new ReconciliationError('not_found');
  if (hold.recoveredAt !== null || hold.failureResultId !== input.failureResultId)
    throw new ReconciliationError('stale');
  if (input.requestedBy === input.approverId) throw new ReconciliationError('requester');
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalId));
  const expectedKind = paused ? 'market_pause_decision' : RECONCILIATION_RECOVERY_APPROVAL_KIND;
  if (
    !approval ||
    approval.status !== 'approved' ||
    approval.kind !== expectedKind ||
    approval.requestedBy !== input.requestedBy ||
    approval.decidedBy !== input.approverId ||
    approval.targetType !== (paused ? 'market' : 'reconciliation_hold') ||
    approval.targetId !== (paused ? hold.marketId : hold.id)
  )
    throw new ReconciliationError('approval');
  const evidence = paused ? approval.payload?.recovery : approval.payload;
  if (
    typeof evidence !== 'object' ||
    evidence === null ||
    !('holdId' in evidence) ||
    !('failureResultId' in evidence) ||
    evidence.holdId !== hold.id ||
    evidence.failureResultId !==
      (input.failureResultId === null ? null : String(input.failureResultId))
  )
    throw new ReconciliationError('approval');
  const latest = await latestReconciliationResult(tx, hold.targetKey);
  if (!latest?.passed) throw new ReconciliationError('not_passed');
  return hold;
}
async function writeRecovery(
  tx: Tx,
  hold: ReconciliationHoldRow,
  input: RecoverReconciliationInput,
  run: ReconciliationRun,
) {
  if (!run.result.passed) throw new ReconciliationError('not_passed');
  const at = await clockTimestamp(tx);
  await tx.insert(reconciliationRecoveries).values({
    holdId: hold.id,
    resultId: run.result.id,
    approvalId: input.approvalId,
    legacyPauseId: hold.legacyPauseId,
    requestedBy: input.requestedBy,
    approvedBy: input.approverId,
    recoveredAt: at,
  });
  const [recovered] = await tx
    .update(reconciliationHolds)
    .set({ recoveredAt: at })
    .where(eq(reconciliationHolds.id, hold.id))
    .returning();
  return recovered!;
}

/** Closed/cancelled/later market recovery never rewinds status. Account recovery touches no order. */
export async function recoverReconciliationHold(
  tx: Tx,
  input: RecoverReconciliationInput,
): Promise<ReconciliationRun & { expired: ExpiredOrders }> {
  const hold = await validateEvidence(
    tx,
    await lockReconciliationHold(tx, input.holdId),
    input,
    false,
  );
  let expired: ExpiredOrders = { expired: [], held: [], touched: { positions: [] } };
  let run: ReconciliationRun;
  if (hold.marketId) {
    const [market] = await tx.select().from(markets).where(eq(markets.id, hold.marketId));
    if (market?.status === 'paused') throw new ReconciliationError('paused');
    const locked = await lockMarketOrders(tx, hold.marketId);
    run = await runMarketReconciliation(tx, hold.marketId, {
      source: 'recovery',
      actorId: input.approverId,
    });
    if (!run.result.passed) throw new ReconciliationError('not_passed');
    // Pre-close statuses cannot be cleared through the post-close route. OPEN failures become
    // PAUSED automatically; scheduled/draft failures have no live orders and may be released.
    if (market && !['draft', 'review', 'scheduled', 'open'].includes(market.status))
      expired = await expireLockedOrders(tx, locked, {
        at: await clockTimestamp(tx),
        endsHold: true,
      });
  } else {
    run = await runAccountReconciliation(
      tx,
      { userId: hold.userId! },
      { source: 'recovery', actorId: input.approverId },
    );
  }
  return { ...run, hold: await writeRecovery(tx, hold, input, run), expired };
}

/** Called by endMarketPause inside the existing approved resume/early-close transaction. */
export async function recoverPausedMarketReconciliation(
  tx: Tx,
  input: {
    marketId: string;
    approvalId: string;
    requestedBy: string;
    approverId: string;
    recovery?: ReconciliationRecoveryEvidence | null;
  },
): Promise<void> {
  const held = (await ledgerHeldMarketIds(tx, [input.marketId])).has(input.marketId);
  if (!held) {
    if (input.recovery) throw new ReconciliationError('stale');
    return;
  }
  const hold = await activeReconciliationHold(tx, reconciliationMarketKey(input.marketId));
  if (!input.recovery || !hold || input.recovery.holdId !== hold.id)
    throw new ReconciliationError('stale');
  const evidence = { ...input, ...input.recovery };
  await validateEvidence(tx, hold, evidence, true);
  const run = await runMarketReconciliation(tx, input.marketId, {
    source: 'recovery',
    actorId: input.approverId,
  });
  await writeRecovery(tx, hold, evidence, run);
}
