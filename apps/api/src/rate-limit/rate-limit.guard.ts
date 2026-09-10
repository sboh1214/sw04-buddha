import { createHash } from 'node:crypto';
import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
// A VALUE import: `emitDecoratorMetadata` writes `design:paramtypes` from what the identifier
// resolves to, and a type-only import erases to `undefined` — which Nest reports as an
// unresolvable dependency at index 2 rather than as a missing import.
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { type RateLimits } from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { RATE_LIMITS } from './rate-limit.limits.js';
import { rateLimitBucket } from './rate-limit.tracker.js';

/**
 * The storage namespace of the per-address bucket (PLAN 7.5's default row): `rl:default:…`.
 * Not a throttler of this guard any more — the bucket is counted by the Fastify hook in
 * address-limit.ts, ahead of parsing and the handler — but the name stays, so the keys do.
 */
export const ADDRESS_THROTTLER = 'default';
/** Counts the row of PLAN 7.5's table a handler names with `@RateLimit`. */
export const ROUTE_THROTTLER = 'route';

/**
 * The Redis key a bucket lives under, minus the storage's own `rl:<throttler>:` prefix.
 *
 * The tracker is HASHED: an account id identifies a person and an address is personal data, and
 * a rate limiter has no reason to keep either where a `KEYS rl:*` can read them. The digest is
 * stable for the life of a window, which is all a counter needs.
 *
 * `context` is null for the address bucket (address-limit.ts), whose key deliberately carries
 * no route: PLAN 7.5's default is stated per address for the whole API, so a key per handler
 * would let a caller spend 100 requests on each of forty paths.
 */
export function rateLimitKey(context: ExecutionContext | null, tracker: string): string {
  const digest = createHash('sha256').update(tracker).digest('hex').slice(0, 32);
  if (context === null) return `any:${digest}`;
  return `${context.getClass().name}.${context.getHandler().name}:${digest}`;
}

/**
 * PLAN 7.5's NAMED buckets, registered once as an APP_GUARD (rate-limit.module.ts).
 *
 * Everything route-specific is metadata: `@RateLimit('<bucket>')` on a handler adds the row of
 * PLAN 7.5's table it names on top of the address bucket, and the numbers come from the
 * `RATE_LIMITS` provider. Trackers and keys come from the module options, so this class
 * carries only the three things the library cannot express: which contexts it applies to,
 * which routes the throttler applies to, and what a refusal looks like on the wire. The address
 * bucket itself is not here: a guard runs inside the route handler and sees only what reaches
 * one, so it is counted by a Fastify hook ahead of parsing and the handler (address-limit.ts).
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(RATE_LIMITS) private readonly limits: RateLimits,
  ) {
    super(options, storage, reflector);
  }

  /**
   * HTTP only. A global guard also runs for `@SubscribeMessage` handlers, where
   * `context.switchToHttp()` yields a socket with no `ip`, no `headers` and no `res.header` —
   * the base class would count every socket message into one bucket and then throw an
   * HttpException into a WebSocket. A connection's own message rate is bounded on the gateway,
   * where a per-connection counter is the honest shape (A-M4-5).
   */
  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(context.getType<string>() !== 'http');
  }

  /**
   * Applies the route throttler only where a handler named a bucket, with that bucket's number;
   * on every other route it is a no-op (the address bucket already counted the request, in the
   * hook). Here rather than in `@Throttle` metadata: the limit comes from an injected table.
   */
  protected override handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context } = requestProps;
    const bucket = rateLimitBucket(this.reflector, context);
    if (bucket === 'default') return Promise.resolve(true);
    return super.handleRequest({ ...requestProps, limit: this.limits[bucket] });
  }

  /**
   * PLAN 7.4's envelope instead of the library's `ThrottlerException: Too Many Requests`.
   * Both render as 429 → `RATE_LIMITED` through ApiExceptionFilter, but only this one carries a
   * `details.retryAfterSeconds` the web can turn into "N초 후 다시 시도" — the same number the
   * `Retry-After` header below carries.
   */
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // `Retry-After` unsuffixed, as the address hook writes it. The base class writes
    // `Retry-After-route` for a named throttler, and a client looking for the standard header
    // would find nothing on exactly the refusals it is most likely to meet — the per-route
    // buckets are the strict ones. The `X-RateLimit-*` family keeps the library's suffix: those
    // are for an operator reading a response, and there the distinction is the useful part.
    const { res } = this.getRequestResponse(context);
    (res as { header: (name: string, value: number) => void }).header(
      'Retry-After',
      detail.timeToBlockExpire,
    );
    throw new AppError('RATE_LIMITED', {
      message: 'Too many requests',
      details: { retryAfterSeconds: detail.timeToBlockExpire },
    });
  }
}
