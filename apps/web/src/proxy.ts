import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next 16's proxy (the successor to `middleware`), matched to `/admin` only.
 *
 * It exists for one reason: a server layout cannot see the pathname, so `/admin/layout.tsx`
 * could only send an unauthenticated visitor to a fixed `?next=`, which lost the page they
 * asked for (M2 had one admin route; M3 added four). The proxy stamps the path it already
 * has on the request, and the layout builds the login destination from it (`adminLoginPath`
 * in `lib/next-path.ts`, which refuses anything but an /admin path).
 *
 * `set`, never `append`: a client-supplied `x-pathname` is overwritten here, so the header
 * the layout reads is always this server's. Nothing else is added — in particular no header
 * the API trusts (`X-Forwarded-For`; TRUST_PROXY is false, A-M0-13). M6's IP rate-limit
 * review (ADR-0022) inherits this file rather than creating it, and widening the matcher is
 * part of that review, not of this change.
 */
export const X_PATHNAME = 'x-pathname';

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(X_PATHNAME, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/admin/:path*' };
