import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { reconciliationHolds } from './schema/index.js';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Before any balance lock, shared by account audits and new orders. Never waits for a market. */
export async function lockReconciliationUserKey(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('reconciliation:user'), hashtext(${userId}))`,
  );
}
/** Whether an unrecovered #93 hold stands on the account; a reader takes no lock (`GET /me/regrant`). */
export async function reconciliationUserHeld(tx: Db | Tx, userId: string): Promise<boolean> {
  const [held] = await tx
    .select({ id: reconciliationHolds.id })
    .from(reconciliationHolds)
    .where(and(eq(reconciliationHolds.userId, userId), isNull(reconciliationHolds.recoveredAt)))
    .limit(1);
  return held !== undefined;
}
