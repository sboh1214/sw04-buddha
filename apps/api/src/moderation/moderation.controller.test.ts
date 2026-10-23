/**
 * 운영 처리 (#50, ADR-0081; ADR-0069 decision 2 #45-5, #45-11…#45-14, decision 3 #37-10, decision 4
 * #50 rows) against the docker `test` profile: the operators' report queue, moderation pages and
 * actions, and what the members read of them. Pinned: a hiding takes a post or a comment out of
 * every public view at once and resolves the pending reports on it (the reporters read 조치함), its
 * author reads the reason on MY 내 글 and on the record of actions — never the operator, a report or
 * a reporter — and a cancellation shows it again; a dismissal changes nothing the public reads and
 * the reporters read 기각; a warning is a record and a notice; the nickname goes back to an auto
 * nickname (held from the others, kept for operators), the 소개 is emptied and the image removed and
 * kept for operators only; an operator never acts on themselves, another does; every action,
 * cancellation and dismissal is recorded with its reason, operator and time; every admin reads the
 * queue, the pages and every report with its reporter. Two operators at once: one hiding of an item
 * stands, and an action takes the reports it resolves in the order a dismissal does (no deadlock).
 * Skips when TEST_* are unset.
 */
import * as crypto from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createPost,
  createProfileImage,
  createReport,
  createUser,
} from '@buddha/db/test';
import {
  AUTO_NICKNAME_ALPHABET,
  AUTO_NICKNAME_PATTERN,
  AUTO_NICKNAME_PREFIX,
  DISMISS_REPORTS_MAX,
  MODERATION_REASON_MAX_LENGTH,
  NICKNAME_CHANGE_INTERVAL_DAYS,
  NICKNAME_HOLD_DAYS,
  adminCommentModerationSchema,
  adminModerationActionSchema,
  adminPostModerationSchema,
  adminReportGroupSchema,
  adminUserModerationSchema,
  commentThreadSchema,
  myCommentSchema,
  myModerationActionSchema,
  myPostSchema,
  myReportSchema,
  postSchema,
  type AdminModerationAction,
  type AdminReportGroup,
  type MyModerationAction,
  type MyReport,
  type Post,
  type PostSummary,
} from '@buddha/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  IMAGE_READ_BUDGET_BYTES,
  IMAGE_READ_BUSY_RETRY_SECONDS,
  imageReads,
} from '../media/image-reads.js';
import { memoryAdmission, memoryWaits } from '../media/memory-admission.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

// The nickname reset's draw (`randomInt`), steerable per test (`withDraws`); the real one otherwise.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const UNKNOWN = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

type Res = { statusCode: number; body: string; json: <T>() => T };

