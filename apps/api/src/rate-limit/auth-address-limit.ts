import { createHash } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AUTH_BASE_PATH } from '../auth/auth.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { RATE_LIMITS } from './rate-limit.limits.js';
import { isCountableAddress } from './rate-limit.tracker.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import type { Redis } from 'ioredis';
import type { RateLimits } from '@buddha/shared';
import { RATE_LIMIT_WINDOW_SECONDS } from '@buddha/shared';

/**
 * PLAN 7.5's per-address default, extended to the one surface a Nest guard cannot reach.
 *
 * better-auth is mounted as `@fastify/middie` middleware that runs BEFORE Nest routing
 * (auth.module.ts), so `RateLimitGuard` never sees `/api/auth/*` — sign-in, password reset,
 * verification mail. `authRateLimiter` bounds those per ADDRESS IN THE BODY (and `/change-email`
 * per account as well — auth.ts), which is the right key for the two abuses they have, but on
 * the unauthenticated routes it leaves no bound on the CALLER: rotating the address gets a fresh
 * bucket every time, and `/sign-in/email` hashes the submitted password even for an address that
 * does not exist (better-auth does that deliberately, so the answer takes the same time either
 * way), so an unbounded caller is an unbounded scrypt. Every `/api/v1/*` route already has that
 * bound; this gives it to the other half of the API.
 *
 * THE SAME BUCKET, deliberately. PLAN 7.5's default is "100req/분/IP" for the API, not per
 * surface, so this counts into the key `RateLimitGuard` uses for the address throttler
 * (`rl:default:any:<digest>`): a caller's hundred covers both halves together.
 *
 * Registered as a raw Fastify `onRequest` hook BEFORE `app.init()`, which is what puts it ahead
 * of middie — Nest queues `httpAdapter.use()` middlewares and flushes them during init, and
 * Fastify runs same-phase hooks in registration order. Installed from both main.ts and
 * test/app.ts for the reason `registerSecurityHeaders` is: a bound only production applies is a
 * bound nothing proves.
 */
export function installAuthAddressLimit(app: NestFastifyApplication): void {
  const storage = new RedisThrottlerStorage(app.get<Redis>(REDIS));
  const limits = app.get<RateLimits>(RATE_LIMITS);
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1_000;

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith(`${AUTH_BASE_PATH}/`)) return;
      if (!isCountableAddress(request.ip)) return;
      const digest = createHash('sha256').update(`ip:${request.ip}`).digest('hex').slice(0, 32);
      const record = await storage.increment(
        `any:${digest}`,
        windowMs,
        limits.default,
        windowMs,
        'default',
      );
      if (!record.isBlocked) return;
      // better-auth's own error shape, not the PLAN 7 envelope: middie runs before Nest's
      // exception filter, so every other failure on these paths already looks like this
      // (ADR-0018), and a refusal that looked different would be the odd one out.
      await reply.code(429).header('Retry-After', record.timeToBlockExpire).send({
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        retryAfterSeconds: record.timeToBlockExpire,
      });
    });
}
