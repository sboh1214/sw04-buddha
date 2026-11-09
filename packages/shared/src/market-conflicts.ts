import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { expectedAccountBodySchema } from './expected-account.js';

/** Every new judgement/correction/dispute decision explicitly confirms this; never default true. */
export const noConflictConfirmationSchema = z.object({ noConflictConfirmed: z.literal(true) });
export const declareMarketConflictBodySchema = expectedAccountBodySchema
  .extend({ reason: approvalReasonSchema })
  .meta({ id: 'DeclareMarketConflictBody' });
export type DeclareMarketConflictBody = z.infer<typeof declareMarketConflictBodySchema>;

/** Admin-only: neither declaration reasons nor the operator's conflict leave this surface. */
export const marketConflictDeclarationSchema = z
  .object({
    id: z.uuid(),
    reason: z.string(),
    declaredAt: z.iso.datetime(),
    declaredBy: adminAccountActorSchema,
  })
  .meta({ id: 'MarketConflictDeclaration' });
export type MarketConflictDeclaration = z.infer<typeof marketConflictDeclarationSchema>;
export const adminMarketConflictsSchema = z
  .object({
    marketId: z.uuid(),
    operator: z.object({
      userId: z.string(),
      hasFill: z.boolean(),
      conflicted: z.boolean(),
      declaration: marketConflictDeclarationSchema.nullable(),
    }),
    declarations: z.array(marketConflictDeclarationSchema),
  })
  .meta({ id: 'AdminMarketConflicts' });
export type AdminMarketConflicts = z.infer<typeof adminMarketConflictsSchema>;
