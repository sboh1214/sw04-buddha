import { type BlockList } from 'node:net';
import { type ExecutionContext, Logger } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { type Reflector } from '@nestjs/core';
import { RATE_LIMIT_BUCKETS, type RateLimitBucket, type RateLimitScope } from '@buddha/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { type Auth, type SessionData } from '../auth/auth.js';
import { type AuthenticatedRequest, isTrustedOrigin } from '../auth/session.guard.js';
import { type Env, ipFamily, webOrigins } from '../config/env.js';
import { emailTracker } from './email-tracker.js';
import { RATE_LIMIT_BUCKET } from './rate-limit.decorator.js';

const logger = new Logger('RateLimitTracker');

/** The bucket declared by @RateLimit on the handler or its controller; `default` otherwise. */
export function rateLimitBucket(reflector: Reflector, context: ExecutionContext): RateLimitBucket {
  return (
    reflector.getAllAndOverride<RateLimitBucket | undefined>(RATE_LIMIT_BUCKET, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'default'
  );
}

export function rateLimitScope(reflector: Reflector, context: ExecutionContext): RateLimitScope {
  return RATE_LIMIT_BUCKETS[rateLimitBucket(reflector, context)].scope;
}

/**
 * A peer that cannot name a client is not counted by address.
 *
 * Every browser request reaches this API through the Next.js rewrite, which is a server-side
 * proxy: the address Fastify reports is the web server's, not the visitor's, and `TRUST_PROXY`
 * stays false because Next fills `X-Forwarded-For` as `client-supplied ?? socket address`
 * (Next 16 `base-server.js` uses `??=`) — a header the caller can set, so trusting it would be
 * worse than not having it. Server-rendered reads do not even take that path: `api.server.ts`
 * dials the API origin directly. Counting all of it together would put every visitor and every
 * render in one 100/min bucket and rate-limit the product rather than an abuser.
 *
 * So the rule is: an address that cannot name a client is not counted. A loopback peer is one
 * case — a developer's own stack, or a rewrite on the same host — and it is built in. The web
 * server on ANOTHER host is the same case with a routable address, and it is named:
 * `RATE_LIMIT_UNCOUNTED_PEERS` (config/env.ts) lists the peers that are proxies whose
 * forwarding is not trusted. The first shape of this knew only loopback, so a split web/API
 * deployment counted every visitor as the web host and the whole site shared one 100/min
 * window (PR #8 review). Direct clients — the Expo app (ADR-0017), anything dialling the API
 * origin over HTTP — always present a real address and are always counted; the Socket.IO
 * handshake is not, because engine.io takes it off the raw HTTP server before Fastify sees it
 * (ADR-0034, A-M6-3).
 *
 * What restores a PER-VISITOR limit behind the rewrite is a reverse proxy AHEAD of the web
 * server that routes `/api/*` straight to this API and appends the visitor to
 * `X-Forwarded-For`, with `TRUST_PROXY` naming that proxy: then `request.ip` is the visitor.
 * Naming the web host in `TRUST_PROXY` is not the answer either: unless the web server is
 * reachable ONLY through a proxy that always appends the header, Next passes a client-supplied
 * one through untouched and Fastify would read whatever the caller wrote — and the web host
 * stays in the uncounted list regardless, because server-rendered reads and the session calls
 * of server components come from it with no header at all.
 *
 * The per-account and per-recipient buckets are unaffected: they are what actually protects
 * `/payments/charge`, `/coupons/redeem` and sign-up, and they work identically behind the
 * rewrite. The one place the address still stands in for them — the route throttler's
 * fallback for a request it can attribute to neither an account nor an address in the body —
 * is a request the route is about to refuse anyway (401, 403 or 400), and it is counted as it
 * always was.
 */
export function isCountableAddress(ip: string | undefined, uncounted?: BlockList): boolean {
  if (ip === undefined || ip.length === 0) return false;
  // ::ffff:127.0.0.1 is how Node reports an IPv4 peer on a dual-stack socket.
  const address = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (address === '::1' || address === '127.0.0.1' || address.startsWith('127.')) return false;
  if (uncounted === undefined) return true;
  // The family is explicit on every check: `BlockList` defaults to IPv4 and answers `false`,
  // not an error, for an IPv6 address checked as IPv4.
  const family = ipFamily(address);
  return family === undefined || !uncounted.check(address, family);
}

/** The tracker of the address throttler: the client address, whatever the route. */
export function addressTracker(req: Record<string, unknown>): string {
  return `ip:${String((req as { ip?: string }).ip)}`;
}

/** `{ email }` of a body that has not been validated yet — guards run before the pipes. */
function emailFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  return emailTracker((body as { email?: unknown }).email);
}

