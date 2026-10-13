/**
 * #171 "관리자 권한이 없는 계정이 관리자 기능과 운영 기록에 접근하지 못하게 하는 검사를 공용으로
 * 둔다". Every admin function and every operation record (audit failures, release-setting changes,
 * admin grants and revokes) is a route under /admin, and each one runs SessionGuard and then
 * AdminGuard before anything else. Like admin-audit.test.ts, the routes come from the module
 * graph, not from a list kept here, so a route added tomorrow is checked tomorrow.
 *
 * Two halves: a static walk of the guard metadata (no Postgres, no Redis: runs everywhere), and
 * the same surface requested for real as a member (403) and with no session (401).
 */
import { schema } from '@buddha/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes, guardsOf, isAdminPath, type DiscoveredRoute } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';

const routes = discoverRoutes();
const adminRoutes = routes.filter((route) => isAdminPath(route.path));

/** The operation records (N01 §9, N03 §8, N04 §6): admins only, like every admin function. */
const OPERATION_RECORDS = [
  'GET /admin/audit-failures',
  'GET /admin/release-settings/changes',
  'GET /admin/admins/changes',
];

describe('admin access (static)', () => {
  it('finds the admin surface and the operation records at all', () => {
    // A guard on the discovery: a walk that found nothing would pass everything below.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    const keys = adminRoutes.map((route) => route.key);
    for (const key of OPERATION_RECORDS) expect(keys).toContain(key);
  });

  it('runs SessionGuard and then AdminGuard first on every /admin route', () => {
    // First, and in this order: AdminGuard reads the session SessionGuard resolved, and a
    // route-level guard (PaidCoinSalesGuard) must not answer a member before the role check.
    const unguarded = adminRoutes
      .filter((route) => {
        const [first, second] = guardsOf(route);
        return first !== SessionGuard || second !== AdminGuard;
      })
      .map((route) => route.key);
    expect(unguarded).toEqual([]);
  });

  it('keeps every AdminGuard route under /admin', () => {
    // So the /admin surface IS the admin surface: the request half below covers every route
    // that needs the role.
    const outside = routes
      .filter((route) => !isAdminPath(route.path) && guardsOf(route).includes(AdminGuard))
      .map((route) => route.key);
    expect(outside).toEqual([]);
  });
});

describe.skipIf(!hasTestInfra)('admin access (integration)', () => {
  let t: TestApp;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
  });

  /** `/api/v1/admin/...` with a uuid for every parameter: the guards answer before any pipe. */
  function urlOf(route: DiscoveredRoute): string {
    return route.url.replaceAll(/:\w+/g, '00000000-0000-4000-8000-000000000000');
  }
  function call(route: DiscoveredRoute, cookie?: string) {
    const safe = route.method === 'GET' || route.method === 'HEAD';
    return t.app.inject({
      method: route.method as 'GET',
      url: urlOf(route),
      headers: {
        origin: 'http://localhost:3000',
        ...(safe ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(safe ? {} : { payload: {} }),
    });
  }

  it('answers a member 403 on every admin route, operation records included', async () => {
    const answers = [];
    for (const route of adminRoutes) {
      const res = await call(route, member.cookie);
      const code = res.json<{ error?: { code: string } }>().error?.code;
      answers.push({ route: route.key, status: res.statusCode, code });
    }
    expect(answers).toEqual(
      adminRoutes.map((route) => ({ route: route.key, status: 403, code: 'FORBIDDEN' })),
    );
  });

  it('answers 401 on every admin route without a session', async () => {
    const answers = [];
    for (const route of adminRoutes) {
      const res = await call(route);
      answers.push({ route: route.key, status: res.statusCode });
    }
    expect(answers).toEqual(adminRoutes.map((route) => ({ route: route.key, status: 401 })));
  });

  it('lets the same member through once it is an admin: the 403 was the role, not the request', async () => {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, member.id));
    await t.app.get(AdminGuard).invalidate(member.id);
    for (const key of OPERATION_RECORDS) {
      const route = adminRoutes.find((candidate) => candidate.key === key)!;
      expect({ key, status: (await call(route, member.cookie)).statusCode }).toEqual({
        key,
        status: 200,
      });
    }
  });
});
