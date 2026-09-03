import { schema } from '@buddha/db';
import { eq } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS } from '../infra/redis/redis.provider.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { AdminGuard, roleCacheKey } from './admin.guard.js';

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
    await t.close();
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

  it('returns undefined for an unknown user and does not cache it', async () => {
    expect(await guard.roleOf('no-such-user')).toBeUndefined();
    expect(await redis.exists(roleCacheKey('no-such-user'))).toBe(0);
  });
});
