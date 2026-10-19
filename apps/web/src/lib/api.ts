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
/**
 * 본인확인 (ADR-0070): the verified number, real name and time — `Me.verification`, and the answer
 * to the confirmation and to `PUT /me/real-name`.
 */
export type PhoneVerification = components['schemas']['PhoneVerification'];
/** `POST /me/phone-verification/code`: real name, number and the account on screen. */
export type RequestPhoneVerificationCodeBody =
  components['schemas']['RequestPhoneVerificationCodeBody'];
/** The answer to a sent code: seconds until it expires and until another may be requested. */
export type PhoneVerificationCodeSent = components['schemas']['PhoneVerificationCodeSent'];
/** `POST /me/phone-verification/confirm`: the six digits and the account on screen. */
export type ConfirmPhoneVerificationBody = components['schemas']['ConfirmPhoneVerificationBody'];
/** `PUT /me/real-name` (MY 설정): the new real name and the account on screen. */
export type UpdateRealNameBody = components['schemas']['UpdateRealNameBody'];
/** `PUT /me/time-zone` (ADR-0063): the zone, or null to follow the browser, and the account. */
export type UpdateTimeZoneBody = components['schemas']['UpdateTimeZoneBody'];
/** `PATCH /me`: the nickname and the account the screen shows (#58). */
export type UpdateMeBody = components['schemas']['UpdateMeBody'];
/** `POST /me/consents` (#58): every consent item at its current version, and the account. */
export type RecordConsentsBody = components['schemas']['RecordConsentsBody'];
/** `POST /me/onboarding/nickname` (#58): the nickname the step sets or confirms, and the account. */
export type SetOnboardingNicknameBody = components['schemas']['SetOnboardingNicknameBody'];
/** `PUT /me/interest-categories` (#58): the categories picked (none: the skip), and the account. */
export type SetInterestCategoriesBody = components['schemas']['SetInterestCategoriesBody'];
export type LedgerEntry = components['schemas']['LedgerEntry'];
export type Payment = components['schemas']['Payment'];
export type Balance = components['schemas']['Balance'];
export type AdminUser = components['schemas']['AdminUser'];
export type ChargePackage = components['schemas']['ChargePackage'];
export type ChargeResult = components['schemas']['ChargeResult'];
export type Coupon = components['schemas']['Coupon'];
export type Market = components['schemas']['Market'];
/** A list row — `GET /markets` and `GET /admin/markets` — and what a market card draws. */
export type MarketSummary = components['schemas']['MarketSummary'];
export type AdminMarket = components['schemas']['AdminMarket'];
/** One of a market's 관련 시장 on the admin detail (#65): the list row, who linked it and when. */
export type AdminRelatedMarket = components['schemas']['AdminRelatedMarket'];
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
/** Whether the caller watches one market (#89): `GET` and `PUT /me/watchlist/{marketId}`. */
export type WatchState = components['schemas']['WatchState'];
/** `PUT /me/watchlist/{marketId}`: watch or unwatch, and the account on screen (ADR-0064). */
export type UpdateWatchBody = components['schemas']['UpdateWatchBody'];
/** One term of the recent searches (#15, ADR-0066): `GET /me/search-history` and its writes. */
export type RecentSearch = components['schemas']['RecentSearch'];
/** `POST /me/search-history`: the submitted term and the account on screen (ADR-0066). */
export type RecordSearchBody = components['schemas']['RecordSearchBody'];
/**
 * 근거 글 (#46, ADR-0073): a community card (`GET /posts`), a post page in one of its three states
 * (`GET /posts/:postId`), the published one alone, its author and its market as every public answer
 * names them, and the answer of a deletion.
 */
export type PostSummary = components['schemas']['PostSummary'];
export type Post = components['schemas']['Post'];
export type PublishedPost = components['schemas']['PublishedPost'];
export type PostAuthor = components['schemas']['PostAuthor'];
export type PostMarket = components['schemas']['PostMarket'];
export type PostDeletion = components['schemas']['PostDeletion'];
/** `POST /posts` and `PUT /posts/:postId`: the title, the editor's JSON and the account on screen. */
export type CreatePostBody = components['schemas']['CreatePostBody'];
export type UpdatePostBody = components['schemas']['UpdatePostBody'];
/**
 * 댓글·대댓글 (#48, ADR-0074): one 댓글 of `GET /posts/:postId/comments` with every 대댓글 under it,
 * a comment in one of its three states (the published one, or the placeholder of a deleted 댓글
 * with 대댓글 under it or of a hidden comment), the published one alone (what the writes answer),
 * the answer of a deletion, and the bodies of a new comment and of an edit.
 */
