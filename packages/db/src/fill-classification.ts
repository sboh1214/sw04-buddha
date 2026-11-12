import {
  fillClassificationPayloadSchema,
  type FillClassificationPayload,
  type FillClassificationRefusal,
} from '@buddha/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvalRequests, fillClassifications, fills, profiles, markets } from './schema/index.js';
import { lockAdminRoles, lockMarket, clockTimestamp } from './tx-helpers.js';
import { recountClassifiedParticipants } from './market-stats.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;
export const FILL_CLASSIFICATION_KIND = 'fill_classification';
export class FillClassificationError extends Error {
  readonly code: FillClassificationRefusal;
  constructor(code: FillClassificationRefusal) {
    super(`Fill classification: ${code}`);
    this.name = 'FillClassificationError';
    this.code = code;
  }
}
const refuse = (code: FillClassificationRefusal): never => {
  throw new FillClassificationError(code);
};

export async function readFillClassification(reader: Reader, fillId: number) {
  const [row] = await reader
    .select()
    .from(fillClassifications)
    .where(eq(fillClassifications.fillId, fillId))
    .orderBy(desc(fillClassifications.revision))
    .limit(1);
  return row ?? null;
}
export async function assertFillClassificationAdmin(tx: Tx, actorId: string): Promise<void> {
  await lockAdminRoles(tx, 'shared');
  const [actor] = await tx
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(eq(profiles.userId, actorId), eq(profiles.role, 'admin'), isNull(profiles.closedAt)),
    );
  if (!actor) refuse('approval');
}
/** Identity is immutable; market first, before roles, clock and approval rows. */
export async function lockClassifiableFill(tx: Tx, fillId: number) {
  const [fill] = await tx.select().from(fills).where(eq(fills.id, fillId));
  if (!fill) return refuse('not_found');
  await lockMarket(tx, fill.marketId);
  return fill;
}
export async function assertFillClassificationCurrent(tx: Tx, payload: FillClassificationPayload) {
  const fill = await lockClassifiableFill(tx, Number(payload.fillId));
  if (fill.marketId !== payload.marketId) return refuse('not_found');
  const current = await readFillClassification(tx, fill.id);
  if ((current?.revision ?? 0n).toString() !== payload.baseRevision) refuse('stale');
  if ((current?.action === 'mark') === (payload.action === 'mark')) refuse('unchanged');
  return fill;
}
/** Call before ApprovalService.approve: this clock serializes only classification decisions. */
export async function lockFillClassificationDecision(tx: Tx, payload: FillClassificationPayload) {
  const fill = await assertFillClassificationCurrent(tx, payload);
  await lockAdminRoles(tx, 'shared');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('buddha:fill_classifications'),1)`);
  const [clock] = await tx
    .select({
      revision: sql<bigint>`coalesce(max(${fillClassifications.revision}),0)::bigint`.mapWith(
        BigInt,
      ),
    })
    .from(fillClassifications);
  if (!clock || clock.revision >= 9223372036854775806n) return refuse('approval');
  return { fill, clock };
}

/** No economic writes, state transitions, notifications or modifications of the raw fill. */
export async function applyFillClassification(tx: Tx, approvalId: string) {
  const [identity] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId));
  if (!identity || identity.kind !== FILL_CLASSIFICATION_KIND || identity.targetType !== 'fill')
    return refuse('not_found');
  const parsed = fillClassificationPayloadSchema.safeParse(identity.payload);
  if (!parsed.success || identity.targetId !== parsed.data.fillId) return refuse('approval');
  const payload = parsed.data;
  await lockClassifiableFill(tx, Number(payload.fillId));
  await lockAdminRoles(tx, 'shared');
  const [prior] = await tx
    .select()
    .from(fillClassifications)
    .where(eq(fillClassifications.approvalId, approvalId));
  if (prior) return { outcome: 'duplicate' as const, execution: prior, stats: null };
  const { clock } = await lockFillClassificationDecision(tx, payload);
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .for('update');
  if (
    !approval ||
    approval.status !== 'approved' ||
    !approval.decidedBy ||
    approval.requestedBy === approval.decidedBy
  )
    return refuse('approval');
  const admins = await tx
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(
        inArray(profiles.userId, [approval.requestedBy, approval.decidedBy]),
        eq(profiles.role, 'admin'),
        isNull(profiles.closedAt),
      ),
    );
  if (admins.length !== 2) return refuse('requester');
  const [market] = await tx
    .select({ statsRevision: markets.statsRevision })
    .from(markets)
    .where(eq(markets.id, payload.marketId));
  if (!market) return refuse('not_found');
  const revision = clock.revision + 1n;
  const [execution] = await tx
    .insert(fillClassifications)
    .values({
      revision,
      approvalId,
      fillId: Number(payload.fillId),
      marketId: payload.marketId,
      action: payload.action,
      baseRevision: BigInt(payload.baseRevision),
      beforeStatsRevision: market.statsRevision,
      afterStatsRevision: market.statsRevision + 1n,
      requestedBy: approval.requestedBy,
      approvedBy: approval.decidedBy,
      performedAt: await clockTimestamp(tx),
      appliedTxid: sql`pg_current_xact_id()::text`,
    })
    .returning();
  const stats = await recountClassifiedParticipants(tx, payload.marketId);
  return { outcome: 'recorded' as const, execution: execution!, stats };
}
