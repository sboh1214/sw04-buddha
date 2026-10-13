import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next 16's proxy (the successor to `middleware`), matched to `/admin` and `/my` only.
 *
 * It exists for one reason: a server layout cannot see the URL, so `/admin/layout.tsx` and
 * `/my/layout.tsx` could only send an unauthenticated visitor to a fixed `?next=`, which lost
 * the page they asked for (M2 had one admin route; M3 added four; MY has nine, #16). The proxy
 * stamps the path and the query string it already has on the request, and each gate builds the
 * login destination from them (`adminLoginPath` in `lib/next-path.ts`, which refuses anything
 * but an /admin path; MY's `requireMySession`, run by the MY layout and every MY page, through
 * `myLoginPath` in `lib/my.ts`, which refuses anything but a /my path and reads nothing from the
 * query but the wallet's `?package=`).
 *
 * `set`, never `append`: a client-supplied `x-pathname` or `x-search` is overwritten here, so the
 * headers the gates read are always this server's. Nothing else is added — in particular no
 * header the API trusts (`X-Forwarded-For`; TRUST_PROXY is false, A-M0-13).
 *
 * M6 did the rate-limit review this file was waiting for and DECIDED NOT TO WIDEN THE MATCHER for
 * it (ADR-0034, A-M6-2); `/my` was added later for the login destination alone. Widening it for the
 * rate limit would buy nothing: Next fills `X-Forwarded-For` in `base-server.js` as
 * `client-supplied ?? socket address` — with `??=`, so a caller's value wins — and it does so
 * BEFORE this proxy runs, which leaves no way here to tell a real client address from a claimed
 * one. Server-rendered reads do not even take this path: `api.server.ts` dials the API origin
 * directly. The answer is a real reverse proxy AHEAD of this server that routes `/api/*` straight
 * to the API and appends the visitor to the header, with `TRUST_PROXY` naming its CIDR (Q-M6-2). A
 * web server on another host goes in the API's `RATE_LIMIT_UNCOUNTED_PEERS` either way — with the
 * proxy, for the server-rendered reads and session calls that still come from it; without it, or
 * the whole site shares one address bucket (ADR-0034 추기).
 *
 * (Earlier revisions of this comment and of QUESTIONS A-M3-24 cited "ADR-0022" for that
 * review; ADR-0022 is the integration-test infrastructure. ADR-0034 is the one.)
 */
export const X_PATHNAME = 'x-pathname';
/** The same request's query string (`?…`, or empty). */
export const X_SEARCH = 'x-search';

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(X_PATHNAME, request.nextUrl.pathname);
  headers.set(X_SEARCH, request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/admin/:path*', '/my/:path*'] };
