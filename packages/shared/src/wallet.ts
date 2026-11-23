import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { uuidParamSchema } from './api/path-param.js';
import { recentPeriodSchema } from './api/period.js';
import { ledgerRefTypeSchema, paymentStatusSchema } from './enums.js';
import { LEDGER_FILTER_KINDS, ledgerEntryKindSchema } from './ledger.js';

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

/**
 * What a Coin correction's ledger row did (#69, ADR-0144): `ledger_only` — the ledger replenished
 * to the balance already held (원장 보충: `replenish_ledger` with no balance change) — or
 * `ledger_amount`, the ledger and the balance moved by the amount (and every legacy row, which has
 * no correction record). `GET /me/reconciliation-corrections` already says the same.
 */
export const LEDGER_CORRECTION_EFFECTS = ['ledger_only', 'ledger_amount'] as const;
export type LedgerCorrectionEffect = (typeof LEDGER_CORRECTION_EFFECTS)[number];

/**
 * One event of the caller's own Coin ledger (#116; the wallet's, #69, ADR-0144). One row per
 * ledger row, never merged or split (ADR-0135 H3). Owner only, and anonymous on the other side: no
 * counterparty account, order or account type, and nothing that tells a pair mint's collateral
 * from a trade's payment (ADR-0135 결과 4) — both are `BUY_FILL`, both refer to their fill.
 */
export const ledgerEntrySchema = z
  .object({
    /** ledger_entries.id (bigserial) as a decimal string, like every other 64-bit id. */
    id: z.string(),
    /**
     * The wallet's kind (LEDGER_KIND_SOURCES): the stored type and the caller's side of it. The
     * stored type itself is not answered (ADR-0135 결과 4) — a field change, not a renamed word.
     */
    kind: ledgerEntryKindSchema,
    /**
     * Signed from the caller's own ledger account: `+` credits it, `−` debits it (PLAN 5.6). Never
     * the other side of the move: no counterparty, no account id (#116).
     */
    amountCoin: coinAmountSchema,
    /**
     * The account's total as its ledger says — available + locked, unless an owner-level write
     * left a gap (ADR-0109 결정 12-8) — right after this event (#116). Above the available Coin
     * while orders hold locks (#118, ADR-0110): a lock moves Coin within the total, no event.
     */
    balanceAfterCoin: coinAmountSchema,
    /** The event's source (#116: every event names one — a payment, a grant, a fill …). */
    refType: ledgerRefTypeSchema,
    refId: z.string(),
    /**
     * A correction's member-facing reason, and a 판정 오류 보상's (#144, ADR-0166; 144-12: the
     * reason its request wrote for the members, never the internal one); null on any other
     * market's event (a settlement's memo names the market as it was titled, which a market no
     * longer public may not show); otherwise the event's own memo (a kept coupon's …).
     */
    memo: z.string().nullable(),
    /** The event's market (`ledger_entries.market_id`); null for a grant, a correction … */
    marketId: z.uuid().nullable(),
    /** The market's slug and title while it is public (`isPublicMarketStatus`), else null. */
    marketSlug: z.string().nullable(),
    marketTitle: z.string().nullable(),
    /**
     * A fill's event only: the caller's own order of the fill — the incoming one when the caller
     * sent it, the resting one when the caller's order rested; null otherwise. Never the other
     * side's order.
     */
    orderId: z.uuid().nullable(),
    /** A correction's event only (LEDGER_CORRECTION_EFFECTS); null for every other kind. */
    correctionEffect: z.enum(LEDGER_CORRECTION_EFFECTS).nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'LedgerEntry' });
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/**
 * `GET /me/ledger` (no `.meta`: query DTO; #69, ADR-0144): newest first, one kind of the filter
 * (LEDGER_FILTER_KINDS; omitted = every kind, there is no `all` value), the events within
 * `period` (#124's format, by the event's time — the time the list is ordered by) and one
 * market's. The cursor carries no filter.
 */
export const myLedgerQuerySchema = cursorQuerySchema.extend({
  kind: z.enum(LEDGER_FILTER_KINDS).optional(),
  period: recentPeriodSchema.optional(),
  marketId: uuidParamSchema.optional(),
});
export type MyLedgerQuery = z.infer<typeof myLedgerQuerySchema>;

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

export const auditFailureSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    payload: z.unknown().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditFailure' });
export type AuditFailure = z.infer<typeof auditFailureSchema>;
