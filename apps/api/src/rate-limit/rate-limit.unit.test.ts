/**
 * The parts of PLAN 7.5 that need no server: which addresses count, and how the store behaves
 * when Redis does not answer. Runs everywhere (no TEST_* infrastructure).
 */
import { type Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { uncountedPeers } from '../config/env.js';
import { emailTracker } from './email-tracker.js';
import { isCountableAddress } from './rate-limit.tracker.js';
import { RATE_LIMIT_KEY_PREFIX, RedisThrottlerStorage } from './redis-throttler.storage.js';

describe('isCountableAddress', () => {
  it('refuses loopback in every spelling Node produces', () => {
    // Fastify reports the socket address verbatim, and a dual-stack listener maps IPv4 peers
    // into ::ffff:. All three are the same machine reaching itself: the Next rewrite, or a
    // developer's own curl. Counting them together would be one bucket for the whole product.
    expect(isCountableAddress('127.0.0.1')).toBe(false);
    expect(isCountableAddress('127.0.0.53')).toBe(false);
    expect(isCountableAddress('::1')).toBe(false);
    expect(isCountableAddress('::ffff:127.0.0.1')).toBe(false);
  });

  it('refuses an absent address rather than counting one bucket for all of them', () => {
    expect(isCountableAddress(undefined)).toBe(false);
    expect(isCountableAddress('')).toBe(false);
  });

  it('counts anything that can name a client', () => {
    expect(isCountableAddress('203.0.113.7')).toBe(true);
    expect(isCountableAddress('::ffff:203.0.113.7')).toBe(true);
    expect(isCountableAddress('2001:db8::1')).toBe(true);
    // A private address is a client too: behind a real reverse proxy with TRUST_PROXY set,
    // this is what an internal caller looks like, and it is not this function's business to
    // decide that a LAN visitor may flood. A private peer that is a PROXY is named, below.
    expect(isCountableAddress('10.1.2.3')).toBe(true);
  });

  it('refuses the peers RATE_LIMIT_UNCOUNTED_PEERS names — addresses and CIDRs, both families', () => {
    // The web server on another host: a routable address that cannot name a visitor, exactly
    // the loopback case with a different number (rate-limit.tracker.ts).
    const listed = uncountedPeers({
      RATE_LIMIT_UNCOUNTED_PEERS: '172.18.0.0/16, 10.0.0.5, fd00::/8, 2001:db8::7',
    });
    expect(isCountableAddress('172.18.3.4', listed)).toBe(false);
    expect(isCountableAddress('::ffff:172.18.3.4', listed)).toBe(false);
    expect(isCountableAddress('10.0.0.5', listed)).toBe(false);
    expect(isCountableAddress('fd00::5', listed)).toBe(false);
    expect(isCountableAddress('2001:db8::7', listed)).toBe(false);
    // Neighbours outside the list are still clients.
    expect(isCountableAddress('172.19.3.4', listed)).toBe(true);
    expect(isCountableAddress('10.0.0.6', listed)).toBe(true);
    expect(isCountableAddress('2001:db8::8', listed)).toBe(true);
    // Loopback stays built in, list or no list.
    expect(isCountableAddress('127.0.0.1', listed)).toBe(false);
    expect(
      isCountableAddress('::1', uncountedPeers({ RATE_LIMIT_UNCOUNTED_PEERS: undefined })),
    ).toBe(false);
  });
});

describe('emailTracker', () => {
  it('folds case and whitespace: one mailbox, one bucket', () => {
    expect(emailTracker(' A@Example.COM ')).toBe('a@example.com');
  });

  it('keys on anything that claims to be an address, however long', () => {
    // `z.email()` has no length cap, and a value the limiter declined to key on was a recipient
    // string free to name on every mail path. The callers hash it, so length costs nothing.
    const long = `${'a'.repeat(400)}@test.local`;
    expect(emailTracker(long)).toBe(long);
  });

  it('has no bucket for a non-string or an empty string', () => {
    expect(emailTracker(undefined)).toBeUndefined();
    expect(emailTracker(42)).toBeUndefined();
    expect(emailTracker('   ')).toBeUndefined();
  });
});

describe('RedisThrottlerStorage', () => {
  /** A `multi()` chain whose `exec()` answers with `replies`, or throws `error`. */
  function fakeRedis(outcome: { replies?: unknown; error?: Error }): Redis {
    const chain = {
      incr: vi.fn(() => chain),
      pexpire: vi.fn(() => chain),
      pttl: vi.fn(() => chain),
      exec: vi.fn(() =>
        outcome.error ? Promise.reject(outcome.error) : Promise.resolve(outcome.replies),
      ),
    };
    return { multi: () => chain } as unknown as Redis;
  }

  it('namespaces the key and reports the window in seconds', async () => {
    const redis = fakeRedis({
      replies: [
        [null, 3],
        [null, 0],
        [null, 41_200],
      ],
    });
    const storage = new RedisThrottlerStorage(redis);
    const record = await storage.increment('any:abc', 60_000, 5, 60_000, 'default');
    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 42, // ceil(41.2s)
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    const chain = redis.multi() as unknown as { incr: ReturnType<typeof vi.fn> };
    expect(chain.incr).toHaveBeenCalledWith(`${RATE_LIMIT_KEY_PREFIX}:default:any:abc`);
  });

  it('blocks once the count passes the limit, and says how long for', async () => {
    const storage = new RedisThrottlerStorage(
      fakeRedis({
        replies: [
          [null, 6],
          [null, 0],
          [null, 10_000],
        ],
      }),
    );
    expect(await storage.increment('k', 60_000, 5, 60_000, 'default')).toEqual({
      totalHits: 6,
      timeToExpire: 10,
      isBlocked: true,
      timeToBlockExpire: 10,
    });
  });

  it('falls back to the configured window when the key lost its expiry', async () => {
    // PTTL answers -2 for a key that vanished between INCR and PTTL (eviction under maxmemory)
    // and -1 for one with no expiry. Neither is a negative number of seconds to wait.
    const storage = new RedisThrottlerStorage(
      fakeRedis({
        replies: [
          [null, 1],
          [null, 1],
          [null, -2],
        ],
      }),
    );
    const record = await storage.increment('k', 60_000, 5, 60_000, 'default');
    expect(record.timeToExpire).toBe(60);
  });

  it('ALLOWS the request when the store is unreachable', async () => {
    // Fail open. A limiter that refuses while Redis is down converts a Redis blip into a total
    // outage of a service whose reads and trades do not need Redis at all.
    const storage = new RedisThrottlerStorage(fakeRedis({ error: new Error('ECONNREFUSED') }));
    expect(await storage.increment('k', 60_000, 5, 60_000, 'default')).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('ALLOWS the request when a command inside the transaction failed', async () => {
    const storage = new RedisThrottlerStorage(
      fakeRedis({
        replies: [
          [new Error('READONLY'), null],
          [null, 1],
          [null, 100],
        ],
      }),
    );
    expect((await storage.increment('k', 60_000, 5, 60_000, 'default')).isBlocked).toBe(false);
  });

  it('ALLOWS the request when the transaction was discarded', async () => {
    const storage = new RedisThrottlerStorage(fakeRedis({ replies: null }));
    expect((await storage.increment('k', 60_000, 5, 60_000, 'default')).isBlocked).toBe(false);
  });
});
