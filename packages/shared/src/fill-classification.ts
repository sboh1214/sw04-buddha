import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { expectedAccountIdSchema } from './expected-account.js';
import { cursorQuerySchema } from './api/pagination.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { approvalStatusSchema, outcomeSchema } from './enums.js';

/** Internal operations only. A classification never changes the underlying fill. */
export const FILL_CLASSIFICATION_ACTIONS = ['mark', 'clear'] as const;
export const fillClassificationActionSchema = z.enum(FILL_CLASSIFICATION_ACTIONS);
export type FillClassificationAction = z.infer<typeof fillClassificationActionSchema>;

export const classificationRevisionSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < 9223372036854775807n);
export const classificationFillIdSchema = z
  .string()
  .max(16)
  .regex(/^[1-9]\d*$/)
  .refine((value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));

export const fillClassificationPayloadSchema = z
  .object({
    fillId: classificationFillIdSchema,
    marketId: z.uuid(),
    action: fillClassificationActionSchema,
    baseRevision: classificationRevisionSchema,
  })
  .strict();
export type FillClassificationPayload = z.infer<typeof fillClassificationPayloadSchema>;

export const requestFillClassificationBodySchema = z
  .object({
    expectedAccountId: expectedAccountIdSchema,
    action: fillClassificationActionSchema,
    baseRevision: classificationRevisionSchema,
    reason: approvalReasonSchema,
  })
  .strict()
  .meta({ id: 'RequestFillClassificationBody' });
export type RequestFillClassificationBody = z.infer<typeof requestFillClassificationBodySchema>;
export const decideFillClassificationBodySchema = z
  .object({
    expectedAccountId: expectedAccountIdSchema,
    reason: approvalReasonSchema,
  })
  .strict()
  .meta({ id: 'DecideFillClassificationBody' });
export type DecideFillClassificationBody = z.infer<typeof decideFillClassificationBodySchema>;
export const retractFillClassificationBodySchema = z
  .object({
    expectedAccountId: expectedAccountIdSchema,
  })
  .strict()
  .meta({ id: 'RetractFillClassificationBody' });
export type RetractFillClassificationBody = z.infer<typeof retractFillClassificationBodySchema>;
export const fillClassificationListQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['pending', 'all']).default('pending'),
});
export type FillClassificationListQuery = z.infer<typeof fillClassificationListQuerySchema>;

export const fillClassificationSchema = z
  .object({
    revision: classificationRevisionSchema,
    approvalId: z.uuid(),
    fillId: classificationFillIdSchema,
    marketId: z.uuid(),
    action: fillClassificationActionSchema,
    requestedBy: adminAccountActorSchema,
    approvedBy: adminAccountActorSchema,
    reason: z.string(),
    decisionReason: z.string(),
    performedAt: z.iso.datetime(),
  })
  .meta({ id: 'FillClassification' });
export type FillClassification = z.infer<typeof fillClassificationSchema>;
export const adminClassifiableFillSchema = z
  .object({
    id: classificationFillIdSchema,
    marketId: z.uuid(),
    marketTitle: z.string(),
    outcome: outcomeSchema,
    priceCoin: z.number().int().min(1).max(99),
    qty: z.number().int().positive(),
    amountCoin: coinAmountSchema,
    createdAt: z.iso.datetime(),
    classificationRevision: classificationRevisionSchema,
    excluded: z.boolean(),
    classification: fillClassificationSchema.nullable(),
  })
  .meta({ id: 'AdminClassifiableFill' });
export type AdminClassifiableFill = z.infer<typeof adminClassifiableFillSchema>;
export const fillClassificationRequestSchema = z
  .object({
    id: z.uuid(),
    payload: fillClassificationPayloadSchema,
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
    execution: fillClassificationSchema.nullable(),
  })
  .meta({ id: 'FillClassificationRequest' });
export type FillClassificationRequest = z.infer<typeof fillClassificationRequestSchema>;
export const fillClassificationWriteSchema = z
  .object({
    request: fillClassificationRequestSchema,
    fill: adminClassifiableFillSchema,
  })
  .meta({ id: 'FillClassificationWrite' });
export type FillClassificationWrite = z.infer<typeof fillClassificationWriteSchema>;

export const FILL_CLASSIFICATION_REFUSALS = [
  'not_found',
  'stale',
  'unchanged',
  'requester',
  'approval',
] as const;
export type FillClassificationRefusal = (typeof FILL_CLASSIFICATION_REFUSALS)[number];