/**
 * What one request is counted against for the ROUTE throttler (`@nestjs/throttler`'s
 * `getTracker`). The value never reaches Redis in the clear — `rateLimitKey` hashes it — so an
 * address or an account id here is a bucket, not a record.
 *
 * The `user` scope resolves the session ITSELF and caches it on the request, and SessionGuard
 * reuses that. Two reasons it has to be this way round: a global guard runs before every
 * controller guard, so `request.auth` is not there yet; and counting before SessionGuard is
 * what makes the limit cover the request rather than trail it. The cache is why it costs
 * nothing — the session is read once per request either way, and only the routes that name a
 * `user` bucket read it at all, so no public route pays for this.
 *
 * A request that SessionGuard is about to refuse for a foreign `Origin` is counted by address
 * instead. Otherwise a page on a sibling host of this site — the very attack A-M2-13 added the
 * Origin check for, and the one case where SameSite=Lax still sends the cookie on a POST —
 * could spend a victim's `/payments/charge` budget ten times a minute without ever reaching a
 * handler, and lock them out of charging from a page they merely visited.
 */
export async function rateLimitTracker(
  auth: Auth,
  reflector: Reflector,
  config: ConfigService<Env, true>,
  req: Record<string, unknown>,
  context: ExecutionContext,
): Promise<string> {
  const request = req as unknown as AuthenticatedRequest;
  const scope = rateLimitScope(reflector, context);
  if (scope === 'user' && isTrustedOrigin(request, trustedOrigins(config))) {
    const session = await sessionOf(auth, request);
    if (session) return `u:${session.user.id}`;
  } else if (scope === 'email') {
    const email = emailFromBody(request.body);
    if (email !== undefined) return `e:${email}`;
  }
  // Fallback for a `user`/`email` route the caller gave neither on, and for one whose Origin
  // will be refused. Safe in the strict direction: such a request is counted by address and
  // then refused 401 or 403 a moment later.
  return addressTracker(req);
}

/**
 * The trusted origin list, computed once per process rather than per request: `webOrigins`
 * parses and canonicalises URLs, and `SessionGuard` builds the same set in its constructor for
 * the same reason.
 */
let cachedOrigins: ReadonlySet<string> | undefined;
function trustedOrigins(config: ConfigService<Env, true>): ReadonlySet<string> {
  cachedOrigins ??= new Set(
    webOrigins({
      WEB_ORIGIN: config.get('WEB_ORIGIN', { infer: true }),
      BETTER_AUTH_URL: config.get('BETTER_AUTH_URL', { infer: true }),
    }),
  );
  return cachedOrigins;
}

async function sessionOf(auth: Auth, request: AuthenticatedRequest): Promise<SessionData | null> {
  if (request.auth) return request.auth;
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (session) request.auth = session;
    return session;
  } catch (error) {
    // A session lookup that failed must not fail the request: the route's own guard will report
    // the outage in its own terms a moment later. Counting by address meanwhile is the
    // conservative fallback — never more permissive than the per-account bucket it replaces.
    logger.warn(
      `session lookup failed, counting by address: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
