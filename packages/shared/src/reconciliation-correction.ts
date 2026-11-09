import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { approvalReasonSchema } from './approvals.js';
import { approvalStatusSchema } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { reconciliationNumericIdSchema } from './reconciliation-api.js';
import { reconciliationResultSchema } from './reconciliation.js';

export const RECONCILIATION_CORRECTION_APPROVAL_KIND = 'reconciliation_correction';
export const RECONCILIATION_CORRECTION_MODES = [
  'restore_actual',
  'replenish_ledger',
  'fund_collateral',
  'return_collateral',
] as const;
export const reconciliationCorrectionModeSchema = z.enum(RECONCILIATION_CORRECTION_MODES);
export type ReconciliationCorrectionMode = z.infer<typeof reconciliationCorrectionModeSchema>;
const coin = z.string().regex(/^(0|[1-9]\d*)$/);
const positiveCoin = z.string().regex(/^[1-9]\d*$/);
const signedCoin = z.string().regex(/^-?(0|[1-9]\d*)$/);

/** Server-calculated exact correction. A changed target invalidates its opaque snapshot key. */
export const reconciliationCorrectionCandidateSchema = z
  .object({
    accountId: reconciliationNumericIdSchema,
    accountKind: z.enum(['user', 'treasury', 'market_collateral', 'market_maker_funds']),
    userId: z.string().nullable(),
    marketId: z.uuid().nullable(),
    holdId: z.uuid().nullable(),
    mode: reconciliationCorrectionModeSchema,
    amountCoin: positiveCoin,
    balanceDeltaCoin: signedCoin,
    balanceBeforeCoin: coin,
    balanceAfterCoin: coin,
    ledgerBeforeCoin: coin,
    ledgerAfterCoin: coin,
    snapshotKey: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .meta({ id: 'ReconciliationCorrectionCandidate' });
export type ReconciliationCorrectionCandidate = z.infer<
  typeof reconciliationCorrectionCandidateSchema
>;

export const reconciliationCorrectionPayloadSchema = z.object({
  failureResultId: reconciliationNumericIdSchema,
  candidate: reconciliationCorrectionCandidateSchema,
  userReason: approvalReasonSchema.nullable(),
});
export type ReconciliationCorrectionPayload = z.infer<typeof reconciliationCorrectionPayloadSchema>;

export const requestReconciliationCorrectionBodySchema = expectedAccountBodySchema
  .extend({
    accountId: reconciliationNumericIdSchema,
    mode: reconciliationCorrectionModeSchema,
    amountCoin: positiveCoin,
    snapshotKey: z.string().regex(/^[a-f0-9]{32}$/),
    reason: approvalReasonSchema,
    userReason: approvalReasonSchema.nullable(),
  })
  .meta({ id: 'RequestReconciliationCorrectionBody' });
export type RequestReconciliationCorrectionBody = z.infer<
  typeof requestReconciliationCorrectionBodySchema
>;

export const reconciliationCorrectionRequestSchema = z
  .object({
    id: z.uuid(),
    resultId: reconciliationNumericIdSchema,
    candidate: reconciliationCorrectionCandidateSchema,
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    userReason: z.string().nullable(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReconciliationCorrectionRequest' });
export type ReconciliationCorrectionRequest = z.infer<typeof reconciliationCorrectionRequestSchema>;
export const reconciliationCorrectionDetailSchema = z
  .object({
    result: reconciliationResultSchema,
    candidates: z.array(reconciliationCorrectionCandidateSchema),
    requests: z.array(reconciliationCorrectionRequestSchema),
  })
  .meta({ id: 'ReconciliationCorrectionDetail' });
export type ReconciliationCorrectionDetail = z.infer<typeof reconciliationCorrectionDetailSchema>;
export const reconciliationCorrectionRequestsQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['pending', 'all']).default('pending'),
});
export type ReconciliationCorrectionRequestsQuery = z.infer<
  typeof reconciliationCorrectionRequestsQuerySchema
>;

/** This allowlist is the affected member's own history; no internal evidence or actor identity. */
export const memberReconciliationCorrectionSchema = z
  .object({
    id: z.uuid(),
    eventId: reconciliationNumericIdSchema,
    mode: reconciliationCorrectionModeSchema,
    amountCoin: positiveCoin,
    balanceDeltaCoin: signedCoin,
    balanceAfterCoin: coin,
    userReason: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MemberReconciliationCorrection' });
export type MemberReconciliationCorrection = z.infer<typeof memberReconciliationCorrectionSchema>;