export type CommentThread = components['schemas']['CommentThread'];
export type PostComment = components['schemas']['PostComment'];
export type PublishedComment = components['schemas']['PublishedComment'];
export type CommentDeletion = components['schemas']['CommentDeletion'];
export type CreateCommentBody = components['schemas']['CreateCommentBody'];
export type UpdateCommentBody = components['schemas']['UpdateCommentBody'];
/** `POST /media/images`'s answer: the stored image's id, which the editor's image node carries. */
export type UploadedImage = components['schemas']['UploadedImage'];
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
/**
 * `POST /admin/admins`: the account to make an admin and why (required, recorded), and the admin
 * on screen (`expectedAccountId`).
 */
export type AdminGrantBody = components['schemas']['AdminGrantBody'];
/**
 * `GET /admin/sms/status` (#183, ADR-0070): the counts of the 본인확인 texts — the last 24 hours
 * against the service's daily limit, and seven Korean days, newest first.
 */
export type AdminSmsStatus = components['schemas']['AdminSmsStatus'];
export type ErrorEnvelope = components['schemas']['ErrorEnvelope'];

/** A non-2xx API response, carrying the `{ error: { code, message, details? } }` envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  /**
   * Whether the answer carried the API's own envelope. False for a body something between the
   * browser and the API wrote in its place: Next's `/api/*` rewrite answers a plain-text 500 when
   * the API cannot be reached (next.config.ts), a gateway in front of the API a 502, 503 or 504.
   */
  readonly enveloped: boolean;

  constructor(status: number, envelope: ErrorEnvelope['error'] | undefined) {
    super(envelope?.message ?? `API error ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope?.code ?? (status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL');
    this.details = envelope?.details;
    this.enveloped = envelope !== undefined;
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
 * Whether a failed request never reached the API: the fetch itself failed (offline, the web
 * origin gone — openapi-fetch rejects, so it is not an ApiError at all), or something between
 * answered for the API with a 5xx that is not the API's envelope — Next's rewrite proxy's 500
 * when the API is down, a gateway's 502–504 (`ApiError.enveloped`). An error the API answered
 * itself, a 500 included, is not this: the API was reached and said what went wrong.
 */
export function isApiUnreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return !error.enveloped && error.status >= 500;
}

/**
 * The field an error is about, when `details` is a `ValidationIssue[]` (`[{ path, message }]`,
 * PLAN 7): every VALIDATION_ERROR, and the few other codes that name a body field the same
 * way (the charge route's 404 for an unknown `packageId`, INSUFFICIENT_BALANCE on `amountCoin`,
 * the in-progress DUPLICATE_REQUEST on the `Idempotency-Key` header, and the FORBIDDEN on
 * `expectedAccountId` when the cookie belongs to another account — the charge, coupon,
 * verification, real-name, password and admin grant and revoke bodies alike).
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
 * server refused to charge, to redeem for, to text a code for, verify or rename, or to set the
 * first password of an account the user is not looking at, or to grant or revoke the admin role
 * as one (PLAN 5.3 shape — `chargeBodySchema`, `redeemCouponBodySchema`, the three 본인확인
 * bodies (ADR-0070), `setPasswordBodySchema`, `adminGrantBodySchema` and `adminRevokeBodySchema`
 * all carry `expectedAccountId`; A-PG-24 for the password and what was then the contact, #171 for
 * the admin ones). Only this FORBIDDEN names the field; the CSRF refusal names none.
 *
 * It lives beside `validationField`, which it is built on, rather than in the wallet hook it
 * started in: the keyed flows that send `expectedAccountId` (charge, coupon) must keep their
 * idempotency key on this answer (the server judged the cookie, not the key), and the 본인확인
 * hooks must not import a wallet hook — and a whole `'use client'` module — to ask a pure
 * question about an ApiError.
 */
export function isForAnotherAccount(error: unknown): boolean {
  return isApiError(error, 'FORBIDDEN') && validationField(error) === 'expectedAccountId';
}
