import { createApiClient, type components } from '@buddha/api-client';
import { type ErrorCode, type ValidationIssue } from '@buddha/shared';

/**
 * Browser client for the API. OpenAPI paths carry the full `/api/v1/...` prefix, so the base
 * URL is the current origin (Next.js rewrites /api/* to the API; the session cookie rides
 * along). On the server the base URL would be NEXT_PUBLIC_API_URL.
 */
export const api = createApiClient({ baseUrl: '', credentials: 'include' });

/**
 * The wire DTOs, aliased here once. Nothing else in the app reaches into `components`: the
 * generated schema is rewritten wholesale by `pnpm api:openapi` on every contract change, so a
 * renamed or dropped schema has to break in this file rather than in every screen that named it.
 */
export type Me = components['schemas']['Me'];
export type LinkedAccount = components['schemas']['LinkedAccount'];
/** Real name + mobile number (ADR-0043): `Me.contact`, and the answer to `PUT /me/contact`. */
export type Contact = components['schemas']['Contact'];
export type ContactBody = components['schemas']['ContactBody'];
export type LedgerEntry = components['schemas']['LedgerEntry'];
export type Payment = components['schemas']['Payment'];
export type Balance = components['schemas']['Balance'];
export type AdminUser = components['schemas']['AdminUser'];
export type ChargePackage = components['schemas']['ChargePackage'];
export type ChargeResult = components['schemas']['ChargeResult'];
/** `GET /payments/provider`: which charge flow the wallet offers (ADR-0042). */
export type PaymentProviderInfo = components['schemas']['PaymentProviderInfo'];
/** `POST /payments/smartro/prepare`: the reserved payment and its signed payment-window form. */
export type SmartroPrepareResult = components['schemas']['SmartroPrepareResult'];
export type Coupon = components['schemas']['Coupon'];
export type Market = components['schemas']['Market'];
export type MarketSummary = components['schemas']['MarketSummary'];
/** A list row: `MarketSummary` plus the card's `sparkline` — only `GET /markets` returns it. */
export type MarketListItem = components['schemas']['MarketListItem'];
/** The five fields a trade answer and a `market:tick` both carry, so both patch a cached market. */
export type MarketStats = components['schemas']['MarketStats'];
export type AdminMarket = components['schemas']['AdminMarket'];
/** One row of `AdminMarket.settlementSteps` (ADR-0046): a judged market's settlement step. */
export type AdminSettlementStep = components['schemas']['AdminSettlementStep'];
export type MarketEvent = components['schemas']['MarketEvent'];
export type Category = components['schemas']['Category'];
/** One row of the global ranking (`GET /leaderboard`, public; PLAN M6 선택). */
export type LeaderboardEntry = components['schemas']['LeaderboardEntry'];
export type Fill = components['schemas']['Fill'];
export type PriceTick = components['schemas']['PriceTick'];
/** The tick route's envelope: the window and bucket the server chose, plus `points`. */
export type PriceSeries = components['schemas']['PriceSeries'];
export type Position = components['schemas']['Position'];
export type Order = components['schemas']['Order'];
export type AdminPayment = components['schemas']['AdminPayment'];
/** `POST /admin/payments/{id}/refund`: why the admin refunds (required, audited). */
export type RefundPaymentBody = components['schemas']['RefundPaymentBody'];
/**
 * `POST /admin/payments/{id}/settle` (수동 정리): the outcome the merchant admin showed, why
 * (required, audited), and — for a credit only — the approval's Tid.
 */
export type SettlePaymentBody = components['schemas']['SettlePaymentBody'];
export type PaymentSettleOutcome = SettlePaymentBody['outcome'];
export type AuditFailure = components['schemas']['AuditFailure'];
export type CreateMarketBody = components['schemas']['CreateMarketBody'];
export type UpdateMarketBody = components['schemas']['UpdateMarketBody'];
/** `POST /admin/markets/{id}/resolve`: judge a closed market — final at once (ADR-0046). */
export type ResolveMarketBody = components['schemas']['ResolveMarketBody'];
export type QuoteBody = components['schemas']['QuoteBody'];
export type QuoteResult = components['schemas']['QuoteResult'];
export type TradeBody = components['schemas']['TradeBody'];
export type TradeResult = components['schemas']['TradeResult'];
export type ErrorEnvelope = components['schemas']['ErrorEnvelope'];

/** A non-2xx API response, carrying the `{ error: { code, message, details? } }` envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, envelope: ErrorEnvelope['error'] | undefined) {
    super(envelope?.message ?? `API error ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope?.code ?? (status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL');
    this.details = envelope?.details;
  }
}

/**
 * Narrows the `{ data, error, response }` result of openapi-fetch into `data`, throwing
 * ApiError for the error envelope so TanStack Query and react-hook-form see one error type.
 */
export function unwrap<T>(result: {
  data?: T;
  error?: ErrorEnvelope | undefined;
  response: Response;
}): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(result.response.status, result.error?.error);
  }
  return result.data;
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/**
 * The field an error is about, when `details` is a `ValidationIssue[]` (`[{ path, message }]`,
 * PLAN 7): every VALIDATION_ERROR, and the few other codes that name a body field the same
 * way (the charge route's 404 for an unknown `packageId`, INSUFFICIENT_BALANCE on `amountP`,
 * the in-progress DUPLICATE_REQUEST on the `Idempotency-Key` header, and the FORBIDDEN on
 * `expectedAccountId` when the cookie belongs to another account — the charge, coupon, trade,
 * payment-window, contact and password bodies alike).
 * Returns the first field name found, e.g. 'nickname'; undefined when no field is named.
 */
export function validationField(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first = (error.details as Partial<ValidationIssue>[])[0]?.path?.[0];
  return typeof first === 'string' ? first : undefined;
}

/**
 * The 403 that means "the cookie belongs to somebody else than the account on screen": the
 * server refused to charge, to redeem for, to trade as, to open a payment window for, or to
 * write the contact or first password of an account the user is not looking at (PLAN 5.3 shape
 * — `chargeBodySchema` (the payment window's prepare too), `redeemCouponBodySchema`,
 * `tradeBodySchema`, `contactBodySchema` and `setPasswordBodySchema` all carry
 * `expectedAccountId`; A-PG-24 for the last two). Only this FORBIDDEN names the field; the CSRF
 * refusal names none.
 *
 * It lives beside `validationField`, which it is built on, rather than in the wallet hook it
 * started in: the keyed flows that send `expectedAccountId` (charge, coupon, trade) must keep
 * their idempotency key on this answer (the server judged the cookie, not the key), and the
 * trade and contact hooks must not import a wallet hook — and a whole `'use client'` module — to
 * ask a pure question about an ApiError.
 */
export function isForAnotherAccount(error: unknown): boolean {
  return isApiError(error, 'FORBIDDEN') && validationField(error) === 'expectedAccountId';
}
