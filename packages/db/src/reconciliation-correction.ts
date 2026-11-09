import {
  reconciliationCorrectionCandidateSchema,
  type ReconciliationCorrectionCandidate,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { balances, reconciliationCorrections } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type ReconciliationCorrectionRow = typeof reconciliationCorrections.$inferSelect;
export class ReconciliationCorrectionError extends Error {
  readonly code:
    'not_found' | 'stale' | 'approval' | 'requester' | 'insufficient_treasury' | 'unsupported';
  constructor(code: ReconciliationCorrectionError['code']) {
    super(`Reconciliation correction: ${code}`);
    this.name = 'ReconciliationCorrectionError';
    this.code = code;
  }
}
function rethrow(error: unknown): never {
  // Drizzle wraps the PostgreSQL error; preserve unexpected failures for rollback/observability.
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    const code = cause.message.match(
      /reconciliation_correction:(not_found|stale|approval|requester|insufficient_treasury|unsupported)/,
    )?.[1];
    if (code)
      throw new ReconciliationCorrectionError(code as ReconciliationCorrectionError['code']);
    cause = cause.cause;
  }
  throw error;
}

/** Pure preview, safe in a read-only REPEATABLE READ transaction. No treasury funding is required. */
export async function previewReconciliationCorrections(
  tx: Tx,
  resultId: number,
): Promise<ReconciliationCorrectionCandidate[]> {
  const { rows } = await tx.execute<{ candidate: unknown }>(
    sql`SELECT candidate FROM public.reconciliation_correction_candidates(${resultId}) candidate`,
  );
  return rows.map(({ candidate }) => reconciliationCorrectionCandidateSchema.parse(candidate));
}

/** Caller first locks the immutable market identity, then admin roles. This helper re-locks
 * those, the user hold key, and EVERY target/market/treasury balance in id order before approvals.
 * Never locks profiles after balances, and never acquires an unrelated market.
 */
export async function lockReconciliationCorrection(
  tx: Tx,
  resultId: number,
  accountId: number,
): Promise<void> {
  try {
    await tx.execute(sql`SELECT public.lock_reconciliation_correction(${resultId},${accountId})`);
  } catch (error) {
    rethrow(error);
  }
}

/** Applies the immutable approved payload, once. The database alone can write the permanent
 * record and the precisely bound gap exception; an application-level raw UPDATE stays forbidden.
 * Publish the returned eventId only after the enclosing transaction commits. A restoration takes
 * its cursor from the ledger sequence but creates no transfer and adds no minted supply.
 */
export async function applyReconciliationCorrection(
  tx: Tx,
  input: { approvalId: string; requestedBy: string; approverId: string },
) {
  let id: string;
  let recorded: boolean;
  try {
    const { rows } = await tx.execute<{ result: { id: string; recorded: boolean } }>(
      sql`SELECT public.apply_reconciliation_correction(${input.approvalId}::uuid,${input.requestedBy},${input.approverId}) AS result`,
    );
    id = rows[0]!.result.id;
    recorded = rows[0]!.result.recorded;
  } catch (error) {
    rethrow(error);
  }
  const [correction] = await tx
    .select()
    .from(reconciliationCorrections)
    .where(eq(reconciliationCorrections.id, id));
  if (!correction) throw new Error('Correction record disappeared');
  const [balance] = await tx
    .select()
    .from(balances)
    .where(eq(balances.accountId, correction.accountId));
  if (!balance) throw new Error('Correction balance disappeared');
  return {
    correction,
    balance,
    eventId: correction.eventId,
    outcome: recorded ? ('recorded' as const) : ('duplicate' as const),
  };
}
