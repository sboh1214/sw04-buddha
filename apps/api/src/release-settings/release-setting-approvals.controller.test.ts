/**
 * 출시 설정 변경의 묶음별 승인 (#331, ADR-0175; owner answers 331-1…331-7) against the docker `test`
 * profile, with the shipped registry: the server splits a change by the item's approval rule into
 * one admin's at once (`applied`) and a `release_setting_change` request another admin approves —
 * writing it in the same transaction — rejects, or its requester retracts (`requested`); one waits
 * per key, it is refused with no other admin to decide it, and its approval is refused once the
 * item changed (`stale`) or its requester is no longer an admin. The rules key by key are
 * @buddha/shared's (release-setting-approvals.test.ts). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { completeOnboarding, setReleaseSetting } from '@buddha/db/test';
import {
  RELEASE_SETTING_CHANGE_APPROVAL_KIND,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeRequest,
  type ReleaseSettingChangeRequestWrite,
  type ReleaseSettingChangeResult,
} from '@buddha/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const BASE = '/api/v1/admin/release-settings';

const START = 'grant.start_coin';
const CAP = 'grant.regrant_total_cap_coin';
const TOP_N = 'market_maker.concentration_top_n';
const ACCEPTING = 'order.accepting';
const REDUCE_AT = 'market_maker.reduce_at_bp';
const HALT_AT = 'market_maker.halt_at_bp';
const RATIO = 'market_maker.reduce_ratio_bp';

type ErrorBody = {
  error: {
    code: string;
    details?: { path: (string | number)[]; message: string }[] | { reason: string };
  };
};
type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('release setting change approvals (integration)', () => {
  let t: TestApp;
  let a: TestUser;
  let b: TestUser;
  let c: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });

  async function makeAdmin(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await completeOnboarding(t.db, { userId: user.id });
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }
  async function revoke(user: TestUser) {
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
  }

  beforeEach(async () => {
    await t.reset();
    a = await makeAdmin();
    b = await makeAdmin();
    c = await makeAdmin();
    member = await signUpTestUser(t);
  });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const patch = (key: string, payload: Record<string, unknown>, who: TestUser = a) =>
    t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${key}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const decide = (
    id: string,
    decision: 'approve' | 'reject' | 'retract',
    who: TestUser,
    reason: string | undefined = '확인했습니다',
  ) =>
    t.app.inject({
      method: 'POST',
      url: `${BASE}/change-requests/${id}/${decision}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: {
        expectedAccountId: who.id,
        ...(decision === 'retract' ? {} : { reason }),
      },
    });
  const get = (url: string, who: TestUser = a) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  async function itemOf(key: string): Promise<ReleaseSetting> {
    return data<ReleaseSetting[]>(await get(BASE)).find((item) => item.key === key)!;
  }
  async function rowOf(key: string) {
    const [row] = await t.db
      .select()
      .from(schema.releaseSettings)
      .where(eq(schema.releaseSettings.key, key));
    return row;
  }
  async function actions(type?: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(type === undefined ? undefined : eq(schema.adminActions.type, type))
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
  }
  async function requestRows() {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.kind, RELEASE_SETTING_CHANGE_APPROVAL_KIND))
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  /** A two-admin change by `who`: answers its request. */
  async function request(key: string, payload: Record<string, unknown>, who: TestUser = a) {
    const res = await patch(key, payload, who);
    expect(res.statusCode, res.body).toBe(200);
    const result = data<ReleaseSettingChangeResult>(res);
    expect(result.outcome).toBe('requested');
    return result.request!;
  }
  function expectNotAllowed(
    res: { statusCode: number; json: <U>() => U; body: string },
    code: string,
    reason: string,
  ) {
    expect(res.statusCode, res.body).toBe(409);
    const error = errorOf(res);
    expect(error.code).toBe(code);
    if (code === 'APPROVAL_NOT_ALLOWED') {
      expect(error.details).toEqual([{ path: ['request'], message: reason }]);
    } else {
      expect(error.details).toEqual({ reason });
    }
  }

  describe('one admin, at once', () => {
    it('applies an observation value, a lowering, closing intake and a status-only move, recording the path', async () => {
      const observed = await patch(TOP_N, { status: 'test', value: 5, reason: '관측 시험' });
      expect(observed.statusCode, observed.body).toBe(200);
      expect(data<ReleaseSettingChangeResult>(observed)).toMatchObject({
        outcome: 'applied',
        setting: { key: TOP_N, status: 'test', value: 5, pendingRequest: null },
        request: null,
      });

      await setReleaseSetting(t.db, { adminId: c.id, key: START, status: 'test', value: 1000 });
      const lowered = await patch(START, { status: 'test', value: 900, reason: '낮추기' });
      expect(data<ReleaseSettingChangeResult>(lowered).outcome).toBe('applied');

      await setReleaseSetting(t.db, { adminId: c.id, key: ACCEPTING, status: 'test', value: true });
      const closed = await patch(ACCEPTING, { status: 'test', value: false, reason: '닫기' });
      expect(data<ReleaseSettingChangeResult>(closed).outcome).toBe('applied');

      await setReleaseSetting(t.db, { adminId: c.id, key: CAP, status: 'approved', value: 500 });
      const down = await patch(CAP, { status: 'test', value: 500, reason: '승인됨에서 내림' });
      expect(data<ReleaseSettingChangeResult>(down).outcome).toBe('applied');

      const records = (await actions('release_setting_change')).filter(
        (row) => row.adminId === a.id,
      );
      expect(records.map((row) => [row.targetId, row.payload])).toEqual([
        [TOP_N, expect.objectContaining({ path: 'one_admin', basis: 'observation' })],
        [START, expect.objectContaining({ path: 'one_admin', basis: 'reduce' })],
        [ACCEPTING, expect.objectContaining({ path: 'one_admin', basis: 'intake_close' })],
        [CAP, expect.objectContaining({ path: 'one_admin', basis: 'status_only' })],
      ]);
      expect(await requestRows()).toEqual([]);
      // The change log tells a one-admin change apart (331-4).
      const log = (await get(`${BASE}/changes?key=${START}`)).json<Page<ReleaseSettingChange>>();
      expect(log.data[0]).toMatchObject({
        path: 'one_admin',
        basis: 'reduce',
        actor: { id: a.id },
        requestedBy: null,
        approvalId: null,
        approvalReason: null,
      });
    });

    it('lets the last admin stop every bot through the risk stages, but not restart them (331-2, I-a)', async () => {
      for (const [key, value] of [
        [REDUCE_AT, 7000],
        [HALT_AT, 9000],
        [RATIO, 3000],
      ] as const) {
        await setReleaseSetting(t.db, { adminId: c.id, key, status: 'test', value });
      }
      await revoke(b);
      await revoke(c);
      // 축소 시작 raised above 중단 시작: invalid, every bot stops — one admin, no decider needed.
      const stop = await patch(REDUCE_AT, { status: 'test', value: 9500, reason: '전체 봇 멈춤' });
      expect(stop.statusCode, stop.body).toBe(200);
      expect(data<ReleaseSettingChangeResult>(stop).outcome).toBe('applied');
      expect((await actions('release_setting_change')).at(-1)?.payload).toMatchObject({
        basis: 'stage_stop',
      });
      // While the bots stand stopped a change stops nothing: the direction rule (331-1). A raise
      // is two admins' — a later restart must not carry one no second admin approved.
      expectNotAllowed(
        await patch(RATIO, { status: 'test', value: 4000, reason: '멈춘 동안 높이기' }),
        'APPROVAL_NOT_ALLOWED',
        'no_decider',
      );
      expect(await rowOf(RATIO)).toMatchObject({ value: 3000 });
      const lower = await patch(RATIO, { status: 'test', value: 2000, reason: '멈춘 동안 낮추기' });
      expect(lower.statusCode, lower.body).toBe(200);
      expect((await actions('release_setting_change')).at(-1)?.payload).toMatchObject({
        basis: 'reduce',
      });
      // Back to a valid combination restarts them: two admins, and none is left to decide.
      expectNotAllowed(
        await patch(REDUCE_AT, { status: 'test', value: 7000, reason: '다시 열기' }),
        'APPROVAL_NOT_ALLOWED',
        'no_decider',
      );
      expect(await requestRows()).toEqual([]);
      expect(await rowOf(REDUCE_AT)).toMatchObject({ value: 9500 });
    });
  });

  describe('two admins', () => {
    it('records a request that changes nothing, then another admin’s approval writes it', async () => {
      const before = await itemOf(START);
      const requested = await patch(START, {
        status: 'test',
        value: 1000,
        reason: '  시작 지급  ',
      });
      expect(requested.statusCode, requested.body).toBe(200);
      const result = data<ReleaseSettingChangeResult>(requested);
      expect(result).toMatchObject({
        outcome: 'requested',
        setting: { key: START, status: 'undecided', value: null },
        request: {
          key: START,
          label: '시작 지급액',
          before: { status: 'undecided', value: null },
          after: { status: 'test', value: 1000 },
          reason: '시작 지급',
          basis: 'enter_value',
          requestedBy: { id: a.id },
          status: 'pending',
          decidedBy: null,
          stale: false,
        },
      });
      expect(result.setting.pendingRequest?.id).toBe(result.request!.id);
      expect(await rowOf(START)).toBeUndefined();
      expect(await itemOf(START)).toMatchObject({
        status: before.status,
        pendingRequest: { id: result.request!.id },
      });
      const [row] = await requestRows();
      expect(row).toMatchObject({
        kind: 'release_setting_change',
        targetType: 'release_setting',
        targetId: START,
        requestedBy: a.id,
        requestReason: '시작 지급',
        status: 'pending',
        payload: {
          key: START,
          before: { status: 'undecided', value: null },
          after: { status: 'test', value: 1000 },
          reason: '시작 지급',
          basis: 'enter_value',
        },
      });
      const [recorded] = await actions('release_setting_change_request');
      expect(recorded).toMatchObject({
        adminId: a.id,
        targetType: 'release_setting',
        targetId: START,
        payload: { approvalId: row!.id, key: START, basis: 'enter_value' },
      });
      expect(recorded!.createdAt.getTime()).toBe(row!.requestedAt.getTime());
      expect(await actions('release_setting_change')).toEqual([]);

      // The requester never decides it.
      expectNotAllowed(await decide(row!.id, 'approve', a), 'APPROVAL_NOT_ALLOWED', 'requester');
      const approved = await decide(row!.id, 'approve', b, '값과 사유를 확인했습니다');
      expect(approved.statusCode, approved.body).toBe(200);
      expect(data<ReleaseSettingChangeRequestWrite>(approved)).toMatchObject({
        request: {
          status: 'approved',
          decidedBy: { id: b.id },
          decisionReason: '값과 사유를 확인했습니다',
        },
        setting: { status: 'test', value: 1000, updatedBy: { id: b.id }, pendingRequest: null },
      });
      // Written by the approver (migration 0020: the record's admin is the row's writer), with the
      // request's reason and its requester (I-e).
      expect(await rowOf(START)).toMatchObject({ status: 'test', value: 1000, updatedBy: b.id });
      const [change] = await actions('release_setting_change');
      expect(change).toMatchObject({
        adminId: b.id,
        payload: {
          key: START,
          before: { status: 'undecided', value: null },
          after: { status: 'test', value: 1000 },
          reason: '시작 지급',
          path: 'two_admin',
          basis: 'enter_value',
          approval: {
            id: row!.id,
            requestedBy: a.id,
            requestedAt: row!.requestedAt.toISOString(),
            decisionReason: '값과 사유를 확인했습니다',
          },
        },
      });
      const log = (await get(`${BASE}/changes?key=${START}`)).json<Page<ReleaseSettingChange>>();
      expect(log.data[0]).toMatchObject({
        path: 'two_admin',
        basis: 'enter_value',
        actor: { id: b.id },
        requestedBy: { id: a.id },
        approvalId: row!.id,
        approvalReason: '값과 사유를 확인했습니다',
      });
      // Decided once.
      expectNotAllowed(await decide(row!.id, 'approve', c), 'APPROVAL_NOT_ALLOWED', 'decided');
      expectNotAllowed(await decide(row!.id, 'reject', c), 'APPROVAL_NOT_ALLOWED', 'decided');
    });

    it('makes every change to 승인됨 two admins’, a lowering included (331-6)', async () => {
      await setReleaseSetting(t.db, { adminId: c.id, key: START, status: 'test', value: 1000 });
      const req = await request(START, { status: 'approved', value: 900, reason: '승인' });
      expect(req.basis).toBe('approved_target');
      const observation = await request(TOP_N, { status: 'approved', value: 5, reason: '승인' });
      expect(observation.basis).toBe('approved_target');
    });

    it('takes one waiting request per key; another key, and a one-admin change, go on', async () => {
      await setReleaseSetting(t.db, { adminId: c.id, key: START, status: 'test', value: 1000 });
      const first = await request(START, { status: 'test', value: 2000, reason: '올리기' });
      // Another admin's two-admin change of the same key waits for that one to be decided.
      expectNotAllowed(
        await patch(START, { status: 'test', value: 3000, reason: '다른 요청' }, b),
        'RELEASE_SETTING_NOT_ALLOWED',
        'request_pending',
      );
      await request(CAP, { status: 'test', value: 500, reason: '다른 항목' });
      // A one-admin change is never blocked (I-d): the request then cannot be approved.
      const lowered = await patch(START, { status: 'test', value: 900, reason: '급히 낮춤' }, b);
      expect(data<ReleaseSettingChangeResult>(lowered).outcome).toBe('applied');
      expect((await itemOf(START)).pendingRequest).toMatchObject({ id: first.id, stale: true });
      expectNotAllowed(
        await decide(first.id, 'approve', c),
        'RELEASE_SETTING_NOT_ALLOWED',
        'stale',
      );
      // Refused in its transaction: the request still waits, the value as it is.
      expect((await requestRows()).find((row) => row.id === first.id)?.status).toBe('pending');
      expect(await rowOf(START)).toMatchObject({ value: 900, updatedBy: b.id });
      // 반려 clears it.
      const rejected = await decide(first.id, 'reject', c, '값이 바뀌었습니다');
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(data<ReleaseSettingChangeRequestWrite>(rejected)).toMatchObject({
        request: { status: 'rejected', stale: false, decidedBy: { id: c.id } },
        setting: { value: 900, pendingRequest: null },
      });
      expect((await actions('release_setting_change_reject')).map((row) => row.payload)).toEqual([
        { approvalId: first.id, key: START, reason: '값이 바뀌었습니다' },
      ]);
      expect(await rowOf(START)).toMatchObject({ value: 900 });
    });

    it('refuses a risk stage’s approval once another stage changed what it would do', async () => {
      for (const [key, value] of [
        [REDUCE_AT, 7000],
        [HALT_AT, 9000],
        [RATIO, 3000],
      ] as const) {
        await setReleaseSetting(t.db, { adminId: c.id, key, status: 'test', value });
      }
      // A raise of 중단 시작 inside a running combination: two admins' `increase`.
      const raise = await request(HALT_AT, { status: 'test', value: 9500, reason: '중단 늦추기' });
      expect(raise).toMatchObject({ basis: 'increase', stale: false });
      // One admin stops every bot by raising 축소 시작 above 중단 시작 (331-2).
      const stop = await patch(
        REDUCE_AT,
        { status: 'test', value: 9200, reason: '전체 봇 멈춤' },
        b,
      );
      expect(data<ReleaseSettingChangeResult>(stop).outcome).toBe('applied');
      // 중단 시작 itself still holds 9000, but approving the raise would now restart every bot
      // with 축소 시작 at 9200, which no second admin approved: stale.
      expect((await itemOf(HALT_AT)).pendingRequest).toMatchObject({ id: raise.id, stale: true });
      const listed = data<ReleaseSettingChangeRequest[]>(
        await get(`${BASE}/change-requests?status=pending`),
      );
      expect(listed.find((item) => item.id === raise.id)).toMatchObject({ stale: true });
      expectNotAllowed(
        await decide(raise.id, 'approve', c),
        'RELEASE_SETTING_NOT_ALLOWED',
        'stale',
      );
      expect(await rowOf(HALT_AT)).toMatchObject({ value: 9000 });
      expect((await requestRows()).find((row) => row.id === raise.id)?.status).toBe('pending');
      // Once the stop is undone the request does what it asked again, and is approved.
      const back = await patch(REDUCE_AT, { status: 'test', value: 7000, reason: '되돌림' }, b);
      expect(data<ReleaseSettingChangeResult>(back).outcome).toBe('requested');
      const backRequest = data<ReleaseSettingChangeResult>(back).request!;
      expect((await decide(backRequest.id, 'approve', c)).statusCode).toBe(200);
      expect((await itemOf(HALT_AT)).pendingRequest).toMatchObject({ id: raise.id, stale: false });
      const approved = await decide(raise.id, 'approve', c);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await rowOf(HALT_AT)).toMatchObject({ value: 9500, updatedBy: c.id });
    });

    it('lets only its requester retract it, and then takes a new one', async () => {
      const req = await request(START, { status: 'test', value: 1000, reason: '시작 지급' });
      expectNotAllowed(await decide(req.id, 'retract', b), 'APPROVAL_NOT_ALLOWED', 'not_requester');
      const retracted = await decide(req.id, 'retract', a);
      expect(retracted.statusCode, retracted.body).toBe(200);
      expect(data<ReleaseSettingChangeRequestWrite>(retracted).request.status).toBe('retracted');
      expect((await actions('release_setting_change_retract')).map((row) => row.payload)).toEqual([
        { approvalId: req.id, key: START },
      ]);
      expectNotAllowed(await decide(req.id, 'approve', b), 'APPROVAL_NOT_ALLOWED', 'retracted');
      await request(START, { status: 'test', value: 1000, reason: '다시 요청' });
      expect(await rowOf(START)).toBeUndefined();
    });

    it('closes a request whose key a release dropped, answering with no item', async () => {
      // A request as an earlier release left it, for a key this one no longer registers
      // (approval_requests keeps what was requested, so it is written so from the start).
      const retired = async () => {
        const [row] = await t.db
          .insert(schema.approvalRequests)
          .values({
            kind: RELEASE_SETTING_CHANGE_APPROVAL_KIND,
            targetType: 'release_setting',
            targetId: 'retired.key',
            payload: {
              key: 'retired.key',
              before: { status: 'undecided', value: null },
              after: { status: 'test', value: 1 },
              reason: '없어진 항목',
              basis: 'enter_value',
            },
            requestedBy: a.id,
            requestReason: '없어진 항목',
            requestedAt: new Date(),
          })
          .returning();
        return row!;
      };
      const first = await retired();
      // Its approval has nothing to write: NOT_FOUND, and it still waits.
      const approve = await decide(first.id, 'approve', b);
      expect(approve.statusCode, approve.body).toBe(404);
      expect((await requestRows()).find((row) => row.id === first.id)?.status).toBe('pending');
      // 반려 commits and says so — the item is gone, not the request.
      const rejected = await decide(first.id, 'reject', b, '항목이 없어졌습니다');
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(data<ReleaseSettingChangeRequestWrite>(rejected)).toMatchObject({
        request: { id: first.id, key: 'retired.key', label: null, status: 'rejected' },
        setting: null,
      });
      const second = await retired();
      const retracted = await decide(second.id, 'retract', a);
      expect(retracted.statusCode, retracted.body).toBe(200);
      expect(data<ReleaseSettingChangeRequestWrite>(retracted)).toMatchObject({
        request: { id: second.id, status: 'retracted' },
        setting: null,
      });
    });

    it('refuses a request no other admin could decide, writing nothing', async () => {
      await revoke(b);
      await revoke(c);
      expectNotAllowed(
        await patch(START, { status: 'test', value: 1000, reason: '혼자' }),
        'APPROVAL_NOT_ALLOWED',
        'no_decider',
      );
      expect(await requestRows()).toEqual([]);
      expect(await actions()).toEqual([]);
    });

    it('refuses the approval once its requester is no longer an admin; a 반려 still closes it', async () => {
      const req = await request(START, { status: 'test', value: 1000, reason: '시작 지급' });
      await revoke(a);
      expectNotAllowed(
        await decide(req.id, 'approve', b),
        'RELEASE_SETTING_NOT_ALLOWED',
        'requester_ineligible',
      );
      expect(await rowOf(START)).toBeUndefined();
      expect((await decide(req.id, 'reject', b)).statusCode).toBe(200);
    });

    it('answers another kind’s request as not found', async () => {
      const [other] = await t.db
        .insert(schema.approvalRequests)
        .values({
          kind: 'market_cancel',
          targetType: 'market',
          targetId: 'x',
          requestedBy: a.id,
          requestReason: '다른 종류',
          requestedAt: new Date(),
        })
        .returning();
      for (const decision of ['approve', 'reject', 'retract'] as const) {
        const res = await decide(other!.id, decision, decision === 'retract' ? a : b);
        expect(res.statusCode, decision).toBe(404);
      }
    });

    it('serialises two requests of one key: one waits, the other is refused', async () => {
      const answers = await Promise.all([
        patch(START, { status: 'test', value: 1000, reason: 'A' }, a),
        patch(START, { status: 'test', value: 2000, reason: 'B' }, b),
      ]);
      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      expect(await requestRows()).toHaveLength(1);
    });
  });

  it('lists the requests newest first, by status and key, a page at a time', async () => {
    const first = await request(START, { status: 'test', value: 1000, reason: '첫째' });
    const second = await request(CAP, { status: 'test', value: 500, reason: '둘째' });
    expect((await decide(first.id, 'approve', b)).statusCode).toBe(200);
    const third = await request(TOP_N, { status: 'approved', value: 5, reason: '셋째' });

    const all = (await get(`${BASE}/change-requests`)).json<Page<ReleaseSettingChangeRequest>>();
    expect(all.data.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
    const pending = (await get(`${BASE}/change-requests?status=pending`)).json<
      Page<ReleaseSettingChangeRequest>
    >();
    expect(pending.data.map((row) => row.id)).toEqual([third.id, second.id]);
    const byKey = (await get(`${BASE}/change-requests?key=${START}`)).json<
      Page<ReleaseSettingChangeRequest>
    >();
    expect(byKey.data).toMatchObject([
      { id: first.id, status: 'approved', decidedBy: { id: b.id } },
    ]);
    const page1 = (await get(`${BASE}/change-requests?limit=2`)).json<
      Page<ReleaseSettingChangeRequest>
    >();
    expect(page1.data.map((row) => row.id)).toEqual([third.id, second.id]);
    const page2 = (
      await get(
        `${BASE}/change-requests?limit=2&cursor=${encodeURIComponent(page1.meta.nextCursor!)}`,
      )
    ).json<Page<ReleaseSettingChangeRequest>>();
    expect(page2.data.map((row) => row.id)).toEqual([first.id]);
    expect(page2.meta.nextCursor).toBeNull();
    expect((await get(`${BASE}/change-requests?status=final`)).statusCode).toBe(400);
  });

  it('is closed to members and anonymous callers, and to a body naming another admin', async () => {
    const req = await request(START, { status: 'test', value: 1000, reason: '시작 지급' });
    for (const [method, url, payload] of [
      ['GET', `${BASE}/change-requests`, undefined],
      ['POST', `${BASE}/change-requests/${req.id}/approve`, { reason: '확인' }],
      ['POST', `${BASE}/change-requests/${req.id}/reject`, { reason: '확인' }],
      ['POST', `${BASE}/change-requests/${req.id}/retract`, {}],
    ] as const) {
      const asMember = await t.app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie: member.cookie },
        payload: payload && { ...payload, expectedAccountId: member.id },
      });
      expect({ url, status: asMember.statusCode }).toEqual({ url, status: 403 });
      const anonymous = await t.app.inject({ method, url, headers: jsonHeaders, payload });
      expect({ url, status: anonymous.statusCode }).toEqual({ url, status: 401 });
    }
    for (const decision of ['approve', 'reject', 'retract'] as const) {
      const refused = await t.app.inject({
        method: 'POST',
        url: `${BASE}/change-requests/${req.id}/${decision}`,
        headers: { ...jsonHeaders, cookie: b.cookie },
        payload: { reason: '확인', expectedAccountId: c.id },
      });
      expect(refused.statusCode, decision).toBe(403);
      expect(errorOf(refused).details).toEqual([
        expect.objectContaining({ path: ['expectedAccountId'] }),
      ]);
    }
    const [row] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(eq(schema.approvalRequests.id, req.id), eq(schema.approvalRequests.status, 'pending')),
      );
    expect(row).toBeDefined();
  });
});
