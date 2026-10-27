import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Me } from './api';
import { safeNextPath } from './next-path';

/**
 * The onboarding gate (ADR-0043, keyed on 본인확인 since ADR-0070): a signed-in account that has
 * not completed the SMS verification (#183) — every new account, social or email, and any account
 * older than the requirement — is sent to /onboarding from every screen except the ones below,
 * and comes back to where it was going once it has verified. Email sign-ups set their password on
 * /set-password first and meet the gate right after it.
 *
 * Pure functions of the URL and of what `GET /me` said, kept out of the gate component
 * (components/auth/onboarding-gate.tsx) so vitest can run them under its node environment.
 * The gate is a client component rather than a check in `proxy.ts`: knowing whether the
 * account has verified takes a `GET /me`, and a proxy that asked the API on every navigation
 * would put one extra request in front of every page — the matcher widening ADR-0034 already
 * declined for less. The client already holds that answer (the nav's balance chip reads it).
 * The gate is the screen's; the server's own check of "verified" (`isPhoneVerified`, @buddha/db)
 * is what the actions that need it (#58, #70) call.
 */

export const ONBOARDING_PATH = '/onboarding';

/**
 * Routes a signed-in account that has not verified may still open. Each entry covers itself and
 * its subtree (`/terms`, `/terms/…`), never a look-alike prefix (`/termsx`).
 * - /onboarding itself, or the gate would loop.
 * - The auth screens: /login, /signup, /reset-password, and /set-password, where an email
 *   sign-up sets its first password before it verifies.
 * - What a visitor must be able to read before handing personal data over: the three legal
 *   documents, and the public charge guide (ADR-0044) while paid Coin is on sale — `/charge` is
 *   not found otherwise (PAID_COIN_SALES_ENABLED, ADR-0049).
 * - /api: never a page — the layout the gate lives in does not render for it — but the list is
 *   total so the decision could move into `proxy.ts` without ever answering an API call (the
 *   auth routes included) with a redirect to an HTML form.
 *
 * /admin is deliberately NOT here: an administrator's account is an account like any other.
 */
export const ONBOARDING_EXEMPT_PATHS: readonly string[] = [
  ONBOARDING_PATH,
  '/login',
  '/signup',
  '/set-password',
  '/reset-password',
  '/terms',
  '/privacy',
  '/refund',
  ...(PAID_COIN_SALES_ENABLED ? ['/charge'] : []),
  '/api',
];

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function isOnboardingExempt(pathname: string): boolean {
  return ONBOARDING_EXEMPT_PATHS.some((root) => isUnder(pathname, root));
}

/**
 * Whether the gate sends this page to /onboarding. `verification` is what `GET /me` said:
 * - `undefined` — not known: no session, the session or `/me` still pending, or `/me` failed.
 *   Never redirect on a guess; a verified member must not be bounced while it loads.
 * - `null` — signed in, and the account has not verified.
 * - a record — nothing to do.
 */
export function needsOnboarding(
  pathname: string,
  verification: Me['verification'] | undefined,
): boolean {
  return verification === null && !isOnboardingExempt(pathname);
}

/** The path part of a same-origin destination, percent-decoded for comparison. */
function pathOf(path: string): string {
  const { pathname } = new URL(path, 'https://x.invalid');
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Where /onboarding returns to: `?next=` if it is a path on this origin (`safeNextPath` — no
 * `https://…`, `//host`, backslash or control-character tricks), otherwise home. Never
 * /onboarding itself: an account that has verified already is sent straight on to `next`, so a
 * `next` pointing back at the gate would bounce between the two for ever.
 */
export function onboardingNext(next: string | string[] | null | undefined): string {
  const safe = safeNextPath(next);
  return isUnder(pathOf(safe), ONBOARDING_PATH) ? '/' : safe;
}

/**
 * The gate's destination for a page at `path` (pathname + search): `/onboarding?next=<path>`,
 * or bare `/onboarding` when there is nowhere better than home to come back to.
 */
export function onboardingPath(path: string): string {
  const next = onboardingNext(path);
  return next === '/' ? ONBOARDING_PATH : `${ONBOARDING_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * The page the gate is leaving, with its query string: `pathname` from `usePathname()` and
 * `search` from `window.location`. The root layout cannot call `useSearchParams` without a
 * Suspense boundary around every page (see nav.tsx `CategoryNav`), so the query string is read
 * from the location when the redirect fires — and only kept while the location is still the
 * page the router reports, so a navigation racing the effect can never borrow another page's.
 */
export function gatedPagePath(pathname: string, location: { pathname: string; search: string }) {
  return location.pathname === pathname ? `${pathname}${location.search}` : pathname;
}
