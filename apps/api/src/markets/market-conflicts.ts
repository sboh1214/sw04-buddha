import { lockAdminRoles, marketConflictOf, schema } from '@buddha/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { fieldError, type Tx } from './market-item-rules.js';

/** Caller holds the market lock first. Role changes cannot race the decision after this. */
export async function assertMarketConflictAdmin(tx: Tx, adminId: string): Promise<void> {
  await lockAdminRoles(tx, 'shared');
  const [profile] = await tx
    .select({ role: schema.profiles.role })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, adminId))
    .limit(1);
  if (profile?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
}

export async function assertNoMarketConflict(
  tx: Tx,
  marketId: string,
  userId: string,
): Promise<void> {
  if ((await marketConflictOf(tx, marketId, userId)).conflicted) {
    throw new AppError('FORBIDDEN', {
      message: 'An interested administrator cannot decide this market',
      details: [{ path: ['conflict'], message: 'market_conflict' }],
    });
  }
}

/** Explicit acknowledgement never substitutes for checking the stored interests. */
export async function assertMarketDecisionEligibility(
  tx: Tx,
  marketId: string,
  adminId: string,
  confirmed: boolean,
): Promise<void> {
  await assertMarketConflictAdmin(tx, adminId);
  if (confirmed !== true)
    throw fieldError('noConflictConfirmed', 'Confirm that no interest needs declaring', 'required');
  await assertNoMarketConflict(tx, marketId, adminId);
}
