import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import {
  DISPUTE_ADMIN_NOTE_MAX,
  DISPUTE_EVIDENCE_URL_MAX,
  DISPUTE_REASON_MAX,
} from './constants.js';
import { disputeStatusSchema, marketStatusSchema, outcomeSchema } from './enums.js';

/**
 * Dispute DTOs (PLAN 5.5, 7.2, 7.3, 12; M5). A dispute is one user's objection to a proposed
 * result, filed while the market is `resolving` and its dispute window is open; the admin
 * reviews it (accepted / rejected + note) and, separately and explicitly, changes the result
 * on the market if warranted (PLAN 12: "수용해도 자동으로 결과가 바뀌지는 않는다").
 *
 * Composition follows market.ts: field maps once, `.meta({ id })` on every DTO a controller
 * answers with, none on the query DTOs (swagger 12 expands an id-less `@Query({ schema })`
 * object into parameters by itself, and `cursorQuerySchema.extend(...)` drops the parent's id).
 */

/** `POST /markets/:id/disputes` (PLAN 7.2). */
export const createDisputeBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(DISPUTE_REASON_MAX),
    evidenceUrl: z
      .url({ protocol: /^https?$/ })
      .max(DISPUTE_EVIDENCE_URL_MAX)
      .nullish(),
  })
  .meta({ id: 'CreateDisputeBody' });
export type CreateDisputeBody = z.infer<typeof createDisputeBodySchema>;

const disputeFields = {
  id: z.uuid(),
  marketId: z.uuid(),
  marketSlug: z.string(),
  marketTitle: z.string(),
  /** The market as it stands now, so a list can say whether the objection is still open to review. */
  marketStatus: marketStatusSchema,
  /** The result currently proposed (or finalized); null once the market was voided. */
  resolvedResult: outcomeSchema.nullable(),
  reason: z.string(),
  evidenceUrl: z.string().nullable(),
  status: disputeStatusSchema,
  adminNote: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
};

/** The caller's own dispute (`GET /me/disputes`, and the answer to filing one). */
export const disputeSchema = z.object(disputeFields).meta({ id: 'Dispute' });
export type Dispute = z.infer<typeof disputeSchema>;

/** `GET /admin/disputes`: the same row with who filed it and who reviewed it. */
export const adminDisputeSchema = z
  .object({
    ...disputeFields,
    userId: z.string(),
    nickname: z.string(),
    /** Reviewing admin's user id; no FK (PLAN 6.2), so it is a plain string. */
    reviewedBy: z.string().nullable(),
  })
  .meta({ id: 'AdminDispute' });
export type AdminDispute = z.infer<typeof adminDisputeSchema>;

/** The two verdicts a review may reach; a dispute never goes back to `open`. */
export const DISPUTE_VERDICTS = ['accepted', 'rejected'] as const;
export type DisputeVerdict = (typeof DISPUTE_VERDICTS)[number];
export const disputeVerdictSchema = z.enum(DISPUTE_VERDICTS);

/** `PATCH /admin/disputes/:id` (PLAN 7.3). */
export const reviewDisputeBodySchema = z
  .object({
    status: disputeVerdictSchema,
    adminNote: z.string().trim().max(DISPUTE_ADMIN_NOTE_MAX).nullish(),
  })
  .meta({ id: 'ReviewDisputeBody' });
export type ReviewDisputeBody = z.infer<typeof reviewDisputeBodySchema>;

/** `GET /me/disputes` (no `.meta`: query DTO). `marketId` narrows the list to one market. */
export const myDisputesQuerySchema = cursorQuerySchema.extend({
  marketId: uuidSchema.optional(),
});
export type MyDisputesQuery = z.infer<typeof myDisputesQuerySchema>;

/** `GET /admin/disputes` (no `.meta`: query DTO). Omitted status = every status. */
export const adminDisputesQuerySchema = cursorQuerySchema.extend({
  status: disputeStatusSchema.optional(),
  marketId: uuidSchema.optional(),
});
export type AdminDisputesQuery = z.infer<typeof adminDisputesQuerySchema>;
