import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { coinAmountInputSchema, coinAmountSchema } from './api/coin-amount.js';
import { cursorQuerySchema } from './api/pagination.js';
import { approvalReasonSchema } from './approvals.js';
import { MAX_COIN_AMOUNT } from './constants.js';
import { approvalStatusSchema } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';

export const TREASURY_ISSUE_APPROVAL_KIND = 'treasury_issue';
const numericId = z.string().regex(/^[1-9]\d*$/);
const positiveCoin = coinAmountInputSchema.refine(
  (value) => value > 0n && value <= MAX_COIN_AMOUNT,
  'must be positive and no greater than MAX_COIN_AMOUNT',
);

/** The approved payload is fixed at request time; approval accepts no replacement amount. */
export const treasuryIssuePayloadSchema = z
  .object({
    amountCoin: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(MAX_COIN_AMOUNT.toString().length)
      .refine((value) => /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= MAX_COIN_AMOUNT),
  })
  .strict();
export const requestTreasuryIssueBodySchema = expectedAccountBodySchema
  .extend({
    amountCoin: positiveCoin,
    reason: approvalReasonSchema,
  })
  .strict()
  .meta({ id: 'RequestTreasuryIssueBody' });
export type RequestTreasuryIssueBody = z.infer<typeof requestTreasuryIssueBodySchema>;
export const decideTreasuryIssueBodySchema = expectedAccountBodySchema
  .extend({
    reason: approvalReasonSchema,
  })
  .strict()
  .meta({ id: 'DecideTreasuryIssueBody' });
export type DecideTreasuryIssueBody = z.infer<typeof decideTreasuryIssueBodySchema>;

export const adminTreasurySchema = z
  .object({
    accountId: numericId.nullable(),
    status: z.enum(['uninitialized', 'ready', 'inconsistent']),
    availableCoin: coinAmountSchema.nullable(),
    lockedCoin: coinAmountSchema.nullable(),
    ledgerCoin: coinAmountSchema.nullable(),
    issuedCoin: coinAmountSchema,
  })
  .meta({ id: 'AdminTreasury' });
export type AdminTreasury = z.infer<typeof adminTreasurySchema>;

export const treasuryIssueRequestSchema = z
  .object({
    id: z.uuid(),
    amountCoin: coinAmountSchema,
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
    ledgerEntryId: numericId.nullable(),
  })
  .meta({ id: 'TreasuryIssueRequest' });
export type TreasuryIssueRequest = z.infer<typeof treasuryIssueRequestSchema>;
export const treasuryIssueWriteSchema = z
  .object({
    treasury: adminTreasurySchema,
    request: treasuryIssueRequestSchema,
  })
  .meta({ id: 'TreasuryIssueWrite' });
export type TreasuryIssueWrite = z.infer<typeof treasuryIssueWriteSchema>;
export const treasuryIssueRequestsQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['pending', 'all']).default('pending'),
});
export type TreasuryIssueRequestsQuery = z.infer<typeof treasuryIssueRequestsQuerySchema>;

/** Actual, immutable issuances only. Pre-feature ledger rows are not invented approval history. */
export const treasuryIssuanceSchema = z
  .object({
    id: z.uuid(),
    approvalId: z.uuid(),
    amountCoin: coinAmountSchema,
    ledgerEntryId: numericId,
    issuedAt: z.iso.datetime(),
    requestedBy: adminAccountActorSchema,
    approvedBy: adminAccountActorSchema,
    requestReason: z.string(),
    approvalReason: z.string(),
  })
  .meta({ id: 'TreasuryIssuance' });
export type TreasuryIssuance = z.infer<typeof treasuryIssuanceSchema>;
