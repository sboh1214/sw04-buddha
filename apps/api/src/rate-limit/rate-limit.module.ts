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
import { ROUTE_THROTTLER, RateLimitGuard, rateLimitKey } from './rate-limit.guard.js';
import { RateLimitsModule } from './rate-limit.limits.js';
import { rateLimitScope, rateLimitTracker } from './rate-limit.tracker.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { ConfigService } from '@nestjs/config';

/**
 * PLAN 7.5 (M6): the NAMED buckets, as one Redis-backed `@nestjs/throttler` throttler applied
 * to every HTTP route.
 *
 * ONE throttler, not one per bucket: the library applies every configured throttler to every
 * route, so a throttler per row of PLAN 7.5's table would count `/trades` three times over.
 * `route` counts the row a handler names with `@RateLimit`, if it names one, and is a no-op
 * elsewhere; its headers carry the `-route` suffix (the library suffixes any name but
 * `default`).
 *
 * The per-address default is NOT here. It was, as a second throttler named `default`, until PR
 * #8's review pointed out that a guard runs inside the route handler and so never saw a body
 * Fastify refused to parse, a request over `bodyLimit` or a path with no route — and that the
 * other half of the API (`/api/auth/*`, served by middie ahead of Nest routing) already had to
 * be counted by a raw Fastify hook for the same reason. The address bucket now lives in that
 * hook alone (address-limit.ts), after routing and ahead of parsing, for every request; a route with
 * a named bucket is subject to both, and whichever bound it reaches first refuses. The earlier
 * lesson stands: naming a bucket must ADD to the address cap, never replace it — `POST
 * /auth/register`'s bucket is the recipient's inbox, and without the cap a caller who varied
 * the address had no bound at all.
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
        // The limit below is a placeholder: RateLimitGuard substitutes each bucket's own
        // number from the RATE_LIMITS provider before the storage ever sees one.
        return {
          storage,
          throttlers: [
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
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}

/** Re-exported so the guard's own module graph is the one place scopes are resolved. */
export { rateLimitScope };
