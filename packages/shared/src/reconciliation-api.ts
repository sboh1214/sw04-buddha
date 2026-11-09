import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { approvalReasonSchema } from './approvals.js';
import { approvalStatusSchema, marketStatusSchema } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import {
  reconciliationHoldSchema,
  reconciliationResultSchema,
  reconciliationTargetSchema,
} from './reconciliation.js';

/** Database identifiers use decimal strings at the boundary and safe integers internally. */
export const reconciliationNumericIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'Identifier is too large');

export const runReconciliationBodySchema = expectedAccountBodySchema
  .extend({
    target: reconciliationTargetSchema.refine(
      (target) => !('accountId' in target) || Number.isSafeInteger(Number(target.accountId)),
      'Identifier is too large',
    ),
  })
  .meta({ id: 'RunReconciliationBody' });
export type RunReconciliationBody = z.infer<typeof runReconciliationBodySchema>;

export const reconciliationRunSchema = z
  .object({
    result: reconciliationResultSchema,
    hold: reconciliationHoldSchema.nullable(),
  })
  .meta({ id: 'ReconciliationRun' });
export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

export const reconciliationResultsQuerySchema = cursorQuerySchema.extend({
  targetKey: z.string().min(1).max(200).optional(),
});
export type ReconciliationResultsQuery = z.infer<typeof reconciliationResultsQuerySchema>;
export const reconciliationHoldsQuerySchema = cursorQuerySchema.extend({
  state: z.enum(['active', 'all']).default('active'),
  marketId: z.uuid().optional(),
  userId: z.string().min(1).max(200).optional(),
});
export type ReconciliationHoldsQuery = z.infer<typeof reconciliationHoldsQuerySchema>;

export const requestReconciliationRecoveryBodySchema = expectedAccountBodySchema
  .extend({
    failureResultId: reconciliationNumericIdSchema.nullable(),
    reason: approvalReasonSchema,
  })
  .meta({ id: 'RequestReconciliationRecoveryBody' });
export type RequestReconciliationRecoveryBody = z.infer<
  typeof requestReconciliationRecoveryBodySchema
>;
export const decideReconciliationRecoveryBodySchema = expectedAccountBodySchema
  .extend({
    reason: approvalReasonSchema,
  })
  .meta({ id: 'DecideReconciliationRecoveryBody' });
export type DecideReconciliationRecoveryBody = z.infer<
  typeof decideReconciliationRecoveryBodySchema
>;

export const reconciliationRecoveryRequestSchema = z
  .object({
    id: z.uuid(),
    holdId: z.uuid(),
    failureResultId: z.string().nullable(),
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReconciliationRecoveryRequest' });
export type ReconciliationRecoveryRequest = z.infer<typeof reconciliationRecoveryRequestSchema>;

export const reconciliationHoldDetailSchema = z
  .object({
    hold: reconciliationHoldSchema,
    latestResult: reconciliationResultSchema.nullable(),
    requests: z.array(reconciliationRecoveryRequestSchema),
    market: z.object({ id: z.uuid(), title: z.string(), status: marketStatusSchema }).nullable(),
    user: adminAccountActorSchema.nullable(),
  })
  .meta({ id: 'ReconciliationHoldDetail' });
export type ReconciliationHoldDetail = z.infer<typeof reconciliationHoldDetailSchema>;
