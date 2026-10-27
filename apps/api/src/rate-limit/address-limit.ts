import { type BlockList } from 'node:net';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AddressRateLimitBucket,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimits,
} from '@buddha/shared';
import { AUTH_BASE_PATH } from '../auth/auth.js';
import { AppError } from '../common/errors/app-error.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { rateLimitKey } from './rate-limit.guard.js';
import { RATE_LIMITS } from './rate-limit.limits.js';
import { addressTracker, isCountableAddress } from './rate-limit.tracker.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { UNCOUNTED_PEERS } from './uncounted-peers.js';
import type { Redis } from 'ioredis';

/**
 * Routes the address bucket never counts, by the pattern Fastify matched (not the raw URL: that
 * carries the query string and whatever encoding the caller chose — `/api/he%61lth` is served
 * by the same handler). Infrastructure polls these on a schedule and they must answer while a
 * flood is being refused: a health check that returns 429 tells an orchestrator to restart the
 * instance that was defending itself (health.controller.ts).
 */
const UNCOUNTED_ROUTES: ReadonlySet<string> = new Set(['/api/health', '/api/health/live']);

/**
 * The image read (`GET /api/v1/media/:mediaId`, #46), by the pattern Fastify matched like the
 * health routes above — so a query string, a percent-encoding or a malformed id (400) is the same
 * route. HEAD too: Fastify answers it from the GET handler.
 */
export const MEDIA_READ_ROUTE = '/api/v1/media/:mediaId';

/**
 * The address bucket a request is counted in, or null for one never counted (the health routes):
 * an image read in `mediaRead` alone, 304s included — not in `default` (owner decision 2026-10-19,
 * ADR-0073: the API checks every image on every use, so a page of thumbnails was a page of
 * requests out of the reader's 100) — and every other request in `default`.
 */
export function addressBucketOf(
  method: string,
  routeUrl: string | undefined,
): AddressRateLimitBucket | null {
  if (routeUrl !== undefined && UNCOUNTED_ROUTES.has(routeUrl)) return null;
  if ((method === 'GET' || method === 'HEAD') && routeUrl === MEDIA_READ_ROUTE) return 'mediaRead';
  return 'default';
}

