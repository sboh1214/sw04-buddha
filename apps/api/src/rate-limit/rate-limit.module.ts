import { type ExecutionContext, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { RATE_LIMIT_BUCKETS, RATE_LIMIT_WINDOW_SECONDS } from '@buddha/shared';
import { type Redis } from 'ioredis';
import { AUTH, type Auth } from '../auth/auth.js';
import { AuthInstanceModule } from '../auth/auth.module.js';
import { type Env } from '../config/env.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import {
  ADDRESS_THROTTLER,
  ROUTE_THROTTLER,
  RateLimitGuard,
  rateLimitKey,
} from './rate-limit.guard.js';
import { RateLimitsModule } from './rate-limit.limits.js';
import { addressTracker, rateLimitScope, rateLimitTracker } from './rate-limit.tracker.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { ConfigService } from '@nestjs/config';

/**
 * PLAN 7.5 (M6): two Redis-backed limiters, applied to every HTTP route.
 *
 * TWO, not one per bucket. `@nestjs/throttler` applies every configured throttler to every
 * route, so a named throttler per row of PLAN 7.5's table would count `/trades` three times
 * over. But one alone was wrong in the other direction: `@RateLimit` overrode the single
 * throttler, so naming a bucket REMOVED the 100/min address cap — and `POST /auth/register`,
 * whose bucket is the recipient's inbox, ended up with no per-caller bound at all.
 *
 * So: `default` counts the client address on every route, and `route` counts the row of the
 * table a handler names, if it names one. A route with a named bucket is subject to both, and
 * the `X-RateLimit-*-route` headers carry the second (the library suffixes any name but
 * `default`).
 *
 * `AuthInstanceModule` is imported for the better-auth instance the `user` scope reads sessions
 * with — the instance module, not `AuthModule`, so this does not pull the HTTP mount and its
 * middie middleware into a cycle with the guard that runs in front of it.
 */
@Module({
  imports: [
    RateLimitsModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule, AuthInstanceModule],
      inject: [REDIS, AUTH, Reflector, ConfigService],
      useFactory: (
        redis: Redis,
        auth: Auth,
        reflector: Reflector,
        config: ConfigService<Env, true>,
      ) => {
        const storage = new RedisThrottlerStorage(redis);
        const ttl = RATE_LIMIT_WINDOW_SECONDS * 1_000;
        // The limits below are placeholders: RateLimitGuard substitutes each bucket's own
        // number from the RATE_LIMITS provider before the storage ever sees one.
        return {
          storage,
          throttlers: [
            {
              name: ADDRESS_THROTTLER,
              ttl,
              limit: RATE_LIMIT_BUCKETS.default.limit,
              getTracker: addressTracker,
              // No route in the key: PLAN 7.5's default is stated per address for the whole
              // API, so splitting it per handler would let a caller spend 100 requests on each
              // of forty paths.
              generateKey: (_context: ExecutionContext, tracker: string) =>
                rateLimitKey(null, tracker),
            },
            {
              name: ROUTE_THROTTLER,
              ttl,
              limit: RATE_LIMIT_BUCKETS.default.limit,
              getTracker: (req: Record<string, unknown>, context: ExecutionContext) =>
                rateLimitTracker(auth, reflector, config, req, context),
              generateKey: (context: ExecutionContext, tracker: string) =>
                rateLimitKey(context, tracker),
            },
          ],
          // Read by nothing here, but the library reads `commonOptions.getTracker` when a
          // throttler declares none; both declare one, so this is only a guard against a
          // future third throttler silently keying on `req.ip`.
          getTracker: addressTracker,
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}

/** Re-exported so the guard's own module graph is the one place scopes are resolved. */
export { rateLimitScope };
