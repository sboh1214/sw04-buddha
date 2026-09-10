import { Logger } from '@nestjs/common';
import { type ThrottlerStorage } from '@nestjs/throttler';
import { type Redis } from 'ioredis';

/**
 * `@nestjs/throttler` declares `ThrottlerStorageRecord` in a module its barrel does not
 * re-export, so it is read off the interface rather than deep-imported from `dist/`.
 */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Namespace of every key this storage writes. Short, colon-separated and un-prefixed, like
 * `role:<userId>` (admin.guard.ts) and the realtime channels — the house shape for a Redis key.
 * Nothing else in the repo writes under it, so a test can sweep `rl:*` without touching the
 * BullMQ (`bull:*`) or role-cache keys that share the database.
 */
export const RATE_LIMIT_KEY_PREFIX = 'rl';

/**
 * `ThrottlerStorage` on the shared ioredis client (PLAN 16: rate-limit state lives in Redis,
 * never in process memory, so a second API instance counts the same requests).
 *
 * Written here rather than taken from `@nest-lab/throttler-storage-redis` for a reason that
 * matters: that package decides whether it was handed a client with `x instanceof Redis`, and
 * if the check misses — which is a coin toss across module shapes — it silently builds its OWN
 * connection, carrying none of the bounds `createRedisClient` exists to impose
 * (`commandTimeout`, `socketTimeout`, `autoResendUnfulfilledCommands: false`, the error
 * logger) and never closed by `RedisModule.onApplicationShutdown`. The algorithm is the same
 * fixed window, in a third of the code.
 *
 * FIXED WINDOW, not sliding: the first request of a window arms a TTL and the window ends when
 * that TTL does. It is what PLAN 7.5 describes ("20req/분"), it costs one round trip, and its
 * one weakness — up to twice the limit across a window boundary — is irrelevant to limits that
 * exist to stop loops and floods rather than to meter a quota.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  /**
   * One round trip: INCR, arm the expiry if the key is new, read what is left of it.
   *
   * `PEXPIRE … NX` (Redis 7) is what makes the window fixed. A bare `PEXPIRE` on every hit
   * would slide the window forward with the traffic, so a caller sending one request per second
   * would never see the counter reset and would be refused for as long as it kept trying; `NX`
   * arms the expiry only when the key has none, i.e. on the INCR that created it.
   *
   * MULTI, not a pipeline: the commands must not interleave with another request's INCR on the
   * same key, or two callers can both create it and neither arm the TTL — a counter that never
   * resets. `ttl` arrives in milliseconds (the guard's unit) and `timeToExpire` leaves in
   * seconds (the interface's).
   *
   * `blockDuration` is deliberately unused. The guard passes `blockDuration ?? ttl` and nothing
   * in this API sets one, so "blocked" is exactly "the window is spent"; a second key for a
   * duration nobody configures would be dead code with its own failure modes.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `${RATE_LIMIT_KEY_PREFIX}:${throttlerName}:${key}`;
    let totalHits: number;
    let ttlMs: number;
    try {
      const replies = await this.redis
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, ttl, 'NX')
        .pttl(redisKey)
        .exec();
      // `exec()` answers null when the transaction was discarded (a lost connection between
      // MULTI and EXEC). Treat it like any other store failure.
      if (replies === null) throw new Error('transaction discarded');
      const [incr, , pttl] = replies;
      if (incr?.[0]) throw incr[0];
      if (pttl?.[0]) throw pttl[0];
      totalHits = Number(incr?.[1]);
      ttlMs = Number(pttl?.[1]);
    } catch (error) {
      // FAIL OPEN. A limiter that refuses when its store is unreachable turns a Redis blip into
      // a total outage of a service whose reads, quotes and trades do not need Redis at all —
      // strictly worse than the flood it would have stopped. Same posture as AdminGuard's role
      // cache, which falls back to Postgres rather than refusing.
      this.logger.warn(
        `rate limit store unavailable, allowing the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
    // PTTL answers -1 for a key with no expiry (impossible after the NX above unless another
    // writer created it) and -2 for one that vanished between INCR and PTTL (eviction under
    // maxmemory). Either way the safe reading is "this window is about to end".
    const timeToExpire = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : Math.ceil(ttl / 1000);
    const isBlocked = totalHits > limit;
    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire: isBlocked ? timeToExpire : 0 };
  }

  /**
   * Drops a bucket.
   *
   * Not part of `ThrottlerStorage` — the guard never needs it, because for an HTTP request the
   * request itself is the event. `authRateLimiter` does: a sign-in with the right password
   * clears the failure count for that address, the way every account lockout does, and that is
   * what lets the attempt be counted BEFORE the handler runs without a shared account locking
   * itself out by being used.
   */
  async clear(key: string, throttlerName: string): Promise<void> {
    try {
      await this.redis.del(`${RATE_LIMIT_KEY_PREFIX}:${throttlerName}:${key}`);
    } catch (error) {
      // A bucket that could not be cleared expires on its own within the window; the caller has
      // nothing to do about it and must not fail a successful sign-in over it.
      this.logger.warn(
        `rate limit bucket could not be cleared: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