/**
 * PLAN 7.5's per-address default — "100req/분/IP", for the API as a whole — as a raw Fastify
 * `onRequest` hook: Fastify's first hook, run once the router has matched (or failed to match)
 * and before anything is parsed, which is the ONE place that sees every request the lifecycle
 * sees.
 *
 * It used to be split: a `@nestjs/throttler` throttler for `/api/v1/*` and this hook for
 * `/api/auth/*` alone, the latter because better-auth is `@fastify/middie` middleware that runs
 * BEFORE Nest routing (auth.module.ts), so no Nest guard — global or otherwise — ever sees it.
 * But a guard runs inside the route handler, which is the LAST stage of Fastify's lifecycle: a
 * body Fastify cannot parse (400), one over `bodyLimit` (413) or a path no route matches (404)
 * is answered before any handler, so none of them were counted either, on the half of the API
 * whose contract says "every route" (PR #8 review). One hook, after routing and ahead of
 * parsing, counts everything a peer sends that enters the lifecycle — the guard keeps only the
 * named buckets (rate-limit.guard.ts), so nothing is counted twice. It is also what makes a
 * refusal cheap: an exhausted peer's body is no longer read, parsed or validated before the 429.
 * Two answers stay uncounted, because Fastify's router writes them to the socket before any
 * hook exists: a path it cannot decode (FST_ERR_BAD_URL, 400) and a parameter over
 * `maxParamLength` (FST_ERR_MAX_PARAM_LENGTH, 414). Neither touches a parser, a handler or a
 * store, and each costs less than the Redis round trip counting it would.
 *
 * Keyed on the address, whatever the path (`rateLimitKey(null, …)`: `rl:default:any:<digest>`),
 * because PLAN 7.5's default is stated per address, not per surface — a caller's hundred covers
 * `/api/v1/*` and `/api/auth/*` together. The one route counted apart is the image read, in a
 * bucket of its own under the same key (`rl:mediaRead:any:<digest>`, `addressBucketOf`): never
 * both. Skipped, not refused, for a peer that cannot name a client (`isCountableAddress`:
 * loopback, and the proxies `RATE_LIMIT_UNCOUNTED_PEERS` lists).
 *
 * The three `X-RateLimit-*` headers on a counted response (on an image read they speak of its own
 * bucket) and `Retry-After` on a refusal are
 * the ones `@nestjs/throttler` wrote for its `default` throttler, in its shape (unsuffixed:
 * the library suffixes every name but `default`, and the named buckets keep `-route`), so
 * docs/API.md's header contract is unchanged. Written on `reply.raw`, as @fastify/helmet does:
 * better-auth answers on the raw response and never flushes Fastify's reply headers, so
 * `reply.header()` would have reached the Nest half only.
 *
 * A refusal has two shapes, on purpose. Under `/api/auth/*` it is better-auth's own
 * `{ code, message, retryAfterSeconds }` — middie runs before Nest's exception filter, so every
 * other error on those paths already looks like this (ADR-0018) and one that looked different
 * would be the odd one out. Everywhere else the hook THROWS the same `AppError` the guard
 * throws, and Fastify hands an error from a hook to the handler Nest installed, which is
 * `ApiExceptionFilter`: the PLAN 7 envelope with `details.retryAfterSeconds`, built in the one
 * place that builds it, and the same `request refused` debug line a named bucket's 429 gets.
 *
 * Registered BEFORE `app.init()`, which is what puts it ahead of middie — Nest queues
 * `httpAdapter.use()` middlewares and flushes them during init, and Fastify runs same-phase
 * hooks in registration order — and AFTER `registerSecurityHeaders`, so a 429 sent from here
 * still carries the API's headers. Installed from both main.ts and test/app.ts for the reason
 * that function is: a bound only production applies is a bound nothing proves.
 */
export function installAddressLimit(app: NestFastifyApplication): void {
  const storage = new RedisThrottlerStorage(app.get<Redis>(REDIS));
  const limits = app.get<RateLimits>(RATE_LIMITS);
  const uncounted = app.get<BlockList>(UNCOUNTED_PEERS);
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1_000;

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      const bucket = addressBucketOf(request.method, request.routeOptions.url);
      if (bucket === null) return;
      if (!isCountableAddress(request.ip, uncounted)) return;
      const limit = limits[bucket];
      // The bucket's name is the storage namespace: `rl:default:any:<digest>` and
      // `rl:mediaRead:any:<digest>` are two counters for one address.
      const record = await storage.increment(
        rateLimitKey(null, addressTracker(request as unknown as Record<string, unknown>)),
        windowMs,
        limit,
        windowMs,
        bucket,
      );
      if (!record.isBlocked) {
        // The storage's fail-open record (Redis unreachable) is `timeToExpire: 0`, a value no
        // real window ever has; a response that was not counted must not advertise a full one.
        if (record.timeToExpire === 0) return;
        reply.raw.setHeader('X-RateLimit-Limit', limit);
        reply.raw.setHeader('X-RateLimit-Remaining', Math.max(0, limit - record.totalHits));
        reply.raw.setHeader('X-RateLimit-Reset', record.timeToExpire);
        return;
      }
      const retryAfterSeconds = record.timeToBlockExpire;
      reply.raw.setHeader('Retry-After', retryAfterSeconds);
      if (request.url.startsWith(`${AUTH_BASE_PATH}/`)) {
        await reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          retryAfterSeconds,
        });
        return;
      }
      throw new AppError('RATE_LIMITED', {
        message: 'Too many requests',
        details: { retryAfterSeconds },
      });
    });
}
