/**
 * 계정 제한 (#139, ADR-0085; ADR-0069 decision 1 #57-12…#57-15, decision 3 #37-8, #37-9, decision 4
 * #139 and #140 rows; ADR-0056 decision 1-7) against the docker `test` profile. Pinned: every step —
 * restricting a member's account for 1, 3, 7 or 30 days or 무기한, bringing its end forward (감경),
 * lifting it early and cancelling it — is a request that does nothing until an admin who neither
 * asked nor is the member approves it, with a reason, and then in the approval's transaction (the
 * term counted from the approval, read after every lock it waited on); a rejection does nothing;
 * neither the one who asked nor the member decides; a request the restriction outgrew — one approved
 * just before it included — is refused on approval and rejected instead; two approvals at once
 * whose deciders are each other's members both go through, with no deadlock. Under it the
 * member's public profile items take no new value (RESTRICTED, kind `account`, clearing open) and
 * an order is refused by the trading check #119 calls (`assertCanTrade`), while writing, likes,
 * reports, the 관심 등록, the balance and every record stay as they were; a term ends by itself;
 * restricted twice, the later end governs, and with a writing restriction the later of the two
 * (the account restriction on a tie). The member reads the restriction, its reason and end, never
 * who asked or approved, nor does an admin it is about. Nothing of it is public. Skips when TEST_*
 * are unset.
 */
import { randomUUID } from 'node:crypto';
import { clockTimestamp, lockAdminRoles, schema } from '@buddha/db';
import {
  completeOnboarding,
  createApprovalRequest,
  createComment,
  createFill,
  createMarket,
  createModerationAction,
  createNotice,
  createPosition,
  createPost,
  createReport,
} from '@buddha/db/test';
import {
  WRITE_LIMITS,
  accountRestrictionDecisionSchema,
  accountRestrictionRequestSchema,
  adminModerationActionSchema,
  adminUserModerationSchema,
  myModerationActionSchema,
  myRestrictionSchema,
  restrictedDetailsSchema,
  type AccountRestrictionDecision,
  type AccountRestrictionRequest,
  type AdminModerationAction,
  type MyModerationAction,
  type RestrictedDetails,
} from '@buddha/shared';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../approvals/approval.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { PUBLIC_ROUTES } from '../surface/registry.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { pngOf } from '../test/png.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter } from '../test/wait.js';
import {
  accountRestrictionOf,
  assertCanTrade,
  assertNotRestricted,
  restrictionInForce,
} from './restrictions.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const DAY_MS = 24 * 60 * 60 * 1_000;

