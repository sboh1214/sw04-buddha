/**
 * Admin accounts (#171) against the docker `test` profile: granting with the email and contact
 * conditions, revoking with the two-admin floor (the revoker's own included), the sessions a
 * revoke deletes (a sign-in in flight's too) and the admin access it ends from the next request
 * (with the cache still saying admin), a grant after a revoke, the records written with each
 * change (or not at all) in the order they were made, the list and the history. Skips when
 * TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { schema } from '@buddha/db';
import { type AdminAccount, type AdminRoleChange } from '@buddha/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard, roleCacheKey } from '../auth/admin.guard.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes, isAdminPath } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const BASE = '/api/v1/admin/admins';
/** Every admin route (admin-access.test.ts walks the same list). */
const adminRoutes = discoverRoutes().filter((route) => isAdminPath(route.path));

type ErrorBody = {
  error: { code: string; details?: { path: (string | number)[]; message: string }[] };
};
type ChangePage = { data: AdminRoleChange[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('admin accounts (integration)', () => {
  let t: TestApp;
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    a = await signUpTestUser(t);
    b = await signUpTestUser(t);
    await promote(a);
    await promote(b);
  });

  /** An admin the way the seed or a fixture makes one: no grant record. */
  async function promote(user: TestUser) {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(user.id);
  }
  async function addContact(userId: string) {
    await t.db
      .insert(schema.userContacts)
      .values({ userId, realName: '홍길동', phone: '01012345678' });
  }
  /** A member ready for a grant: verified (the sign-up does it) with a contact. */
  async function candidate() {
    const user = await signUpTestUser(t);
    await addContact(user.id);
    return user;
  }

  const get = (url: string, cookie = a.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });
  /**
   * A grant or revoke by `actor` (its cookie), naming it as the account on screen
   * (`expectedAccountId`) unless the payload names another.
   */
  const grant = (payload: Record<string, unknown>, actor: TestUser = a) =>
    t.app.inject({
      method: 'POST',
      url: BASE,
      headers: { ...jsonHeaders, cookie: actor.cookie },
      payload: { expectedAccountId: actor.id, ...payload },
    });
  const revoke = (userId: string, payload: Record<string, unknown>, actor: TestUser = a) =>
    t.app.inject({
      method: 'POST',
      url: `${BASE}/${userId}/revoke`,
      headers: { ...jsonHeaders, cookie: actor.cookie },
      payload: { expectedAccountId: actor.id, ...payload },
    });
  async function signIn(user: TestUser): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders,
      payload: { email: user.email, password: user.password },
    });
    expect(res.statusCode).toBe(200);
    const raw = [res.headers['set-cookie']]
      .flat()
      .find((cookie) => cookie?.startsWith('buddha.session_token='));
    if (!raw) throw new Error('sign-in set no session cookie');
    return raw.split(';')[0]!;
  }

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;

  async function roleOf(userId: string) {
    const [row] = await t.db
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row?.role;
  }
  async function records() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(inArray(schema.adminActions.type, ['admin_grant', 'admin_revoke']))
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
  }
  async function sessionsOf(userId: string) {
    return t.db.select().from(schema.session).where(eq(schema.session.userId, userId));
  }
  /** Polls `check` every 20 ms until it holds; throws after 5 s. */
  async function until(check: () => Promise<boolean>, what: string) {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await check()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  /**
   * Whether another backend of this database comes to wait on a lock while running a statement
   * that matches `pattern` (ILIKE): true once one does, false when `done()` holds first.
   */
  async function waitsOnLock(pattern: string, done: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 250; attempt++) {
      const { rows } = await t.db.execute<{ waiting: number }>(sql`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`);
      if ((rows[0]?.waiting ?? 0) > 0) return true;
      if (done()) return false;
      await sleep(20);
    }
    throw new Error(`neither a lock wait on ${pattern} nor the end came`);
  }
  async function nicknameOf(userId: string) {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.nickname;
  }

  it('grants a verified account with a contact: the role, its record and the answer agree', async () => {
    const c = await candidate();
    // C's role is cached as `user` by a refused request: the grant must not wait 60 s for it.
    expect((await get(BASE, c.cookie)).statusCode).toBe(403);

    const res = await grant({ userId: c.id, reason: '운영 인원 추가' });
    expect(res.statusCode).toBe(201);
    const change = data<AdminRoleChange>(res);
    const [record] = await records();
    expect(change).toEqual({
      id: record!.id,
      type: 'admin_grant',
      target: { id: c.id, email: c.email, nickname: await nicknameOf(c.id) },
      actor: { id: a.id, nickname: await nicknameOf(a.id) },
      reason: '운영 인원 추가',
      createdAt: record!.createdAt.toISOString(),
    });
    expect(record).toMatchObject({
      adminId: a.id,
      type: 'admin_grant',
      targetType: 'user',
      targetId: c.id,
      payload: { reason: '운영 인원 추가' },
    });
    expect(await roleOf(c.id)).toBe('admin');
    // From the next request, on the session C already had.
    expect((await get(BASE, c.cookie)).statusCode).toBe(200);
  });

  it('refuses a grant the conditions do not allow, writing nothing', async () => {
    // Unverified (an address registered and never confirmed), even with a contact.
    const unverifiedId = randomUUID();
    await t.db.insert(schema.user).values({
      id: unverifiedId,
      name: 'unverified',
      email: `unverified-${unverifiedId}@test.local`,
      emailVerified: false,
    });
    await addContact(unverifiedId);
    // Verified, with no real name and mobile number (ADR-0043).
    const noContact = await signUpTestUser(t);
    for (const [userId, reason] of [
      [unverifiedId, 'email_not_verified'],
      [noContact.id, 'contact_required'],
      [b.id, 'already_admin'],
    ] as const) {
      const res = await grant({ userId, reason: '시험' });
      expect({ userId, status: res.statusCode }).toEqual({ userId, status: 409 });
      expect(errorOf(res)).toMatchObject({
        code: 'ROLE_CHANGE_NOT_ALLOWED',
        details: [{ path: ['userId'], message: reason }],
      });
    }
    const unknown = await grant({ userId: 'no-such-user', reason: '시험' });
    expect(unknown.statusCode).toBe(404);
    // The reason is required.
    const c = await candidate();
    for (const payload of [{ userId: c.id }, { userId: c.id, reason: '   ' }]) {
      const res = await grant(payload);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect(await records()).toEqual([]);
    expect(await roleOf(unverifiedId)).toBe('user');
    expect(await roleOf(noContact.id)).toBe('user');
    expect(await roleOf(c.id)).toBe('user');
  });

  it('lets two or more accounts hold the role at once, and lists them with their grants', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const res = await get(BASE);
    expect(res.statusCode).toBe(200);
    const admins = data<AdminAccount[]>(res);
    const [record] = await records();
    expect(admins).toEqual([
      {
        id: a.id,
        email: a.email,
        nickname: await nicknameOf(a.id),
        grantedAt: null,
        grantedBy: null,
      },
      {
        id: b.id,
        email: b.email,
        nickname: await nicknameOf(b.id),
        grantedAt: null,
        grantedBy: null,
      },
      {
        id: c.id,
        email: c.email,
        nickname: await nicknameOf(c.id),
        grantedAt: record!.createdAt.toISOString(),
        grantedBy: { id: a.id, nickname: await nicknameOf(a.id) },
      },
    ]);
    // Each of the three may use the admin surface.
    for (const user of [a, b, c]) expect((await get(BASE, user.cookie)).statusCode).toBe(200);
  });

  it('revokes: the role, its record, every session of the account and its admin access at once', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const elsewhere = await signIn(c);
    // Both sessions work.
    for (const cookie of [c.cookie, elsewhere])
      expect((await get(BASE, cookie)).statusCode).toBe(200);
    expect(await sessionsOf(c.id)).toHaveLength(2);
    const othersBefore = (await sessionsOf(a.id)).length + (await sessionsOf(b.id)).length;

    const res = await revoke(c.id, { reason: '담당 종료' });
    expect(res.statusCode).toBe(200);
    expect(data<AdminRoleChange>(res)).toMatchObject({
      type: 'admin_revoke',
      target: { id: c.id, email: c.email },
      actor: { id: a.id },
      reason: '담당 종료',
    });
    expect(await roleOf(c.id)).toBe('user');
    expect((await records()).map((row) => [row.type, row.adminId, row.targetId])).toEqual([
      ['admin_grant', a.id, c.id],
      ['admin_revoke', a.id, c.id],
    ]);
    // Signed out everywhere: both cookies are dead, on the admin surface and off it.
    expect(await sessionsOf(c.id)).toEqual([]);
    for (const cookie of [c.cookie, elsewhere]) {
      expect((await get(BASE, cookie)).statusCode).toBe(401);
      expect((await get('/api/v1/me', cookie)).statusCode).toBe(401);
    }
    // Nobody else was signed out.
    expect((await sessionsOf(a.id)).length + (await sessionsOf(b.id)).length).toBe(othersBefore);
    // A fresh sign-in is a member's session.
    const again = await signIn(c);
    const refused = await get(BASE, again);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    expect((await get('/api/v1/me', again)).statusCode).toBe(200);
  });

  it('refuses a revoke that would leave fewer than two admins, one of its own included', async () => {
    for (const target of [b.id, a.id]) {
      const res = await revoke(target, { reason: '시험' });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ROLE_CHANGE_NOT_ALLOWED',
        details: [{ path: ['userId'], message: 'min_admins' }],
      });
    }
    expect(await records()).toEqual([]);
    expect([await roleOf(a.id), await roleOf(b.id)]).toEqual(['admin', 'admin']);
    expect(await sessionsOf(a.id)).toHaveLength(1);
    expect(await sessionsOf(b.id)).toHaveLength(1);
  });

  it('lets an admin revoke itself while two others remain, and signs it out', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const res = await revoke(a.id, { reason: '스스로 내려놓음' });
    expect(res.statusCode).toBe(200);
    expect(data<AdminRoleChange>(res)).toMatchObject({
      type: 'admin_revoke',
      target: { id: a.id },
      actor: { id: a.id },
    });
    expect(await roleOf(a.id)).toBe('user');
    expect((await get(BASE, a.cookie)).statusCode).toBe(401);
    expect((await get(BASE, b.cookie)).statusCode).toBe(200);
  });

  it('refuses a revoke of a member or of nobody', async () => {
    const c = await candidate();
    const res = await revoke(c.id, { reason: '시험' });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'ROLE_CHANGE_NOT_ALLOWED',
      details: [{ path: ['userId'], message: 'not_admin' }],
    });
    expect((await revoke('no-such-user', { reason: '시험' })).statusCode).toBe(404);
    expect((await revoke(b.id, {})).statusCode).toBe(400);
    expect(await records()).toEqual([]);
  });

  it('refuses a grant or revoke whose body names another account than the cookie, writing nothing', async () => {
    // A tab still showing one admin after another tab signed in as somebody else: the cookie is
    // the other's, the body names the account on screen. Refused before anything is read or
    // written (403 naming expectedAccountId), as the charge, coupon and contact bodies are.
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const d = await candidate();
    const before = await records();
    const sessionsBefore = await Promise.all([a, b, c].map((user) => sessionsOf(user.id)));
    const mismatched = [
      // A grant B's cookie would record under B while the screen shows A.
      () => grant({ userId: d.id, reason: '시험', expectedAccountId: a.id }, b),
      // The screen shows A revoking its own role; the cookie is B's: A would lose the role and
      // the tab, believing it A's own revoke, would sign B out.
      () => revoke(a.id, { reason: '시험', expectedAccountId: a.id }, b),
      // The screen shows A revoking B; the cookie is B's: it would be B's own revoke, which the
      // screen would take for another's and stay on a stale admin screen.
      () => revoke(b.id, { reason: '시험', expectedAccountId: a.id }, b),
      // Another admin's revoke under a third account's name.
      () => revoke(c.id, { reason: '시험', expectedAccountId: d.id }, a),
    ];
    for (const send of mismatched) {
      const res = await send();
      expect(res.statusCode).toBe(403);
      const error = errorOf(res);
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    // Without the field, both are malformed.
    for (const res of [
      await grant({ userId: d.id, reason: '시험', expectedAccountId: undefined }),
      await revoke(c.id, { reason: '시험', expectedAccountId: undefined }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['expectedAccountId'] }],
      });
    }
    expect(await records()).toEqual(before);
    expect([
      await roleOf(a.id),
      await roleOf(b.id),
      await roleOf(c.id),
      await roleOf(d.id),
    ]).toEqual(['admin', 'admin', 'admin', 'user']);
    expect(await Promise.all([a, b, c].map((user) => sessionsOf(user.id)))).toEqual(sessionsBefore);
  });

  it('keeps a revoked account out while the role cache still says admin', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    expect((await get(BASE, c.cookie)).statusCode).toBe(200);
    const redis = t.app.get<Redis>(REDIS);
    const key = roleCacheKey(c.id);
    expect(await redis.get(key)).toBe('admin');

    // The revoke writes nothing to the cache, so it keeps saying `admin` for up to 60 s.
    expect((await revoke(c.id, { reason: '담당 종료' })).statusCode).toBe(200);
    expect(await roleOf(c.id)).toBe('user');
    expect(await redis.get(key)).toBe('admin');

    // The old cookie is signed out, and a fresh sign-in is a member's session on every admin
    // route — this screen and every other one, writes included: the guard never answers a
    // cached admin, it reads Postgres.
    expect((await get(BASE, c.cookie)).statusCode).toBe(401);
    const again = await signIn(c);
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    const answers = [];
    for (const route of adminRoutes) {
      const safe = route.method === 'GET' || route.method === 'HEAD';
      const res = await t.app.inject({
        method: route.method as 'GET',
        // A uuid for every parameter: the guards answer before any pipe.
        url: `/api/v1${route.path.replaceAll(/:\w+/g, '00000000-0000-4000-8000-000000000000')}`,
        headers: safe ? { cookie: again } : { ...jsonHeaders, cookie: again },
        ...(safe ? {} : { payload: {} }),
      });
      const code = res.json<{ error?: { code: string } }>().error?.code;
      answers.push({ route: route.key, status: res.statusCode, code });
    }
    expect(answers).toEqual(
      adminRoutes.map((route) => ({ route: route.key, status: 403, code: 'FORBIDDEN' })),
    );
    // The stale entry was there all along, and stays until it expires.
    expect(await redis.get(key)).toBe('admin');
    expect((await get('/api/v1/me', again)).statusCode).toBe(200);
  });

  it('lets a grant that commits after a revoke stand, however late the revoke touches the cache', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const redis = t.app.get<Redis>(REDIS);
    const key = roleCacheKey(c.id);
    // Any write of C's key other than a grant's `admin`, or a delete of it — whatever the revoke
    // does to the cache after its commit — is held until the grant below has committed and
    // cached, as a slow Redis round trip would hold it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const set = redis.set.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    const del = redis.del.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    const setSpy = vi
      .spyOn(redis, 'set')
      .mockImplementation(((...args: unknown[]) =>
        args[0] === key && args[1] !== 'admin'
          ? released.then(() => set(...args))
          : set(...args)) as never);
    const delSpy = vi
      .spyOn(redis, 'del')
      .mockImplementation(((...args: unknown[]) =>
        args.includes(key) ? released.then(() => del(...args)) : del(...args)) as never);
    try {
      const revoking = revoke(c.id, { reason: '담당 종료' });
      await until(async () => (await roleOf(c.id)) === 'user', "the revoke's commit");
      // B grants C again: the latest committed change, cached after the revoke committed.
      expect((await grant({ userId: c.id, reason: '다시 부여' }, b)).statusCode).toBe(201);
      release();
      expect((await revoking).statusCode).toBe(200);
    } finally {
      setSpy.mockRestore();
      delSpy.mockRestore();
    }
    expect(await roleOf(c.id)).toBe('admin');
    // C signs in again (the revoke ended its sessions) and is an admin from the first request.
    const again = await signIn(c);
    expect((await get(BASE, again)).statusCode).toBe(200);
  });

  it('ends a session a sign-in was still committing when the revoke began', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    // A sign-in's session insert, not committed yet: its foreign key check holds FOR KEY SHARE
    // on C's user row until it commits.
    let inserted!: () => void;
    const insertedOnce = new Promise<void>((resolve) => (inserted = resolve));
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    const signingIn = t.db.transaction(async (tx) => {
      await tx.insert(schema.session).values({
        id: randomUUID(),
        token: randomUUID(),
        userId: c.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      });
      inserted();
      await committing;
    });
    await insertedOnce;

    let revoked = false;
    const revoking = revoke(c.id, { reason: '담당 종료' }).then((res) => {
      revoked = true;
      return res;
    });
    // The revoke's FOR UPDATE on that row waits for the sign-in rather than deleting the
    // sessions it can see now and committing past the one being made.
    const waited = await waitsOnLock('%for update%', () => revoked);
    commit();
    await signingIn;
    const res = await revoking;
    expect(waited).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(await roleOf(c.id)).toBe('user');
    expect(await sessionsOf(c.id)).toEqual([]);
  });

  it('makes a sign-in during a revoke wait, then start a member session', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    // The revoke stops right before its session delete, with every lock it took held.
    let reached!: () => void;
    const atDelete = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    const original = t.db.transaction.bind(t.db);
    const pausing = vi.spyOn(t.db, 'transaction').mockImplementationOnce(((
      work: (tx: unknown) => Promise<unknown>,
      config?: unknown,
    ) =>
      original(
        (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'delete') {
                  return (table: typeof schema.session) => ({
                    where: async (condition: Parameters<typeof eq>[0]) => {
                      reached();
                      await resumed;
                      return target.delete(table).where(condition as never);
                    },
                  });
                }
                const value: unknown = Reflect.get(target, property);
                if (typeof value !== 'function') return value;
                const bound: unknown = value.bind(target);
                return bound;
              },
            }),
          ),
        config as never,
      )) as never);
    let revoking: ReturnType<typeof revoke> | undefined;
    try {
      revoking = revoke(c.id, { reason: '담당 종료' });
      await atDelete;
    } finally {
      pausing.mockRestore();
    }

    let signedIn = false;
    const signingIn = signIn(c).then((cookie) => {
      signedIn = true;
      return cookie;
    });
    // C's session insert waits on the revoke's lock of C's user row.
    const waited = await waitsOnLock('%"session"%', () => signedIn);
    resume();
    expect((await revoking).statusCode).toBe(200);
    const cookie = await signingIn;
    expect(waited).toBe(true);
    // Made after the revoke, the session survives it — as a member's.
    expect(await sessionsOf(c.id)).toHaveLength(1);
    const refused = await get(BASE, cookie);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    expect((await get('/api/v1/me', cookie)).statusCode).toBe(200);
  });

  it('refuses an actor revoked between the guard and the lock', async () => {
    // AdminGuard read A's role as admin, then another admin's revoke committed before A's grant
    // took the lock. The guard let the request through; the check under the lock does not.
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, a.id));
    const c = await candidate();
    const read = vi.spyOn(AdminGuard.prototype, 'roleOf').mockResolvedValueOnce('admin');
    const res = await grant({ userId: c.id, reason: '시험' });
    expect(read).toHaveBeenCalledWith(a.id);
    read.mockRestore();
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(await records()).toEqual([]);
    expect(await roleOf(c.id)).toBe('user');
  });

  it('keeps two admins when two revokes race: one of them is refused', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    // Each would leave two on its own; together they would leave one.
    const [first, second] = await Promise.all([
      revoke(b.id, { reason: '경쟁 1' }, a),
      revoke(c.id, { reason: '경쟁 2' }, a),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const admins = await t.db
      .select({ id: schema.profiles.userId })
      .from(schema.profiles)
      .where(eq(schema.profiles.role, 'admin'));
    expect(admins).toHaveLength(2);
    expect((await records()).filter((row) => row.type === 'admin_revoke')).toHaveLength(1);
  });

  it('writes a change and its record together or not at all', async () => {
    const c = await candidate();
    await grant({ userId: c.id, reason: '셋째 관리자' });
    const before = await records();
    // The transaction fails at its last step (the session delete of a revoke, the role update
    // of a grant) after the record was inserted: nothing of it may remain.
    const original = t.db.transaction.bind(t.db);
    const failing = (method: 'delete' | 'update') =>
      vi.spyOn(t.db, 'transaction').mockImplementation(((
        work: (tx: unknown) => Promise<unknown>,
        config?: unknown,
      ) =>
        original(
          (tx) =>
            work(
              new Proxy(tx, {
                get(target, property) {
                  if (property === method) throw new Error('injected failure');
                  const value: unknown = Reflect.get(target, property);
                  if (typeof value !== 'function') return value;
                  const bound: unknown = value.bind(target);
                  return bound;
                },
              }),
            ),
          config as never,
        )) as never);

    const revokeSpy = failing('delete');
    expect((await revoke(c.id, { reason: '실패할 회수' })).statusCode).toBe(500);
    revokeSpy.mockRestore();
    const d = await candidate();
    const grantSpy = failing('update');
    expect((await grant({ userId: d.id, reason: '실패할 부여' })).statusCode).toBe(500);
    grantSpy.mockRestore();

    expect(await records()).toEqual(before);
    expect(await roleOf(c.id)).toBe('admin');
    expect(await roleOf(d.id)).toBe('user');
    expect(await sessionsOf(c.id)).toHaveLength(1);
  });

  it('makes each role change later than the last, even when the clock has not passed it', async () => {
    // B's grant recorded a minute ahead of the database clock: the changes after it are recorded
    // 1 ms after the last one rather than at the clock's earlier instant, so the history keeps
    // them in the order they were made (two changes inside one millisecond tie the same way).
    const ahead = new Date(Date.now() + 60_000);
    await t.db.insert(schema.adminActions).values({
      adminId: a.id,
      type: 'admin_grant',
      targetType: 'user',
      targetId: b.id,
      payload: { reason: '앞선 시각' },
      createdAt: ahead,
    });
    const c = await candidate();
    expect((await grant({ userId: c.id, reason: '셋째 관리자' })).statusCode).toBe(201);
    expect((await revoke(c.id, { reason: '담당 종료' }, b)).statusCode).toBe(200);

    expect(
      (await records()).map((row) => [row.type, row.targetId, row.createdAt.getTime()]),
    ).toEqual([
      ['admin_grant', b.id, ahead.getTime()],
      ['admin_grant', c.id, ahead.getTime() + 1],
      ['admin_revoke', c.id, ahead.getTime() + 2],
    ]);
    const history = (await get(`${BASE}/changes`)).json<ChangePage>().data;
    expect(history.map((change) => [change.type, change.target.id])).toEqual([
      ['admin_revoke', c.id],
      ['admin_grant', c.id],
      ['admin_grant', b.id],
    ]);
  });

  it('pages the history newest first, with the account, the admin and the reason, and by account', async () => {
    const c = await candidate();
    const d = await candidate();
    await grant({ userId: c.id, reason: '첫째' });
    await grant({ userId: d.id, reason: '둘째' }, b);
    await revoke(c.id, { reason: '셋째' });
    // Another kind of record never shows up here.
    await t.db.insert(schema.adminActions).values({
      adminId: a.id,
      type: 'balance_adjust',
      targetType: 'user',
      targetId: c.id,
      payload: { amountCoin: '1', memo: '시험' },
    });

    const first = await get(`${BASE}/changes?limit=2`, b.cookie);
    expect(first.statusCode).toBe(200);
    const page1 = first.json<ChangePage>();
    expect(page1.data.map((change) => [change.type, change.target.id, change.reason])).toEqual([
      ['admin_revoke', c.id, '셋째'],
      ['admin_grant', d.id, '둘째'],
    ]);
    expect(page1.data[1]!.actor).toEqual({ id: b.id, nickname: await nicknameOf(b.id) });
    expect(page1.meta.nextCursor).not.toBeNull();
    const second = await get(
      `${BASE}/changes?limit=2&cursor=${encodeURIComponent(page1.meta.nextCursor!)}`,
    );
    const page2 = second.json<ChangePage>();
    expect(page2.data.map((change) => [change.type, change.target.id])).toEqual([
      ['admin_grant', c.id],
    ]);
    expect(page2.meta.nextCursor).toBeNull();

    const ofC = await get(`${BASE}/changes?userId=${encodeURIComponent(c.id)}`);
    expect(ofC.json<ChangePage>().data.map((change) => change.type)).toEqual([
      'admin_revoke',
      'admin_grant',
    ]);
    // The balance adjustment names C too, and stays out of its role history.
    const ofCAll = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, c.id));
    expect(ofCAll).toHaveLength(3);
  });
});