describe.skipIf(!hasTestInfra)('/api/v1 moderation (integration)', () => {
  let t: TestApp;
  let author: TestUser;
  let reporter: TestUser;
  let admin: TestUser;
  let other: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;
  let post: Awaited<ReturnType<typeof createPost>>;
  let comment: Awaited<ReturnType<typeof createComment>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    author = await onboarded();
    reporter = await onboarded();
    admin = await anAdmin();
    other = await anAdmin();
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      title: '근거 글',
      text: '본문 첫 줄',
    });
    comment = await createComment(t.db, { postId: post.id, authorId: author.id, body: '댓글' });
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

  const send = (url: string, payload: Record<string, unknown>, who: TestUser) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
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
  const actionOf = (res: Res): AdminModerationAction =>
    adminModerationActionSchema.parse(dataOf(res));
  const refusalOf = (res: Res) => {
    expect(res.statusCode, res.body).toBe(409);
    const error = res.json<{ error: { code: string; details: { reason: string } } }>().error;
    expect(error.code).toBe('MODERATION_NOT_ALLOWED');
    return error.details.reason;
  };
  const report = async (path: string, who: TestUser = reporter, reason = 'spam') =>
    myReportSchema.parse(dataOf<unknown>(await send(`${path}/reports`, { reason }, who), 201));
  const myReports = async (who: TestUser = reporter): Promise<MyReport[]> =>
    dataOf<unknown[]>(await read('/me/reports', who)).map((item) => myReportSchema.parse(item));
  const myActions = async (who: TestUser = author): Promise<MyModerationAction[]> =>
    dataOf<unknown[]>(await read('/me/moderation/actions', who)).map((item) =>
      myModerationActionSchema.parse(item),
    );
  const postPage = async (postId = post.id): Promise<Post> =>
    postSchema.parse(dataOf(await read(`/posts/${postId}`)));
  const cards = async (): Promise<PostSummary[]> => dataOf(await read('/posts'));
  /**
   * The post's count of comments in view as #48's counter keeps it (`post_comment_counts`, 0 with
   * no row, ADR-0074 7-33) — checked against the post's comments counted afresh, neither deleted
   * nor hidden, and against what the public reads on the post and its card (`commentCount`).
   */
  const commentCount = async (postId = post.id): Promise<number> => {
    const { rows } = await t.db.execute<{ kept: number; counted: number }>(sql`
      SELECT COALESCE((SELECT count FROM post_comment_counts WHERE post_id = ${postId}::uuid), 0)
               AS kept,
             (SELECT count(*)::int FROM post_comments
               WHERE post_id = ${postId}::uuid AND deleted_at IS NULL AND hidden_at IS NULL)
               AS counted`);
    const kept = rows[0]!.kept;
    expect(kept, 'the counter against a count afresh').toBe(rows[0]!.counted);
    expect((await postPage(postId)).commentCount).toBe(kept);
    expect((await cards()).find((card) => card.id === postId)?.commentCount).toBe(kept);
    return kept;
  };
  const audits = (type: string) =>
    t.db.select().from(schema.adminActions).where(eq(schema.adminActions.type, type));
  const queue = async (status?: 'pending' | 'resolved', who: TestUser = admin) =>
    dataOf<unknown[]>(await read(`/admin/reports${status ? `?status=${status}` : ''}`, who)).map(
      (item) => adminReportGroupSchema.parse(item),
    );
  const reportRow = async (id: string) => {
    const [row] = await t.db.select().from(schema.reports).where(eq(schema.reports.id, id));
    return row!;
  };
  const profileRow = async (userId: string) => {
    const [row] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!;
  };
  const changeNickname = (who: TestUser, nickname: string) =>
    t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ nickname, expectedAccountId: who.id }),
    });

  /**
   * Runs `whileHeld` while another connection holds what `statements` take in an open transaction
   * — another operator's write in flight — and commits it once the request waits on it.
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
      await waitForLockWaiter(holder, 'the request on what another transaction holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  /**
   * Runs `run` with the nickname reset drawing the auto nicknames `nicknames` name, in order (four
   * of AUTO_NICKNAME_ALPHABET each, `randomInt(max)`), and the real draw again after — every other
   * form (`randomInt(min, max)`, the factories' phone numbers) is the real one throughout.
   */
  async function withDraws<T>(nicknames: readonly string[], run: () => Promise<T>): Promise<T> {
    const draws = nicknames.flatMap((nickname) =>
      [...nickname.slice(AUTO_NICKNAME_PREFIX.length)].map((char) =>
        AUTO_NICKNAME_ALPHABET.indexOf(char),
      ),
    );
    const draw = vi.mocked(crypto.randomInt) as unknown as Mock<(...args: number[]) => number>;
    const real = draw.getMockImplementation()!;
    draw.mockImplementation((...args) =>
      args.length === 1 && draws.length > 0 ? draws.shift()! : real(...args),
    );
    try {
      return await run();
    } finally {
      draw.mockImplementation(real);
    }
  }

  describe('hiding', () => {
    it('takes a post out of every public view at once, resolves its reports and tells its author why', async () => {
      const first = await report(`/posts/${post.id}`);
      const second = await report(`/posts/${post.id}`, await onboarded(), 'harassment');
      const onComment = await report(`/comments/${comment.id}`);
      const action = actionOf(
        await send(
          `/admin/moderation/posts/${post.id}/hide`,
          { reason: 'harassment', note: ' 욕설 ' },
          admin,
        ),
      );
      expect(action).toMatchObject({
        type: 'hide',
        user: { id: author.id },
        subject: { type: 'post', postId: post.id },
        reason: { code: 'harassment', note: '욕설' },
        createdBy: { id: admin.id },
        cancelledAt: null,
        endsAt: null,
        removed: null,
        reportCount: 2,
      });
      // The public: the placeholder, out of the list and the author's profile.
      expect(await postPage()).toMatchObject({ state: 'hidden', id: post.id });
      expect((await cards()).map((card) => card.id)).not.toContain(post.id);
      const [profile] = await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, author.id));
      expect(dataOf<unknown[]>(await read(`/profiles/${profile!.publicId}/posts`))).toEqual([]);
      // No new comment under it, no edit by its author.
      const refusedComment = await send(
        `/posts/${post.id}/comments`,
        { body: '새 댓글' },
        reporter,
      );
      expect(refusedComment.statusCode).toBe(409);
      // The author: '숨김' and the reason on MY 내 글, the action on MY's record — no operator.
      const [mine] = dataOf<unknown[]>(await read('/me/posts', author)).map((item) =>
        myPostSchema.parse(item),
      );
      expect(mine?.hidden).toEqual({ reason: { code: 'harassment', note: '욕설' } });
      const [received] = await myActions();
      expect(received).toEqual({
        id: action.id,
        type: 'hide',
        reason: { code: 'harassment', note: '욕설' },
        subject: { type: 'post', id: post.id, title: '근거 글', excerpt: '본문 첫 줄' },
        createdAt: action.createdAt,
        endsAt: null,
        endChange: null,
        cancelledAt: null,
      });
      const body = (await read('/me/moderation/actions', author)).body;
      expect(body).not.toContain(admin.id);
      expect(body).not.toContain(reporter.id);
      // The reporters: 조치함 with when; the comment's report still waits.
      const statuses = Object.fromEntries((await myReports()).map((r) => [r.id, r.status]));
      expect(statuses).toEqual({ [first.id]: 'actioned', [onComment.id]: 'pending' });
      const [resolved] = await t.db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.id, second.id));
      expect(resolved).toMatchObject({
        status: 'actioned',
        resolvedBy: admin.id,
        actionId: action.id,
      });
      expect(resolved?.resolvedAt).not.toBeNull();
      // Recorded: the action and the audit row, in one transaction.
      const [audit] = await audits('moderation_post_hide');
      expect(audit).toMatchObject({
        adminId: admin.id,
        targetType: 'moderation_action',
        targetId: action.id,
        payload: {
          actionId: action.id,
          postId: post.id,
          userId: author.id,
          reason: 'harassment',
          note: '욕설',
        },
      });
      expect((audit?.payload as { reportIds: string[] }).reportIds.sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it('takes a comment out of the comment list, as its placeholder', async () => {
      const action = actionOf(
        await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(action.subject).toEqual({ type: 'comment', commentId: comment.id, postId: post.id });
      const [thread] = dataOf<unknown[]>(await read(`/posts/${post.id}/comments`)).map((item) =>
        commentThreadSchema.parse(item),
      );
      expect(thread?.comment).toEqual({ state: 'hidden', id: comment.id });
      expect((await myActions())[0]).toMatchObject({
        type: 'hide',
        subject: { type: 'comment', id: comment.id, postId: post.id, excerpt: '댓글' },
      });
      expect(await audits('moderation_comment_hide')).toHaveLength(1);
    });

    it('refuses a hidden, a deleted, an unknown item and the operator’s own; another operator hides it', async () => {
      const hidden = actionOf(
        await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(
        refusalOf(await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, other)),
      ).toBe('hidden');
      const deleted = await createPost(t.db, {
        marketId: market.id,
        authorId: author.id,
        deletedAt: new Date(),
      });
      expect(
        refusalOf(
          await send(`/admin/moderation/posts/${deleted.id}/hide`, { reason: 'spam' }, admin),
        ),
      ).toBe('deleted');
      expect(
        (await send(`/admin/moderation/posts/${UNKNOWN}/hide`, { reason: 'spam' }, admin))
          .statusCode,
      ).toBe(404);
      expect(
        (await send(`/admin/moderation/comments/${UNKNOWN}/hide`, { reason: 'spam' }, admin))
          .statusCode,
      ).toBe(404);
      // 기타 needs the explanation the member reads.
      expect(
        (await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'other' }, admin))
          .statusCode,
      ).toBe(400);
      // An operator's own post: refused to them, taken by another (decision 4 #50).
      const own = await createPost(t.db, { marketId: market.id, authorId: admin.id });
      await report(`/posts/${own.id}`);
      expect(
        refusalOf(await send(`/admin/moderation/posts/${own.id}/hide`, { reason: 'spam' }, admin)),
      ).toBe('own');
      const byOther = actionOf(
        await send(`/admin/moderation/posts/${own.id}/hide`, { reason: 'spam' }, other),
      );
      expect(byOther).toMatchObject({
        user: { id: admin.id },
        createdBy: { id: other.id },
        reportCount: 1,
      });
      expect(hidden.id).not.toBe(byOther.id);
    });

    it('shows the item again once cancelled with a reason, and keeps the reports resolved', async () => {
      const onPost = await report(`/posts/${post.id}`);
      const hidden = actionOf(
        await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin),
      );
      const cancelled = actionOf(
        await send(
          `/admin/moderation/actions/${hidden.id}/cancel`,
          { reason: ' 이의 인정 ' },
          other,
        ),
      );
      expect(cancelled).toMatchObject({
        id: hidden.id,
        cancelledBy: { id: other.id },
        cancelReason: '이의 인정',
      });
      expect(cancelled.cancelledAt).not.toBeNull();
      expect((await postPage()).state).toBe('published');
      expect((await cards()).map((card) => card.id)).toContain(post.id);
      const [mine] = dataOf<unknown[]>(await read('/me/posts', author)).map((item) =>
        myPostSchema.parse(item),
      );
      expect(mine?.hidden).toBeNull();
      // The member reads it cancelled; the reporter's result stands.
      expect((await myActions())[0]?.cancelledAt).toBe(cancelled.cancelledAt);
      expect((await myReports()).find((r) => r.id === onPost.id)?.status).toBe('actioned');
      // Once only; never by the member acted on.
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${hidden.id}/cancel`, { reason: '다시' }, admin),
        ),
      ).toBe('cancelled');
      const [audit] = await audits('moderation_cancel');
      expect(audit).toMatchObject({
        adminId: other.id,
        targetId: hidden.id,
        payload: { actionId: hidden.id, type: 'hide', userId: author.id, reason: '이의 인정' },
      });
      // Hidden again later: a new action.
      actionOf(await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin));
      expect((await postPage()).state).toBe('hidden');
      expect(
        (await send(`/admin/moderation/actions/${UNKNOWN}/cancel`, { reason: '없음' }, admin))
          .statusCode,
      ).toBe(404);
      expect(
        (await send(`/admin/moderation/actions/${hidden.id}/cancel`, { reason: ' ' }, admin))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await send(
            `/admin/moderation/actions/${hidden.id}/cancel`,
            { reason: 'x'.repeat(MODERATION_REASON_MAX_LENGTH + 1) },
            admin,
          )
        ).statusCode,
      ).toBe(400);
    });

    it('refuses a comment’s hiding on the operator’s own, a deleted and a hidden comment', async () => {
      const own = await createComment(t.db, { postId: post.id, authorId: admin.id });
      expect(
        refusalOf(
          await send(`/admin/moderation/comments/${own.id}/hide`, { reason: 'spam' }, admin),
        ),
      ).toBe('own');
      const deleted = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        deletedAt: new Date(),
      });
      expect(
        refusalOf(
          await send(`/admin/moderation/comments/${deleted.id}/hide`, { reason: 'spam' }, admin),
        ),
      ).toBe('deleted');
      // Hidden with no hiding recorded: the comment's own column answers, not the standing
      // hiding's index.
      const hidden = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        hiddenAt: new Date(),
      });
      expect(
        refusalOf(
          await send(`/admin/moderation/comments/${hidden.id}/hide`, { reason: 'spam' }, admin),
        ),
      ).toBe('hidden');
      expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
      const [kept] = await t.db
        .select({ hiddenAt: schema.postComments.hiddenAt })
        .from(schema.postComments)
        .where(eq(schema.postComments.id, deleted.id));
      expect(kept?.hiddenAt).toBeNull();
      // Another operator hides the operator's own.
      actionOf(await send(`/admin/moderation/comments/${own.id}/hide`, { reason: 'spam' }, other));
    });

    it('answers a second hiding of one item `hidden`, at once and past the item’s lock', async () => {
      const [one, two] = await Promise.all([
        send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin),
        send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, other),
      ]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
      expect(refusalOf(one.statusCode === 409 ? one : two)).toBe('hidden');
      // Another operator's hiding of the comment recorded meanwhile without its column (in
      // flight): the standing hiding's index answers, as the same refusal.
      const late = await whileLocked(
        [
          [
            'INSERT INTO moderation_actions (type, user_id, comment_id, reason, created_by) VALUES ($1, $2, $3, $4, $5)',
            ['hide', author.id, comment.id, 'spam', other.id],
          ],
        ],
        () => send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(refusalOf(late)).toBe('hidden');
      const actions = await t.db.select().from(schema.moderationActions);
      expect(
        actions.map((action) => [action.postId ?? action.commentId, action.createdBy]),
      ).toEqual(
        expect.arrayContaining([
          [post.id, expect.any(String)],
          [comment.id, other.id],
        ]),
      );
      expect(actions).toHaveLength(2);
    });

    it('takes the reports it resolves in id order, the order a dismissal takes them', async () => {
      // r1 came first and sorts last by id, r2 came after and sorts first. A dismissal locks them
      // r2 then r1; an action must too, or a dismissal and an action at once could each hold one
      // the other waits for (a deadlock, a 500 to one operator).
      const r1 = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const r2 = '00000000-0000-4000-8000-000000000001';
      const second = await onboarded();
      for (const [id, who, hoursAgo, hash] of [
        [r1, reporter, 2, 'a'],
        [r2, second, 1, 'b'],
      ] as const) {
        await t.db.insert(schema.reports).values({
          id,
          targetType: 'post',
          postId: post.id,
          reportedUserId: author.id,
          reporterId: who.id,
          reporterPhoneHash: hash.repeat(64),
          reason: 'spam',
          createdAt: new Date(Date.now() - hoursAgo * HOUR_MS),
        });
      }
      const holder = await t.db.$client.connect();
      let hiding: ReturnType<typeof send> | undefined;
      try {
        await holder.query('BEGIN');
        // Another operator's dismissal of r1, in flight.
        await holder.query('SELECT id FROM reports WHERE id = $1 FOR UPDATE', [r1]);
        hiding = send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin);
        await waitForLockWaiter(holder, 'the hiding on the report another transaction holds');
        // The hiding holds r2 already: it took it before it came to r1.
        await expect(
          holder.query('SELECT id FROM reports WHERE id = $1 FOR UPDATE NOWAIT', [r2]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(actionOf(await hiding).reportCount).toBe(2);
    });

    it('shows a comment again once its hiding is cancelled', async () => {
      const hidden = actionOf(
        await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      const cancelled = actionOf(
        await send(`/admin/moderation/actions/${hidden.id}/cancel`, { reason: '이의 인정' }, other),
      );
      const [thread] = dataOf<unknown[]>(await read(`/posts/${post.id}/comments`)).map((item) =>
        commentThreadSchema.parse(item),
      );
      expect(thread?.comment).toMatchObject({ state: 'published', id: comment.id, body: '댓글' });
      const mine = dataOf<unknown[]>(await read('/me/comments', author))
        .map((item) => myCommentSchema.parse(item))
        .find((item) => item.id === comment.id);
      expect(mine?.hidden).toBeNull();
      expect((await myActions())[0]).toMatchObject({
        id: hidden.id,
        cancelledAt: cancelled.cancelledAt,
      });
      // The standing hiding is gone: the comment is hidden again by a new action.
      const again = actionOf(
        await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(again.id).not.toBe(hidden.id);
    });

    it('keeps the post’s comment count exact (#48’s counter, ADR-0074 7-33): a 댓글 or 대댓글 hidden leaves it and comes back with the cancellation; a refused hiding, a hidden one its author deletes and that hiding’s cancellation after move nothing', async () => {
      const reply = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        parentId: comment.id,
        body: '답글',
      });
      const second = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        body: '둘째 댓글',
      });
      expect(await commentCount()).toBe(3);
      const onComment = actionOf(
        await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(await commentCount()).toBe(2);
      const onReply = actionOf(
        await send(`/admin/moderation/comments/${reply.id}/hide`, { reason: 'spam' }, admin),
      );
      expect(await commentCount()).toBe(1);
      // Hidden already: refused, nothing moves.
      expect(
        refusalOf(
          await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, other),
        ),
      ).toBe('hidden');
      expect(await commentCount()).toBe(1);
      // The 댓글's hiding cancelled: in view and counted again.
      actionOf(
        await send(
          `/admin/moderation/actions/${onComment.id}/cancel`,
          { reason: '이의 인정' },
          other,
        ),
      );
      expect(await commentCount()).toBe(2);
      // The hidden 대댓글 deleted by its author (MY's 삭제, ADR-0080): out of the count already.
      dataOf(await send(`/comments/${reply.id}/delete`, {}, author));
      expect(await commentCount()).toBe(2);
      // Its hiding cancelled after: `hidden_at` cleared on a deleted one, still out.
      actionOf(
        await send(
          `/admin/moderation/actions/${onReply.id}/cancel`,
          { reason: '이의 인정' },
          other,
        ),
      );
      expect(await commentCount()).toBe(2);
      // A deleted 댓글: one less by its deletion, and its hiding is refused, nothing moving.
      dataOf(await send(`/comments/${second.id}/delete`, {}, author));
      expect(await commentCount()).toBe(1);
      expect(
        refusalOf(
          await send(`/admin/moderation/comments/${second.id}/hide`, { reason: 'spam' }, admin),
        ),
      ).toBe('deleted');
      expect(await commentCount()).toBe(1);
    });

    it('names an item the member deleted since by its kind alone on their record (#45-5)', async () => {
      const onPost = actionOf(
        await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin),
      );
      const onComment = actionOf(
        await send(`/admin/moderation/comments/${comment.id}/hide`, { reason: 'spam' }, admin),
      );
      // The author deletes both afterwards (a hidden item stays theirs to delete, #45-5).
      await t.db
        .update(schema.posts)
        .set({ deletedAt: new Date() })
        .where(eq(schema.posts.id, post.id));
      await t.db
        .update(schema.postComments)
        .set({ deletedAt: new Date() })
        .where(eq(schema.postComments.id, comment.id));
      const record = await myActions();
      expect(record.find((action) => action.id === onPost.id)?.subject).toEqual({
        type: 'post',
        id: post.id,
        title: null,
        excerpt: null,
      });
      expect(record.find((action) => action.id === onComment.id)?.subject).toEqual({
        type: 'comment',
        id: comment.id,
        postId: post.id,
        excerpt: null,
      });
      const body = (await read('/me/moderation/actions', author)).body;
      for (const text of ['근거 글', '본문 첫 줄', '댓글']) expect(body).not.toContain(text);
    });

    it('refuses to cancel an action on the operator themselves', async () => {
      const own = await createPost(t.db, { marketId: market.id, authorId: admin.id });
      const hidden = actionOf(
        await send(`/admin/moderation/posts/${own.id}/hide`, { reason: 'spam' }, other),
      );
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${hidden.id}/cancel`, { reason: '내 글' }, admin),
        ),
      ).toBe('own');
    });
  });

  describe('dismissing', () => {
    it('closes the reports named with nothing done: the public reads the same, the reporters 기각', async () => {
      const first = await report(`/posts/${post.id}`);
      // A report that arrives while the operator's screen shows the first alone: not named, so
      // not closed — the operator has not read it.
      const second = await onboarded();
      const later = await report(`/posts/${post.id}`, second, 'harassment');
      const before = await postPage();
      const res = dataOf<{ reports: unknown[] }>(
        await send('/admin/reports/dismiss', { reportIds: [first.id], reason: '위반 아님' }, admin),
      );
      expect(res.reports).toHaveLength(1);
      expect(res.reports[0]).toMatchObject({
        id: first.id,
        status: 'dismissed',
        resolvedBy: { id: admin.id },
        dismissalReason: '위반 아님',
        actionId: null,
      });
      expect(await postPage()).toEqual(before);
      expect((await myReports())[0]).toMatchObject({ id: first.id, status: 'dismissed' });
      expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
      const [audit] = await audits('report_dismiss');
      expect(audit).toMatchObject({
        adminId: admin.id,
        targetType: null,
        payload: { reportIds: [first.id], reason: '위반 아님' },
      });
      expect((await myReports(second))[0]).toMatchObject({ id: later.id, status: 'pending' });
      // The queue counts it as the one pending, its reasons the pending ones' alone.
      expect(await queue()).toEqual([
        expect.objectContaining({
          pendingCount: 1,
          reportCount: 2,
          reasons: [{ reason: 'harassment', count: 1 }],
        }),
      ]);
      expect(
        refusalOf(
          await send(
            '/admin/reports/dismiss',
            { reportIds: [first.id, later.id], reason: '다시' },
            admin,
          ),
        ),
      ).toBe('resolved');
      expect((await myReports()).find((r) => r.id === first.id)?.status).toBe('dismissed');
      expect((await reportRow(later.id)).status).toBe('pending');
    });

    it('takes DISMISS_REPORTS_MAX reports at a time, so a target with more is dismissed in turns', async () => {
      // More pending reports on one post than one dismissal takes: one each from as many people.
      const ids: string[] = [];
      const start = Date.now() - DAY_MS;
      for (let i = 0; i <= DISMISS_REPORTS_MAX; i += 1) {
        const someone = await createUser(t.db);
        const row = await createReport(t.db, {
          reporterId: someone.user.id,
          reportedUserId: author.id,
          postId: post.id,
          createdAt: new Date(start + i * 1_000),
        });
        ids.push(row.id);
      }
      const all = await send(
        '/admin/reports/dismiss',
        { reportIds: ids, reason: '위반 아님' },
        admin,
      );
      expect(all.statusCode).toBe(400);
      expect(all.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [expect.objectContaining({ path: ['reportIds'] })],
      });
      expect((await queue())[0]?.pendingCount).toBe(DISMISS_REPORTS_MAX + 1);
      // The oldest DISMISS_REPORTS_MAX, as the screen sends them; the newest waits for the next.
      const oldest = ids.slice(0, DISMISS_REPORTS_MAX);
      const res = dataOf<{ reports: unknown[] }>(
        await send('/admin/reports/dismiss', { reportIds: oldest, reason: '위반 아님' }, admin),
      );
      expect(res.reports).toHaveLength(DISMISS_REPORTS_MAX);
      expect((await queue()).map((group) => group.pendingCount)).toEqual([1]);
      expect((await reportRow(ids.at(-1)!)).status).toBe('pending');
      dataOf(
        await send(
          '/admin/reports/dismiss',
          { reportIds: ids.slice(-1), reason: '위반 아님' },
          admin,
        ),
      );
      expect(await queue()).toEqual([]);
    });

    it('refuses the operator’s own reports, unknown ones and a missing reason', async () => {
      const own = await createPost(t.db, { marketId: market.id, authorId: admin.id });
      const onOwn = await report(`/posts/${own.id}`);
      expect(
        refusalOf(
          await send('/admin/reports/dismiss', { reportIds: [onOwn.id], reason: '없음' }, admin),
        ),
      ).toBe('own');
      const notFound = await send(
        '/admin/reports/dismiss',
        { reportIds: [UNKNOWN], reason: '없음' },
        admin,
      );
      expect(notFound.statusCode).toBe(404);
      expect(
        (await send('/admin/reports/dismiss', { reportIds: [onOwn.id] }, other)).statusCode,
      ).toBe(400);
      // A reason longer than its column: the body's refusal, never the database's (a 500).
      expect(
        (
          await send(
            '/admin/reports/dismiss',
            { reportIds: [onOwn.id], reason: 'x'.repeat(MODERATION_REASON_MAX_LENGTH + 1) },
            other,
          )
        ).statusCode,
      ).toBe(400);
      expect((await reportRow(onOwn.id)).status).toBe('pending');
      // One report named twice, in two cases, is one.
      const res = dataOf<{ reports: { id: string }[] }>(
        await send(
          '/admin/reports/dismiss',
          { reportIds: [onOwn.id, onOwn.id.toUpperCase()], reason: '없음' },
          other,
        ),
      );
      expect(res.reports.map((row) => row.id)).toEqual([onOwn.id]);
      const [audit] = await audits('report_dismiss');
      expect(audit?.payload).toEqual({ reportIds: [onOwn.id], reason: '없음' });
    });
  });

  describe('warning', () => {
    it('records a warning and the member’s notice, resolving the reports on its subject', async () => {
      const onComment = await report(`/comments/${comment.id}`);
      const onPost = await report(`/posts/${post.id}`);
      const action = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/warn`,
          {
            reason: 'harassment',
            note: '다음에는 숨깁니다',
            subject: { type: 'comment', commentId: comment.id },
          },
          admin,
        ),
      );
      expect(action).toMatchObject({
        type: 'warning',
        user: { id: author.id },
        subject: { type: 'comment', commentId: comment.id, postId: post.id },
        reportCount: 1,
      });
      // Nothing else changes: the comment and the post are as they were.
      expect((await postPage()).state).toBe('published');
      const statuses = Object.fromEntries((await myReports()).map((r) => [r.id, r.status]));
      expect(statuses).toEqual({ [onComment.id]: 'actioned', [onPost.id]: 'pending' });
      expect((await myActions())[0]).toMatchObject({
        type: 'warning',
        reason: { code: 'harassment', note: '다음에는 숨깁니다' },
        subject: { type: 'comment', id: comment.id },
      });
      // Without a subject: about nothing in particular.
      const plain = actionOf(
        await send(`/admin/moderation/users/${author.id}/warn`, { reason: 'spam' }, admin),
      );
      expect(plain.subject).toBeNull();
      expect((await myActions())[0]).toMatchObject({ id: plain.id, subject: null });
      expect(await audits('moderation_warning')).toHaveLength(2);
    });

    it('resolves the reports on the post or the profile it is about, by any case of the id', async () => {
      const onPost = await report(`/posts/${post.id}`);
      const onComment = await report(`/comments/${comment.id}`);
      const onProfile = await report(
        `/profiles/${await publicIdOf(author.id)}`,
        reporter,
        'impersonation',
      );
      // An upper-case id is the same post: its reports are matched on the lower-case key.
      const aboutPost = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/warn`,
          { reason: 'spam', subject: { type: 'post', postId: post.id.toUpperCase() } },
          admin,
        ),
      );
      expect(aboutPost).toMatchObject({
        subject: { type: 'post', postId: post.id },
        reportCount: 1,
      });
      expect(await reportRow(onPost.id)).toMatchObject({
        status: 'actioned',
        actionId: aboutPost.id,
        resolvedBy: admin.id,
      });
      // Without a subject the profile's reports wait; about the profile they are resolved.
      actionOf(await send(`/admin/moderation/users/${author.id}/warn`, { reason: 'spam' }, admin));
      expect((await reportRow(onProfile.id)).status).toBe('pending');
      const aboutProfile = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/warn`,
          { reason: 'impersonation', subject: { type: 'profile' } },
          admin,
        ),
      );
      expect(aboutProfile).toMatchObject({ subject: null, reportCount: 1 });
      expect(await reportRow(onProfile.id)).toMatchObject({
        status: 'actioned',
        actionId: aboutProfile.id,
      });
      const statuses = Object.fromEntries((await myReports()).map((r) => [r.id, r.status]));
      expect(statuses).toEqual({
        [onPost.id]: 'actioned',
        [onComment.id]: 'pending',
        [onProfile.id]: 'actioned',
      });
      // The member reads a warning about the profile as one about nothing in particular (7-9).
      expect((await myActions()).find((action) => action.id === aboutProfile.id)?.subject).toBe(
        null,
      );
      const audit = (await audits('moderation_warning')).find(
        (row) => row.targetId === aboutProfile.id,
      );
      expect((audit?.payload as { reportIds: string[] }).reportIds).toEqual([onProfile.id]);
    });

    it('refuses a subject not the member’s, an unknown member and the operator themselves', async () => {
      const mine = await createPost(t.db, { marketId: market.id, authorId: reporter.id });
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${author.id}/warn`,
            { reason: 'spam', subject: { type: 'post', postId: mine.id } },
            admin,
          ),
        ),
      ).toBe('not_theirs');
      expect(
        (await send(`/admin/moderation/users/unknown-user/warn`, { reason: 'spam' }, admin))
          .statusCode,
      ).toBe(404);
      expect(
        refusalOf(
          await send(`/admin/moderation/users/${admin.id}/warn`, { reason: 'spam' }, admin),
        ),
      ).toBe('own');
      actionOf(await send(`/admin/moderation/users/${admin.id}/warn`, { reason: 'spam' }, other));
    });
  });

  describe('profile items (#37-10)', () => {
    it('gives the nickname back to an auto nickname, held from everybody — the member too — and kept for operators', async () => {
      await t.db
        .update(schema.profiles)
        .set({ nickname: '사칭닉네임' })
        .where(eq(schema.profiles.userId, author.id));
      const onProfile = await report(
        `/profiles/${await publicIdOf(author.id)}`,
        reporter,
        'impersonation',
      );
      const action = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      expect(action).toMatchObject({
        type: 'nickname_reset',
        subject: null,
        removed: { item: 'nickname', nickname: '사칭닉네임' },
        reportCount: 1,
      });
      const [profile] = await t.db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, author.id));
      expect(profile?.nickname).toMatch(AUTO_NICKNAME_PATTERN);
      // No change of the member's to count an interval from (owner decision 2026-10-21).
      expect(profile?.nicknameChangedAt).toBeNull();
      // The nickname taken away is held from every account, the member's own included (owner
      // decision 2026-10-21: the hold the others get) — a hold naming no account.
      const [hold] = await t.db
        .select()
        .from(schema.nicknameHolds)
        .where(eq(schema.nicknameHolds.nickname, '사칭닉네임'));
      expect(hold).toBeDefined();
      expect(hold?.userId).toBeNull();
      // It names the reset, from the reset's own time: what its cancellation hands over, and what
      // the member's 조치·신고 내역 counts its 30 days from (owner decision 2026-10-22).
      expect(hold?.actionId).toBe(action.id);
      expect(hold?.releasedAt.toISOString()).toBe(action.createdAt);
      const taken = await t.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: {
          origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
          cookie: reporter.cookie,
        },
        payload: JSON.stringify({ nickname: '사칭닉네임', expectedAccountId: reporter.id }),
      });
      expect(taken.statusCode).toBe(409);
      expect((await myReports()).find((r) => r.id === onProfile.id)?.status).toBe('actioned');
      expect((await myActions())[0]).toMatchObject({
        type: 'nickname_reset',
        subject: { type: 'profile' },
      });
      // An auto nickname already has nothing to take away.
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${author.id}/nickname-reset`,
            { reason: 'impersonation' },
            admin,
          ),
        ),
      ).toBe('nothing_to_remove');
      expect(await audits('moderation_nickname_reset')).toHaveLength(1);
      // The member cannot take the old one back for the 30 days of the hold.
      const back = await changeNickname(author, '사칭닉네임');
      expect(back.statusCode, back.body).toBe(409);
      expect(back.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: { reason: 'taken' },
      });
      // Past the hold, it is theirs to pick again, as anybody's.
      await t.db
        .update(schema.nicknameHolds)
        .set({ releasedAt: new Date(Date.now() - (NICKNAME_HOLD_DAYS + 1) * DAY_MS) })
        .where(eq(schema.nicknameHolds.nickname, '사칭닉네임'));
      expect((await changeNickname(author, '사칭닉네임')).statusCode).toBe(200);
    });

    it('waives the member’s 30-day interval: a new nickname at once, and the 30 days from that pick (owner decision 2026-10-21)', async () => {
      // The member changed to the nickname reported a day ago: without the reset they would wait
      // 29 days more.
      await t.db
        .update(schema.profiles)
        .set({ nickname: '사칭닉네임', nicknameChangedAt: new Date(Date.now() - DAY_MS) })
        .where(eq(schema.profiles.userId, author.id));
      actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      expect((await profileRow(author.id)).nicknameChangedAt).toBeNull();
      // MY 설정 reads no wait.
      const me = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: author.cookie },
      });
      expect(me.json<{ data: { profile: unknown } }>().data.profile).toMatchObject({
        nicknameChangeAvailableAt: null,
      });
      const picked = await changeNickname(author, '새닉네임');
      expect(picked.statusCode, picked.body).toBe(200);
      const pickedAt = (await profileRow(author.id)).nicknameChangedAt;
      expect(pickedAt).not.toBeNull();
      // That pick is a change: the next one waits its 30 days.
      const next = await changeNickname(author, '또다른닉네임');
      expect(next.statusCode, next.body).toBe(409);
      expect(next.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: {
          reason: 'change_interval',
          nextChangeAt: new Date(
            pickedAt!.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
          ).toISOString(),
        },
      });
    });

    it('hands the hold to the member once the reset is cancelled: theirs to pick at once with no change since a reset, nobody else’s in any case for the rest of the 30 days, nothing restored (owner decision 2026-10-22)', async () => {
      // A nickname with letters that have a case, so 'in any case' below is three nicknames.
      const former = 'Imposter7';
      await t.db
        .update(schema.profiles)
        .set({ nickname: former })
        .where(eq(schema.profiles.userId, author.id));
      const first = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      // The member picks another at once (the interval waived), and a second reset takes it too.
      // That second reset also clears the interval the pick set again (`resetNickname`), so the
      // member's pick of the former nickname below meets no interval: a pick between a reset and
      // its cancellation with no reset after it is the next test's.
      expect((await changeNickname(author, '두번째닉네임')).statusCode).toBe(200);
      const second = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      const auto = (await profileRow(author.id)).nickname;
      expect(auto).toMatch(AUTO_NICKNAME_PATTERN);
      const holdOf = async (nickname: string) => {
        const [row] = await t.db
          .select()
          .from(schema.nicknameHolds)
          .where(eq(schema.nicknameHolds.nickname, nickname));
        return row!;
      };
      const before = await holdOf(former);

      // The first reset cancelled (an accepted appeal, #45-14).
      const cancelled = actionOf(
        await send(`/admin/moderation/actions/${first.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      expect(cancelled.cancelledAt).not.toBeNull();
      // Its hold is the member's now, from the same time: nothing else of it moves.
      expect(await holdOf(former)).toEqual({ ...before, userId: author.id });
      // The second reset's hold still names no account.
      expect((await holdOf('두번째닉네임')).userId).toBeNull();
      // Nothing is restored: the member keeps the auto nickname until they pick.
      expect((await profileRow(author.id)).nickname).toBe(auto);

      // Another account cannot take it for the rest of the 30 days, in any case.
      const cases = [former, former.toUpperCase(), former.toLowerCase()];
      expect(new Set(cases).size).toBe(3);
      for (const nickname of cases) {
        const taken = await changeNickname(reporter, nickname);
        expect(taken.statusCode, taken.body).toBe(409);
        expect(taken.json<{ error: unknown }>().error).toMatchObject({
          code: 'NICKNAME_NOT_ALLOWED',
          details: { reason: 'taken' },
        });
      }
      // The second reset's nickname stays held from the member too.
      const stillHeld = await changeNickname(author, '두번째닉네임');
      expect(stillHeld.statusCode, stillHeld.body).toBe(409);
      expect(stillHeld.json<{ error: unknown }>().error).toMatchObject({
        details: { reason: 'taken' },
      });
      // The member picks it again at once.
      const back = await changeNickname(author, former);
      expect(back.statusCode, back.body).toBe(200);
      expect((await profileRow(author.id)).nickname).toBe(former);
      // The second reset stands; the cancellation is audited as every other.
      expect(second.cancelledAt).toBeNull();
      const [cancelAudit] = await audits('moderation_cancel');
      expect(cancelAudit?.payload).toMatchObject({ actionId: first.id, type: 'nickname_reset' });
    });

    it('lets the member take back the nickname a cancelled reset handed them with no interval while its hold stands, even after a pick since the reset — any other nickname waits the interval, another account is refused it (owner decision 2026-10-22 (2차) 1)', async () => {
      // The usual order: the reset leaves the member an auto nickname and waives the interval, so
      // they pick another at once — which starts a new interval — and an appeal (14 days) is
      // accepted after that.
      const former = 'Imposter7';
      await t.db
        .update(schema.profiles)
        .set({ nickname: former })
        .where(eq(schema.profiles.userId, author.id));
      const reset = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      const picked = await changeNickname(author, '새닉네임');
      expect(picked.statusCode, picked.body).toBe(200);
      const pickedAt = (await profileRow(author.id)).nicknameChangedAt!;
      expect(pickedAt).not.toBeNull();
      const intervalOf = (from: Date) =>
        new Date(from.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS).toISOString();
      const expectInterval = (res: Res, nextChangeAt: string) => {
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json<{ error: unknown }>().error).toMatchObject({
          code: 'NICKNAME_NOT_ALLOWED',
          details: { reason: 'change_interval', nextChangeAt },
        });
      };
      // Before the cancellation the hold names nobody: the pick's interval refuses the former
      // nickname as any other.
      expectInterval(await changeNickname(author, former), intervalOf(pickedAt));

      actionOf(
        await send(`/admin/moderation/actions/${reset.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      const [hold] = await t.db
        .select()
        .from(schema.nicknameHolds)
        .where(eq(schema.nicknameHolds.actionId, reset.id));
      expect(hold?.userId).toBe(author.id);

      // That nickname as it was taken away, not another case of it: the hold keeps every case
      // from the others, the waiver is for the nickname.
      expectInterval(await changeNickname(author, former.toUpperCase()), intervalOf(pickedAt));
      // Any other nickname waits the interval the pick started.
      expectInterval(await changeNickname(author, '셋째닉네임'), intervalOf(pickedAt));
      // Another account is refused it, in any case, for the rest of the 30 days…
      for (const nickname of [former, former.toLowerCase()]) {
        const taken = await changeNickname(reporter, nickname);
        expect(taken.statusCode, taken.body).toBe(409);
        expect(taken.json<{ error: unknown }>().error).toMatchObject({
          code: 'NICKNAME_NOT_ALLOWED',
          details: { reason: 'taken' },
        });
      }
      // …and one whose own interval runs meets that interval: the waiver is the member's alone.
      const reporterChangedAt = new Date(Date.now() - DAY_MS);
      await t.db
        .update(schema.profiles)
        .set({ nicknameChangedAt: reporterChangedAt })
        .where(eq(schema.profiles.userId, reporter.id));
      expectInterval(await changeNickname(reporter, former), intervalOf(reporterChangedAt));
      expect((await profileRow(author.id)).nickname).toBe('새닉네임');

      // The member takes it back at once.
      const back = await changeNickname(author, former);
      expect(back.statusCode, back.body).toBe(200);
      const backRow = await profileRow(author.id);
      expect(backRow.nickname).toBe(former);
      // A change like any other: the next interval counts from it…
      expect(backRow.nicknameChangedAt!.getTime()).toBeGreaterThan(pickedAt.getTime());
      // …and the nickname the member gave up for it is their own hold, which names no reset and
      // waives nothing.
      expectInterval(
        await changeNickname(author, '새닉네임'),
        intervalOf(backRow.nicknameChangedAt!),
      );
      expect((await profileRow(author.id)).nickname).toBe(former);
    });

    it('waives nothing once the handed-back hold has ended: from 30 days after the reset the member’s interval applies to that nickname as to any (owner decision 2026-10-22 (2차) 1)', async () => {
      const former = 'Imposter7';
      await t.db
        .update(schema.profiles)
        .set({ nickname: former })
        .where(eq(schema.profiles.userId, author.id));
      const reset = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      expect((await changeNickname(author, '새닉네임')).statusCode).toBe(200);
      actionOf(
        await send(`/admin/moderation/actions/${reset.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      // The reset and its hold moved back to just past the 30 days; the member's pick a day ago,
      // so its interval still runs.
      const changedAt = new Date(Date.now() - DAY_MS);
      await t.db
        .update(schema.profiles)
        .set({ nicknameChangedAt: changedAt })
        .where(eq(schema.profiles.userId, author.id));
      const holdAt = async (releasedAt: Date) => {
        await t.db
          .update(schema.nicknameHolds)
          .set({ releasedAt })
          .where(eq(schema.nicknameHolds.actionId, reset.id));
      };
      await holdAt(new Date(Date.now() - NICKNAME_HOLD_DAYS * DAY_MS - HOUR_MS));
      const ended = await changeNickname(author, former);
      expect(ended.statusCode, ended.body).toBe(409);
      expect(ended.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: {
          reason: 'change_interval',
          nextChangeAt: new Date(
            changedAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
          ).toISOString(),
        },
      });
      // An hour before its end the hold still stands, and the member takes the nickname back.
      await holdAt(new Date(Date.now() - NICKNAME_HOLD_DAYS * DAY_MS + HOUR_MS));
      const standing = await changeNickname(author, former);
      expect(standing.statusCode, standing.body).toBe(200);
      expect((await profileRow(author.id)).nickname).toBe(former);
    });

    it('waives the interval once per handed-back hold: after two cancelled resets the member takes each nickname back at once, and one taken back and given up again waits the interval (owner decision 2026-10-22 (4차) 1)', async () => {
      const first = 'Imposter7';
      const second = '두번째닉네임';
      await t.db
        .update(schema.profiles)
        .set({ nickname: first })
        .where(eq(schema.profiles.userId, author.id));
      const resetOf = async () =>
        actionOf(
          await send(
            `/admin/moderation/users/${author.id}/nickname-reset`,
            { reason: 'impersonation' },
            admin,
          ),
        );
      // Each reset takes a nickname and clears the interval, so the member picks another at once.
      const reset1 = await resetOf();
      expect((await changeNickname(author, second)).statusCode).toBe(200);
      const reset2 = await resetOf();
      expect((await changeNickname(author, '셋째닉네임')).statusCode).toBe(200);
      for (const reset of [reset1, reset2]) {
        actionOf(
          await send(
            `/admin/moderation/actions/${reset.id}/cancel`,
            { reason: '이의 인정' },
            admin,
          ),
        );
      }
      const handed = await t.db
        .select({ nickname: schema.nicknameHolds.nickname })
        .from(schema.nicknameHolds)
        .where(eq(schema.nicknameHolds.userId, author.id));
      expect(handed.map((row) => row.nickname)).toEqual(expect.arrayContaining([first, second]));

      // Each handed-back nickname once, each pick a change within the last one's interval: the
      // first gives up 셋째닉네임, which is not a take-back of either.
      for (const nickname of [first, second]) {
        const res = await changeNickname(author, nickname);
        expect(res.statusCode, res.body).toBe(200);
        expect((await profileRow(author.id)).nickname).toBe(nickname);
      }
      // The first was taken back and given up again: its hold has waived the interval once, and
      // the member waits the interval the last pick started, as for any nickname.
      const lastPickAt = (await profileRow(author.id)).nicknameChangedAt!;
      const again = await changeNickname(author, first);
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: {
          reason: 'change_interval',
          nextChangeAt: new Date(
            lastPickAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
          ).toISOString(),
        },
      });
      // The nickname the member picked themselves names no reset: its hold waives nothing.
      const own = await changeNickname(author, '셋째닉네임');
      expect(own.statusCode, own.body).toBe(409);
      expect(own.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: { reason: 'change_interval' },
      });
      expect((await profileRow(author.id)).nickname).toBe(second);
      // The hold still keeps it from every other account, the member's waiver used or not.
      const taken = await changeNickname(reporter, first);
      expect(taken.statusCode, taken.body).toBe(409);
      expect(taken.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: { reason: 'taken' },
      });
    });

    it('counts the take-back used from the member giving that nickname up at or after the cancellation, not one they gave up before the reset (owner decision 2026-10-22 (4차) 1)', async () => {
      const former = 'Imposter7';
      // The member gave the nickname up 40 days ago and took it again since — their own hold
      // never keeps it from them — before the reset took it.
      await t.db
        .update(schema.profiles)
        .set({ nickname: former })
        .where(eq(schema.profiles.userId, author.id));
      await t.db.insert(schema.nicknameHolds).values({
        nickname: former,
        userId: author.id,
        releasedAt: new Date(Date.now() - 40 * DAY_MS),
      });
      const reset = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      expect((await changeNickname(author, '새닉네임')).statusCode).toBe(200);
      actionOf(
        await send(`/admin/moderation/actions/${reset.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      // That old hold of the member's own is not a take-back since the cancellation: the waiver
      // stands, and the member takes the nickname back within the pick's interval.
      const back = await changeNickname(author, former);
      expect(back.statusCode, back.body).toBe(200);
      expect((await profileRow(author.id)).nickname).toBe(former);

      // The interval of the take-back gone by, the member gives the nickname up again…
      await t.db
        .update(schema.profiles)
        .set({
          nicknameChangedAt: new Date(Date.now() - (NICKNAME_CHANGE_INTERVAL_DAYS + 1) * DAY_MS),
        })
        .where(eq(schema.profiles.userId, author.id));
      expect((await changeNickname(author, '셋째닉네임')).statusCode).toBe(200);
      const gaveUpAt = (await profileRow(author.id)).nicknameChangedAt!;
      // …while the handed-back hold still stands (the reset was just now): the take-back is used,
      // and that nickname waits the interval the last pick started.
      const expectUsed = async () => {
        const res = await changeNickname(author, former);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json<{ error: unknown }>().error).toMatchObject({
          code: 'NICKNAME_NOT_ALLOWED',
          details: {
            reason: 'change_interval',
            nextChangeAt: new Date(
              gaveUpAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
            ).toISOString(),
          },
        });
        expect((await profileRow(author.id)).nickname).toBe('셋째닉네임');
      };
      await expectUsed();
      // The member's hold of it from then names no reset; given up in the very millisecond of the
      // cancellation (the clock's resolution), it counts all the same.
      const [action] = await t.db
        .select({ cancelledAt: schema.moderationActions.cancelledAt })
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, reset.id));
      const givenUp = await t.db
        .update(schema.nicknameHolds)
        .set({ releasedAt: action!.cancelledAt! })
        .where(
          and(
            eq(schema.nicknameHolds.userId, author.id),
            eq(schema.nicknameHolds.nickname, former),
            isNull(schema.nicknameHolds.actionId),
            gt(schema.nicknameHolds.releasedAt, new Date(Date.now() - DAY_MS)),
          ),
        )
        .returning({ id: schema.nicknameHolds.id });
      expect(givenUp).toHaveLength(1);
      await expectUsed();
    });

    it('counts a change of case away from a handed-back nickname as giving it up: after two cancelled resets of two cases of one nickname the member cannot switch between them within the interval (owner decision 2026-10-22 (4차) 1)', async () => {
      const upper = 'Imposter7';
      const lower = 'imposter7';
      await t.db
        .update(schema.profiles)
        .set({ nickname: upper })
        .where(eq(schema.profiles.userId, author.id));
      const resetAndCancel = async () => {
        const reset = actionOf(
          await send(
            `/admin/moderation/users/${author.id}/nickname-reset`,
            { reason: 'impersonation' },
            admin,
          ),
        );
        actionOf(
          await send(
            `/admin/moderation/actions/${reset.id}/cancel`,
            { reason: '이의 인정' },
            admin,
          ),
        );
      };
      const pick = async (nickname: string) => {
        const res = await changeNickname(author, nickname);
        expect(res.statusCode, res.body).toBe(200);
        expect((await profileRow(author.id)).nickname).toBe(nickname);
      };
      // Each reset clears the interval, and the hold its cancellation hands the member keeps no
      // case of it from them: after the first they pick the other case at once, which the second
      // takes away and hands back in turn, and after the second the first case again.
      await resetAndCancel();
      await pick(lower);
      await resetAndCancel();
      await pick(upper);
      // Within that pick's interval the second reset's nickname, not given up since its
      // cancellation, is taken back once with no interval — a change of case only, which gives up
      // the first reset's nickname exactly as it was taken away.
      await pick(lower);
      const lastPickAt = (await profileRow(author.id)).nicknameChangedAt!;
      const givenUp = await t.db
        .select({ userId: schema.nicknameHolds.userId })
        .from(schema.nicknameHolds)
        .where(
          and(
            eq(schema.nicknameHolds.nickname, upper),
            isNull(schema.nicknameHolds.actionId),
            gt(schema.nicknameHolds.releasedAt, new Date(Date.now() - DAY_MS)),
          ),
        );
      expect(givenUp).toEqual([{ userId: author.id }]);
      // So the first case, taken back and given up again, waits the interval as any: no switching
      // between the two cases while both holds stand.
      const again = await changeNickname(author, upper);
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json<{ error: unknown }>().error).toMatchObject({
        code: 'NICKNAME_NOT_ALLOWED',
        details: {
          reason: 'change_interval',
          nextChangeAt: new Date(
            lastPickAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
          ).toISOString(),
        },
      });
      expect((await profileRow(author.id)).nickname).toBe(lower);
    });

    it('hands the hold over under the nickname’s lock: a pick in flight reads it held, one that comes meanwhile waits and takes it — past the interval of a pick since the reset (owner decisions 2026-10-22, (2차) 1)', async () => {
      await t.db
        .update(schema.profiles)
        .set({ nickname: '사칭닉네임' })
        .where(eq(schema.profiles.userId, author.id));
      const reset = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      const holder = await t.db.$client.connect();
      let cancelling: Promise<Res> | undefined;
      let picks: Promise<Res[]> | undefined;
      let open = false;
      try {
        // A pick of the nickname in flight first: it holds the nickname's lock, as a pick does,
        // and the cancellation waits for it — the pick reads the hold as the reset left it.
        await holder.query('BEGIN');
        open = true;
        await holder.query('SELECT lock_nickname($1)', ['사칭닉네임']);
        cancelling = send(
          `/admin/moderation/actions/${reset.id}/cancel`,
          { reason: '이의' },
          admin,
        );
        await waitForLockWaiter(holder, 'the cancellation on the nickname’s lock');
        const inFlight = await holder.query<{ held: boolean }>(
          'SELECT nickname_held($1, $2) AS held',
          ['사칭닉네임', author.id],
        );
        expect(inFlight.rows[0]?.held).toBe(true);
        await holder.query('ROLLBACK');
        open = false;
        expect((await cancelling).statusCode).toBe(200);
        expect((await changeNickname(author, '사칭닉네임')).statusCode).toBe(200);
      } finally {
        if (open) await holder.query('ROLLBACK');
        holder.release();
        await cancelling?.catch(() => undefined);
      }

      // Another reset, cancelled while two picks come: the cancellation holds the nickname's
      // lock while it waits on the hold's row, the picks wait for that lock, and once it commits
      // the member takes the nickname and the other account is refused. This member has picked
      // another nickname since the reset, so their interval runs: the pick reads the hold under
      // that lock, as handed, and takes it with no interval (owner decision 2026-10-22 (2차) 1).
      const member = await onboarded();
      await t.db
        .update(schema.profiles)
        .set({ nickname: '두번째사칭' })
        .where(eq(schema.profiles.userId, member.id));
      const second = actionOf(
        await send(
          `/admin/moderation/users/${member.id}/nickname-reset`,
          { reason: 'spam' },
          admin,
        ),
      );
      expect((await changeNickname(member, '그사이닉네임')).statusCode).toBe(200);
      expect((await profileRow(member.id)).nicknameChangedAt).not.toBeNull();
      const rowHolder = await t.db.$client.connect();
      open = false;
      cancelling = undefined;
      try {
        await rowHolder.query('BEGIN');
        open = true;
        await rowHolder.query('SELECT 1 FROM nickname_holds WHERE action_id = $1 FOR UPDATE', [
          second.id,
        ]);
        cancelling = send(
          `/admin/moderation/actions/${second.id}/cancel`,
          { reason: '이의' },
          admin,
        );
        await waitForLockWaiter(rowHolder, 'the cancellation on the hold’s row');
        picks = Promise.all([
          changeNickname(member, '두번째사칭'),
          changeNickname(reporter, '두번째사칭'),
        ]);
        await waitForLockWaiter(rowHolder, 'the two picks on the nickname’s lock', 3);
        await rowHolder.query('COMMIT');
        open = false;
        expect((await cancelling).statusCode).toBe(200);
        const [mine, theirs] = await picks;
        expect(mine!.statusCode, mine!.body).toBe(200);
        expect(theirs!.statusCode, theirs!.body).toBe(409);
        expect(theirs!.json<{ error: unknown }>().error).toMatchObject({
          code: 'NICKNAME_NOT_ALLOWED',
          details: { reason: 'taken' },
        });
        expect((await profileRow(member.id)).nickname).toBe('두번째사칭');
      } finally {
        if (open) await rowHolder.query('ROLLBACK');
        rowHolder.release();
        await cancelling?.catch(() => undefined);
        await picks?.catch(() => undefined);
      }
    });

    it('draws past a nickname held from the member and one another account has in any case', async () => {
      const [held, taken, free] = ['user_2222', 'user_3333', 'user_4444'];
      await t.db
        .update(schema.profiles)
        .set({ nickname: '사칭닉네임' })
        .where(eq(schema.profiles.userId, author.id));
      // Given up by another account a day ago: held from the member (#57-6).
      await t.db
        .insert(schema.nicknameHolds)
        .values({ nickname: held, userId: reporter.id, releasedAt: new Date(Date.now() - DAY_MS) });
      // Another account's nickname, in another case.
      await t.db
        .update(schema.profiles)
        .set({ nickname: 'User_3333' })
        .where(eq(schema.profiles.userId, other.id));
      actionOf(
        await withDraws([held, taken, free], () =>
          send(`/admin/moderation/users/${author.id}/nickname-reset`, { reason: 'spam' }, admin),
        ),
      );
      expect((await profileRow(author.id)).nickname).toBe(free);
      // Ten draws that are all held: nothing changes, and the operator is told it failed.
      const third = await onboarded();
      await t.db
        .update(schema.profiles)
        .set({ nickname: '두번째사칭' })
        .where(eq(schema.profiles.userId, third.id));
      const failed = await withDraws(Array<string>(10).fill(held), () =>
        send(`/admin/moderation/users/${third.id}/nickname-reset`, { reason: 'spam' }, admin),
      );
      expect(failed.statusCode).toBe(500);
      expect(failed.json<{ error: { code: string } }>().error.code).toBe('INTERNAL');
      expect((await profileRow(third.id)).nickname).toBe('두번째사칭');
      expect(
        await t.db
          .select()
          .from(schema.nicknameHolds)
          .where(eq(schema.nicknameHolds.nickname, '두번째사칭')),
      ).toEqual([]);
      expect(
        await t.db
          .select()
          .from(schema.moderationActions)
          .where(eq(schema.moderationActions.userId, third.id)),
      ).toEqual([]);
      expect(await audits('moderation_nickname_reset')).toHaveLength(1);
    });

    it('refuses every profile item on the operator themselves', async () => {
      await t.db
        .update(schema.profiles)
        .set({ nickname: '운영자닉네임', bio: '운영자 소개' })
        .where(eq(schema.profiles.userId, admin.id));
      const image = await createProfileImage(t.db, { userId: admin.id, contentType: 'image/png' });
      for (const route of ['nickname-reset', 'bio-clear', 'image-remove']) {
        expect(
          refusalOf(
            await send(`/admin/moderation/users/${admin.id}/${route}`, { reason: 'spam' }, admin),
          ),
        ).toBe('own');
      }
      expect(await profileRow(admin.id)).toMatchObject({
        nickname: '운영자닉네임',
        bio: '운영자 소개',
        imageId: image.id,
      });
      expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
    });

    it('empties the 소개, kept for operators', async () => {
      expect(
        refusalOf(
          await send(`/admin/moderation/users/${author.id}/bio-clear`, { reason: 'spam' }, admin),
        ),
      ).toBe('nothing_to_remove');
      await t.db
        .update(schema.profiles)
        .set({ bio: '홍보 링크' })
        .where(eq(schema.profiles.userId, author.id));
      const action = actionOf(
        await send(`/admin/moderation/users/${author.id}/bio-clear`, { reason: 'spam' }, admin),
      );
      expect(action.removed).toEqual({ item: 'bio', bio: '홍보 링크' });
      const profile = dataOf<{ bio: string | null }>(
        await read(`/profiles/${await publicIdOf(author.id)}`),
      );
      expect(profile.bio).toBeNull();
    });

    it('removes the image: served to nobody, kept for operators at their own address', async () => {
      const image = await createProfileImage(t.db, { userId: author.id, contentType: 'image/png' });
      await t.storage.put(image.storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
      expect((await read(`/media/${image.id}`)).statusCode).toBe(200);
      const action = actionOf(
        await send(
          `/admin/moderation/users/${author.id}/image-remove`,
          { reason: 'personal_info' },
          admin,
        ),
      );
      expect(action.removed).toEqual({
        item: 'image',
        imageUrl: `/api/v1/admin/media/${image.id}`,
      });
      expect((await read(`/media/${image.id}`)).statusCode).toBe(404);
      const [row] = await t.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, image.id));
      expect(row).toMatchObject({ kind: 'profile_image' });
      expect(row?.attachedAt).not.toBeNull();
      const kept = await read(`/admin/media/${image.id}`, other);
      expect(kept.statusCode).toBe(200);
      expect(kept.headers['content-type']).toBe('image/png');
      // A copy for this operator's browser alone, asked again on every use (`answerImage`, as the
      // admin's notice images — ADR-0081 결과 5).
      expect(kept.headers['cache-control']).toBe('private, no-cache');
      expect(kept.headers.etag).toBe(`"${image.id}"`);
      expect((await read(`/admin/media/${image.id}`, author)).statusCode).toBe(403);
      // Nothing left to remove.
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${author.id}/image-remove`,
            { reason: 'spam' },
            admin,
          ),
        ),
      ).toBe('nothing_to_remove');
    });

    it('serves an operator the kept image as every image read is served: revalidated, within the reads’ budget and the API’s memory, a HEAD from the row (ADR-0073 9-36 and 9-46)', async () => {
      // The restack onto #46's last commits (ADR-0081 결과 5): `GET /admin/media/:mediaId` answers
      // through `answerImage`, as `GET /media/:mediaId` and the admin's notice images do — it took
      // no share of either before, so an operator's reads could hold the API's memory past both.
      const MiB = 1024 * 1024;
      const image = await createProfileImage(t.db, { userId: author.id, contentType: 'image/png' });
      await t.storage.put(image.storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
      const url = `/api/v1/admin/media/${image.id}`;
      const revalidated = await t.app.inject({
        method: 'GET',
        url,
        headers: { cookie: other.cookie, 'if-none-match': `"${image.id}"` },
      });
      expect(revalidated.statusCode).toBe(304);
      // Other reads hold the whole budget: refused unread, with Retry-After; given back once sent.
      const others = imageReads.take(IMAGE_READ_BUDGET_BYTES);
      expect(others).not.toBeNull();
      try {
        const busy = await read(`/admin/media/${image.id}`, other);
        expect(busy.statusCode).toBe(429);
        expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
        expect(busy.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      } finally {
        others?.();
      }
      expect((await read(`/admin/media/${image.id}`, other)).statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });
      const get = vi.spyOn(t.storage, 'get');
      const readMs = memoryWaits.readMs;
      try {
        // The headers a GET would carry, the length the row's, and no store read nor share.
        const head = await t.app.inject({ method: 'HEAD', url, headers: { cookie: other.cookie } });
        expect(head.statusCode).toBe(200);
        expect(head.rawPayload.length).toBe(0);
        expect(head.headers).toMatchObject({
          'content-type': 'image/png',
          'content-length': String(image.byteSize),
          'cache-control': 'private, no-cache',
          etag: `"${image.id}"`,
        });
        expect((await t.app.inject({ method: 'HEAD', url })).statusCode).toBe(401);
        // The API's memory full for the whole wait: refused unread with Retry-After.
        memoryAdmission.configure({ ceilingBytes: 416 * MiB, resident: () => 416 * MiB });
        memoryWaits.readMs = 100;
        const busy = await read(`/admin/media/${image.id}`, other);
        expect(busy.statusCode).toBe(429);
        expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
        expect(get).not.toHaveBeenCalled();
        expect(imageReads.size).toBe(0);
        expect(memoryAdmission.heldBytes).toBe(0);
      } finally {
        memoryAdmission.configure({ ceilingBytes: null });
        memoryWaits.readMs = readMs;
        get.mockRestore();
      }
      expect((await read(`/admin/media/${image.id}`, other)).statusCode).toBe(200);
      // An unknown id, as an image that is not there.
      expect((await read(`/admin/media/${crypto.randomUUID()}`, other)).statusCode).toBe(404);
    });
  });

  describe('the operators’ reads', () => {
    it('groups the queue by target, the one waiting longest first, then the processed ones', async () => {
      const profilePublicId = await publicIdOf(author.id);
      await report(`/posts/${post.id}`);
      await report(`/comments/${comment.id}`);
      await report(`/posts/${post.id}`, await onboarded(), 'harassment');
      const onProfile = await report(`/profiles/${profilePublicId}`, reporter, 'impersonation');
      const pending = await queue(undefined, other);
      expect(pending.map((group) => group.target)).toEqual([
        { type: 'post', postId: post.id },
        { type: 'comment', commentId: comment.id, postId: post.id },
        { type: 'profile', userId: author.id },
      ]);
      expect(pending[0]).toMatchObject({
        user: { id: author.id },
        state: 'published',
        title: '근거 글',
        excerpt: '본문 첫 줄',
        pendingCount: 2,
        reportCount: 2,
        reporterCount: 2,
        reasons: [
          { reason: 'spam', count: 1 },
          { reason: 'harassment', count: 1 },
        ],
        lastResolvedAt: null,
      });
      // A page at a time.
      const page = await read('/admin/reports?limit=2', admin);
      const meta = page.json<{ meta: { nextCursor: string | null } }>().meta;
      expect(meta.nextCursor).not.toBeNull();
      const next = dataOf<AdminReportGroup[]>(
        await read(`/admin/reports?limit=2&cursor=${encodeURIComponent(meta.nextCursor!)}`, admin),
      );
      expect(next.map((group) => group.target.type)).toEqual(['profile']);
      // Processed, the target moves to the resolved part.
      await send(
        '/admin/reports/dismiss',
        { reportIds: [onProfile.id], reason: '위반 아님' },
        admin,
      );
      expect((await queue()).map((group) => group.target.type)).toEqual(['post', 'comment']);
      const resolved = await queue('resolved');
      expect(resolved).toEqual([
        expect.objectContaining({
          target: { type: 'profile', userId: author.id },
          pendingCount: 0,
          firstPendingAt: null,
          reasons: [{ reason: 'impersonation', count: 1 }],
        }),
      ]);
    });

    it('pages the processed targets, the latest processing first', async () => {
      const now = Date.now();
      const processed = [
        { postId: post.id, hoursAgo: 3 },
        { commentId: comment.id, hoursAgo: 2 },
        { hoursAgo: 1 },
      ];
      for (const { hoursAgo, ...target } of processed) {
        await createReport(t.db, {
          ...target,
          reporterId: reporter.id,
          reportedUserId: author.id,
          status: 'dismissed',
          resolvedAt: new Date(now - hoursAgo * HOUR_MS),
          resolvedBy: admin.id,
          dismissalReason: '위반 아님',
          createdAt: new Date(now - 5 * HOUR_MS),
        });
      }
      const first = await read('/admin/reports?status=resolved&limit=2', admin);
      expect(dataOf<AdminReportGroup[]>(first).map((group) => group.target)).toEqual([
        { type: 'profile', userId: author.id },
        { type: 'comment', commentId: comment.id, postId: post.id },
      ]);
      const cursor = first.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor;
      expect(cursor).not.toBeNull();
      const second = await read(
        `/admin/reports?status=resolved&limit=2&cursor=${encodeURIComponent(cursor!)}`,
        admin,
      );
      expect(dataOf<AdminReportGroup[]>(second).map((group) => group.target)).toEqual([
        { type: 'post', postId: post.id },
      ]);
      expect(second.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor).toBeNull();
    });

    it('shows a post whatever its state, its history, its reports with their reporters and the author’s record', async () => {
      await t.db.insert(schema.postRevisions).values({
        postId: post.id,
        title: '처음 제목',
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '처음' }] }],
        },
        bodyText: '처음',
        imageIds: [],
        writtenAt: new Date(Date.now() - 60_000),
      });
      const first = await report(`/posts/${post.id}`);
      const onProfile = await report(
        `/profiles/${await publicIdOf(author.id)}`,
        reporter,
        'impersonation',
      );
      // The comments under it, reported or not: a 대댓글 after its 댓글, and one gone from every
      // view, which operators still reach.
      const reply = await createComment(t.db, {
        postId: post.id,
        authorId: reporter.id,
        parentId: comment.id,
        body: '대댓글',
        createdAt: new Date(Date.now() + 2_000),
      });
      const gone = await createComment(t.db, {
        postId: post.id,
        authorId: reporter.id,
        body: '지운 댓글',
        createdAt: new Date(Date.now() + 1_000),
        deletedAt: new Date(Date.now() + 3_000),
      });
      const warned = actionOf(
        await send(`/admin/moderation/users/${author.id}/warn`, { reason: 'spam' }, admin),
      );
      const hidden = actionOf(
        await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin),
      );
      // The author deletes it afterwards: the original stays for operators.
      await t.db
        .update(schema.posts)
        .set({ deletedAt: new Date() })
        .where(eq(schema.posts.id, post.id));
      const page = adminPostModerationSchema.parse(
        dataOf(await read(`/admin/moderation/posts/${post.id}`, other)),
      );
      expect(page).toMatchObject({
        id: post.id,
        state: 'deleted',
        title: '근거 글',
        author: { id: author.id },
        revisions: [{ title: '처음 제목' }],
        reporterCount: 1,
        purgedAt: null,
      });
      expect(page.reports).toHaveLength(1);
      expect(page.reports[0]).toMatchObject({
        id: first.id,
        reporter: { id: reporter.id },
        status: 'actioned',
        actionId: hidden.id,
      });
      expect(page.actions.map((action) => action.id)).toEqual([hidden.id]);
      expect(page.authorActions.map((action) => action.id)).toEqual([hidden.id, warned.id]);
      expect(
        page.comments.map(({ id, parentId, author: by, state, excerpt }) => ({
          id,
          parentId,
          author: by.id,
          state,
          excerpt,
        })),
      ).toEqual([
        { id: comment.id, parentId: null, author: author.id, state: 'published', excerpt: '댓글' },
        {
          id: reply.id,
          parentId: comment.id,
          author: reporter.id,
          state: 'published',
          excerpt: '대댓글',
        },
        { id: gone.id, parentId: null, author: reporter.id, state: 'gone', excerpt: '지운 댓글' },
      ]);
      expect((await read(`/admin/moderation/posts/${UNKNOWN}`, admin)).statusCode).toBe(404);

      const commentPage = adminCommentModerationSchema.parse(
        dataOf(await read(`/admin/moderation/comments/${comment.id}`, admin)),
      );
      expect(commentPage).toMatchObject({
        id: comment.id,
        state: 'published',
        body: '댓글',
        post: { id: post.id, state: 'deleted' },
        authorActions: [{ id: hidden.id }, { id: warned.id }],
        purgedAt: null,
      });

      const userPage = adminUserModerationSchema.parse(
        dataOf(await read(`/admin/moderation/users/${author.id}`, admin)),
      );
      expect(userPage.user.id).toBe(author.id);
      // The profile's reports alone: the member's post report is the post's (its 기각 and the
      // warning's default subject act on this list).
      expect(userPage.reports.map((row) => row.id)).toEqual([onProfile.id]);
      expect(userPage.reporterCount).toBe(1);
      expect(userPage.actions.map((action) => action.id)).toEqual([hidden.id, warned.id]);
      expect((await read('/admin/moderation/users/unknown-user', admin)).statusCode).toBe(404);

      const all = dataOf<AdminModerationAction[]>(await read('/admin/moderation/actions', other));
      expect(all.map((action) => action.id)).toEqual([hidden.id, warned.id]);
    });

    it('says when the retention emptied a deleted original (#184)', async () => {
      const deletedAt = new Date(Date.now() - 60_000);
      const purgedAt = new Date();
      await t.db.update(schema.posts).set({ deletedAt }).where(eq(schema.posts.id, post.id));
      // As the worker's retention.purge leaves it (migration 0042).
      await t.db
        .update(schema.posts)
        .set({
          title: null,
          body: { type: 'doc', content: [] },
          bodyText: '',
          imageIds: [],
          purgedAt,
        })
        .where(eq(schema.posts.id, post.id));
      const gone = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        body: '지운 댓글',
        deletedAt,
      });
      await t.db
        .update(schema.postComments)
        .set({ body: '', purgedAt })
        .where(eq(schema.postComments.id, gone.id));
      const page = adminPostModerationSchema.parse(
        dataOf(await read(`/admin/moderation/posts/${post.id}`, admin)),
      );
      expect(page).toMatchObject({
        state: 'deleted',
        title: null,
        body: { type: 'doc', content: [] },
        deletedAt: deletedAt.toISOString(),
        purgedAt: purgedAt.toISOString(),
      });
      const commentPage = adminCommentModerationSchema.parse(
        dataOf(await read(`/admin/moderation/comments/${gone.id}`, admin)),
      );
      expect(commentPage).toMatchObject({ body: '', purgedAt: purgedAt.toISOString() });
    });

    it('finds a member’s page by the public id of their profile’s address, as a public profile’s 운영 link does (owner decision 2026-10-21)', async () => {
      const publicId = await publicIdOf(author.id);
      await report(`/profiles/${publicId}`, reporter, 'impersonation');
      actionOf(await send(`/admin/moderation/users/${author.id}/warn`, { reason: 'spam' }, admin));
      const byAccount = dataOf<unknown>(await read(`/admin/moderation/users/${author.id}`, admin));
      const byProfile = adminUserModerationSchema.parse(
        dataOf(await read(`/admin/moderation/profiles/${publicId}`, admin)),
      );
      // The same page, whichever way it was found.
      expect(byProfile).toEqual(byAccount);
      expect(byProfile.user).toMatchObject({ id: author.id, publicId });
      expect(byProfile.reports).toHaveLength(1);
      expect(byProfile.actions).toHaveLength(1);
      // Any case of the id, as the public profile reads it.
      expect(
        dataOf<{ user: { id: string } }>(
          await read(`/admin/moderation/profiles/${publicId.toUpperCase()}`, admin),
        ).user.id,
      ).toBe(author.id);
      // Another member's page by theirs; a public id nobody has, one not of the shape and an
      // account id are each 404 — the account id finds nothing here.
      expect(
        dataOf<{ user: { id: string } }>(
          await read(`/admin/moderation/profiles/${await publicIdOf(reporter.id)}`, admin),
        ).user.id,
      ).toBe(reporter.id);
      const unknownPublicId = publicId === 'zzzzzzzzzz' ? 'yyyyyyyyyy' : 'zzzzzzzzzz';
      for (const id of [unknownPublicId, 'not-an-id!', author.id]) {
        const res = await read(`/admin/moderation/profiles/${encodeURIComponent(id)}`, admin);
        expect({ id, status: res.statusCode }).toEqual({ id, status: 404 });
      }
    });

    it('never tells the member reported who reported, and keeps every count off the public answers', async () => {
      await report(`/posts/${post.id}`);
      actionOf(await send(`/admin/moderation/posts/${post.id}/hide`, { reason: 'spam' }, admin));
      for (const url of ['/me/posts', '/me/comments', '/me/moderation/actions', '/me/reports']) {
        const body = (await read(url, author)).body;
        expect({
          url,
          reporter: body.includes(reporter.id),
          admin: body.includes(admin.id),
        }).toEqual({
          url,
          reporter: false,
          admin: false,
        });
      }
      const publicAnswer = (await read(`/posts/${post.id}`)).body;
      expect(publicAnswer).not.toMatch(/report|moderation|warning/i);
      // The action's row holds the operator; the member's answer does not.
      const rows = await t.db
        .select()
        .from(schema.moderationActions)
        .where(
          and(
            eq(schema.moderationActions.userId, author.id),
            eq(schema.moderationActions.createdBy, admin.id),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });

  async function publicIdOf(userId: string): Promise<string> {
    const [row] = await t.db
      .select({ publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.publicId;
  }
});
