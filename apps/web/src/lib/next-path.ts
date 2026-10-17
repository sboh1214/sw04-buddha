/**
 * Post-authentication destinations. No dependency of its own on purpose: a server layout
 * imports it (`app/admin/layout.tsx`) and must not pull the better-auth browser client in
 * with it.
 */
export const ADMIN_LOGIN_FALLBACK = '/admin/users';

/** ASCII control characters (0x00-0x1f, 0x7f) or a backslash (0x5c) anywhere in the path. */
function hasControlCharOrBackslash(path: string): boolean {
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Only same-origin paths are accepted as a post-auth destination, so a crafted
 * `?next=https://evil` can never turn the login page into an open redirect.
 * - A repeated parameter (`?next=/a&next=/b`) reaches a page as an array. Nothing here ever
 *   builds one, so the redirect gate REFUSES anything that is not a string rather than
 *   picking a winner — deliberately unlike `errorCodes()` above, which flattens because a
 *   notice is cosmetic while a redirect target is a security decision.
 * - `//host` is protocol-relative and `/\host` is treated the same by browsers.
 * - ASCII control characters are rejected anywhere: the WHATWG URL parser strips tab and
 *   newline before parsing, so `/\t/evil.com` would resolve to `http://evil.com/`.
 * - Finally the path must resolve on a fixed dummy origin, which is the authoritative check.
 */
export function safeNextPath(next: string | string[] | null | undefined, fallback = '/'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback;
  if (hasControlCharOrBackslash(next)) return fallback;
  try {
    if (new URL(next, 'https://x.invalid').origin !== 'https://x.invalid') return fallback;
  } catch {
    return fallback;
  }
  return next;
}

/**
 * The login URL an unauthenticated admin visit redirects to, carrying where they were going
 * so the sign-in returns them there. `pathname` comes from the header `proxy.ts` stamps on
 * every /admin request; it is refused unless it is an /admin path, so a client-supplied
 * value cannot steer the redirect (`safeNextPath` also refuses anything off-origin), and it
 * carries no query string — Next's own `_rsc` cache-buster would otherwise end up in the
 * destination.
 */
export function adminLoginPath(pathname: string | null | undefined): string {
  const next = typeof pathname === 'string' ? pathname.split('?')[0] : undefined;
  const safe = safeNextPath(next, ADMIN_LOGIN_FALLBACK);
  return `/login?next=${encodeURIComponent(safe.startsWith('/admin/') ? safe : ADMIN_LOGIN_FALLBACK)}`;
}

/**
 * The login URL a control on a public page sends a signed-out visitor to, told to come back to
 * that page — the string form of the `{ pathname: '/login', query: { next: pathname } }` links
 * the screens already render (`AuthButtons`, `MyPosition`), for a button that navigates with
 * `router.push`, which takes no UrlObject. The 관심 등록 button is one (#89: the visitor returns to
 * the same market detail and presses again, ADR-0061 decision 3). The path goes through
 * `safeNextPath` like every destination, so a value that is not a path on this origin brings the
 * visitor home instead; the query string is not carried.
 */
export function loginPathBackTo(pathname: string | null | undefined): string {
  const path = typeof pathname === 'string' ? pathname.split('?')[0] : undefined;
  return `/login?next=${encodeURIComponent(safeNextPath(path))}`;
}

/**
 * The login URL for a page whose query string IS the page: the home's 관심 시장 view
 * (`/?watchlist=1&category=…`, ADR-0065), which a signed-out visitor who picks it must come back
 * to with the view on (ADR-0061 decision 1, item 12). Unlike `loginPathBackTo` the query is
 * carried — the caller builds it from normalised filters (`homePath`), not from the address bar,
 * so nothing a crafted link adds rides along. The whole of it still goes through `safeNextPath`,
 * so a value that is not a path on this origin brings the visitor home instead.
 */
export function loginPathBackToPage(pathAndQuery: string): string {
  return `/login?next=${encodeURIComponent(safeNextPath(pathAndQuery))}`;
}
