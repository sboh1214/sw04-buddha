import { createApiClient, type components } from '@buddha/api-client';
import { type ErrorCode, type ValidationIssue } from '@buddha/shared';

/**
 * Browser client for the API. OpenAPI paths carry the full `/api/v1/...` prefix, so the base
 * URL is the current origin (Next.js rewrites /api/* to the API; the session cookie rides
 * along). On the server the base URL would be NEXT_PUBLIC_API_URL.
 */
export const api = createApiClient({ baseUrl: '', credentials: 'include' });

export type Me = components['schemas']['Me'];
export type LinkedAccount = components['schemas']['LinkedAccount'];
export type LedgerEntry = components['schemas']['LedgerEntry'];
export type Payment = components['schemas']['Payment'];
export type AdminUser = components['schemas']['AdminUser'];
export type ChargePackage = components['schemas']['ChargePackage'];
export type ChargeResult = components['schemas']['ChargeResult'];
export type Coupon = components['schemas']['Coupon'];
export type Market = components['schemas']['Market'];
export type MarketSummary = components['schemas']['MarketSummary'];
export type AdminMarket = components['schemas']['AdminMarket'];
export type MarketEvent = components['schemas']['MarketEvent'];
export type Category = components['schemas']['Category'];
export type Fill = components['schemas']['Fill'];
export type AdminPayment = components['schemas']['AdminPayment'];
export type AuditFailure = components['schemas']['AuditFailure'];
export type CreateMarketBody = components['schemas']['CreateMarketBody'];
export type UpdateMarketBody = components['schemas']['UpdateMarketBody'];
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
 * the in-progress DUPLICATE_REQUEST on the `Idempotency-Key` header, the charge route's
 * FORBIDDEN on `expectedAccountId` when the cookie belongs to another account).
 * Returns the first field name found, e.g. 'nickname'; undefined when no field is named.
 */
export function validationField(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first = (error.details as Partial<ValidationIssue>[])[0]?.path?.[0];
  return typeof first === 'string' ? first : undefined;
}