type Res = { statusCode: number; body: string; json: <T>() => T };

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe.skipIf(!hasTestInfra)('/api/v1 account restriction (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let other: TestUser;
  let admin: TestUser;
  let second: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;
  let post: Awaited<ReturnType<typeof createPost>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await onboarded();
    other = await onboarded();
    admin = await anAdmin();
    second = await anAdmin();
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, { marketId: market.id, authorId: member.id, text: '본문' });
  });

  async function onboarded(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  }
  async function anAdmin(): Promise<TestUser> {
    const user = await onboarded();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  const call = (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload: Record<string, unknown>,
    who: TestUser,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const send = (url: string, payload: Record<string, unknown>, who: TestUser) =>
    call('POST', url, payload, who);
  const read = (url: string, who?: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ data: T }>().data;
  };
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const error = res.json<{ error: { code: string; details: unknown } }>().error;
    expect(error.code).toBe(code);
    return error.details;
  };
  const refusalOf = (res: Res) =>
    (errorOf(res, 409, 'MODERATION_NOT_ALLOWED') as { reason: string }).reason;
  const approvalRefusalOf = (res: Res) =>
    (errorOf(res, 409, 'APPROVAL_NOT_ALLOWED') as { message: string }[])[0]!.message;
  const restrictedOf = (res: Res): RestrictedDetails =>
    restrictedDetailsSchema.parse(errorOf(res, 403, 'RESTRICTED'));
  const requestOf = (res: Res): AccountRestrictionRequest =>
    accountRestrictionRequestSchema.parse(dataOf(res));
  const decisionOf = (res: Res): AccountRestrictionDecision =>
    accountRestrictionDecisionSchema.parse(dataOf(res));

  const NOTE = '여러 계정으로 같은 시장 거래';
  const ask = (
    days: number | null,
    who: TestUser = member,
    extra: Record<string, unknown> = {},
    by: TestUser = admin,
  ) =>
    send(
      `/admin/moderation/users/${who.id}/account-restriction`,
      { reason: 'multi_account', note: NOTE, days, ...extra },
      by,
    );
  const approve = (requestId: string, by: TestUser = second, reason = '증거 확인') =>
    send(`/admin/moderation/account-restriction-requests/${requestId}/approve`, { reason }, by);
  const reject = (requestId: string, by: TestUser = second, reason = '증거 부족') =>
    send(`/admin/moderation/account-restriction-requests/${requestId}/reject`, { reason }, by);
  /** Asked by `admin`, approved by `second`: the restriction in force. */
  const restrict = async (
    days: number | null,
    who: TestUser = member,
    extra: Record<string, unknown> = {},
  ): Promise<AdminModerationAction> => {
    const request = requestOf(await ask(days, who, extra));
    return decisionOf(await approve(request.id)).action!;
  };
  const askChange = (
    actionId: string,
    change: 'shorten' | 'lift' | 'cancel',
    extra: Record<string, unknown> = {},
    by: TestUser = admin,
  ) =>
    send(
      `/admin/moderation/actions/${actionId}/account-restriction/${change}`,
      { reason: `${change} 사유`, ...extra },
      by,
    );
  const change = async (
    actionId: string,
    kind: 'shorten' | 'lift' | 'cancel',
    extra: Record<string, unknown> = {},
  ): Promise<AdminModerationAction> =>
    decisionOf(await approve(requestOf(await askChange(actionId, kind, extra)).id)).action!;
  const mine = async (who: TestUser = member) =>
    myRestrictionSchema.parse(dataOf(await read('/me/moderation/restriction', who)));
  const myActions = async (who: TestUser = member): Promise<MyModerationAction[]> =>
    dataOf<unknown[]>(await read('/me/moderation/actions', who)).map((item) =>
      myModerationActionSchema.parse(item),
    );
  const audits = (type: string) =>
    t.db.select().from(schema.adminActions).where(eq(schema.adminActions.type, type));
  const accountActions = () =>
    t.db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.type, 'account_restriction'));

  describe('another admin’s approval (ADR-0056 1-7)', () => {
    it('does nothing on a request; another admin’s approval puts it in force then, recording who asked, who approved, why and when', async () => {
      const request = requestOf(await ask(7));
      expect(request).toMatchObject({
        change: 'apply',
        user: { id: member.id },
        actionId: null,
        apply: { reason: { code: 'multi_account', note: NOTE }, days: 7, subject: null },
        requestReason: NOTE,
        requestedBy: { id: admin.id },
        status: 'pending',
        decidedBy: null,
        moot: null,
        aboutViewer: false,
      });
      // Nothing in force yet: no restriction, nothing for the member to read.
      expect(await accountActions()).toEqual([]);
      expect(await mine()).toEqual({ restriction: null, accountRestriction: null });
      expect(await myActions()).toEqual([]);
      expect((await call('PUT', '/me/bio', { bio: '새 소개' }, member)).statusCode).toBe(200);
      expect(await audits('account_restriction_request')).toEqual([
        expect.objectContaining({
          adminId: admin.id,
          targetType: 'approval_request',
          targetId: request.id,
        }),
      ]);

      const decision = decisionOf(await approve(request.id));
      const action = decision.action!;
      expect(decision.request).toMatchObject({
        status: 'approved',
        decidedBy: { id: second.id },
        decisionReason: '증거 확인',
        actionId: action.id,
      });
      expect(action).toMatchObject({
        type: 'account_restriction',
        user: { id: member.id },
        reason: { code: 'multi_account', note: NOTE },
        createdBy: { id: admin.id },
        approval: { requestId: request.id, decidedBy: { id: second.id }, reason: '증거 확인' },
        cancelApproval: null,
        endChanges: [],
      });
      // In force from the approval: its time is the decision's, its term counted from it.
      expect(action.createdAt).toBe(decision.request.decidedAt);
      expect(Date.parse(action.endsAt!) - Date.parse(action.createdAt)).toBe(7 * DAY_MS);
      expect(await mine()).toEqual({
        restriction: null,
        accountRestriction: { kind: 'account', endsAt: action.endsAt },
      });
      expect(await audits('account_restriction_approve')).toEqual([
        expect.objectContaining({
          adminId: second.id,
          targetId: request.id,
          payload: expect.objectContaining({
            change: 'apply',
            actionId: action.id,
            userId: member.id,
          }) as unknown,
        }),
      ]);
      // Decided once.
      expect(approvalRefusalOf(await approve(request.id, admin))).toBe('requester');
      const third = await anAdmin();
      expect(approvalRefusalOf(await approve(request.id, third))).toBe('decided');
      expect(await accountActions()).toHaveLength(1);
    });

    it('never lets the one who asked decide, nor the member; a member’s route is refused', async () => {
      const request = requestOf(await ask(3));
      expect(approvalRefusalOf(await approve(request.id, admin))).toBe('requester');
      expect(approvalRefusalOf(await reject(request.id, admin))).toBe('requester');
      // An admin restricted by another: never their own decision either way (`own`).
      const restrictedAdmin = await anAdmin();
      const onAdmin = requestOf(await ask(3, restrictedAdmin, {}, admin));
      expect(refusalOf(await approve(onAdmin.id, restrictedAdmin))).toBe('own');
      expect(refusalOf(await reject(onAdmin.id, restrictedAdmin))).toBe('own');
      // Asking about oneself is refused at once; a member reaches no admin route.
      expect(refusalOf(await ask(3, admin, {}, admin))).toBe('own');
      expect((await approve(request.id, member)).statusCode).toBe(403);
      expect((await ask(3, other, {}, member)).statusCode).toBe(403);
      expect(await accountActions()).toEqual([]);
      const [stored] = await t.db
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, request.id));
      expect(stored!.status).toBe('pending');
    });

    it('does nothing on a rejection, the way a request no longer wanted is closed', async () => {
      const request = requestOf(await ask(null));
      const decision = decisionOf(await reject(request.id));
      expect(decision.action).toBeNull();
      expect(decision.request).toMatchObject({
        status: 'rejected',
        decidedBy: { id: second.id },
        decisionReason: '증거 부족',
        actionId: null,
      });
      expect(await accountActions()).toEqual([]);
      expect(await mine()).toEqual({ restriction: null, accountRestriction: null });
      expect(approvalRefusalOf(await approve(request.id))).toBe('decided');
      expect(await audits('account_restriction_reject')).toHaveLength(1);
    });

    it('keeps the direct routes of #185 and #50 from an account restriction: only an approved request moves or cancels it', async () => {
      const action = await restrict(7);
      for (const path of ['lift', 'cancel']) {
        expect(
          refusalOf(
            await send(`/admin/moderation/actions/${action.id}/${path}`, { reason: 'x' }, admin),
          ),
        ).toBe('approval_required');
      }
      expect(
        refusalOf(
          await send(
            `/admin/moderation/actions/${action.id}/shorten`,
            { endsAt: new Date(Date.now() + DAY_MS).toISOString(), reason: 'x' },
            admin,
          ),
        ),
      ).toBe('approval_required');
      // And a request names an account restriction only.
      const warning = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'warning',
      });
      expect(refusalOf(await askChange(warning.id, 'lift'))).toBe('not_account_restriction');
      expect((await askChange(randomUUID(), 'lift')).statusCode).toBe(404);
      // An admin restricted asks nothing about their own restriction.
      const restrictedAdmin = await anAdmin();
      const onAdmin = await restrict(7, restrictedAdmin);
      for (const kind of ['lift', 'cancel'] as const) {
        expect(refusalOf(await askChange(onAdmin.id, kind, {}, restrictedAdmin))).toBe('own');
      }
    });

    it('takes the terms and the owner’s reasons with an explanation always', async () => {
      for (const days of [1, 3, 7, 30, null]) {
        expect((await ask(days)).statusCode).toBe(200);
      }
      for (const days of [2, 0, undefined]) {
        expect((await ask(days as number)).statusCode).toBe(400);
      }
      expect(
        (
          await send(
            `/admin/moderation/users/${member.id}/account-restriction`,
            { reason: 'off_topic', note: NOTE, days: 7 },
            admin,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await send(
            `/admin/moderation/users/${member.id}/account-restriction`,
            { reason: 'spam', days: 7 },
            admin,
          )
        ).statusCode,
      ).toBe(400);
      expect((await approve(randomUUID())).statusCode).toBe(404);
    });

    it('approves two requests at once whose deciders are each other’s members, without a deadlock: an approval locks the member’s and the decider’s profiles first, in one order (7-17)', async () => {
      // `admin` asks to restrict `second` and `third`; each of them approves the one about the other
      // (an operator's restriction is decided by a third admin, 7-15).
      const third = await anAdmin();
      const onSecond = requestOf(await ask(7, second));
      const onThird = requestOf(await ask(3, third));
      const { approvalRequests } = schema;
      const observer = await t.db.$client.connect();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = () => {};
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      // Both requests' rows held, so the two approvals wait together and are let go at once.
      // Locked as they came (the member's profile by the approval, then the decider's by the
      // decision's trigger, migration 0021), each would take its member's profile and park on its
      // request — the decision's own lock — and both would go on together to the trigger, each
      // waiting for the profile the other holds: a deadlock, one approval a 500. In one order
      // (7-17) the two want the same two profiles, so the one that comes second waits on the
      // first's profile locks while the first parks on its request; let go, they run one after
      // the other.
      const holder = t.db.transaction(async (tx) => {
        await tx
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(inArray(approvalRequests.id, [onSecond.id, onThird.id]))
          .for('update');
        held();
        await gate;
      });
      let answers: Res[];
      try {
        await holding;
        const byThird = approve(onSecond.id, third);
        const bySecond = approve(onThird.id, second);
        await waitForLockWaiter(observer, 'the two approvals waiting on a lock', 2);
        release();
        await holder;
        answers = await Promise.all([byThird, bySecond]);
      } finally {
        release();
        observer.release();
      }
      const [aboutSecond, aboutThird] = answers.map((answer) => decisionOf(answer));
      expect(aboutSecond!.request).toMatchObject({
        status: 'approved',
        decidedBy: { id: third.id },
      });
      expect(aboutThird!.request).toMatchObject({
        status: 'approved',
        decidedBy: { id: second.id },
      });
      expect((await accountActions()).map((row) => row.userId).sort()).toEqual(
        [second.id, third.id].sort(),
      );
    });
  });

  describe('a request’s life and memo (owner decision 2026-10-23)', () => {
    const retract = (requestId: string, by: TestUser = admin) =>
      send(`/admin/moderation/account-restriction-requests/${requestId}/retract`, {}, by);
    const queue = async (status: 'pending' | 'decided' | 'retracted', who: TestUser = second) =>
      dataOf<unknown[]>(
        await read(`/admin/moderation/account-restriction-requests?status=${status}`, who),
      ).map((item) => accountRestrictionRequestSchema.parse(item));
    async function revoke(who: TestUser): Promise<void> {
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, who.id));
      await t.app.get(AdminGuard).invalidate(who.id);
    }
    const stored = (id: string) =>
      t.db
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, id))
        .then((rows) => rows[0]);
    /**
     * `sending()` made while a grant or revoke of `who` is in flight, as AdminAccountsService makes
     * one — the admin-roles lock held exclusively, the role written, not committed: it must wait on
     * that lock (an advisory one, seen in pg_stat_activity) until the role change commits, and is
     * answered after.
     */
    async function behindRole(
      who: TestUser,
      role: 'admin' | 'user',
      sending: () => Promise<Res>,
    ): Promise<Res> {
      let written = () => {};
      const writing = new Promise<void>((resolve) => {
        written = resolve;
      });
      let commit = () => {};
      const committing = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const observer = await t.db.$client.connect();
      const changing = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        await tx.update(schema.profiles).set({ role }).where(eq(schema.profiles.userId, who.id));
        written();
        await committing;
      });
      try {
        await Promise.race([writing, changing]);
        const pending = sending();
        try {
          await waitForLockWaiter(observer, 'the request behind the role change in flight');
          const { rows } = await observer.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> pg_backend_pid()
                 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
          );
          expect((rows[0] as { n: number }).n).toBe(1);
        } finally {
          commit();
          await changing;
          await t.app.get(AdminGuard).invalidate(who.id);
        }
        return await pending;
      } finally {
        commit();
        observer.release();
      }
    }

    it('lets the one who asked retract a request before its decision — recorded with who and when, decided by no one after — and no one else', async () => {
      const request = requestOf(await ask(7));
      // Another admin, and a member, retract nothing.
      expect(approvalRefusalOf(await retract(request.id, second))).toBe('not_requester');
      expect((await retract(request.id, member)).statusCode).toBe(403);
      expect((await stored(request.id))!.status).toBe('pending');

      const retracted = requestOf(await retract(request.id));
      expect(retracted).toMatchObject({
        id: request.id,
        status: 'retracted',
        requestedBy: { id: admin.id },
        decidedBy: null,
        decisionReason: null,
        decidedAt: null,
        moot: null,
      });
      expect(Date.parse(retracted.retractedAt!)).toBeGreaterThan(Date.parse(request.requestedAt));
      expect(await audits('account_restriction_retract')).toEqual([
        expect.objectContaining({
          adminId: admin.id,
          targetType: 'approval_request',
          targetId: request.id,
          payload: {
            requestId: request.id,
            change: 'apply',
            actionId: null,
            userId: member.id,
          },
        }),
      ]);
      // Closed: decided by no one, retracted once, nothing in force.
      expect(approvalRefusalOf(await approve(request.id))).toBe('retracted');
      expect(approvalRefusalOf(await reject(request.id))).toBe('retracted');
      expect(approvalRefusalOf(await retract(request.id))).toBe('retracted');
      expect(await accountActions()).toEqual([]);
      expect(await mine()).toEqual({ restriction: null, accountRestriction: null });
      // Off the waiting list and the member's page, on its own list — not the decided one.
      expect((await queue('pending')).map((item) => item.id)).toEqual([]);
      expect((await queue('decided')).map((item) => item.id)).toEqual([]);
      expect(await queue('retracted')).toEqual([
        expect.objectContaining({ id: request.id, retractedAt: retracted.retractedAt }),
      ]);
      expect(
        adminUserModerationSchema.parse(
          dataOf(await read(`/admin/moderation/users/${member.id}`, second)),
        ).accountRestrictionRequests,
      ).toEqual([]);

      // A decided request is not retracted; a change of a restriction is retracted the same way,
      // a moot one too.
      const decided = requestOf(await ask(3));
      const action = decisionOf(await approve(decided.id)).action!;
      expect(approvalRefusalOf(await retract(decided.id))).toBe('decided');
      const lift = requestOf(await askChange(action.id, 'lift'));
      const cancel = requestOf(await askChange(action.id, 'cancel'));
      decisionOf(await approve(cancel.id));
      const moot = (await queue('pending')).find((item) => item.id === lift.id);
      expect(moot?.moot).toBe('cancelled');
      expect(requestOf(await retract(lift.id))).toMatchObject({
        status: 'retracted',
        actionId: action.id,
      });
      expect(
        (await audits('account_restriction_retract')).find((row) => row.targetId === lift.id)
          ?.payload,
      ).toEqual({
        requestId: lift.id,
        change: 'lift',
        actionId: action.id,
        userId: member.id,
      });
      // Retracted latest first, a page at a time to the last.
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const res = await read(
          `/admin/moderation/account-restriction-requests?status=retracted&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          second,
        );
        pages.push(dataOf<{ id: string }[]>(res).map((item) => item.id));
        cursor = res.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor;
      } while (cursor !== null && pages.length < 5);
      expect(pages).toEqual([[lift.id], [request.id]]);
    });

    it('retracts, approves and rejects only a request of #139: another consumer’s is not found and stays pending', async () => {
      // Requests of another two-person consumer (#78, #144, #152, #130 — none lets its requests be
      // retracted), asked by the admin: one naming a real moderation action and one naming the
      // member, so neither a missing target nor the action's lookup refuses them — only the kind.
      const warning = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'warning',
      });
      const others = [
        await createApprovalRequest(t.db, {
          kind: 'test_kind',
          targetType: 'moderation_action',
          targetId: warning.id,
          payload: null,
          requestedBy: admin.id,
        }),
        await createApprovalRequest(t.db, {
          kind: 'test_kind',
          targetType: 'user',
          targetId: member.id,
          payload: null,
          requestedBy: admin.id,
        }),
      ];
      for (const request of others) {
        errorOf(await retract(request.id), 404, 'NOT_FOUND');
        errorOf(await approve(request.id), 404, 'NOT_FOUND');
        errorOf(await reject(request.id), 404, 'NOT_FOUND');
        expect(await stored(request.id)).toEqual(request);
        expect(request).toMatchObject({ status: 'pending', retractedAt: null, decidedBy: null });
      }
      for (const type of [
        'account_restriction_retract',
        'account_restriction_approve',
        'account_restriction_reject',
      ]) {
        expect(await audits(type)).toEqual([]);
      }
      expect(await accountActions()).toEqual([]);
    });

    it('refuses a request no admin could decide — none but the one asking and the member — and takes it once one could', async () => {
      // Two admins, as the seed has: the market's maker (an admin the factory made) is one no more.
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(
          and(
            eq(schema.profiles.role, 'admin'),
            notInArray(schema.profiles.userId, [admin.id, second.id]),
          ),
        );
      // One asks about the other, and no third could decide it.
      expect(refusalOf(await ask(7, second))).toBe('no_decider');
      expect(await t.db.select().from(schema.approvalRequests)).toEqual([]);
      expect(await audits('account_restriction_request')).toEqual([]);
      // A third admin can: the request is taken, and decided by that admin alone.
      const third = await anAdmin();
      const onSecond = requestOf(await ask(7, second));
      const action = decisionOf(await approve(onSecond.id, third)).action!;
      // Revoked since, the third admin leaves a change about the second undecidable: refused.
      await revoke(third);
      expect(refusalOf(await askChange(action.id, 'lift'))).toBe('no_decider');
      expect(refusalOf(await askChange(action.id, 'cancel'))).toBe('no_decider');
      expect(
        refusalOf(
          await askChange(action.id, 'shorten', {
            endsAt: new Date(Date.now() + DAY_MS).toISOString(),
          }),
        ),
      ).toBe('no_decider');
      // A member's request needs another admin than the one asking: with one admin left, none.
      await revoke(second);
      expect(refusalOf(await ask(7))).toBe('no_decider');
      expect((await t.db.select().from(schema.approvalRequests)).map((row) => row.id)).toEqual([
        onSecond.id,
      ]);
    });

    it('asks for a decider under the admin-roles lock: a revoke in flight is waited for and refuses the request, a grant in flight is waited for and takes it (answer 13, 7-14)', async () => {
      // Two admins, as the seed has, and a third: the only one who could decide about the second.
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(
          and(
            eq(schema.profiles.role, 'admin'),
            notInArray(schema.profiles.userId, [admin.id, second.id]),
          ),
        );
      const third = await anAdmin();
      const onSecond = requestOf(await ask(7, second));
      const action = decisionOf(await approve(onSecond.id, third)).action!;
      const ids = async () =>
        (await t.db.select().from(schema.approvalRequests)).map((row) => row.id).sort();

      // A change asked while the third's revoke is in flight (the role written, not committed): it
      // waits for the revoke and is refused once that commits, with nothing recorded.
      expect(refusalOf(await behindRole(third, 'user', () => askChange(action.id, 'lift')))).toBe(
        'no_decider',
      );
      expect(await ids()).toEqual([onSecond.id]);
      // A restriction asked while the third's grant is in flight: waited for, then taken — not refused
      // for want of the admin the grant is making. And the other way round for each kind of request.
      const applied = requestOf(await behindRole(third, 'admin', () => ask(3, second)));
      expect(refusalOf(await behindRole(third, 'user', () => ask(1, second)))).toBe('no_decider');
      const lift = requestOf(await behindRole(third, 'admin', () => askChange(action.id, 'lift')));
      expect(await ids()).toEqual([onSecond.id, applied.id, lift.id].sort());
      expect(
        (await audits('account_restriction_request')).map((row) => row.targetId).sort(),
      ).toEqual([onSecond.id, applied.id].sort());
      expect((await audits('account_restriction_lift_request')).map((row) => row.targetId)).toEqual(
        [lift.id],
      );
      // And the third, admin again, decides them.
      expect(decisionOf(await reject(applied.id, third)).request.status).toBe('rejected');
      expect(decisionOf(await reject(lift.id, third)).request.status).toBe('rejected');
    });

    it('keeps the operators’ memo for every operator — the one who asked, the one who decides and the rest, before the decision and after — never the member’s nor the admin’s it is about', async () => {
      const memo = '같은 기기에서 다섯 계정 — 운영자만';
      const request = requestOf(await ask(7, member, { memo: `  ${memo}  ` }));
      expect(request.apply).toMatchObject({ memo, reason: { note: NOTE } });
      expect(requestOf(await ask(3, member, { memo: '   ' })).apply?.memo).toBeNull();
      expect(requestOf(await ask(3)).apply?.memo).toBeNull();
      expect((await ask(3, member, { memo: '메'.repeat(501) })).statusCode).toBe(400);
      // Every admin reads it on the queue — the one who asked as well as the one who decides —
      // and on the member's page.
      for (const who of [admin, second]) {
        expect(
          (await queue('pending', who)).find((item) => item.id === request.id)?.apply?.memo,
        ).toBe(memo);
      }
      expect(
        adminUserModerationSchema
          .parse(dataOf(await read(`/admin/moderation/users/${member.id}`, second)))
          .accountRestrictionRequests.find((item) => item.id === request.id)?.apply?.memo,
      ).toBe(memo);
      // In force, the member reads the restriction and its explanation, never the memo.
      const decision = decisionOf(await approve(request.id));
      expect(decision.request.apply?.memo).toBe(memo);
      // Decided, still every admin's — an admin who decided nothing of it included.
      const bystander = await anAdmin();
      for (const who of [admin, second, bystander]) {
        expect(
          (await queue('decided', who)).find((item) => item.id === request.id)?.apply?.memo,
        ).toBe(memo);
      }
      for (const path of ['/me/moderation/actions', '/me/moderation/restriction']) {
        const res = await read(path, member);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(memo);
      }
      expect(JSON.stringify(decision.action)).not.toContain(memo);
      // About an admin: withheld from that admin, shown to the others.
      const restrictedAdmin = await anAdmin();
      const aboutAdmin = requestOf(await ask(7, restrictedAdmin, { memo }));
      expect(aboutAdmin.apply?.memo).toBe(memo);
      const asTarget = (await queue('pending', restrictedAdmin)).find(
        (item) => item.id === aboutAdmin.id,
      );
      expect(asTarget).toMatchObject({ aboutViewer: true, apply: { memo: null } });
      expect(
        (await queue('pending', second)).find((item) => item.id === aboutAdmin.id),
      ).toMatchObject({ aboutViewer: false, apply: { memo } });
      expect(
        (await audits('account_restriction_request')).find((row) => row.targetId === aboutAdmin.id)
          ?.payload,
      ).toMatchObject({ memo });
    });
  });

  describe('what it blocks and what it leaves open', () => {
    it('keeps public profile items from new values with its kind and end, and leaves clearing and the time zone open (#37-9, decision 7)', async () => {
      expect((await call('PUT', '/me/bio', { bio: '처음 소개' }, member)).statusCode).toBe(200);
      const action = await restrict(30);
      const expected: RestrictedDetails = { kind: 'account', endsAt: action.endsAt };
      expect(restrictedOf(await call('PATCH', '/me', { nickname: '새이름' }, member))).toEqual(
        expected,
      );
      expect(restrictedOf(await call('PUT', '/me/bio', { bio: '새 소개' }, member))).toEqual(
        expected,
      );
      expect((await call('PUT', '/me/bio', { bio: null }, member)).statusCode).toBe(200);
      const zone = await call('PUT', '/me/time-zone', { timeZone: 'Asia/Tokyo' }, member);
      expect(zone.statusCode, zone.body).toBe(200);
    });

    it('refuses a profile image as RESTRICTED before #187’s write limits ask, and counts the member’s post images under them as anyone’s (ADR-0083 7-14)', async () => {
      // The member's number has used the day's uploads already (WRITE_LIMITS' uploads_24h, a
      // post's image and a profile image together): unrestricted, the next is WRITE_LIMITED.
      const [verified] = await t.db
        .select({ phone: schema.phoneVerifications.phone })
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, member.id));
      const phoneHash = t.app.get(PhoneHasher).hash(verified!.phone);
      const [day] = WRITE_LIMITS.upload;
      await t.db.insert(schema.writeLimitEvents).values(
        Array.from({ length: day!.limit }, (_, index) => ({
          phoneHash,
          action: 'upload' as const,
          createdAt: new Date(Date.now() - 60 * 60 * 1_000 - index * 60_000),
        })),
      );
      const uploads = async () =>
        (
          await t.db
            .select()
            .from(schema.writeLimitEvents)
            .where(eq(schema.writeLimitEvents.phoneHash, phoneHash))
        ).length;
      // A real image each time, so that nothing but the checks keeps it from being stored.
      const upload = (url: string, method: 'PUT' | 'POST') =>
        t.app.inject({
          method,
          url: `/api/v1${url}?expectedAccountId=${encodeURIComponent(member.id)}`,
          headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/png', cookie: member.cookie },
          payload: pngOf(8, 8),
        });
      errorOf(await upload('/me/profile-image', 'PUT'), 429, 'WRITE_LIMITED');
      const stored = t.storage.objects.size;
      // Restricted: a profile image is a public item's new value, refused at the one check point
      // (`assertPublicItemEdit` — `restrictionInForce`) before the limits' check ahead of the
      // conversion (ProfileImageService.replace), as a writing restriction is (#185): the member
      // hears the sanction, not a time to try again that would be refused anyway.
      const action = await restrict(1);
      expect(restrictedOf(await upload('/me/profile-image', 'PUT'))).toEqual({
        kind: 'account',
        endsAt: action.endsAt,
      });
      // A post's image is no public item and the account restriction no writing restriction
      // (#57-12): it goes on to the limits like anyone's, past the day's uploads WRITE_LIMITED.
      errorOf(await upload('/media/images', 'POST'), 429, 'WRITE_LIMITED');
      // Nothing stored, recorded or counted.
      expect(t.storage.objects.size).toBe(stored);
      expect(await t.db.select().from(schema.mediaObjects)).toEqual([]);
      expect(await uploads()).toBe(day!.limit);
    });

    it('leaves community writing, likes, reports and the 관심 등록 open (#57-12, #57-13)', async () => {
      await restrict(null);
      const created = await send(
        '/posts',
        { marketId: market.id, title: '새 글', body: doc('새 본문') },
        member,
      );
      expect(created.statusCode, created.body).toBe(201);
      const commented = await send(`/posts/${post.id}/comments`, { body: '새 댓글' }, member);
      expect(commented.statusCode, commented.body).toBe(201);
      const othersPost = await createPost(t.db, { marketId: market.id, authorId: other.id });
      expect(
        (await call('PUT', `/posts/${othersPost.id}/like`, { liked: true }, member)).statusCode,
      ).toBe(200);
      const reported = await send(`/posts/${othersPost.id}/reports`, { reason: 'spam' }, member);
      expect(reported.statusCode, reported.body).toBe(201);
      const watched = await call('PUT', `/me/watchlist/${market.id}`, { watched: true }, member);
      expect(watched.statusCode, watched.body).toBe(200);
    });

    it('leaves what the member wrote where it was: the post, its comments and the profile’s 글·댓글 tabs (#45-12 «이미 쓴 글 (#139와 함께) … 그대로 둔다», ADR-0080 결과 5)', async () => {
      const comment = await createComment(t.db, {
        postId: post.id,
        authorId: member.id,
        body: '댓글',
      });
      await restrict(null);
      const [profile] = await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      const ids = (res: Res) => dataOf<{ id: string }[]>(res).map((item) => item.id);
      expect(ids(await read(`/profiles/${profile!.publicId}/posts`))).toContain(post.id);
      expect(ids(await read(`/profiles/${profile!.publicId}/comments`))).toContain(comment.id);
      expect(dataOf<{ state: string }>(await read(`/posts/${post.id}`)).state).toBe('published');
      // And the member's own MY '내 글' still lists them.
      expect(ids(await read('/me/posts', member))).toContain(post.id);
      expect(ids(await read('/me/comments', member))).toContain(comment.id);
    });

    it('refuses trading through the check #119 calls, and only an account restriction does (#57-12, N02 §9)', async () => {
      const trade = () => t.db.transaction((tx) => assertCanTrade(tx, member.id));
      await expect(trade()).resolves.toBeUndefined();
      // A writing restriction does not stop trading.
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: null,
      });
      await expect(trade()).resolves.toBeUndefined();
      const week = await restrict(7);
      await expect(trade()).rejects.toMatchObject({
        code: 'RESTRICTED',
        details: { kind: 'account', endsAt: week.endsAt },
      });
      const indefinite = await restrict(null);
      await expect(trade()).rejects.toMatchObject({ details: { kind: 'account', endsAt: null } });
      // Lifted, the week governs; cancelled too, none; another member trades.
      await change(indefinite.id, 'lift');
      await expect(trade()).rejects.toMatchObject({ details: { endsAt: week.endsAt } });
      await change(week.id, 'cancel');
      await expect(trade()).resolves.toBeUndefined();
      await expect(t.db.transaction((tx) => assertCanTrade(tx, other.id))).resolves.toBeUndefined();
    });

    it('holds an approval until an order in flight commits — the order’s own check holds the member’s profile — and times what it writes after every wait (7-14)', async () => {
      const request = requestOf(
        await ask(7, member, { subject: { type: 'post', postId: post.id } }),
      );
      const observer = await t.db.$client.connect();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let checked = () => {};
      const inFlight = new Promise<void>((resolve) => {
        checked = resolve;
      });
      // An order in flight as #119 will make it: the trading check first, the rest of its work
      // after, its time read just before it commits.
      const order = t.db.transaction(async (tx) => {
        await assertCanTrade(tx, member.id);
        checked();
        await gate;
        return clockTimestamp(tx);
      });
      let orderedAt: Date;
      let action: AdminModerationAction;
      try {
        await inFlight;
        const pending = approve(request.id);
        await waitForLockWaiter(observer, 'the approval behind the order’s trading check');
        // A report on the restriction's subject, filed and committed while the approval waits.
        const filed = await send(`/posts/${post.id}/reports`, { reason: 'spam' }, other);
        expect(filed.statusCode, filed.body).toBe(201);
        release();
        orderedAt = await order;
        action = decisionOf(await pending).action!;
      } finally {
        release();
        observer.release();
      }
      // In force from after what got in first: the order, and the report it resolves.
      expect(Date.parse(action.createdAt)).toBeGreaterThanOrEqual(orderedAt.getTime());
      const [report] = await t.db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.postId, post.id));
      expect(report).toMatchObject({ status: 'actioned', actionId: action.id });
      expect(report!.resolvedAt!.toISOString()).toBe(action.createdAt);
      expect(report!.resolvedAt!.getTime()).toBeGreaterThanOrEqual(report!.createdAt.getTime());
      // And an order after it reads it.
      await expect(t.db.transaction((tx) => assertCanTrade(tx, member.id))).rejects.toMatchObject({
        code: 'RESTRICTED',
      });
    });

    it('names the later of a writing and an account restriction where both refuse, the account restriction on a tie (#77, #140 hooks)', async () => {
      const both = () => t.db.transaction((tx) => restrictionInForce(tx, member.id));
      const refuse = () => t.db.transaction((tx) => assertNotRestricted(tx, member.id));
      expect(await both()).toBeNull();
      await expect(refuse()).resolves.toBeUndefined();
      // An account restriction alone refuses with its own kind and end.
      const week = await restrict(7);
      await expect(refuse()).rejects.toMatchObject({
        code: 'RESTRICTED',
        details: { kind: 'account', endsAt: week.endsAt },
      });
      // A writing restriction ending at the same instant: the account restriction (7-6).
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: new Date(week.endsAt!),
      });
      expect(await both()).toEqual({ kind: 'account', endsAt: week.endsAt });
      // One ending later: the writing restriction.
      const writing = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: new Date(Date.now() + 30 * DAY_MS),
      });
      const month = { kind: 'writing', endsAt: writing.endsAt!.toISOString() };
      expect(await both()).toEqual(month);
      await expect(refuse()).rejects.toMatchObject({ code: 'RESTRICTED', details: month });
      // The account restriction ending later (무기한): it.
      await restrict(null);
      expect(await both()).toEqual({ kind: 'account', endsAt: null });
      await expect(refuse()).rejects.toMatchObject({
        code: 'RESTRICTED',
        details: { kind: 'account', endsAt: null },
      });
      // Both 무기한: the account restriction.
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: null,
      });
      expect(await both()).toEqual({ kind: 'account', endsAt: null });
      // The public items name it too.
      expect(restrictedOf(await call('PUT', '/me/bio', { bio: '새 소개' }, member)).kind).toBe(
        'account',
      );
    });

    it('leaves the balance, the records and the holdings as they were, readable throughout (N02 §9)', async () => {
      await createFill(t.db, { marketId: market.id, amountCoin: 610n, userId: member.id, qty: 10 });
      await createPosition(t.db, {
        userId: member.id,
        marketId: market.id,
        outcome: 'YES',
        qty: 10,
        costBasisCoin: 610n,
      });
      const trading = async () => {
        const answers = [];
        for (const url of ['/me', '/me/ledger', '/me/positions', '/me/orders']) {
          const res = await read(url, member);
          expect(res.statusCode, `${url} ${res.body}`).toBe(200);
          answers.push(res.body);
        }
        const { balances, ledgerEntries, orders, positions } = schema;
        return {
          answers,
          rows: await Promise.all([
            t.db.select().from(balances).where(eq(balances.userId, member.id)),
            t.db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, member.id)),
            t.db.select().from(orders).where(eq(orders.userId, member.id)),
            t.db.select().from(positions).where(eq(positions.userId, member.id)),
          ]),
        };
      };
      const before = await trading();
      const indefinite = await restrict(null);
      expect(await trading()).toEqual(before);
      await change(indefinite.id, 'shorten', {
        endsAt: new Date(Date.now() + DAY_MS).toISOString(),
      });
      expect(await trading()).toEqual(before);
      await change(indefinite.id, 'lift');
      expect(await trading()).toEqual(before);
      const week = await restrict(7);
      await change(week.id, 'cancel');
      expect(await trading()).toEqual(before);
    });

    it('is nowhere in a public answer, whoever reads it (#37-8: an internal risk flag)', async () => {
      // Every public GET of the registry, its path naming the member's market, post, 댓글 (its
      // 대댓글 page — #48 — holding the member's 대댓글) and profile, and a pinned notice (#138):
      // the routes the restacked base added (ADR-0085 결과 5), as #185's own test names them.
      const [profile] = await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      const comment = await createComment(t.db, { postId: post.id, authorId: member.id });
      await createComment(t.db, {
        postId: post.id,
        authorId: member.id,
        parentId: comment.id,
        body: '대댓글',
      });
      const notice = await createNotice(t.db, { title: '점검 안내', pinSlot: 1 });
      const params: Readonly<Record<string, string>> = {
        id: market.id,
        idOrSlug: market.slug,
        postId: post.id,
        commentId: comment.id,
        publicId: profile!.publicId,
        mediaId: randomUUID(),
        noticeId: notice.id,
      };
      const urls = Object.keys(PUBLIC_ROUTES)
        .filter((key) => key.startsWith('GET '))
        .map((key) =>
          key.slice('GET '.length).replace(/:(\w+)/g, (_, name: string) => {
            const value = params[name];
            if (value === undefined) throw new Error(`no value for :${name} in ${key}`);
            return value;
          }),
        );
      expect(urls).toEqual(
        expect.arrayContaining([
          `/posts/${post.id}`,
          `/comments/${comment.id}/replies`,
          `/notices/${notice.id}`,
          `/profiles/${profile!.publicId}`,
          `/profiles/${profile!.publicId}/posts`,
          `/profiles/${profile!.publicId}/comments`,
        ]),
      );
      const VOLATILE = new Set(['uptimeSeconds', 'checks', 'from', 'to', 'points']);
      const stable = (body: string): string => {
        try {
          return JSON.stringify(JSON.parse(body), (key, value: unknown) =>
            VOLATILE.has(key) ? undefined : value,
          );
        } catch {
          return body;
        }
      };
      const answers = async (): Promise<string[]> => {
        const out: string[] = [];
        for (const url of urls) {
          for (const [label, who] of [
            ['anyone', undefined],
            ['another member', other],
            ['the member', member],
          ] as const) {
            const res = await read(url, who);
            out.push(`${label} ${url} ${String(res.statusCode)} ${stable(res.body)}`);
          }
        }
        return out;
      };
      const before = await answers();
      const note = `내부 표지 ${randomUUID()}`;
      // Pending, then in force: neither shows.
      const request = requestOf(await ask(30, member, { note }));
      expect(await answers()).toEqual(before);
      const action = decisionOf(await approve(request.id)).action!;
      const after = await answers();
      expect(after).toEqual(before);
      for (const answer of after) {
        expect(answer).not.toMatch(/restrict|sanction/i);
        for (const marker of [action.id, request.id, note, action.endsAt!]) {
          expect(answer).not.toContain(marker);
        }
      }
    });
  });

  describe('its end, 감경, lifting and cancelling', () => {
    it('ends by itself at its end: the time is compared, nothing runs', async () => {
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        approvedBy: second.id,
        type: 'account_restriction',
        createdAt: new Date(Date.now() - 2 * DAY_MS),
        endsAt: new Date(Date.now() - 1),
      });
      expect(await mine()).toEqual({ restriction: null, accountRestriction: null });
      await expect(
        t.db.transaction((tx) => assertCanTrade(tx, member.id)),
      ).resolves.toBeUndefined();
      expect((await call('PUT', '/me/bio', { bio: '새 소개' }, member)).statusCode).toBe(200);
      // Restricted twice, the later end governs; 무기한 over any term.
      const week = await restrict(7);
      await restrict(1);
      expect(await accountRestrictionOf(t.db, member.id)).toEqual({
        kind: 'account',
        endsAt: week.endsAt,
      });
    });

    it('brings the end forward (감경), lifts and cancels each by an approved request, recorded with its approval; the member reads the change, never who or why', async () => {
      const indefinite = await restrict(null);
      const newEnd = new Date(Date.now() + 2 * DAY_MS).toISOString();
      const shortened = await change(indefinite.id, 'shorten', { endsAt: newEnd });
      expect(shortened.endsAt).toBe(newEnd);
      expect(shortened.endChanges).toEqual([
        expect.objectContaining({
          kind: 'shorten',
          previousEndsAt: null,
          endsAt: newEnd,
          reason: 'shorten 사유',
          createdBy: expect.objectContaining({ id: admin.id }) as unknown,
          approval: expect.objectContaining({
            decidedBy: expect.objectContaining({ id: second.id }) as unknown,
          }) as unknown,
        }),
      ]);
      expect(await mine()).toEqual({
        restriction: null,
        accountRestriction: { kind: 'account', endsAt: newEnd },
      });
      const lifted = await change(indefinite.id, 'lift');
      expect(Date.parse(lifted.endsAt!)).toBeLessThanOrEqual(Date.now());
      expect(lifted.endChanges.map((entry) => entry.kind)).toEqual(['shorten', 'lift']);
      expect(await mine()).toEqual({ restriction: null, accountRestriction: null });
      const [read1] = await myActions();
      expect(read1).toMatchObject({
        id: indefinite.id,
        type: 'account_restriction',
        reason: { code: 'multi_account', note: NOTE },
        endsAt: lifted.endsAt,
        endChange: { kind: 'lift', originalEndsAt: null },
        cancelledAt: null,
      });
      // Cancelled by an approved request: an ended one too.
      const cancelled = await change(indefinite.id, 'cancel');
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(cancelled.cancelledBy?.id).toBe(admin.id);
      expect(cancelled.cancelApproval?.decidedBy?.id).toBe(second.id);
      // Never who asked or approved, nor why it changed.
      const body = (await read('/me/moderation/actions', member)).body;
      for (const marker of [admin.id, second.id, '증거 확인', 'lift 사유', 'shorten 사유']) {
        expect(body).not.toContain(marker);
      }
      expect(await audits('account_restriction_shorten_request')).toHaveLength(1);
      expect(await audits('account_restriction_lift_request')).toHaveLength(1);
      expect(await audits('account_restriction_cancel_request')).toHaveLength(1);
      expect(await audits('account_restriction_approve')).toHaveLength(4);
    });

    it('refuses a request for nothing, and an approval of what the restriction outgrew — which is rejected instead (moot)', async () => {
      const week = await restrict(7);
      const future = (ms: number) => new Date(Date.now() + ms).toISOString();
      expect(refusalOf(await askChange(week.id, 'shorten', { endsAt: future(-60_000) }))).toBe(
        'end_passed',
      );
      expect(refusalOf(await askChange(week.id, 'shorten', { endsAt: future(8 * DAY_MS) }))).toBe(
        'not_earlier',
      );
      // Two requests on one restriction: the cancellation approved first leaves the lift moot.
      const lift = requestOf(await askChange(week.id, 'lift'));
      const cancel = requestOf(await askChange(week.id, 'cancel'));
      decisionOf(await approve(cancel.id));
      expect(refusalOf(await approve(lift.id))).toBe('cancelled');
      expect(refusalOf(await askChange(week.id, 'lift'))).toBe('cancelled');
      const page = dataOf<unknown[]>(
        await read('/admin/moderation/account-restriction-requests', admin),
      ).map((item) => accountRestrictionRequestSchema.parse(item));
      expect(page.map((item) => [item.id, item.moot])).toEqual([[lift.id, 'cancelled']]);
      decisionOf(await reject(lift.id));
      // A 감경 whose end passed while it waited: refused on approval, nothing changed.
      const day = await restrict(3);
      const late = await createApprovalRequest(t.db, {
        kind: 'account_restriction_shorten',
        targetType: 'moderation_action',
        targetId: day.id,
        payload: { userId: member.id, actionId: day.id, endsAt: future(-1_000) },
        requestedBy: admin.id,
      });
      expect(refusalOf(await approve(late.id))).toBe('end_passed');
      const [unchanged] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, day.id));
      expect(unchanged!.endsAt!.toISOString()).toBe(day.endsAt);
    });

    it('refuses a 감경 or a lift of one that ended by itself, asked or approved (moot `ended`), and still cancels it', async () => {
      const ended = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        approvedBy: second.id,
        type: 'account_restriction',
        createdAt: new Date(Date.now() - 2 * DAY_MS),
        endsAt: new Date(Date.now() - 60_000),
      });
      expect(refusalOf(await askChange(ended.id, 'lift'))).toBe('ended');
      expect(
        refusalOf(
          await askChange(ended.id, 'shorten', {
            endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          }),
        ),
      ).toBe('ended');
      // A lift asked before it ended: listed as moot, its approval refused with nothing written.
      const late = await createApprovalRequest(t.db, {
        kind: 'account_restriction_lift',
        targetType: 'moderation_action',
        targetId: ended.id,
        payload: { userId: member.id, actionId: ended.id },
        requestedBy: admin.id,
      });
      const queue = dataOf<unknown[]>(
        await read('/admin/moderation/account-restriction-requests', second),
      ).map((item) => accountRestrictionRequestSchema.parse(item));
      expect(queue.map((item) => [item.id, item.moot])).toEqual([[late.id, 'ended']]);
      expect(refusalOf(await approve(late.id))).toBe('ended');
      const [unchanged] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, ended.id));
      expect(unchanged!.endsAt).toEqual(ended.endsAt);
      expect(
        await t.db
          .select()
          .from(schema.restrictionEndChanges)
          .where(eq(schema.restrictionEndChanges.actionId, ended.id)),
      ).toEqual([]);
      const [stillPending] = await t.db
        .select({ status: schema.approvalRequests.status })
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, late.id));
      expect(stillPending!.status).toBe('pending');
      // Its cancellation is asked and approved all the same (7-4).
      const cancelled = await change(ended.id, 'cancel');
      expect(cancelled.cancelledAt).not.toBeNull();
    });

    it('lets no admin decide a 감경, lift or cancellation of their own restriction, either way (`own`)', async () => {
      const restrictedAdmin = await anAdmin();
      const onAdmin = await restrict(7, restrictedAdmin);
      const requests = [
        requestOf(
          await askChange(onAdmin.id, 'shorten', {
            endsAt: new Date(Date.now() + DAY_MS).toISOString(),
          }),
        ),
        requestOf(await askChange(onAdmin.id, 'lift')),
        requestOf(await askChange(onAdmin.id, 'cancel')),
      ];
      for (const request of requests) {
        expect(refusalOf(await approve(request.id, restrictedAdmin))).toBe('own');
        expect(refusalOf(await reject(request.id, restrictedAdmin))).toBe('own');
      }
      const ids = requests.map((request) => request.id);
      const stored = await t.db
        .select({ status: schema.approvalRequests.status })
        .from(schema.approvalRequests)
        .where(inArray(schema.approvalRequests.id, ids));
      expect(stored.map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
      const [unchanged] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, onAdmin.id));
      expect(unchanged).toMatchObject({ cancelledAt: null, endsAt: new Date(onAdmin.endsAt!) });
      expect(
        await t.db
          .select()
          .from(schema.restrictionEndChanges)
          .where(eq(schema.restrictionEndChanges.actionId, onAdmin.id)),
      ).toEqual([]);
      // Another admin decides it, and the record names the member it is about.
      decisionOf(await approve(requests[1]!.id));
      const decided = (await audits('account_restriction_approve')).find(
        (row) => row.targetId === requests[1]!.id,
      );
      expect(decided?.payload).toMatchObject({ change: 'lift', userId: restrictedAdmin.id });
    });

    it('times a change after one approved while it waited: a lift behind a lift has nothing left to lift, a cancellation behind one comes after it (7-14)', async () => {
      const third = await anAdmin();
      const approvals = t.app.get(ApprovalService);
      /**
       * Holds the restriction's row while `behind` is sent and parks on it, then — a moment after —
       * approves `lift` as `third` and writes it as an approval does, and commits: an approval
       * decided just before `behind` was let through.
       */
      const liftAhead = async (
        restriction: AdminModerationAction,
        lift: AccountRestrictionRequest,
        behind: () => Promise<Res>,
      ): Promise<{ liftedAt: Date; answer: Res }> => {
        const { moderationActions, restrictionEndChanges } = schema;
        const observer = await t.db.$client.connect();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held = () => {};
        const holding = new Promise<void>((resolve) => {
          held = resolve;
        });
        const ahead = t.db.transaction(async (tx) => {
          await tx
            .select({ id: moderationActions.id })
            .from(moderationActions)
            .where(eq(moderationActions.id, restriction.id))
            .for('update');
          held();
          await gate;
          const decided = await approvals.approve(third.id, lift.id, '먼저 승인', tx);
          const at = decided.decidedAt!;
          await tx
            .update(moderationActions)
            .set({ endsAt: at })
            .where(eq(moderationActions.id, restriction.id));
          await tx.insert(restrictionEndChanges).values({
            actionId: restriction.id,
            kind: 'lift',
            previousEndsAt: restriction.endsAt === null ? null : new Date(restriction.endsAt),
            endsAt: at,
            reason: lift.requestReason,
            createdBy: admin.id,
            createdAt: at,
            approvalId: lift.id,
          });
          return at;
        });
        try {
          await holding;
          const answer = behind();
          await waitForLockWaiter(observer, 'the approval behind the restriction’s row');
          await sleep(5);
          release();
          return { liftedAt: await ahead, answer: await answer };
        } finally {
          release();
          observer.release();
        }
      };

      // Two lifts asked: the one approved while the other's approval waits leaves it `ended`.
      const week = await restrict(7);
      const lift = requestOf(await askChange(week.id, 'lift'));
      const behindLift = requestOf(await askChange(week.id, 'lift'));
      const lifted = await liftAhead(week, lift, () => approve(behindLift.id));
      expect(refusalOf(lifted.answer)).toBe('ended');
      const [afterLift] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, week.id));
      expect(afterLift!.endsAt).toEqual(lifted.liftedAt);
      expect(
        await t.db
          .select()
          .from(schema.restrictionEndChanges)
          .where(eq(schema.restrictionEndChanges.actionId, week.id)),
      ).toHaveLength(1);
      // A cancellation waiting behind a lift: cancelled after it.
      const day = await restrict(3);
      const dayLift = requestOf(await askChange(day.id, 'lift'));
      const cancel = requestOf(await askChange(day.id, 'cancel'));
      const behindCancel = await liftAhead(day, dayLift, () => approve(cancel.id));
      const cancelled = decisionOf(behindCancel.answer).action!;
      expect(cancelled.endChanges.map((entry) => entry.kind)).toEqual(['lift']);
      expect(Date.parse(cancelled.cancelledAt!)).toBeGreaterThanOrEqual(
        behindCancel.liftedAt.getTime(),
      );
      expect(Date.parse(cancelled.cancelledAt!)).toBeGreaterThanOrEqual(
        Date.parse(cancelled.endChanges[0]!.createdAt),
      );
    });
  });

  describe('giving it and the requests’ pages', () => {
    it('comes from the report queue: the subject’s pending reports are resolved by the approval, not by the request', async () => {
      const report = await createReport(t.db, {
        reporterId: other.id,
        reportedUserId: member.id,
        postId: post.id,
        reason: 'spam',
      });
      const request = requestOf(
        await ask(7, member, { subject: { type: 'post', postId: post.id } }),
      );
      expect(request.apply?.subject).toEqual({ type: 'post', postId: post.id });
      const pendingReports = () =>
        t.db
          .select({ status: schema.reports.status, actionId: schema.reports.actionId })
          .from(schema.reports)
          .where(eq(schema.reports.id, report.id));
      expect(await pendingReports()).toEqual([{ status: 'pending', actionId: null }]);
      const action = decisionOf(await approve(request.id)).action!;
      expect(action.subject).toEqual({ type: 'post', postId: post.id });
      expect(action.reportCount).toBe(1);
      expect(await pendingReports()).toEqual([{ status: 'actioned', actionId: action.id }]);
      const othersPost = await createPost(t.db, { marketId: market.id, authorId: other.id });
      expect(
        refusalOf(await ask(7, member, { subject: { type: 'post', postId: othersPost.id } })),
      ).toBe('not_theirs');
    });

    it('lists the pending requests oldest first and the decided latest first, a page at a time to the last', async () => {
      const first = requestOf(await ask(7));
      const otherRequest = requestOf(await ask(3, other));
      const last = requestOf(await ask(30, other));
      const queue = `/admin/moderation/account-restriction-requests`;
      const page = async (status: 'pending' | 'decided') =>
        dataOf<unknown[]>(await read(`${queue}?status=${status}`, second)).map(
          (item) => accountRestrictionRequestSchema.parse(item).id,
        );
      /** Every page of `status`, one request at a time, following the cursor to the end. */
      const paged = async (status: 'pending' | 'decided') => {
        const ids: string[][] = [];
        let cursor: string | null = null;
        do {
          const res = await read(
            `${queue}?status=${status}&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
            second,
          );
          ids.push(dataOf<{ id: string }[]>(res).map((item) => item.id));
          cursor = res.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor;
        } while (cursor !== null && ids.length < 5);
        return ids;
      };
      expect(await page('pending')).toEqual([first.id, otherRequest.id, last.id]);
      expect(await paged('pending')).toEqual([[first.id], [otherRequest.id], [last.id]]);
      decisionOf(await reject(last.id));
      decisionOf(await approve(first.id));
      decisionOf(await reject(otherRequest.id));
      expect(await page('pending')).toEqual([]);
      expect(await page('decided')).toEqual([otherRequest.id, first.id, last.id]);
      expect(await paged('decided')).toEqual([[otherRequest.id], [first.id], [last.id]]);
    });

    it('withholds the asking and the deciding admins from an admin it is about — the requests, the queue, the approvals of the restriction, its changes and its cancellation (owner decision 2026-10-21 answer 14)', async () => {
      const restrictedAdmin = await anAdmin();
      const queue = (status: 'pending' | 'decided', who: TestUser) =>
        read(`/admin/moderation/account-restriction-requests?status=${status}`, who).then((res) =>
          dataOf<unknown[]>(res)
            .map((item) => accountRestrictionRequestSchema.parse(item))
            .filter((item) => item.user.id === restrictedAdmin.id),
        );
      const memberPage = async (who: TestUser) =>
        adminUserModerationSchema.parse(
          dataOf(await read(`/admin/moderation/users/${restrictedAdmin.id}`, who)),
        );
      const withheld = { requestedBy: null, decidedBy: null, aboutViewer: true };
      const named = (decided: boolean) => ({
        requestedBy: expect.objectContaining({ id: admin.id }) as unknown,
        decidedBy: decided ? (expect.objectContaining({ id: second.id }) as unknown) : null,
        aboutViewer: false,
      });

      // Waiting: on the member page and in the queue, without the admin who asked.
      const aboutAdmin = requestOf(await ask(7, restrictedAdmin));
      expect((await memberPage(restrictedAdmin)).accountRestrictionRequests).toEqual([
        expect.objectContaining({ id: aboutAdmin.id, ...withheld }),
      ]);
      expect(await queue('pending', restrictedAdmin)).toEqual([
        expect.objectContaining({ id: aboutAdmin.id, ...withheld }),
      ]);
      expect((await memberPage(second)).accountRestrictionRequests).toEqual([
        expect.objectContaining({ id: aboutAdmin.id, ...named(false) }),
      ]);
      const approved = adminModerationActionSchema.parse(
        decisionOf(await approve(aboutAdmin.id)).action,
      );
      expect((await memberPage(restrictedAdmin)).accountRestrictionRequests).toEqual([]);

      // A change request shows on the member's page too, with the restriction it changes.
      const lift = requestOf(await askChange(approved.id, 'lift'));
      const withLift = await memberPage(second);
      expect(withLift.accountRestrictionRequests).toEqual([
        expect.objectContaining({
          id: lift.id,
          actionId: approved.id,
          target: {
            createdAt: approved.createdAt,
            endsAt: approved.endsAt,
            reason: approved.reason,
            cancelledAt: null,
          },
        }),
      ]);
      expect(await queue('pending', restrictedAdmin)).toEqual([
        expect.objectContaining({ id: lift.id, ...withheld }),
      ]);
      decisionOf(await approve(lift.id));
      const cancel = requestOf(await askChange(approved.id, 'cancel'));
      decisionOf(await approve(cancel.id));

      // Decided: the apply, the lift and the cancellation, without who asked or decided.
      const decidedIds = [aboutAdmin.id, lift.id, cancel.id].sort();
      const asTarget = await queue('decided', restrictedAdmin);
      expect(asTarget.map((item) => item.id).sort()).toEqual(decidedIds);
      for (const item of asTarget) expect(item).toMatchObject(withheld);
      const asOther = await queue('decided', second);
      expect(asOther.map((item) => item.id).sort()).toEqual(decidedIds);
      for (const item of asOther) expect(item).toMatchObject(named(true));

      // The restriction's record: who asked, approved, changed and cancelled it, withheld.
      const recordAsTarget = {
        aboutViewer: true,
        createdBy: null,
        cancelledBy: null,
        approval: expect.objectContaining({ decidedBy: null }) as unknown,
        cancelApproval: expect.objectContaining({ decidedBy: null }) as unknown,
        endChanges: [
          expect.objectContaining({
            kind: 'lift',
            createdBy: null,
            approval: expect.objectContaining({ decidedBy: null }) as unknown,
          }),
        ],
      };
      const ownRecord = (await memberPage(restrictedAdmin)).actions.find(
        (action) => action.id === approved.id,
      );
      expect(ownRecord).toMatchObject(recordAsTarget);
      const listed = dataOf<unknown[]>(await read('/admin/moderation/actions', restrictedAdmin))
        .map((item) => adminModerationActionSchema.parse(item))
        .find((action) => action.id === approved.id);
      expect(listed).toMatchObject(recordAsTarget);
      const seenRecord = (await memberPage(second)).actions.find(
        (action) => action.id === approved.id,
      );
      expect(seenRecord).toMatchObject({
        aboutViewer: false,
        createdBy: expect.objectContaining({ id: admin.id }) as unknown,
        cancelledBy: expect.objectContaining({ id: admin.id }) as unknown,
        approval: expect.objectContaining({
          decidedBy: expect.objectContaining({ id: second.id }) as unknown,
        }) as unknown,
        cancelApproval: expect.objectContaining({
          decidedBy: expect.objectContaining({ id: second.id }) as unknown,
        }) as unknown,
        endChanges: [
          expect.objectContaining({
            createdBy: expect.objectContaining({ id: admin.id }) as unknown,
            approval: expect.objectContaining({
              decidedBy: expect.objectContaining({ id: second.id }) as unknown,
            }) as unknown,
          }),
        ],
      });
      const members = await t.db
        .select()
        .from(schema.moderationActions)
        .where(
          and(
            eq(schema.moderationActions.userId, restrictedAdmin.id),
            eq(schema.moderationActions.type, 'account_restriction'),
          ),
        );
      expect(members).toHaveLength(1);
    });

    it('reads an operator’s rejection as one even where the deciding admin is withheld, never as a closure’s (#140)', async () => {
      // `decidedBy` is null both for the admin a request is about (withheld) and for a request a
      // member's closure closed (no decider): `closedByAccountClosure` is the stored row's.
      const restrictedAdmin = await anAdmin();
      const request = requestOf(await ask(7, restrictedAdmin));
      decisionOf(await reject(request.id));
      const decided = async (who: TestUser) =>
        dataOf<unknown[]>(
          await read('/admin/moderation/account-restriction-requests?status=decided', who),
        )
          .map((item) => accountRestrictionRequestSchema.parse(item))
          .find((item) => item.id === request.id);
      expect(await decided(restrictedAdmin)).toMatchObject({
        status: 'rejected',
        decidedBy: null,
        aboutViewer: true,
        closedByAccountClosure: false,
      });
      expect(await decided(second)).toMatchObject({
        status: 'rejected',
        decidedBy: { id: second.id },
        aboutViewer: false,
        closedByAccountClosure: false,
      });
    });
  });
});
