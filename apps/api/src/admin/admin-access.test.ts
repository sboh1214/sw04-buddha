/**
 * #171 "관리자 권한이 없는 계정이 관리자 기능과 운영 기록에 접근하지 못하게 하는 검사를 공용으로
 * 둔다". Every admin function and every operation record (audit failures, release-setting changes,
 * admin grants and revokes) is a route under /admin, and each one runs SessionGuard and then
 * AdminGuard before anything else. Like admin-audit.test.ts, the routes come from the module
 * graph, not from a list kept here, so a route added tomorrow is checked tomorrow.
 *
 * An admin is an account like any other: until it has finished the onboarding (#58: consent,
 * 본인확인, nickname) every /admin route refuses it too, OnboardedGuard right after AdminGuard
 * (409 ONBOARDING_REQUIRED, 오너 결정 2026-10-19, ADR-0072) — after the role, so a member hears
 * 403 whatever its onboarding.
 *
 * Two halves: a static walk of the guard metadata (no Postgres, no Redis: runs everywhere), and
 * the same surface requested for real as a member (403), with no session (401) and as an admin
 * that has not finished the onboarding (409). And what an admin reads of the records about
 * themselves (#50): every admin reads the reports and the actions (ADR-0056 1-2), but not who
 * reported them, what the reporter wrote nor which operator acted (owner decision 2026-10-21).
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createModerationAction,
  createPost,
  createReport,
} from '@buddha/db/test';
import {
  adminCommentModerationSchema,
  adminModerationActionSchema,
  adminPostModerationSchema,
  adminUserModerationSchema,
  type AdminModerationAction,
  type AdminReport,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes, guardsOf, isAdminPath, type DiscoveredRoute } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';

const routes = discoverRoutes();
const adminRoutes = routes.filter((route) => isAdminPath(route.path));

/**
 * The operation records (N01 §9, N03 §8, N04 §6): admins only, like every admin function. A
 * notice's records and earlier versions (#138, owner decision 2026-10-21) answer an empty page for
 * a notice that is not there, so they are asked here with the walk's placeholder id too.
 */
const OPERATION_RECORDS = [
  'GET /admin/audit-failures',
  'GET /admin/release-settings/changes',
  'GET /admin/admins/changes',
  'GET /admin/notices/:noticeId/actions',
  'GET /admin/notices/:noticeId/revisions',
  // #50: the reports, their processing and the moderation actions (N04 §6, ADR-0056 1-2).
  'GET /admin/reports',
  'GET /admin/moderation/actions',
];

