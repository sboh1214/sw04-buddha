import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { pAmountInputSchema, pAmountSchema } from './api/p-amount.js';
import { chargePackageSchema } from './charge-package.js';
import { ledgerEntryTypeSchema, ledgerRefTypeSchema, paymentStatusSchema } from './enums.js';

/** Admin adjustments are bounded in either direction (PLAN 7.3). */
export const ADJUST_MAX_ABS_P = 1_000_000n;
export const ADJUST_MEMO_MAX_LENGTH = 200;

export const balanceSchema = z
  .object({ availableP: pAmountSchema, lockedP: pAmountSchema })
  .meta({ id: 'Balance' });
export type Balance = z.infer<typeof balanceSchema>;

export const paymentSchema = z
  .object({
    id: z.uuid(),
    /** P credited. */
    amountP: pAmountSchema,
    /** KRW actually paid: below amountP whenever the package carried a discount. */
    priceKrw: z.number().int(),
    /** The package bought, or null once an admin removed it (the amounts above stay). */
    packageId: z.uuid().nullable(),
    /** PAYMENT_PROVIDERS; only 'mock' exists in the MVP. */
    provider: z.string(),
    providerRef: z.string().nullable(),
    status: paymentStatusSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Payment' });
export type Payment = z.infer<typeof paymentSchema>;

export const ledgerEntrySchema = z
  .object({
    /** ledger_entries.id (bigserial) as a decimal string, like every other 64-bit id. */
    id: z.string(),
    type: ledgerEntryTypeSchema,
    /** Signed: `+` credits the account, `−` debits it (PLAN 5.6). */
    amountP: pAmountSchema,
    /** available_p right after this entry was written. */
    balanceAfterP: pAmountSchema,
    refType: ledgerRefTypeSchema.nullable(),
    refId: z.string().nullable(),
    memo: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'LedgerEntry' });
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** What `POST /payments/charge` answers with: the payment and the balance it produced. */
export const chargeResultSchema = z
  .object({
    payment: paymentSchema,
    package: chargePackageSchema,
    balance: balanceSchema,
    ledgerEntry: ledgerEntrySchema,
  })
  .meta({ id: 'ChargeResult' });
export type ChargeResult = z.infer<typeof chargeResultSchema>;

/** `POST /admin/users/:id/balance-adjust` (PLAN 7.3): signed amount, reason required. */
export const balanceAdjustBodySchema = z
  .object({
    amountP: pAmountInputSchema.refine(
      (value) => value !== 0n && value >= -ADJUST_MAX_ABS_P && value <= ADJUST_MAX_ABS_P,
      `must be a non-zero amount within ±${ADJUST_MAX_ABS_P.toString()}`,
    ),
    memo: z.string().trim().min(1).max(ADJUST_MEMO_MAX_LENGTH),
  })
  .meta({ id: 'BalanceAdjustBody' });
export type BalanceAdjustBody = z.infer<typeof balanceAdjustBodySchema>;

export const adminUserSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    nickname: z.string(),
    role: z.enum(['user', 'admin']),
    balance: balanceSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminUser' });
export type AdminUser = z.infer<typeof adminUserSchema>;

/** `GET /admin/users`: free-text search over email and nickname (PLAN 7.3). */
export const adminUserQuerySchema = cursorQuerySchema
  .extend({ q: z.string().trim().min(1).max(100).optional() })
  .meta({ id: 'AdminUserQuery' });
export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>;

/** `GET /admin/payments`: every charge, with the account it belongs to. */
export const adminPaymentSchema = paymentSchema
  .extend({ userId: z.string(), nickname: z.string() })
  .meta({ id: 'AdminPayment' });
export type AdminPayment = z.infer<typeof adminPaymentSchema>;

export const adminBalanceAdjustResultSchema = z
  .object({ user: adminUserSchema, ledgerEntry: ledgerEntrySchema })
  .meta({ id: 'AdminBalanceAdjustResult' });
export type AdminBalanceAdjustResult = z.infer<typeof adminBalanceAdjustResultSchema>;

export const auditFailureSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    payload: z.unknown().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditFailure' });
export type AuditFailure = z.infer<typeof auditFailureSchema>;
