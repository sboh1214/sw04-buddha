/**
 * The two-person rule (#171) against the docker `test` profile, with a test kind. The requester's
 * own decision is refused, another admin's is taken, a decider who is not an admin now is refused,
 * a request is decided once, and the requester, the decider, both instants and both reasons are
 * kept — the decision strictly after the request, even when the clock steps back in between. A
 * retraction (a consumer's choice, #139) is the requester's alone, of a pending request, and
 * closes it to every decision. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { type Db, schema } from '@buddha/db';
import { createUser } from '@buddha/db/test';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import type * as Clock from '../infra/db/clock.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ApprovalService } from './approval.service.js';

const KIND = 'test_kind';

/**
 * The database clock as the services read it (`clockTimestamp`), moved by `clock.shiftMs`: a
 * negative shift between a request and its decision is a clock that stepped back in between.
 */
const clock = vi.hoisted(() => ({ shiftMs: 0 }));
vi.mock('../infra/db/clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Clock>();
  return {
    ...actual,
    clockTimestamp: async (tx: Clock.StatementExecutor) =>
      new Date((await actual.clockTimestamp(tx)).getTime() + clock.shiftMs),
  };
});

describe.skipIf(!hasTestInfra)('ApprovalService (integration)', () => {
  let t: TestApp;
  let approvals: ApprovalService;
  let requester: string;
  let other: string;
  let third: string;
  let member: string;

  beforeAll(async () => {
    t = await createTestApp();
    approvals = t.app.get(ApprovalService);
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    requester = (await createUser(t.db, { role: 'admin' })).user.id;
    other = (await createUser(t.db, { role: 'admin' })).user.id;
    third = (await createUser(t.db, { role: 'admin' })).user.id;
    member = (await createUser(t.db)).user.id;
  });
  afterEach(() => {
    clock.shiftMs = 0;
  });

  const open = (by = requester) =>
    approvals.request({
      kind: KIND,
      targetType: 'market',
      targetId: randomUUID(),
      payload: { note: '시험' },
      requestedBy: by,
      reason: '  요청 사유  ',
    });

  /** The AppError a call rejects with: its code and first detail. */
  async function refusal(call: Promise<unknown>) {
    const error: unknown = await call.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
    const details = error.details as { message: string }[] | undefined;
    return { code: error.code, detail: details?.[0]?.message };
  }

  async function rows() {
    return t.db.select().from(schema.approvalRequests);
  }

  it('records a request as pending, with its requester, reason and instant', async () => {
    const request = await open();
    expect(request).toMatchObject({
      kind: KIND,
      targetType: 'market',
      payload: { note: '시험' },
      requestedBy: requester,
      requestReason: '요청 사유',
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
    });
    expect(request.requestedAt).toBeInstanceOf(Date);
    expect(await rows()).toEqual([request]);
  });

  it('refuses the requester its own decision, approve and reject alike, writing nothing', async () => {
    const request = await open();
    for (const decide of ['approve', 'reject'] as const) {
      expect(await refusal(approvals[decide](requester, request.id, '내가 승인'))).toEqual({
        code: 'APPROVAL_NOT_ALLOWED',
        detail: 'requester',
      });
    }
    expect(await rows()).toEqual([request]);
  });

  it("takes another admin's approval and keeps requester, decider, instants and reasons", async () => {
    const request = await open();
    const decided = await approvals.approve(other, request.id, ' 확인했다 ');
    expect(decided).toMatchObject({
      id: request.id,
      requestedBy: requester,
      requestReason: '요청 사유',
      requestedAt: request.requestedAt,
      status: 'approved',
      decidedBy: other,
      decisionReason: '확인했다',
    });
    expect(decided.decidedAt!.getTime()).toBeGreaterThan(request.requestedAt.getTime());
    expect(await approvals.get(request.id)).toEqual(decided);
  });

  it('decides strictly after the request even when the clock steps back, approve and reject alike', async () => {
    // The clock reads a minute earlier at the decision than at the request: the decision is
    // recorded 1 ms after the request rather than before it, so the chronology holds.
    for (const decide of ['approve', 'reject'] as const) {
      clock.shiftMs = 0;
      const request = await open();
      clock.shiftMs = -60_000;
      const decided = await approvals[decide](other, request.id, '시계가 거꾸로');
      expect(decided.decidedAt!.getTime()).toBe(request.requestedAt.getTime() + 1);
      expect(await approvals.get(request.id)).toEqual(decided);
    }
  });

  it("takes another admin's rejection the same way", async () => {
    const request = await open();
    const decided = await approvals.reject(other, request.id, '근거 부족');
    expect(decided).toMatchObject({
      status: 'rejected',
      decidedBy: other,
      decisionReason: '근거 부족',
    });
  });

  it('refuses a decider who is not an admin now', async () => {
    const request = await open();
    expect(await refusal(approvals.approve(member, request.id, '회원'))).toEqual({
      code: 'FORBIDDEN',
      detail: undefined,
    });
    // An admin revoked since: the role is read at the decision, not cached.
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, other));
    expect(await refusal(approvals.reject(other, request.id, '회수된 관리자'))).toEqual({
      code: 'FORBIDDEN',
      detail: undefined,
    });
    expect(await rows()).toEqual([request]);
  });

  it('decides a request once: a second decision is refused, whoever makes it', async () => {
    const request = await open();
    const decided = await approvals.approve(other, request.id, '첫 결정');
    for (const [decider, decide] of [
      [third, 'reject'],
      [other, 'approve'],
    ] as const) {
      expect(await refusal(approvals[decide](decider, request.id, '둘째 결정'))).toEqual({
        code: 'APPROVAL_NOT_ALLOWED',
        detail: 'decided',
      });
    }
    expect(await rows()).toEqual([decided]);
  });

  it('takes exactly one of two decisions made at once', async () => {
    const request = await open();
    const outcomes = await Promise.allSettled([
      approvals.approve(other, request.id, '동시 1'),
      approvals.reject(third, request.id, '동시 2'),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(failed && (failed.reason as AppError).code).toBe('APPROVAL_NOT_ALLOWED');
    const [row] = await rows();
    expect(row!.status).not.toBe('pending');
  });

  it('requires a reason, refuses an unknown request and a malformed kind', async () => {
    expect(
      await refusal(approvals.request({ kind: KIND, requestedBy: requester, reason: '  ' })),
    ).toMatchObject({ code: 'VALIDATION_ERROR' });
    const request = await open();
    expect(await refusal(approvals.approve(other, request.id, ''))).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await refusal(approvals.approve(other, randomUUID(), '없음'))).toEqual({
      code: 'NOT_FOUND',
      detail: undefined,
    });
    await expect(
      approvals.request({ kind: 'Market Open', requestedBy: requester, reason: '시험' }),
    ).rejects.toThrow(/approval kind/);
    expect(await rows()).toEqual([request]);
  });

  it('takes a retraction by the requester alone, of a pending request, closing it to every decision (#139)', async () => {
    const request = await open();
    // Anyone else, admin or not, is refused; nothing is written.
    expect(await refusal(approvals.retract(other, request.id))).toEqual({
      code: 'APPROVAL_NOT_ALLOWED',
      detail: 'not_requester',
    });
    expect(await refusal(approvals.retract(member, request.id))).toEqual({
      code: 'FORBIDDEN',
      detail: undefined,
    });
    expect(await rows()).toEqual([request]);
    // The requester, strictly after the request even when the clock steps back.
    clock.shiftMs = -60_000;
    const retracted = await approvals.retract(requester, request.id);
    expect(retracted).toMatchObject({
      status: 'retracted',
      requestedBy: requester,
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
    });
    expect(retracted.retractedAt!.getTime()).toBe(request.requestedAt.getTime() + 1);
    // Closed: no decision, no second retraction.
    for (const decide of ['approve', 'reject'] as const) {
      expect(await refusal(approvals[decide](other, request.id, '늦은 결정'))).toEqual({
        code: 'APPROVAL_NOT_ALLOWED',
        detail: 'retracted',
      });
    }
    expect(await refusal(approvals.retract(requester, request.id))).toEqual({
      code: 'APPROVAL_NOT_ALLOWED',
      detail: 'retracted',
    });
    expect(await rows()).toEqual([retracted]);
    // A decided request is not retracted; a requester revoked since retracts nothing.
    clock.shiftMs = 0;
    const decided = await approvals.approve(other, (await open()).id, '승인');
    expect(await refusal(approvals.retract(requester, decided.id))).toEqual({
      code: 'APPROVAL_NOT_ALLOWED',
      detail: 'decided',
    });
    const pending = await open();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, requester));
    expect(await refusal(approvals.retract(requester, pending.id))).toEqual({
      code: 'FORBIDDEN',
      detail: undefined,
    });
    expect(await approvals.get(pending.id)).toEqual(pending);
  });

  it('takes exactly one of a retraction and a decision made at once', async () => {
    const request = await open();
    const outcomes = await Promise.allSettled([
      approvals.retract(requester, request.id),
      approvals.approve(other, request.id, '동시 결정'),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(failed && (failed.reason as AppError).code).toBe('APPROVAL_NOT_ALLOWED');
    const [row] = await rows();
    expect(['retracted', 'approved']).toContain(row!.status);
  });

  it("decides inside the consumer's transaction: rolled back with it", async () => {
    const request = await open();
    const db: Db = t.db;
    await expect(
      db.transaction(async (tx) => {
        await approvals.approve(other, request.id, '함께 되돌린다', tx);
        throw new Error('the approved work failed');
      }),
    ).rejects.toThrow('the approved work failed');
    expect(await rows()).toEqual([request]);
    // And committed with it.
    await db.transaction(async (tx) => {
      await approvals.approve(other, request.id, '함께 남는다', tx);
    });
    expect(await approvals.get(request.id)).toMatchObject({ status: 'approved', decidedBy: other });
  });
});
