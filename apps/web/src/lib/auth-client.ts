import { createAuthClient } from 'better-auth/react';
import { copy } from '@/copy';
import { safeNextPath } from './next-path';

export { safeNextPath };

/** Synthetic `error.code` for a request that never completed. Not a better-auth code. */
const NETWORK_ERROR_CODE = 'NETWORK_ERROR';

/**
 * better-fetch never wraps its own `fetch` call, so a request that fails at the transport
 * (offline, DNS, connection reset, the origin gone) REJECTS instead of answering `{ error }`.
 * Every call site here is written as `const { error } = await ...`, and the react-hook-form
 * submit handlers are invoked as `void onSubmit(e)`, so such a rejection is swallowed: the
 * user gets a silent no-op, a spinner that never stops, or — through react-query's `onError`,
 * which passes the raw throw — the browser's English "Failed to fetch" in a Korean toast.
 *
 * Answering with a normal error response instead puts all of them back on their usual
 * `if (error)` path. Two details matter:
 * - the body is read here, inside the same try: better-fetch calls `response.text()` outside
 *   this function, so a connection that dies mid-body would reject there instead;
 * - an AbortError is re-thrown, because a cancelled request is not a network failure and
 *   better-auth's session atom relies on it to tell the two apart.
 */
export async function fetchOrNetworkError(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetch(input, init);
    // 204/304 must stay body-less; everything better-auth returns is small JSON otherwise.
    if (response.status === 204 || response.status === 304) return response;
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return new Response(JSON.stringify({ code: NETWORK_ERROR_CODE }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/**
 * better-auth browser client. The API is reached same-origin through the Next.js rewrite
 * (`/api/auth/*` -> NEXT_PUBLIC_API_URL, next.config.ts), so no `baseURL` is given:
 * better-auth 1.7 rejects a relative `baseURL` ("Invalid base URL: /api/auth") and, when it
 * is omitted, resolves `window.location.origin + basePath` in the browser. The module also
 * evaluates during SSR of client components, but `useSession` never fetches on the server.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  // better-auth spreads its own fetch options first, so this override wins.
  fetchOptions: { customFetchImpl: fetchOrNetworkError },
});

/**
 * `useSession` is deliberately NOT re-exported here: it lives in `lib/use-session.ts`, which
 * wraps it so the server and the hydrating render agree. This module is imported by SERVER
 * components too (login/page.tsx, set-password/page.tsx and the two beside them read
 * `authNoticeFor` / `safeNextPath` / `verifyLinkErrorCode`), so it must not pull a React hook
 * into a Server Component module — importing `useSyncExternalStore` here fails the build.
 */
export const { signIn, signUp, signOut } = authClient;

/** Social providers wired in apps/api (PLAN 10.2). Order = button order. */
export const SOCIAL_PROVIDERS = ['google', 'kakao', 'naver'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/**
 * better-auth error codes the UI branches on (`error.code` of a failed client call).
 * Compared as string literals on purpose: `authClient.$ERROR_CODES` is declared in the client
 * types but is NOT defined by the 1.7 react client at runtime (the dynamic path proxy turns it
 * into a fetch function, so `$ERROR_CODES.X.code` is never a string).
 */
export const AUTH_ERROR = {
  /** Not better-auth's: `fetchOrNetworkError` above puts it on a request that never completed. */
  NETWORK: NETWORK_ERROR_CODE,
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_EMAIL_OR_PASSWORD: 'INVALID_EMAIL_OR_PASSWORD',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** 1.7.2 sign-up emits the `_USE_ANOTHER_EMAIL` variant; the short one is kept for older routes. */
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  PASSWORD_TOO_LONG: 'PASSWORD_TOO_LONG',
  INVALID_TOKEN: 'INVALID_TOKEN',
  FAILED_TO_UNLINK_LAST_ACCOUNT: 'FAILED_TO_UNLINK_LAST_ACCOUNT',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'CREDENTIAL_ACCOUNT_NOT_FOUND',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
} as const;

/** `account.providerId` of the email+password login method. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

/** Shape of a failed better-auth client call (`error` of the `{ data, error }` result). */
export interface AuthClientError {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
  /** The API's issues (`{ path, message }[]`) on the refusals the API's hook adds (ADR-0092). */
  details?: unknown;
}

/**
 * Whether a better-auth write was refused because the cookie is another account's than the one its
 * MY 설정 card was drawn for (ADR-0092): the 403 FORBIDDEN whose `details` name `expectedAccountId`,
 * the API's own refusal (`isForAnotherAccount` in lib/api.ts) as the auth instance's `hooks.before`
 * answers it — unwrapped, better-auth's `{ code, message, details }`. Not the CSRF 403 better-auth
 * answers an untrusted Origin with, which names no field. Nothing was written; the card asks for the
 * session again, so SessionCacheGuard puts the account that is really signed in on screen.
 */
export function isAuthForAnotherAccount(error: AuthClientError | null | undefined): boolean {
  if (error?.status !== 403 || error.code !== 'FORBIDDEN') return false;
  if (!Array.isArray(error.details)) return false;
  const first: unknown = error.details[0];
  if (typeof first !== 'object' || first === null || !('path' in first)) return false;
  const path: unknown = (first as { path?: unknown }).path;
  return Array.isArray(path) && path[0] === 'expectedAccountId';
}

/**
 * Korean copy for a better-auth error (PLAN 0.1 rule 6: UI strings live in copy.ts, never the
 * library's English `message`). Forms that need a field-specific reaction check `code` first
 * and use this for everything else.
 */
export function authErrorMessage(
  error: AuthClientError | null | undefined,
  fallback: string = copy.errUnknown,
): string {
  if (error?.status === 0) return copy.errNetwork;
  switch (error?.code) {
    case AUTH_ERROR.NETWORK:
      return copy.errNetwork;
    case AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD:
      return copy.loginFailed;
    case AUTH_ERROR.INVALID_EMAIL:
      return copy.errEmailInvalid;
    case AUTH_ERROR.PASSWORD_TOO_SHORT:
      return copy.errPasswordTooShort;
    case AUTH_ERROR.PASSWORD_TOO_LONG:
      return copy.errPasswordTooLong;
    case AUTH_ERROR.USER_ALREADY_EXISTS:
    case AUTH_ERROR.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
      return copy.emailAlreadyUsed;
    case AUTH_ERROR.FAILED_TO_UNLINK_LAST_ACCOUNT:
      return copy.unlinkRefused;
    case AUTH_ERROR.PROVIDER_NOT_FOUND:
      return copy.socialUnavailable;
    default:
      return fallback;
  }
}

/**
 * Codes better-auth's verify-email route puts on `?error=` when a link fails
 * (email-verification.mjs redirectOnError). Everything else on that parameter comes from an
 * OAuth round-trip, whose codes must not be mistaken for a broken link: `unable_to_get_user_info`
 * and `unable_to_create_user` contain "user", so the match is exact, not a substring test.
 */
const VERIFY_LINK_ERROR_CODES = new Set([
  'token_expired',
  'invalid_token',
  'user_not_found',
  'invalid_user',
]);

/** The `?error=` value split into comparable codes (better-auth sends one; a URL may carry more). */
function errorCodes(error: string | string[] | undefined): string[] {
  if (error === undefined) return [];
  return (Array.isArray(error) ? error : [error])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The code in `?error=` that says a verification link itself failed, or undefined when the
 * parameter is absent or describes something else (an OAuth round-trip). Pages that stay
 * useful after a bad link (set-password) branch on this instead of `authNoticeFor`, whose
 * fallback would turn any unknown code into a scary alert, and pass the returned code on so
 * the next screen classifies it the same way.
 */
export function verifyLinkErrorCode(error: string | string[] | undefined): string | undefined {
  return errorCodes(error).find((code) => VERIFY_LINK_ERROR_CODES.has(code));
}

/**
 * Korean notice for the `?error=` parameter better-auth redirects back with, or undefined
 * when there is none. `fallback` names what the page was doing (social sign-in, linking).
 */
export function authNoticeFor(
  error: string | string[] | undefined,
  fallback: string,
): string | undefined {
  if (error === undefined) return undefined;
  const codes = errorCodes(error);
  if (codes.some((code) => VERIFY_LINK_ERROR_CODES.has(code))) return copy.verifyLinkInvalid;
  if (codes.some((code) => code.includes('account_already_linked'))) return copy.linkAlreadyUsed;
  return fallback;
}
