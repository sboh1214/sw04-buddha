import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fromNodeHeaders } from 'better-auth/node';
import { type FastifyRequest } from 'fastify';
import { AppError } from '../common/errors/app-error.js';
import { type Env, webOrigins } from '../config/env.js';
import { AUTH, type Auth, type SessionData } from './auth.js';

/**
 * Fastify request after SessionGuard ran — or after the rate-limit guard resolved the session
 * first, which it does for the routes counted per account (`@RateLimit('charge')` and friends,
 * rate-limit.tracker.ts).
 *
 * That second writer is why `@CurrentUser()` still refuses a request with no `auth` rather than
 * treating the field as proof of anything: a route in a `user` bucket that forgot SessionGuard
 * would carry a resolved session here. It would at least have passed the Origin check — the
 * tracker runs `isTrustedOrigin` before it resolves anything — but every such route is behind
 * SessionGuard today, and the decorator's own 401 is the backstop if one is not.
 */
export type AuthenticatedRequest = FastifyRequest & { auth?: SessionData };

/** Methods that must not change state (RFC 9110 §9.2.1); every other one is checked for CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether this request's `Origin` is one of ours — the predicate behind `refuseForeignOrigin`,
 * exported because the rate-limit guard runs BEFORE this one and needs the same answer: a
 * request that is about to be refused for its Origin must not be counted against the account
 * whose cookie it carries (rate-limit.tracker.ts).
 *
 * Reads are never checked, and a request with no `Origin` passes: see `refuseForeignOrigin` for
 * why both of those are deliberate.
 */
export function isTrustedOrigin(
  request: Pick<FastifyRequest, 'method' | 'headers'>,
  trusted: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.origin;
  return origin === undefined || trusted.has(origin);
}

/**
 * Resolves the better-auth session from the request cookies and attaches it as
 * `request.auth` for @CurrentUser()/@CurrentSession(). No session -> 401 with the PLAN 7
 * error envelope (AppError, rendered by ApiExceptionFilter). Apply with
 * `@UseGuards(SessionGuard)` on controllers that need a user; public routes (PLAN 7.1)
 * simply do not use it.
 *
 * Also the CSRF check for those routes (`refuseForeignOrigin`): a cookie is only honoured
 * for a state-changing request when the browser says it came from us.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    config: ConfigService<Env, true>,
  ) {
    // The same list better-auth trusts for its own routes (auth.ts `trustedOrigins`), matched
    // as exact origins — no wildcard patterns here — and with a deliberately different policy
    // for a missing header (see refuseForeignOrigin; better-auth falls back to Referer and
    // refuses when both are absent).
    this.trustedOrigins = new Set(
      webOrigins({
        WEB_ORIGIN: config.get('WEB_ORIGIN', { infer: true }),
        BETTER_AUTH_URL: config.get('BETTER_AUTH_URL', { infer: true }),
      }),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.refuseForeignOrigin(request);
    // Reused when the global rate-limit guard already resolved it: a route in a per-account
    // bucket (`@RateLimit('charge')` and friends) is counted per account, which means the session
    // was read before this guard ran (rate-limit.tracker.ts). Reading it twice would double the
    // session query on exactly the routes PLAN 7.5 singles out.
    const session =
      request.auth ??
      (await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) }));
    if (!session) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    request.auth = session;
    return true;
  }

  /**
   * The session cookie is SameSite=Lax and ADR-0017 puts the web and the API on sibling hosts
   * of one site, so a page on any other host of that site can submit a form with the cookie
   * attached — and the better-auth Nest module parses `application/x-www-form-urlencoded`
   * bodies, so such a form reaches these handlers with a body zod accepts (a balance
   * adjustment is two fields). better-auth checks `Origin` on its own /api/auth/* routes only;
   * PLAN M6's "CSRF(better-auth 기본)" holds for those alone. Browsers send `Origin` on every
   * POST, form or fetch, same-origin or not, so an untrusted value is refused; a request without
   * one came from no browser and cannot be a cross-site request forgery, so it passes (curl,
   * a server, the tests). Reads are never checked: without CORS headers nothing cross-origin
   * can read them anyway.
   */
  private refuseForeignOrigin(request: FastifyRequest): void {
    if (isTrustedOrigin(request, this.trustedOrigins)) return;
    throw new AppError('FORBIDDEN', { message: 'Cross-origin request refused' });
  }
}
