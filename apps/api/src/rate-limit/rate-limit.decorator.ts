import { SetMetadata } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { type RateLimitBucket } from '@buddha/shared';

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
 * caller could then mail five links each to unlimited addresses. The two throttlers now run
 * side by side (rate-limit.module.ts) and the second reports itself as `X-RateLimit-*-route`.
 */
export const RateLimit = (
  bucket: Exclude<RateLimitBucket, 'default'>,
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_BUCKET, bucket);

/**
 * Exempts a handler entirely. Used by `/api/health`, which infrastructure polls on a schedule
 * and which must answer even while a flood is being refused — a health check that returns 429
 * tells an orchestrator to restart the instance that was defending itself.
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SkipThrottle();
