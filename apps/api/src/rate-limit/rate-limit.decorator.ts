import { SetMetadata } from '@nestjs/common';
import { type AddressRateLimitBucket, type RateLimitBucket } from '@buddha/shared';

export const RATE_LIMIT_BUCKET = 'buddha:rateLimitBucket';

/**
 * Adds one handler (or one controller) to a bucket of PLAN 7.5's table on TOP of the default.
 *
 * The number is NOT written here: it comes from the `RATE_LIMITS` provider, which serves
 * `DEFAULT_RATE_LIMITS` in every environment and can be overridden in one place — a route
 * declares WHAT it is counted by, the table declares HOW MANY. That seam exists because PLAN's
 * own two requirements collide: PLAN 7.5 caps `/payments/charge` at 10/min/user while PLAN M2
 * AC 2 proves the charge transaction with twenty concurrent charges by one account, and the
 * concurrency invariant has to stay provable without moving the shipped limit.
 *
 * ON TOP OF, not instead of. The first shape of this REPLACED the default, on the argument that
 * one limit per route keeps `X-RateLimit-*` unambiguous — which quietly removed the only
 * per-caller bound from `POST /auth/register`, whose own bucket is the RECIPIENT's inbox. A
 * caller could then mail five links each to unlimited addresses. The address bucket now runs
 * ahead of the guard, in a Fastify hook (address-limit.ts), and this one reports itself as
 * `X-RateLimit-*-route`.
 *
 * There is no decorator to exempt a route from the address bucket, nor to move it to the other
 * address bucket: the hook sees the Fastify route it matched, not the Nest controller behind it,
 * so `Reflector` metadata is out of its reach — the two health routes it exempts and the image
 * read it counts in `mediaRead` are named in address-limit.ts itself.
 * (`@SkipThrottle()` would be inert — it names a throttler this guard no longer runs — which is
 * why the one this file used to export is gone.)
 */
export const RateLimit = (
  bucket: Exclude<RateLimitBucket, AddressRateLimitBucket>,
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_BUCKET, bucket);
