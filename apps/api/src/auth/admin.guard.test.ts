import { schema } from '@buddha/db';
import { eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS } from '../infra/redis/redis.provider.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { AdminGuard, ROLE_CACHE_TTL_SECONDS, roleCacheKey } from './admin.guard.js';

describe.skipIf(!hasTestInfra)('AdminGuard role cache (integration, PLAN 10.5)', () => {
  let t: TestApp;
  let guard: AdminGuard;
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp();
    guard = t.app.get(AdminGuard);
    redis = t.app.get<Redis>(REDIS);
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('reads the role from Postgres, caches it for 60 s, and honours invalidate()', async () => {
    const user = await signUpTestUser(t);
    await redis.del(roleCacheKey(user.id));

    expect(await guard.roleOf(user.id)).toBe('user');
    expect(await redis.ttl(roleCacheKey(user.id))).toBeGreaterThan(50);

    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    expect(await guard.roleOf(user.id)).toBe('user'); // still cached

    await guard.invalidate(user.id);
    expect(await guard.roleOf(user.id)).toBe('admin');
  });

  it('answers admin only from Postgres: a cached admin is never taken, nor filled over', async () => {
    // As a revoke leaves it: it writes nothing to the cache (#171).
    const user = await signUpTestUser(t);
    await redis.set(roleCacheKey(user.id), 'admin', 'EX', ROLE_CACHE_TTL_SECONDS);
    expect(await guard.roleOf(user.id)).toBe('user');
    expect(await redis.get(roleCacheKey(user.id))).toBe('admin');

    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    expect(await guard.roleOf(user.id)).toBe('admin');
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, user.id));
    expect(await guard.roleOf(user.id)).toBe('user'); // no admin answer was cached on the way
  });

  it('returns undefined for an unknown user and does not cache it', async () => {
    expect(await guard.roleOf('no-such-user')).toBeUndefined();
    expect(await redis.exists(roleCacheKey('no-such-user'))).toBe(0);
  });
});
