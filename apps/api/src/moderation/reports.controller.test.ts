/**
 * 신고 접수 (#50, ADR-0081; ADR-0069 decision 2 #45-10, #45-13, #45-15, decision 3 #37-10, decision
 * 7) against the docker `test` profile: a member reports a 근거 글, a 댓글 or 대댓글 and a profile, and
 * reads their own reports and results on MY. Pinned: only an account that finished the onboarding
 * reports, and never its own; one reason, '기타' with a description; a placeholder (deleted,
 * hidden) takes none and a gone item is NOT_FOUND; the same person — the account, or the number of
 * an account that withdrew — has one pending report per target and may report again once it was
 * processed, and an operator's change of the number takes the pending and recent reports with it
 * (owner decision 2026-10-21); at most 20 a person in the last 24 hours, none for an operator, the
 * person's reports counted one after the other; a report waits for a hiding or a deletion in
 * flight and never lands on it; no count of reports hides anything; the answer and the list carry
 * the target as the public sees it and the result, never the member reported's account nor
 * anyone's report but the caller's. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  changePhoneAsOperator,
  completeOnboarding,
  createComment,
  createMarket,
  createPhoneVerification,
  createPost,
  createReport,
  createUser,
} from '@buddha/db/test';
import {
  REPORTS_PER_DAY,
  myReportSchema,
  postSchema,
  reportLimitedDetailsSchema,
  type MyReport,
  type ReportReason,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const UNKNOWN = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

const HOUR_MS = 60 * 60 * 1_000;

describe.skipIf(!hasTestInfra)('/api/v1 reports (integration)', () => {
  let t: TestApp;
  let author: TestUser;
  let reporter: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;
  let post: Awaited<ReturnType<typeof createPost>>;
  let comment: Awaited<ReturnType<typeof createComment>>;
  let reply: Awaited<ReturnType<typeof createComment>>;
  let authorPublicId: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    author = await signUpTestUser(t);
    reporter = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: author.id });
    await completeOnboarding(t.db, { userId: reporter.id });
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      title: '근거 글',
      text: '첫 줄\n둘째 줄',
    });
    comment = await createComment(t.db, { postId: post.id, authorId: author.id, body: '댓글' });
    reply = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      parentId: comment.id,
      body: '대댓글',
    });
    authorPublicId = (await profileOf(author.id)).publicId;
  });

  const profileOf = async (userId: string) => {
    const [row] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!;
  };

  const send = (url: string, payload: unknown, who: TestUser | null) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify(payload),
    });
  const report = (
    path: string,
    who: TestUser | null = reporter,
    body: { reason?: ReportReason; description?: string | null } = {},
  ) =>
    send(
      `${path}/reports`,
      {
        reason: body.reason ?? 'spam',
        description: body.description,
        expectedAccountId: who?.id ?? 'x',
      },
      who,
    );
  const reported = (res: { statusCode: number; body: string; json: <T>() => T }): MyReport => {
    expect(res.statusCode, res.body).toBe(201);
    return myReportSchema.parse(res.json<{ data: unknown }>().data);
  };
  const errorOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; details?: unknown } }>().error;
  const myReports = async (who: TestUser = reporter): Promise<MyReport[]> => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/reports',
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: unknown[] }>().data.map((item) => myReportSchema.parse(item));
  };
  const rows = () => t.db.select().from(schema.reports);
  const hashOf = async (userId: string) => {
    const [row] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, userId));
    return t.app.get(PhoneHasher).hash(row!.phone);
  };

  it('takes a report on a post, a 댓글, a 대댓글 and a profile, and answers it as the reporter’s list does', async () => {
    const onPost = reported(await report(`/posts/${post.id}`));
    expect(onPost).toMatchObject({
      target: { type: 'post', post: { state: 'published', id: post.id, title: '근거 글' } },
      reason: 'spam',
      description: null,
      status: 'pending',
      resolvedAt: null,
    });
    const onComment = reported(
      await report(`/comments/${comment.id}`, reporter, { reason: 'harassment' }),
    );
    expect(onComment.target).toEqual({
      type: 'comment',
      postId: post.id,
      comment: { state: 'published', id: comment.id, excerpt: '댓글' },
    });
    const onReply = reported(
      await report(`/comments/${reply.id}`, reporter, {
        reason: 'other',
        description: '  권리 침해 아님, 그 밖의 이유\r\n둘째 줄 ',
      }),
    );
    expect(onReply.description).toBe('권리 침해 아님, 그 밖의 이유\n둘째 줄');
    // The public id in any case, as the profile reads it.
    const onProfile = reported(
      await report(`/profiles/${authorPublicId.toUpperCase()}`, reporter, {
        reason: 'impersonation',
      }),
    );
    expect(onProfile.target).toMatchObject({
      type: 'profile',
      member: { kind: 'member', publicId: authorPublicId },
    });
    // Stored with the reporter's number's hash and the member reported, intake time from the
    // database's clock (N05 §8).
    const stored = await rows();
    expect(stored).toHaveLength(4);
    const hash = await hashOf(reporter.id);
    for (const row of stored) {
      expect(row).toMatchObject({
        reporterId: reporter.id,
        reporterPhoneHash: hash,
        reportedUserId: author.id,
        status: 'pending',
      });
    }
    // The list: newest first, the same items. Nothing names the account reported or the reporter.
    const list = await myReports();
    expect(list.map((item) => item.id)).toEqual(
      [onProfile, onReply, onComment, onPost].map((r) => r.id),
    );
    const body = JSON.stringify(list);
    expect(body).not.toContain(author.id);
    expect(body).not.toContain(reporter.id);
    // The author reads none of them.
    expect(await myReports(author)).toEqual([]);
  });

  it('opens to an account that finished the onboarding, naming the account on screen', async () => {
    expect((await report(`/posts/${post.id}`, null)).statusCode).toBe(401);
    const fresh = await signUpTestUser(t);
    const notYet = await report(`/posts/${post.id}`, fresh);
    expect(notYet.statusCode).toBe(409);
    expect(errorOf(notYet).code).toBe('ONBOARDING_REQUIRED');
    const other = await send(
      `/posts/${post.id}/reports`,
      { reason: 'spam', expectedAccountId: author.id },
      reporter,
    );
    expect(other.statusCode).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it('takes one reason of the eight, and a description with 기타 (#45-10)', async () => {
    const other = await report(`/posts/${post.id}`, reporter, { reason: 'other' });
    expect(other.statusCode).toBe(400);
    expect(errorOf(other).details).toEqual([expect.objectContaining({ path: ['description'] })]);
    const forecast = await send(
      `/posts/${post.id}/reports`,
      { reason: 'wrong_forecast', expectedAccountId: reporter.id },
      reporter,
    );
    expect(forecast.statusCode).toBe(400);
    const long = await report(`/posts/${post.id}`, reporter, {
      reason: 'spam',
      description: 'x'.repeat(501),
    });
    expect(long.statusCode).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('refuses one’s own post, comment and profile', async () => {
    for (const path of [
      `/posts/${post.id}`,
      `/comments/${comment.id}`,
      `/comments/${reply.id}`,
      `/profiles/${authorPublicId}`,
    ]) {
      const res = await report(path, author);
      expect({ path, status: res.statusCode, error: errorOf(res) }).toMatchObject({
        path,
        status: 409,
        error: { code: 'REPORT_NOT_ALLOWED', details: { reason: 'own' } },
      });
    }
    expect(await rows()).toEqual([]);
  });

  it('refuses a placeholder and answers a gone or unknown target NOT_FOUND', async () => {
    const hidden = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      hiddenAt: new Date(),
    });
    const deleted = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    await createComment(t.db, { postId: deleted.id, authorId: reporter.id });
    const gone = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    const hiddenComment = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      hiddenAt: new Date(),
    });
    const deletedThread = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    await createComment(t.db, {
      postId: post.id,
      authorId: reporter.id,
      parentId: deletedThread.id,
    });
    const goneReply = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      parentId: comment.id,
      deletedAt: new Date(),
    });
    for (const [path, expected] of [
      [`/posts/${hidden.id}`, { status: 409, reason: 'hidden' }],
      [`/posts/${deleted.id}`, { status: 409, reason: 'deleted' }],
      [`/comments/${hiddenComment.id}`, { status: 409, reason: 'hidden' }],
      [`/comments/${deletedThread.id}`, { status: 409, reason: 'deleted' }],
      [`/posts/${gone.id}`, { status: 404, reason: undefined }],
      [`/comments/${goneReply.id}`, { status: 404, reason: undefined }],
      [`/posts/${UNKNOWN}`, { status: 404, reason: undefined }],
      [`/comments/${UNKNOWN}`, { status: 404, reason: undefined }],
      ['/profiles/zzzzzzzzzz', { status: 404, reason: undefined }],
      ['/profiles/not-an-id', { status: 404, reason: undefined }],
    ] as const) {
      const res = await report(path);
      const error = errorOf(res) as { details?: { reason?: string } };
      expect({ path, status: res.statusCode, reason: error.details?.reason }).toEqual({
        path,
        ...expected,
      });
    }
    // A post of an ended market takes reports, as its likes do.
    const closed = await createMarket(t.db, { status: 'settled' });
    const old = await createPost(t.db, { marketId: closed.id, authorId: author.id });
    reported(await report(`/posts/${old.id}`));
  });

  it('holds one pending report per person and target, and takes another once it was processed (decision 7)', async () => {
    const first = reported(await report(`/posts/${post.id}`));
    const again = await report(`/posts/${post.id}`, reporter, { reason: 'harassment' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({ details: { reason: 'duplicate' } });
    // Another target, or another person, is another report.
    reported(await report(`/comments/${comment.id}`));
    reported(await report(`/posts/${post.id}`, await onboarded()));
    // Processed — here dismissed by an operator — the same person reports it again.
    const admin = await createUser(t.db, { role: 'admin' });
    await t.db
      .update(schema.reports)
      .set({
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedBy: admin.user.id,
        dismissalReason: '위반 아님',
      })
      .where(eq(schema.reports.id, first.id));
    const second = reported(await report(`/posts/${post.id}`, reporter, { reason: 'harassment' }));
    expect(second.id).not.toBe(first.id);
    expect(
      (await myReports()).filter((item) => item.target.type === 'post').map((item) => item.status),
    ).toEqual(['pending', 'dismissed']);
  });

  it('holds the same number as the same person after a withdrawal (decision 7)', async () => {
    reported(await report(`/posts/${post.id}`));
    // #140's withdrawal deletes the 본인확인 record and keeps the reports; a new account then
    // verifies the same number.
    const [record] = await t.db
      .select()
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, reporter.id));
    await t.db
      .delete(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, reporter.id));
    const again = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: again.id, phone: record!.phone });
    await completeOnboarding(t.db, { userId: again.id });
    const res = await report(`/posts/${post.id}`, again);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({ details: { reason: 'duplicate' } });
    // Its own list is its own account's: the withdrawn account's report is not there.
    expect(await myReports(again)).toEqual([]);
  });

  it('takes 20 reports in the last 24 hours per person, counting a withdrawn account’s, none for an operator (#45-15)', async () => {
    const hash = await hashOf(reporter.id);
    const now = Date.now();
    // 19 of the window — a withdrawn account's on the same number among them — and one past it.
    const withdrawn = await createUser(t.db);
    const targets = await Promise.all(
      Array.from({ length: REPORTS_PER_DAY + 1 }, () =>
        createPost(t.db, { marketId: market.id, authorId: author.id }),
      ),
    );
    for (let i = 0; i < REPORTS_PER_DAY - 1; i += 1) {
      await createReport(t.db, {
        reporterId: i === 0 ? withdrawn.user.id : reporter.id,
        reporterPhoneHash: hash,
        reportedUserId: author.id,
        postId: targets[i]!.id,
        createdAt: new Date(now - (i + 1) * HOUR_MS),
      });
    }
    // A report on the profile 25 hours ago: out of the window.
    await createReport(t.db, {
      reporterId: reporter.id,
      reporterPhoneHash: hash,
      reportedUserId: author.id,
      createdAt: new Date(now - 25 * HOUR_MS),
    });
    // The 20th passes.
    reported(await report(`/posts/${post.id}`));
    // The 21st is refused until the oldest of the 20 in the window — 19 hours old — leaves it: in
    // 5 hours, rounded up to the minute.
    const limited = await report(`/comments/${comment.id}`);
    expect(limited.statusCode).toBe(429);
    const error = errorOf(limited);
    expect(error.code).toBe('REPORT_LIMITED');
    const details = reportLimitedDetailsSchema.parse(error.details);
    expect(details.limit).toBe(REPORTS_PER_DAY);
    expect(details.retryAfterSeconds % 60).toBe(0);
    expect(details.retryAfterSeconds).toBeGreaterThan(4 * 3_600);
    expect(details.retryAfterSeconds).toBeLessThanOrEqual(5 * 3_600);
    // Nothing was written by the refusal.
    expect(await rows()).toHaveLength(REPORTS_PER_DAY + 1);
    // Another person is not limited; nor is an operator, whatever they filed.
    reported(await report(`/comments/${comment.id}`, await onboarded()));
    const admin = await onboarded();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    const adminHash = await hashOf(admin.id);
    for (let i = 0; i < REPORTS_PER_DAY; i += 1) {
      await createReport(t.db, {
        reporterId: admin.id,
        reporterPhoneHash: adminHash,
        reportedUserId: author.id,
        postId: targets[i]!.id,
      });
    }
    reported(await report(`/comments/${comment.id}`, admin));
  });

  it('takes the person’s reports to the new number when an operator changes it, so a later account there is the same person (owner decision 2026-10-21)', async () => {
    reported(await report(`/posts/${post.id}`));
    const oldHash = await hashOf(reporter.id);
    const [record] = await t.db
      .select()
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, reporter.id));
    // The rest of a full day's count, under the old number.
    const targets = await Promise.all(
      Array.from({ length: REPORTS_PER_DAY - 1 }, () =>
        createPost(t.db, { marketId: market.id, authorId: author.id }),
      ),
    );
    for (const target of targets) {
      await createReport(t.db, {
        reporterId: reporter.id,
        reporterPhoneHash: oldHash,
        reportedUserId: author.id,
        postId: target.id,
      });
    }
    const newPhone = '01077778888';
    const newHash = t.app.get(PhoneHasher).hash(newPhone);
    // The doc's SQL as the operator runs it (docs/OPERATIONS.md): the hash moves, nothing else.
    const before = await rows();
    await changePhoneAsOperator(t.db, {
      userId: reporter.id,
      phone: newPhone,
      hash: (digits) => t.app.get(PhoneHasher).hash(digits),
    });
    expect(await rows()).toEqual(
      expect.arrayContaining(before.map((row) => ({ ...row, reporterPhoneHash: newHash }))),
    );
    // The account keeps both rules, whatever number it holds now.
    const again = await report(`/posts/${post.id}`);
    expect(errorOf(again)).toMatchObject({ details: { reason: 'duplicate' } });
    expect((await report(`/comments/${reply.id}`)).statusCode).toBe(429);
    // Another account verifies the old number: none of it is theirs — that account is another
    // person.
    const next = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: next.id, phone: record!.phone });
    await completeOnboarding(t.db, { userId: next.id });
    expect(await hashOf(next.id)).toBe(oldHash);
    reported(await report(`/posts/${post.id}`, next));
    reported(await report(`/comments/${comment.id}`, next));
    // The account withdraws (#140 deletes the 본인확인 record and keeps the reports) and comes back
    // on the new number: the same person — its pending report and its count follow it there.
    await t.db
      .delete(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, reporter.id));
    const back = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: back.id, phone: newPhone });
    await completeOnboarding(t.db, { userId: back.id });
    const duplicate = await report(`/posts/${post.id}`, back);
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate)).toMatchObject({ details: { reason: 'duplicate' } });
    const limited = await report(`/comments/${reply.id}`, back);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('REPORT_LIMITED');
  });

  // ---- reports that meet another write in flight ------------------------------------------------

  /**
   * Runs `whileHeld` while another connection holds what `statements` take in an open transaction
   * — the same person's other report, an operator's hiding, the author's deletion — and commits it
   * once the request waits on it.
   */
  async function whileLocked<T>(
    statements: [string, unknown[]][],
    whileHeld: () => Promise<T>,
  ): Promise<T> {
    const holder = await t.db.$client.connect();
    let pending: Promise<T> | undefined;
    let committed = false;
    try {
      await holder.query('BEGIN');
      for (const [text, values] of statements) await holder.query(text, values);
      pending = whileHeld();
      await waitForLockWaiter(holder, 'the report on what another transaction holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  it('counts one person’s reports one after the other: a report waits for their report in flight (#45-15)', async () => {
    const hash = await hashOf(reporter.id);
    const targets = await Promise.all(
      Array.from({ length: REPORTS_PER_DAY }, () =>
        createPost(t.db, { marketId: market.id, authorId: author.id }),
      ),
    );
    for (const target of targets.slice(1)) {
      await createReport(t.db, {
        reporterId: reporter.id,
        reporterPhoneHash: hash,
        reportedUserId: author.id,
        postId: target.id,
      });
    }
    // The 20th, from another tab: under the number's lock, written and not yet committed. The
    // report waits for it, then counts it — never both counting 19.
    const res = await whileLocked(
      [
        ["SELECT pg_advisory_xact_lock(hashtext('buddha:reports'), hashtext($1))", [hash]],
        [
          'INSERT INTO reports (target_type, post_id, reported_user_id, reporter_id, reporter_phone_hash, reason) VALUES ($1, $2, $3, $4, $5, $6)',
          ['post', targets[0]!.id, author.id, reporter.id, hash, 'spam'],
        ],
      ],
      () => report(`/comments/${comment.id}`),
    );
    expect(res.statusCode, res.body).toBe(429);
    expect(errorOf(res).code).toBe('REPORT_LIMITED');
    expect(await rows()).toHaveLength(REPORTS_PER_DAY);
  });

  it('waits for a hiding or a deletion in flight and is refused after it, never landing on it', async () => {
    const onPost = await whileLocked(
      [['UPDATE posts SET hidden_at = now() WHERE id = $1', [post.id]]],
      () => report(`/posts/${post.id}`),
    );
    expect(onPost.statusCode, onPost.body).toBe(409);
    expect(errorOf(onPost).details).toEqual({ reason: 'hidden' });
    const onComment = await whileLocked(
      [['UPDATE post_comments SET hidden_at = now() WHERE id = $1', [comment.id]]],
      () => report(`/comments/${comment.id}`),
    );
    expect(onComment.statusCode, onComment.body).toBe(409);
    expect(errorOf(onComment).details).toEqual({ reason: 'hidden' });
    // A 대댓글 deleted: gone from every view, as if it never was.
    const onReply = await whileLocked(
      [['UPDATE post_comments SET deleted_at = now() WHERE id = $1', [reply.id]]],
      () => report(`/comments/${reply.id}`),
    );
    expect(onReply.statusCode, onReply.body).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('hides nothing and changes nothing the public reads, however many report it (#45-10)', async () => {
    const before = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    for (let i = 0; i < 5; i += 1) reported(await report(`/posts/${post.id}`, await onboarded()));
    const after = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(postSchema.parse(after.json<{ data: unknown }>().data)).toEqual(
      postSchema.parse(before.json<{ data: unknown }>().data),
    );
    const [row] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(row?.hiddenAt).toBeNull();
    // The public answers carry no word of a report.
    expect(after.body).not.toMatch(/report/i);
  });

  it('shows the reporter a placeholder by its id once the target is hidden or deleted', async () => {
    reported(await report(`/posts/${post.id}`));
    reported(await report(`/comments/${reply.id}`));
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    await t.db
      .update(schema.postComments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.postComments.id, reply.id));
    const [onReply, onPost] = await myReports();
    expect(onPost!.target).toEqual({ type: 'post', post: { state: 'hidden', id: post.id } });
    expect(onReply!.target).toEqual({
      type: 'comment',
      postId: post.id,
      comment: { state: 'deleted', id: reply.id },
    });
  });

  /** A new account past the onboarding. */
  async function onboarded(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  }
});
