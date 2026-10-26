import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { coinAmountInputSchema, coinAmountSchema } from './api/coin-amount.js';
import { ledgerEntryTypeSchema, ledgerRefTypeSchema, paymentStatusSchema } from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';

/** Admin adjustments are bounded in either direction (PLAN 7.3). */
export const ADJUST_MAX_ABS_COIN = 1_000_000n;
export const ADJUST_MEMO_MAX_LENGTH = 200;

export const balanceSchema = z
  .object({ availableCoin: coinAmountSchema, lockedCoin: coinAmountSchema })
  .meta({ id: 'Balance' });
export type Balance = z.infer<typeof balanceSchema>;

export const paymentSchema = z
  .object({
    id: z.uuid(),
    /** Coin credited. */
    amountCoin: coinAmountSchema,
    /** KRW actually paid: below amountCoin whenever the package carried a discount. */
    priceKrw: z.number().int(),
    /** The package bought, or null once an admin removed it (the amounts above stay). */
    packageId: z.uuid().nullable(),
    /** PAYMENT_PROVIDERS; kept a plain string like the column. */
    provider: z.string(),
    /** The provider's transaction id (a PG's approval id). */
    providerRef: z.string().nullable(),
    status: paymentStatusSchema,
    /** The PG's PayMethod of the approval (CARD, KAKAO, …); null for mock and unapproved rows. */
    method: z.string().nullable(),
    /** When the charge was approved and credited; null until then. */
    approvedAt: z.iso.datetime().nullable(),
    /** When an admin refund was confirmed by the PG (status `refunded`). */
    refundedAt: z.iso.datetime().nullable(),
    /**
     * Why a payment that did not go through ended — the PG's last ResultMsg (a card refusal), or
     * the reason a cancel was made — shown to the payer under a `failed` or `cancelled` one.
     */
    resultMessage: z.string().nullable(),
    /**
     * `cancelled` only (null for every other status): whether the card's cancel is confirmed —
     * a `net_cancel` event the PG confirmed. False while a cancel of an approval we could not
     * credit got no clear answer, or has not been answered yet: the card may still be charged,
     * so it is not over for the payer.
     */
    cancelConfirmed: z.boolean().nullable(),
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
    amountCoin: coinAmountSchema,
    /** available_coin right after this entry was written. */
    balanceAfterCoin: coinAmountSchema,
    refType: ledgerRefTypeSchema.nullable(),
    refId: z.string().nullable(),
    memo: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'LedgerEntry' });
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/**
 * What `POST /payments/charge` answers with: the payment and the balance it produced.
 *
 * No `package`: the payment row is the immutable record of the purchase (id, Coin granted, KRW
 * paid — ADR-0026), while the catalogue row it points at may be re-priced or deleted by an
 * admin at any time. Echoing that row would be redundant on a fresh answer and wrong on a
 * replayed one (same `Idempotency-Key`, PLAN 5.4), which must be the first outcome, not the
 * catalogue as it stands today. `balance` is the account's balance at the time of the answer,
 * so a replay reports the current one, which is what the client shows.
 */
export const chargeResultSchema = z
  .object({
    payment: paymentSchema,
    balance: balanceSchema,
    ledgerEntry: ledgerEntrySchema,
  })
  .meta({ id: 'ChargeResult' });
export type ChargeResult = z.infer<typeof chargeResultSchema>;

/**
 * `POST /admin/users/:id/balance-adjust` (PLAN 7.3): signed amount, reason required, as the admin
 * on screen (`expectedAccountId`, ADR-0092 — Q-PG-8 ①, owner decision 2026-10-26 «이 PR에서 더함»).
 */
export const balanceAdjustBodySchema = z
  .object({
    amountCoin: coinAmountInputSchema.refine(
      (value) => value !== 0n && value >= -ADJUST_MAX_ABS_COIN && value <= ADJUST_MAX_ABS_COIN,
      `must be a non-zero amount within ±${ADJUST_MAX_ABS_COIN.toString()}`,
    ),
    memo: z.string().trim().min(1).max(ADJUST_MEMO_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'BalanceAdjustBody' });
export type BalanceAdjustBody = z.infer<typeof balanceAdjustBodySchema>;

export const adminUserSchema = z
  .object({
    id: z.string(),
    /** A closed account's is its placeholder (`closedAccountEmail`, #140): the address is gone. */
    email: z.email(),
    /** Null for an account its member closed (#140): the nickname went with the closure. */
    nickname: z.string().nullable(),
    role: z.enum(['user', 'admin']),
    balance: balanceSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminUser' });
export type AdminUser = z.infer<typeof adminUserSchema>;

/**
 * Which accounts `GET /admin/users` lists: `open` ones only, or `closed` ones only (their member
 * closed them, #140); every account when absent. The account list (`/admin/users`) keeps the
 * closed ones beside the rest with their own '탈퇴' marker, and the admin role's grant search asks
 * for `open` ones only — a closed account never takes the role, so it is not offered at all (owner
 * decision 2026-10-23 (2차) 5, ADR-0086; ACCOUNT_CLOSED stays the grant's own guard).
 */
export const ADMIN_USER_STATUSES = ['open', 'closed'] as const;
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

/** `GET /admin/users`: free-text search over email and nickname (PLAN 7.3), all or by status. */
export const adminUserQuerySchema = cursorQuerySchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(ADMIN_USER_STATUSES).optional(),
  })
  .meta({ id: 'AdminUserQuery' });
export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>;

/** `GET /admin/payments`: every charge, with the account it belongs to. */
export const adminPaymentSchema = paymentSchema
  .extend({
    userId: z.string(),
    /** Null for an account its member closed (#140): the nickname went with the closure. */
    nickname: z.string().nullable(),
  })
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
