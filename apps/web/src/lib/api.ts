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
export type Coupon = components['schemas']['Coupon'];
export type Market = components['schemas']['Market'];
export type MarketSummary = components['schemas']['MarketSummary'];
/** A list row: `MarketSummary` plus the card's `sparkline` — only `GET /markets` returns it. */
export type MarketListItem = components['schemas']['MarketListItem'];
export type AdminMarket = components['schemas']['AdminMarket'];
/** One row of `AdminMarket.settlementSteps` (ADR-0046): a judged market's settlement step. */
export type AdminSettlementStep = components['schemas']['AdminSettlementStep'];
export type MarketEvent = components['schemas']['MarketEvent'];
export type Category = components['schemas']['Category'];
export type Fill = components['schemas']['Fill'];
export type PriceTick = components['schemas']['PriceTick'];
/** The tick route's envelope: the window and bucket the server chose, plus `points`. */
export type PriceSeries = components['schemas']['PriceSeries'];
export type Position = components['schemas']['Position'];
export type Order = components['schemas']['Order'];
export type AdminPayment = components['schemas']['AdminPayment'];
/** `POST /admin/payments/{id}/refund`: why the admin refunds (required, audited). */
export type RefundPaymentBody = components['schemas']['RefundPaymentBody'];
export type AuditFailure = components['schemas']['AuditFailure'];
export type CreateMarketBody = components['schemas']['CreateMarketBody'];
export type UpdateMarketBody = components['schemas']['UpdateMarketBody'];
/** `POST /admin/markets/{id}/resolve`: judge a closed market — final at once (ADR-0046). */
export type ResolveMarketBody = components['schemas']['ResolveMarketBody'];
/** A release setting (#170): what the item is, its status and value, and who changed it last. */
export type ReleaseSetting = components['schemas']['ReleaseSetting'];
/** One `GET /admin/release-settings/changes` entry: before and after, reason, admin and time. */
export type ReleaseSettingChange = components['schemas']['ReleaseSettingChange'];
/** `PATCH /admin/release-settings/{key}`: the new status and value, and why (required, audited). */
export type ReleaseSettingChangeBody = components['schemas']['ReleaseSettingChangeBody'];
/** A status and value, before or after a change: `value` is null exactly while `undecided`. */
export type ReleaseSettingState = components['schemas']['ReleaseSettingState'];
/** An account that holds the admin role now, with its latest grant (#171). */
export type AdminAccount = components['schemas']['AdminAccount'];
/** One admin grant or revoke as recorded: account, admin, reason and time (#171). */
export type AdminRoleChange = components['schemas']['AdminRoleChange'];
/** `POST /admin/admins`: the account to make an admin and why (required, recorded). */
export type AdminGrantBody = components['schemas']['AdminGrantBody'];
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
 * way (the charge route's 404 for an unknown `packageId`, INSUFFICIENT_BALANCE on `amountCoin`,
 * the in-progress DUPLICATE_REQUEST on the `Idempotency-Key` header, and the FORBIDDEN on
 * `expectedAccountId` when the cookie belongs to another account — the charge, coupon,
 * contact and password bodies alike).
 * Returns the first field name found, e.g. 'nickname'; undefined when no field is named.
 */
export function validationField(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first = (error.details as Partial<ValidationIssue>[])[0]?.path?.[0];
  return typeof first === 'string' ? first : undefined;
}

/**
 * The first issue's `message`, when `details` is a `ValidationIssue[]`: how the API tells apart
 * refusals that share a code and a field — a taken market slug (`already exists`), a release
 * setting change to the current state (RELEASE_SETTING_UNCHANGED_MESSAGE). Undefined otherwise.
 */
export function validationMessage(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first: unknown = error.details[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return undefined;
  const message: unknown = (first as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * The 403 that means "the cookie belongs to somebody else than the account on screen": the
 * server refused to charge, to redeem for, or to write the contact or first password of an
 * account the user is not looking at (PLAN 5.3 shape — `chargeBodySchema`,
 * `redeemCouponBodySchema`, `contactBodySchema` and `setPasswordBodySchema` all carry
 * `expectedAccountId`; A-PG-24 for the last two). Only this FORBIDDEN names the field; the CSRF refusal names none.
 *
 * It lives beside `validationField`, which it is built on, rather than in the wallet hook it
 * started in: the keyed flows that send `expectedAccountId` (charge, coupon) must keep their
 * idempotency key on this answer (the server judged the cookie, not the key), and the contact
 * hook must not import a wallet hook — and a whole `'use client'` module — to ask a pure
 * question about an ApiError.
 */
export function isForAnotherAccount(error: unknown): boolean {
  return isApiError(error, 'FORBIDDEN') && validationField(error) === 'expectedAccountId';
}