describe('admin access (static)', () => {
  it('finds the admin surface and the operation records at all', () => {
    // A guard on the discovery: a walk that found nothing would pass everything below.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    const keys = adminRoutes.map((route) => route.key);
    for (const key of OPERATION_RECORDS) expect(keys).toContain(key);
  });

  it('runs SessionGuard, AdminGuard and then OnboardedGuard first on every /admin route', () => {
    // First, and in this order: AdminGuard reads the session SessionGuard resolved, a route-level
    // guard (PaidCoinSalesGuard) must not answer a member before the role check, and the
    // onboarding is asked of admins only (ADR-0072), so a member's answer stays the role's 403.
    const unguarded = adminRoutes
      .filter((route) => {
        const [first, second, third] = guardsOf(route);
        return first !== SessionGuard || second !== AdminGuard || third !== OnboardedGuard;
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

  it('answers an admin that has not finished the onboarding 409 on every admin route (#58)', async () => {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, member.id));
    await t.app.get(AdminGuard).invalidate(member.id);
    const answers = [];
    for (const route of adminRoutes) {
      const res = await call(route, member.cookie);
      const error = res.json<{ error?: { code: string; details?: unknown } }>().error;
      answers.push({
        route: route.key,
        status: res.statusCode,
        code: error?.code,
        details: error?.details,
      });
    }
    // Every step is missing: a fresh account, refused before any pipe or body is read.
    expect(answers).toEqual(
      adminRoutes.map((route) => ({
        route: route.key,
        status: 409,
        code: 'ONBOARDING_REQUIRED',
        details: { steps: ['consent', 'verification', 'nickname'] },
      })),
    );
  });

  it('lets the same member through once it is an onboarded admin: the 403 was the role, the 409 the onboarding', async () => {
    await completeOnboarding(t.db, { userId: member.id });
    // Onboarded but still a member: the role's 403, as for any member.
    const [first] = adminRoutes;
    expect((await call(first!, member.cookie)).statusCode).toBe(403);
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

describe.skipIf(!hasTestInfra)(
  'admin access to the records about oneself (#50, integration)',
  () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => {
      await t?.close(); // undefined when beforeAll timed out waiting for the file lock
    });
    beforeEach(async () => {
      await t.reset();
    });

    /** An onboarded account; an admin when `admin`. */
    async function account(
      admin: boolean,
    ): Promise<TestUser & { nickname: string; publicId: string }> {
      const user = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: user.id });
      if (admin) {
        await t.db
          .update(schema.profiles)
          .set({ role: 'admin' })
          .where(eq(schema.profiles.userId, user.id));
        await t.app.get(AdminGuard).invalidate(user.id);
      }
      const [profile] = await t.db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, user.id));
      return { ...user, nickname: profile!.nickname, publicId: profile!.publicId };
    }

    const read = async (url: string, who: TestUser) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1${url}`,
        headers: { cookie: who.cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };

    it('reads the reports on oneself and the actions on oneself without the reporters, their texts and the operators (owner decision 2026-10-21)', async () => {
      // A is an admin reported and acted on; O is the other operator; R reported A; M is a member O
      // acted on too, for the record A reads in full.
      const a = await account(true);
      const o = await account(true);
      const r = await account(false);
      const m = await account(false);
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: a.id });
      const comment = await createComment(t.db, { postId: post.id, authorId: a.id });
      const description = `report-text-${a.id}`;
      const hiding = await createModerationAction(t.db, {
        userId: a.id,
        createdBy: o.id,
        postId: post.id,
        reason: 'spam',
        note: '회원이 읽는 설명',
      });
      await createReport(t.db, {
        reporterId: r.id,
        reportedUserId: a.id,
        postId: post.id,
        reason: 'other',
        description,
        status: 'actioned',
        resolvedBy: o.id,
        actionId: hiding.id,
      });
      await createReport(t.db, {
        reporterId: r.id,
        reportedUserId: a.id,
        commentId: comment.id,
        reason: 'other',
        description,
        status: 'dismissed',
        resolvedBy: o.id,
        dismissalReason: '위반 아님',
      });
      await createReport(t.db, {
        reporterId: r.id,
        reportedUserId: a.id,
        reason: 'other',
        description,
      });
      await createModerationAction(t.db, {
        userId: a.id,
        createdBy: o.id,
        reason: 'harassment',
        cancelled: { at: new Date(), by: o.id, reason: '이의를 받아들임' },
      });
      const onM = await createModerationAction(t.db, {
        userId: m.id,
        createdBy: o.id,
        reason: 'spam',
      });

      const pages = [
        `/admin/moderation/posts/${post.id}`,
        `/admin/moderation/comments/${comment.id}`,
        `/admin/moderation/users/${a.id}`,
        `/admin/moderation/profiles/${a.publicId}`,
        '/admin/moderation/actions',
        '/admin/reports?status=resolved',
        '/admin/reports',
      ];
      for (const url of pages) {
        const body = (await read(url, a)).body;
        for (const hidden of [r.id, r.nickname, description, o.id, o.nickname]) {
          // M's action names its operator: only the records about A withhold them.
          if (url === '/admin/moderation/actions' && (hidden === o.id || hidden === o.nickname)) {
            continue;
          }
          expect({ url, hidden, shown: body.includes(hidden) }).toEqual({
            url,
            hidden,
            shown: false,
          });
        }
      }
      // What stays: the reasons, the times, what was done — and the count of reporters.
      const postPage = adminPostModerationSchema.parse(
        (await read(`/admin/moderation/posts/${post.id}`, a)).json<{ data: unknown }>().data,
      );
      expect(postPage.reporterCount).toBe(1);
      expect(postPage.reports).toEqual([
        expect.objectContaining<Partial<AdminReport>>({
          reporter: null,
          description: null,
          resolvedBy: null,
          reason: 'other',
          status: 'actioned',
          actionId: hiding.id,
          aboutViewer: true,
        }),
      ]);
      expect(postPage.actions).toEqual([
        expect.objectContaining<Partial<AdminModerationAction>>({
          id: hiding.id,
          createdBy: null,
          reason: { code: 'spam', note: '회원이 읽는 설명' },
          aboutViewer: true,
        }),
      ]);
      const commentPage = adminCommentModerationSchema.parse(
        (await read(`/admin/moderation/comments/${comment.id}`, a)).json<{ data: unknown }>().data,
      );
      expect(commentPage.reports[0]).toMatchObject({
        reporter: null,
        resolvedBy: null,
        dismissalReason: '위반 아님',
        aboutViewer: true,
      });
      for (const url of [
        `/admin/moderation/users/${a.id}`,
        `/admin/moderation/profiles/${a.publicId}`,
      ]) {
        const page = adminUserModerationSchema.parse(
          (await read(url, a)).json<{ data: unknown }>().data,
        );
        expect(page.user.id).toBe(a.id);
        expect(page.reporterCount).toBe(1);
        expect(page.reports.map((report) => [report.reporter, report.aboutViewer])).toEqual([
          [null, true],
        ]);
        const cancelled = page.actions.find((action) => action.cancelledAt !== null)!;
        expect(cancelled).toMatchObject({
          createdBy: null,
          cancelledBy: null,
          cancelReason: '이의를 받아들임',
          aboutViewer: true,
        });
      }
      const log = (await read('/admin/moderation/actions', a))
        .json<{ data: unknown[] }>()
        .data.map((item) => adminModerationActionSchema.parse(item));
      expect(log.find((action) => action.id === onM.id)).toMatchObject({
        createdBy: { id: o.id, nickname: o.nickname },
        aboutViewer: false,
      });
      expect(
        log.filter((action) => action.user.id === a.id).map((action) => action.createdBy),
      ).toEqual([null, null]);

      // Another operator reads the same records whole (ADR-0056 1-2).
      const full = (await read(`/admin/moderation/posts/${post.id}`, o)).body;
      for (const shown of [r.id, r.nickname, description, o.nickname]) {
        expect(full).toContain(shown);
      }
      const asOther = adminPostModerationSchema.parse(
        (await read(`/admin/moderation/posts/${post.id}`, o)).json<{ data: unknown }>().data,
      );
      expect(asOther.reports[0]).toMatchObject({
        reporter: { id: r.id },
        description,
        resolvedBy: { id: o.id },
        aboutViewer: false,
      });
      expect(asOther.actions[0]).toMatchObject({ createdBy: { id: o.id }, aboutViewer: false });
    });
  },
);
