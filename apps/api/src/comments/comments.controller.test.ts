/**
 * 댓글·대댓글 (#48, ADR-0074; ADR-0069 decision 2 #45-2…#45-5) against the docker `test` profile: a
 * post's comments and their authors' writes, and what the comments change of the post (its
 * placeholder and its count). Pinned: anyone reads and only an account that finished the
 * onboarding writes or edits, while deleting one's own needs a session alone; two layers, a reply
 * to a 대댓글 joining its 댓글; oldest first, a page of 댓글 at a time (20 at most) with their first 50
 * 대댓글 and the rest 50 a page on the reply route, however large a thread (오너 결정 2026-10-21); plain
 * text, trimmed, line breaks kept, 1,000 characters; the author by public face only; edits keep
 * the operators' history; deletion and hiding as #45-5 says, for comments and now for posts; a
 * hidden or deleted post or 댓글 takes no new comment; writing never touches a balance, an order or
 * a position. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { closeDb, createDb, schema, type Db } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createPost,
  createUser,
  testDbUrls,
} from '@buddha/db/test';
import {
  COMMENT_BODY_EMPTY_MESSAGE,
  COMMENT_REPLIES_PAGE_SIZE,
  commentBodyTooLongMessage,
  commentDeletionSchema,
  commentThreadSchema,
  encodeKeyset,
  postCommentSchema,
  postSchema,
  publishedCommentSchema,
  type CommentThread,
  type Post,
  type PostSummary,
} from '@buddha/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LinkReviewService } from '../link-review/link-review.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { PostsService } from '../posts/posts.service.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { WriteLimitsService } from '../write-limits/write-limits.service.js';
import { CommentCursors } from './comment-cursor.js';
import { CommentsService } from './comments.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type ThreadPage = { data: CommentThread[]; meta: { nextCursor: string | null } };

/** A node of `EXPLAIN (ANALYZE, FORMAT JSON)`'s plan, as far as these tests read it. */
interface ExplainedPlan {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainedPlan[];
}

describe.skipIf(!hasTestInfra)('/api/v1 comments (integration)', () => {
  let t: TestApp;
  let author: TestUser;
  let other: TestUser;
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
    author = await signUpTestUser(t);
    other = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: author.id });
    await completeOnboarding(t.db, { userId: other.id });
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, { marketId: market.id, authorId: author.id, title: '근거 글' });
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: unknown, who: TestUser | null) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify(payload),
    });

  /** `POST /posts/:postId/comments` as `who`, on the post of the test unless `postId` says. */
  const write = (
    body: Record<string, unknown> = {},
    who: TestUser | null = author,
    postId = post.id,
  ) =>
    send(
      'POST',
      `/posts/${postId}/comments`,
      { body: '근거가 있나요?', expectedAccountId: who?.id ?? 'x', ...body },
      who,
    );
  const written = async (body: Record<string, unknown> = {}, who: TestUser = author) => {
    const res = await write(body, who);
    expect(res.statusCode, res.body).toBe(201);
    return publishedCommentSchema.parse(res.json<{ data: unknown }>().data);
  };
  const reply = (parentId: string, body = '답입니다', who: TestUser = author) =>
    written({ parentId, body }, who);
  const edit = (commentId: string, body: string, who: TestUser = author) =>
    send('PUT', `/comments/${commentId}`, { body, expectedAccountId: who.id }, who);
  const remove = (commentId: string, who: TestUser = author) =>
    send('POST', `/comments/${commentId}/delete`, { expectedAccountId: who.id }, who);

  const listing = (query = '', postId = post.id, cookie?: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments${query === '' ? '' : `?${query}`}`,
      headers: cookie ? { cookie } : {},
    });
  const page = async (query = '', postId = post.id): Promise<ThreadPage> => {
    const res = await listing(query, postId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ThreadPage>();
    for (const thread of body.data) commentThreadSchema.parse(thread);
    return body;
  };
  /** The threads as `[id or state, [reply ids or states]]`, a placeholder named by its state. */
  const shape = async (postId = post.id) =>
    (await page('', postId)).data.map(({ comment, replies }) => [
      comment.state === 'published' ? comment.id : `${comment.state}:${comment.id}`,
      replies.map((one) => (one.state === 'published' ? one.id : `${one.state}:${one.id}`)),
    ]);
  const postPage = async (postId = post.id): Promise<Post> => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect(res.statusCode, res.body).toBe(200);
    return postSchema.parse(res.json<{ data: unknown }>().data);
  };
  const card = async (postId = post.id): Promise<PostSummary | undefined> => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/posts' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: PostSummary[] }>().data.find((row) => row.id === postId);
  };
  const errorOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; details?: unknown } }>().error;
  /** The public face of `who`: what a placeholder must never carry (#45-5). */
  const faceOf = async (who: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname, publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, who.id));
    return [profile!.nickname, profile!.publicId];
  };
  /** An operator's hiding (#50 brings the action): the row's time, as that action writes it. */
  const hide = async (table: 'posts' | 'postComments', id: string) => {
    if (table === 'posts') {
      await t.db.update(schema.posts).set({ hiddenAt: new Date() }).where(eq(schema.posts.id, id));
    } else {
      await t.db
        .update(schema.postComments)
        .set({ hiddenAt: new Date() })
        .where(eq(schema.postComments.id, id));
    }
  };

  // ---- writing and reading --------------------------------------------------------------------

  it('writes 댓글 and 대댓글 and shows them to everyone oldest first, the author by public face only', async () => {
    const first = await written({ body: '  첫 줄\r\n\r\n셋째 줄  ' });
    const second = await written({ body: '두 번째 댓글' }, other);
    const answer = await reply(first.id, '첫 답', other);
    const again = await reply(first.id, '둘째 답');
    expect(first).toMatchObject({
      state: 'published',
      parentId: null,
      body: '첫 줄\n\n셋째 줄',
      editedAt: null,
    });
    expect(answer).toMatchObject({ parentId: first.id, body: '첫 답' });
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, author.id));
    expect(first.author).toEqual({
      kind: 'member',
      publicId: profile!.publicId,
      nickname: profile!.nickname,
      imageUrl: null,
      isAdmin: false,
    });
    // Anyone reads: anonymously, as another account and as the author, the same answer.
    const anonymous = await listing();
    expect(anonymous.statusCode).toBe(200);
    expect((await listing('', post.id, other.cookie)).body).toBe(anonymous.body);
    expect((await listing('', post.id, author.cookie)).body).toBe(anonymous.body);
    expect(await shape()).toEqual([
      [first.id, [answer.id, again.id]],
      [second.id, []],
    ]);
    expect(anonymous.body).not.toContain(author.id);
    expect(anonymous.body).not.toContain(other.id);
    const [thread] = (await page()).data;
    expect(thread?.comment).toEqual(first);
    expect(thread?.replies[0]).toEqual(answer);
  });

  it('makes a reply to a 대댓글 another 대댓글 of its 댓글: two layers, never three (#45-2)', async () => {
    const comment = await written();
    const answer = await reply(comment.id, '답', other);
    const toTheAnswer = await reply(answer.id, '답의 답');
    expect(toTheAnswer.parentId).toBe(comment.id);
    expect(await shape()).toEqual([[comment.id, [answer.id, toTheAnswer.id]]]);
    const rows = await t.db.select().from(schema.postComments);
    expect(rows.filter((row) => row.parentId === answer.id)).toEqual([]);
  });

  it('refuses a parent that is no comment of this post, naming parentId', async () => {
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const foreign = await createComment(t.db, { postId: elsewhere.id, authorId: author.id });
    for (const parentId of [foreign.id, '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60']) {
      const res = await write({ parentId });
      expect(res.statusCode, res.body).toBe(404);
      expect(errorOf(res).details).toEqual([
        { path: ['parentId'], message: 'no such comment on this post' },
      ]);
    }
    expect((await write({ parentId: 'x' })).statusCode).toBe(400);
    expect((await write({}, author, '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60')).statusCode).toBe(404);
    expect((await listing('', 'nope')).statusCode).toBe(400);
    expect((await t.db.select().from(schema.postComments)).map((row) => row.id)).toEqual([
      foreign.id,
    ]);
  });

  it('pages 댓글 oldest first with the 대댓글 under each, ties by id, no deleted one taking a place', async () => {
    const base = Date.now() - 60_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const make = (seconds: number, extra: Partial<Parameters<typeof createComment>[1]> = {}) =>
      createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        createdAt: at(seconds),
        ...extra,
      });
    const a = await make(1);
    const tieOne = await make(2);
    const tieTwo = await make(2);
    const [b, c] = [tieOne, tieTwo].sort((x, y) => (x.id < y.id ? -1 : 1));
    // Deleted with nothing under it: in no page, so the second page is still full.
    await make(3, { deletedAt: new Date() });
    const d = await make(4);
    const e = await make(5);
    // 대댓글 written in another order than they were dated: shown by their time.
    const late = await make(30, { parentId: a.id });
    const early = await make(20, { parentId: a.id });
    const first = await page('limit=2');
    expect(first.data.map(({ comment }) => comment.id)).toEqual([a.id, b!.id]);
    expect(first.data[0]?.replies.map((one) => one.id)).toEqual([early.id, late.id]);
    const second = await page(`limit=2&cursor=${first.meta.nextCursor!}`);
    expect(second.data.map(({ comment }) => comment.id)).toEqual([c!.id, d.id]);
    const third = await page(`limit=2&cursor=${second.meta.nextCursor!}`);
    expect(third.data.map(({ comment }) => comment.id)).toEqual([e.id]);
    expect(third.meta.nextCursor).toBeNull();
    // The cursors are sealed for this post's list (오너 결정 2026-10-21 (2차) 답 3): one that does not
    // open — not a cursor, the plain keyset these lists gave before, another post's (a thread's:
    // the next test, which has one) — is a VALIDATION_ERROR naming `cursor`, not the first page the
    // web would draw twice.
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: author.id });
    await createComment(t.db, { postId: elsewhere.id, authorId: author.id, createdAt: at(1) });
    await createComment(t.db, { postId: elsewhere.id, authorId: author.id, createdAt: at(2) });
    const foreign = await page('limit=1', elsewhere.id);
    for (const cursor of [
      'garbage',
      encodeKeyset({ createdAt: b!.createdAt, id: b!.id }),
      foreign.meta.nextCursor!,
    ]) {
      const res = await listing(`limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(res.statusCode, cursor).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['cursor'] }],
      });
    }
  });

  it('pages the 댓글 in view through two walks — the undeleted ones and those 대댓글 in view hang under — in one order, ties by id across the two', async () => {
    // Codex review on PR #220 (ADR-0074 7-31): the page reads the undeleted 댓글 down one
    // index and the deleted 댓글 still in view through their undeleted 대댓글 down another, and
    // takes the first of the two together. Every kind of 댓글, interleaved and tied, paged at every
    // size: the pages together are the 댓글 in view, oldest first, ties by id, each page full while
    // more follow — whichever walk the page's last 댓글 came from.
    const base = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const root = (seconds: number, extra: Partial<Parameters<typeof createComment>[1]> = {}) =>
      createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        createdAt: at(seconds),
        ...extra,
      });
    const under = (
      parentId: string,
      seconds: number,
      extra: { deletedAt?: Date; hiddenAt?: Date } = {},
    ) =>
      createComment(t.db, {
        postId: post.id,
        authorId: other.id,
        parentId,
        createdAt: at(seconds),
        ...extra,
      });
    const gone = new Date();
    const inView: { id: string; createdAt: Date }[] = [];
    const kinds = [
      'live',
      'live-with-replies',
      'hidden',
      'placeholder',
      'placeholder-hidden-reply',
      'dead',
      'dead-deleted-replies',
      'hidden-placeholder',
    ] as const;
    const deletedKinds: readonly string[] = [
      'placeholder',
      'placeholder-hidden-reply',
      'dead',
      'dead-deleted-replies',
      'hidden-placeholder',
    ];
    for (let round = 0; round < 3; round += 1) {
      // Three 댓글 of each kind a round: one of each kind at one moment, again at another — ties
      // within and across the two walks, broken by id — and one of each kind a moment apart.
      for (let slot = 0; slot < 3; slot += 1) {
        for (const [index, kind] of kinds.entries()) {
          const seconds = 10 + round * 100 + slot * 20 + (slot === 2 ? index : 0);
          const row = await root(seconds, {
            ...(deletedKinds.includes(kind) ? { deletedAt: gone } : {}),
            ...(kind === 'hidden' || kind === 'hidden-placeholder' ? { hiddenAt: gone } : {}),
          });
          switch (kind) {
            case 'live-with-replies':
            case 'placeholder':
            case 'hidden-placeholder':
              await under(row.id, 500 + seconds, { deletedAt: gone });
              await under(row.id, 501 + seconds);
              break;
            case 'placeholder-hidden-reply':
              await under(row.id, 500 + seconds, { hiddenAt: gone });
              break;
            case 'dead-deleted-replies':
              await under(row.id, 500 + seconds, { deletedAt: gone });
              await under(row.id, 501 + seconds, { deletedAt: gone });
              break;
            default:
              break;
          }
          if (kind !== 'dead' && kind !== 'dead-deleted-replies') inView.push(row);
        }
      }
    }
    const expected = [...inView]
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1))
      .map((row) => row.id);
    expect(expected).toHaveLength(3 * 3 * 6);
    for (const limit of [1, 2, 3, 7, 20]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const one: ThreadPage = await page(
          `limit=${String(limit)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        seen.push(...one.data.map(({ comment }) => comment.id));
        cursor = one.meta.nextCursor;
        if (cursor === null) break;
        expect(one.data, `limit ${String(limit)}`).toHaveLength(limit);
      }
      expect(seen, `limit ${String(limit)}`).toEqual(expected);
    }
  });

  it('walks no deleted comment out of view: a page and a reply page cost what is in view, however many were written and deleted (Codex review on PR #220)', async () => {
    // Thousands of 댓글 written and deleted with nothing under them, before and after the ones in
    // view, and thousands of 대댓글 deleted before a thread's first one in view — under an
    // undeleted 댓글 and under a deleted one kept as its placeholder. Every statement the comment
    // page and the reply page run is explained as it runs (EXPLAIN ANALYZE, BUFFERS), on a table
    // with statistics and with another post's comments in its indexes: the rows they read of
    // `post_comments` and the pages they touch stay with what the answers carry, never the deleted
    // history (ADR-0074 7-31, which records the plans). The indexes holding no deleted comment are
    // schema.test.ts's to pin; this pins that the statements read them, and read them by their
    // leading columns.
    const DEAD = 3_000;
    const ELSEWHERE = 5_000;
    const base = Date.now() - 86_400_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const deadRoots = (fromSeconds: number) =>
      t.db.execute(sql`
        INSERT INTO post_comments (post_id, author_id, body, created_at, deleted_at)
        SELECT ${post.id}::uuid, ${other.id}::text, '지운 댓글 ' || n,
               ${at(fromSeconds).toISOString()}::timestamptz + make_interval(secs => n::double precision / 10),
               now()
        FROM generate_series(1, ${DEAD}) AS n`);
    const deadReplies = (parentId: string, fromSeconds: number) =>
      t.db.execute(sql`
        INSERT INTO post_comments (post_id, parent_id, parent_created_at, author_id, body, created_at, deleted_at)
        SELECT ${post.id}::uuid, ${parentId}::uuid,
               (SELECT created_at FROM post_comments WHERE id = ${parentId}::uuid),
               ${other.id}::text, '지운 답 ' || n,
               ${at(fromSeconds).toISOString()}::timestamptz + make_interval(secs => n::double precision / 10),
               now()
        FROM generate_series(1, ${DEAD}) AS n`);
    await deadRoots(0);
    const live = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(1_000),
    });
    const placeholder = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(1_001),
      deletedAt: new Date(),
    });
    await deadReplies(live.id, 1_100);
    await deadReplies(placeholder.id, 1_100);
    for (const thread of [live, placeholder]) {
      for (let index = 0; index < 3; index += 1) {
        await createComment(t.db, {
          postId: post.id,
          authorId: other.id,
          parentId: thread.id,
          createdAt: at(2_000 + index),
        });
      }
    }
    await deadRoots(3_000);
    const after = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(4_000),
    });
    await deadRoots(5_000);
    // Another post's comments, all in view — 댓글 each with a 대댓글 — so the indexes of the comments
    // not deleted are not this post's alone: a statement that read one off its leading columns (a
    // thread's 대댓글 down the post's 대댓글 by their `parent_id`) would walk all of it, which the
    // rows a scan returns do not show and the pages it touches do.
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: author.id });
    await t.db.execute(sql`
      INSERT INTO post_comments (post_id, author_id, body, created_at)
      SELECT ${elsewhere.id}::uuid, ${other.id}::text, '다른 글의 댓글 ' || n,
             ${at(0).toISOString()}::timestamptz + make_interval(secs => n::double precision)
      FROM generate_series(1, ${ELSEWHERE}) AS n`);
    await t.db.execute(sql`
      INSERT INTO post_comments (post_id, parent_id, parent_created_at, author_id, body, created_at)
      SELECT post_id, id, created_at, author_id, '다른 글의 답', created_at + interval '1 second'
      FROM post_comments
      WHERE post_id = ${elsewhere.id}::uuid`);
    // Planned as a database with statistics plans them (autovacuum analyzes), not as a table never
    // measured, where a small partial index read off its leading columns can look cheapest — the
    // plan the review found the deleted 대댓글 hiding behind. The profiles the pages join are
    // measured too: left unmeasured (some 290 rows assumed for the three here), the reply page
    // could merge-join them down the authors' index and read every comment of the two authors,
    // as the random ids of the accounts fell — about one run in three. ANALYZE is the owner's.
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await owner.execute(sql`ANALYZE post_comments, profiles`);
    } finally {
      await closeDb(owner);
    }

    // The service on a database handle that records each statement it sends.
    const statements: { text: string; values: unknown[] }[] = [];
    const recording: Db = drizzle({
      client: t.db.$client,
      schema,
      casing: 'snake_case',
      logger: { logQuery: (text, values) => statements.push({ text, values }) },
    });
    const service = new CommentsService(
      recording,
      t.app.get(CommentCursors),
      t.app.get(WriteLimitsService),
      t.app.get(LinkReviewService),
    );
    /** Rows of `post_comments` a plan's scans read: those they kept and those they filtered out. */
    const commentRowsRead = (plan: ExplainedPlan): number =>
      (plan['Relation Name'] === 'post_comments'
        ? (plan['Actual Rows'] +
            (plan['Rows Removed by Filter'] ?? 0) +
            (plan['Rows Removed by Index Recheck'] ?? 0)) *
          plan['Actual Loops']
        : 0) + (plan.Plans ?? []).reduce((sum, child) => sum + commentRowsRead(child), 0);
    /**
     * Pages a statement touched (shared buffers hit and read; a node counts its children's): an
     * index walked off its leading columns shows here, where the rows it returns are few.
     */
    const pagesTouched = (plan: ExplainedPlan): number =>
      (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
    const readBy = async (run: () => Promise<unknown>) => {
      statements.length = 0;
      await run();
      let rows = 0;
      let pages = 0;
      for (const { text, values } of statements) {
        const explained = await t.db.$client.query<{ 'QUERY PLAN': [{ Plan: ExplainedPlan }] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
          values,
        );
        const plan = explained.rows[0]!['QUERY PLAN'][0].Plan;
        rows += commentRowsRead(plan);
        pages += pagesTouched(plan);
      }
      return { rows, pages, statements: statements.length };
    };

    const listed = await service.list(post.id, { limit: 20 });
    expect(listed.items.map(({ comment }) => [comment.state, comment.id])).toEqual([
      ['published', live.id],
      ['deleted', placeholder.id],
      ['published', after.id],
    ]);
    expect(listed.items.map(({ replies }) => replies.length)).toEqual([3, 3, 0]);
    // The post's state, its 댓글 and their 대댓글: a few rows each — not the 9,000 댓글 and 6,000
    // 대댓글 deleted — and a few pages: the ceilings below stand well above what the readings touch
    // (69, 46, 22 and 11 on Postgres 16) and well below what they touched with a thread's 대댓글
    // read down the post's 대댓글 index by their `parent_id` (some 320, 170, 100 and 90, the rows as
    // few as here — ADR-0074 decision 8).
    const listing = await readBy(() => service.list(post.id, { limit: 20 }));
    expect(listing.statements).toBe(4);
    expect(listing.rows).toBeLessThan(40);
    expect(listing.pages).toBeLessThan(120);
    // A page whose cursor stands among the deleted ones, and the last (empty) page after them.
    const second = await readBy(() => service.list(post.id, { limit: 1 }));
    expect(second.rows).toBeLessThan(20);
    expect(second.pages).toBeLessThan(80);
    const firstPage = await service.list(post.id, { limit: 2 });
    const rest = await service.list(post.id, { limit: 2, cursor: firstPage.nextCursor! });
    expect(rest.items.map(({ comment }) => comment.id)).toEqual([after.id]);
    expect(rest.nextCursor).toBeNull();
    const lastPage = await readBy(() =>
      service.list(post.id, { limit: 2, cursor: firstPage.nextCursor! }),
    );
    expect(lastPage.rows).toBeLessThan(20);
    expect(lastPage.pages).toBeLessThan(50);
    // A thread's replies, under the undeleted 댓글 and under the placeholder: 3 in view, 3,000
    // deleted before them.
    for (const thread of [live, placeholder]) {
      const replies = await service.replies(thread.id, {});
      expect(replies.items).toHaveLength(3);
      const read = await readBy(() => service.replies(thread.id, {}));
      expect(read.rows).toBeLessThan(15);
      expect(read.pages).toBeLessThan(40);
    }
  });

  it('seals the cursors so a page ending on a placeholder does not tell its time (오너 결정 2026-10-21 (2차) 답 3)', async () => {
    // A deleted 댓글 kept as its placeholder (대댓글 hang under it) ends the first page; a hidden
    // 대댓글 ends its thread's first 50. Their answers carry their ids alone, and so do the cursors
    // after them: no time of writing in any spelling, and the next page still follows on.
    const base = Date.now() - 600_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000 + 123);
    const deleted = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(1),
      deletedAt: new Date(),
    });
    // The 50th 대댓글 by time, hidden; one more after it.
    const hiddenAt = at(2 + COMMENT_REPLIES_PAGE_SIZE - 1);
    for (let index = 0; index < COMMENT_REPLIES_PAGE_SIZE + 1; index += 1) {
      await createComment(t.db, {
        postId: post.id,
        authorId: other.id,
        parentId: deleted.id,
        createdAt: at(2 + index),
        ...(index === COMMENT_REPLIES_PAGE_SIZE - 1 ? { hiddenAt: new Date() } : {}),
      });
    }
    const later = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(100),
    });
    const res = await listing('limit=1');
    expect(res.statusCode, res.body).toBe(200);
    const first = res.json<ThreadPage>();
    expect(first.data[0]?.comment).toEqual({ state: 'deleted', id: deleted.id });
    expect(first.data[0]?.replies.at(-1)).toMatchObject({ state: 'hidden' });
    const cursors = [first.meta.nextCursor!, first.data[0]!.repliesNextCursor!];
    for (const time of [deleted.createdAt, hiddenAt]) {
      const millis = time.getTime();
      for (const spelling of [String(millis), time.toISOString(), millis.toString(16)]) {
        expect(res.body).not.toContain(spelling);
      }
      for (const cursor of cursors) {
        expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain(String(millis));
      }
    }
    expect((await page(`limit=1&cursor=${first.meta.nextCursor!}`)).data[0]?.comment.id).toBe(
      later.id,
    );
    // Sealed for its list: the thread's cursor reads on in that thread only.
    const replies = await t.app.inject({
      method: 'GET',
      url: `/api/v1/comments/${deleted.id}/replies?cursor=${cursors[1]!}`,
    });
    expect(replies.statusCode, replies.body).toBe(200);
    expect(replies.json<{ data: unknown[] }>().data).toHaveLength(1);
    // Not in another thread, nor in either other list: the 댓글 list of the same post takes no
    // thread's cursor, and the thread takes no cursor of the 댓글 list.
    const misplaced = [
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${later.id}/replies?cursor=${cursors[1]!}`,
      }),
      await listing(`limit=1&cursor=${encodeURIComponent(cursors[1]!)}`),
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${deleted.id}/replies?cursor=${cursors[0]!}`,
      }),
    ];
    for (const refused of misplaced) {
      expect(refused.statusCode, refused.body).toBe(400);
      expect(errorOf(refused)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['cursor'] }],
      });
    }
  });

  it('carries the first 50 대댓글 of each 댓글 and reads the rest 50 at a time (오너 결정 2026-10-21)', async () => {
    const base = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const thread = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(0),
    });
    const small = await createComment(t.db, {
      postId: post.id,
      authorId: other.id,
      createdAt: at(1),
    });
    // 120 대댓글 a second apart, written in reverse so the order is the time's, not the insert's;
    // a deleted one takes no place, a hidden one is its placeholder.
    const replies: string[] = [];
    for (let index = 119; index >= 0; index -= 1) {
      const row = await createComment(t.db, {
        postId: post.id,
        authorId: index % 2 === 0 ? author.id : other.id,
        parentId: thread.id,
        createdAt: at(10 + index),
        ...(index === 7 ? { deletedAt: new Date() } : {}),
        ...(index === 60 ? { hiddenAt: new Date() } : {}),
      });
      replies[index] = row.id;
    }
    const shown = replies.filter((_, index) => index !== 7);
    const smallReply = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      parentId: small.id,
      createdAt: at(500),
    });

    const listed = await page();
    expect(listed.data.map(({ comment }) => comment.id)).toEqual([thread.id, small.id]);
    const [big, little] = listed.data;
    expect(big!.replies.map((reply) => reply.id)).toEqual(shown.slice(0, 50));
    expect(big!.repliesNextCursor).not.toBeNull();
    expect(little).toMatchObject({ replies: [{ id: smallReply.id }], repliesNextCursor: null });

    const replyPage = async (commentId: string, cursor?: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${commentId}/replies${cursor === undefined ? '' : `?cursor=${cursor}`}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ data: unknown[]; meta: { nextCursor: string | null } }>();
      return {
        items: body.data.map((item) => postCommentSchema.parse(item)),
        nextCursor: body.meta.nextCursor,
      };
    };
    // Without a cursor: the page the comment list carries.
    const first = await replyPage(thread.id);
    expect(first.items).toEqual(big!.replies);
    expect(first.nextCursor).toBe(big!.repliesNextCursor);
    const second = await replyPage(thread.id, big!.repliesNextCursor!);
    expect(second.items.map((reply) => reply.id)).toEqual(shown.slice(50, 100));
    expect(second.items.find((reply) => reply.id === replies[60])).toEqual({
      state: 'hidden',
      id: replies[60],
    });
    const third = await replyPage(thread.id, second.nextCursor!);
    expect(third.items.map((reply) => reply.id)).toEqual(shown.slice(100));
    expect(third.nextCursor).toBeNull();
    // Anyone reads them, the same answer. A cursor that does not open for this thread — not a
    // cursor, the plain keyset, the comment page's, another thread's — is a VALIDATION_ERROR naming
    // `cursor` (오너 결정 2026-10-21 (2차) 답 3).
    const otherThread = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      parentId: null,
    });
    for (let index = 0; index < COMMENT_REPLIES_PAGE_SIZE + 1; index += 1) {
      await createComment(t.db, { postId: post.id, authorId: other.id, parentId: otherThread.id });
    }
    const otherCursor = (await page()).data.find(
      ({ comment }) => comment.id === otherThread.id,
    )!.repliesNextCursor!;
    const twoPages = await page('limit=1');
    for (const cursor of [
      'garbage',
      encodeKeyset({ createdAt: at(10 + 49), id: replies[49]! }),
      twoPages.meta.nextCursor!,
      otherCursor,
    ]) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${thread.id}/replies?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode, cursor).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: ['cursor'] }],
      });
    }
    const read = (cookie?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${thread.id}/replies`,
        headers: cookie === undefined ? {} : { cookie },
      });
    const anonymous = (await read()).body;
    expect((await read(other.cookie)).body).toBe(anonymous);
    expect((await read(author.cookie)).body).toBe(anonymous);
    expect(anonymous).not.toContain(author.id);
    expect(anonymous).not.toContain(other.id);
    // Exactly 50 under a 댓글: all of them here, no cursor.
    await t.db
      .update(schema.postComments)
      .set({ deletedAt: new Date() })
      .where(inArray(schema.postComments.id, shown.slice(50)));
    const fifty = (await page()).data[0]!;
    expect(fifty.replies).toHaveLength(50);
    expect(fifty.repliesNextCursor).toBeNull();
    expect((await replyPage(thread.id)).nextCursor).toBeNull();
  });

  it('answers NOT_FOUND for the replies of what is no thread in view', async () => {
    const thread = await written();
    const answer = await reply(thread.id);
    const replies = (commentId: string) =>
      t.app.inject({ method: 'GET', url: `/api/v1/comments/${commentId}/replies` });
    // A 대댓글 has no replies of its own (#45-2); an unknown id is no comment.
    expect((await replies(answer.id)).statusCode).toBe(404);
    expect((await replies('0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60')).statusCode).toBe(404);
    expect((await replies('nope')).statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/comments/${thread.id}/replies?cursor=`,
        })
      ).statusCode,
    ).toBe(400);
    // A hidden 댓글 and a deleted one kept as its placeholder still show what hangs under them.
    await hide('postComments', thread.id);
    expect((await replies(thread.id)).json<{ data: { id: string }[] }>().data).toEqual([
      expect.objectContaining({ id: answer.id }),
    ]);
    expect((await remove(thread.id)).statusCode).toBe(200);
    expect((await replies(thread.id)).statusCode).toBe(200);
    // Nothing under it any more: the 댓글 is gone from every view, its thread too.
    expect((await remove(answer.id)).statusCode).toBe(200);
    expect((await replies(thread.id)).statusCode).toBe(404);
  });

  it('breaks a tie of 대댓글 written at one moment by id, across the 50th and the cursor', async () => {
    const base = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const thread = await createComment(t.db, {
      postId: post.id,
      authorId: author.id,
      createdAt: at(0),
    });
    const before: string[] = [];
    for (let index = 0; index < 49; index += 1) {
      const row = await createComment(t.db, {
        postId: post.id,
        authorId: other.id,
        parentId: thread.id,
        createdAt: at(1 + index),
      });
      before.push(row.id);
    }
    // The 50th to the 52nd written at one moment, inserted in the reverse of their ids' order: the
    // time alone, or the table's own order, would put them wrong — and the page ends among them.
    const tied = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [...tied].reverse()) {
      await t.db.insert(schema.postComments).values({
        id,
        postId: post.id,
        authorId: other.id,
        parentId: thread.id,
        parentCreatedAt: thread.createdAt,
        body: `같은 때 ${id}`,
        createdAt: at(100),
      });
    }
    const after = await createComment(t.db, {
      postId: post.id,
      authorId: other.id,
      parentId: thread.id,
      createdAt: at(200),
    });
    const order = [...before, ...tied, after.id];

    const replyPage = async (cursor?: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/comments/${thread.id}/replies${cursor === undefined ? '' : `?cursor=${cursor}`}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ data: { id: string }[]; meta: { nextCursor: string | null } }>();
    };
    const [listed] = (await page()).data;
    expect(listed!.replies.map((reply) => reply.id)).toEqual(order.slice(0, 50));
    // The reply route's own first page is the same, and its cursor reads on with no gap and no
    // repeat: the other two of the tie, then the later one.
    const first = await replyPage();
    expect(first.data.map((reply) => reply.id)).toEqual(order.slice(0, 50));
    expect(first.meta.nextCursor).toBe(listed!.repliesNextCursor);
    const rest = await replyPage(listed!.repliesNextCursor!);
    expect(rest.data.map((reply) => reply.id)).toEqual(order.slice(50));
    expect(rest.meta.nextCursor).toBeNull();
    // The same reads with the 대댓글 index out of play — the rows sorted as the table holds them
    // (the tie in the reverse of the ids' order), not walked in the index's (created_at, id) order,
    // nor reordered by a hash join — so the id that breaks the tie is the queries' own ORDER BY's.
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await tx.execute(sql`SET LOCAL enable_hashjoin = off`);
      await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
      const sorted = new CommentsService(
        tx as unknown as Db,
        t.app.get(CommentCursors),
        t.app.get(WriteLimitsService),
        t.app.get(LinkReviewService),
      ) as unknown as {
        firstReplies(threadIds: string[]): Promise<{ id: string }[]>;
        replies(
          commentId: string,
          query: { cursor?: string },
        ): Promise<{ items: { id: string }[] }>;
      };
      expect((await sorted.firstReplies([thread.id])).map((row) => row.id)).toEqual(
        order.slice(0, 51),
      );
      const second = await sorted.replies(thread.id, { cursor: listed!.repliesNextCursor! });
      expect(second.items.map((reply) => reply.id)).toEqual(order.slice(50));
    });
  });

  it('reads a page of 20 댓글 at most, each with at most 50 대댓글, however large the thread', async () => {
    expect((await listing('limit=21')).statusCode).toBe(400);
    expect((await listing('limit=20')).statusCode).toBe(200);
    // A 댓글 with 5,000 대댓글 (written in one statement), beside 19 more with 60 each: the page
    // carries 50 of each, its query reads no more than one past that a 댓글, and the reply page
    // reads on from there.
    const big = await createComment(t.db, { postId: post.id, authorId: author.id });
    const rest = [];
    for (let index = 0; index < 19; index += 1) {
      rest.push(await createComment(t.db, { postId: post.id, authorId: other.id }));
    }
    const fill = (parentId: string, count: number) =>
      t.db.execute(sql`
        INSERT INTO post_comments (post_id, parent_id, parent_created_at, author_id, body, created_at)
        SELECT ${post.id}::uuid, ${parentId}::uuid,
               (SELECT created_at FROM post_comments WHERE id = ${parentId}::uuid),
               ${other.id}::text, '대댓글 ' || n,
               now() - make_interval(secs => (${count}::int - n)::double precision)
        FROM generate_series(1, ${count}) AS n`);
    await fill(big.id, 5_000);
    for (const thread of rest) await fill(thread.id, 60);
    const listed = await page();
    expect(listed.data).toHaveLength(20);
    for (const thread of listed.data) {
      expect(thread.replies).toHaveLength(50);
      expect(thread.repliesNextCursor).not.toBeNull();
    }
    // By its id: the 댓글 were written a moment apart by the database clock, and two in one
    // millisecond (`timestamp(3)`) are ordered by their random ids — the big one is not always
    // first, and the others' 대댓글 bear the same words.
    const bigThread = listed.data.find(({ comment }) => comment.id === big.id)!;
    expect(bigThread.replies.map((one) => (one.state === 'published' ? one.body : ''))).toEqual(
      Array.from({ length: 50 }, (_, index) => `대댓글 ${String(index + 1)}`),
    );
    // The bound is the query's, not the trim after it (Codex review on PR #220): the page's read of
    // the 대댓글 stops at COMMENT_REPLIES_PAGE_SIZE + 1 for each 댓글 — the one more says whether more
    // follow — so the 5,000 are never read. The answer above would be the same without it.
    // Its private read, reached through Nest's `get` (the result's type is the caller's to say).
    const service: {
      firstReplies(threadIds: string[]): Promise<{ parentId: string | null }[]>;
    } = t.app.get(CommentsService);
    const read = await service.firstReplies(listed.data.map(({ comment }) => comment.id));
    const perThread = new Map<string | null, number>();
    for (const row of read) perThread.set(row.parentId, (perThread.get(row.parentId) ?? 0) + 1);
    expect(perThread.size).toBe(20);
    expect(new Set(perThread.values())).toEqual(new Set([COMMENT_REPLIES_PAGE_SIZE + 1]));
    expect(read).toHaveLength(20 * (COMMENT_REPLIES_PAGE_SIZE + 1));
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/comments/${big.id}/replies?cursor=${bigThread.repliesNextCursor!}`,
    });
    const next = res.json<{ data: { body?: string }[]; meta: { nextCursor: string | null } }>();
    expect(next.data.map((one) => one.body)).toEqual(
      Array.from({ length: 50 }, (_, index) => `대댓글 ${String(index + 51)}`),
    );
    expect(next.meta.nextCursor).not.toBeNull();
  });

  it('keeps text as written: markup and addresses are text, the length is 1,000 code points', async () => {
    const markup = '<script>alert(1)</script> [링크](javascript:alert(1)) https://example.com/a';
    expect((await written({ body: markup })).body).toBe(markup);
    expect((await written({ body: '😀'.repeat(1_000) })).body).toBe('😀'.repeat(1_000));
    const blank = await write({ body: ' \n\t ' });
    expect(blank.statusCode).toBe(400);
    expect(errorOf(blank).details).toEqual([
      { path: ['body'], message: COMMENT_BODY_EMPTY_MESSAGE },
    ]);
    const long = await write({ body: '가'.repeat(1_001) });
    expect(long.statusCode).toBe(400);
    expect(errorOf(long).details).toEqual([
      { path: ['body'], message: commentBodyTooLongMessage(1_001) },
    ]);
    // A lone surrogate is U+FFFD, not a failed write.
    expect((await written({ body: 'a\ud800b' })).body).toBe('a�b');
    expect(await t.db.select().from(schema.postComments)).toHaveLength(3);
  });

  it('writes on a post of a market in every public status', async () => {
    for (const status of ['closed', 'resolved', 'settled', 'voided'] as const) {
      const ended = await createMarket(t.db, { status });
      const there = await createPost(t.db, { marketId: ended.id, authorId: other.id });
      const res = await write({}, author, there.id);
      expect(res.statusCode, `${status}: ${res.body}`).toBe(201);
    }
  });

  // ---- deletion and hiding --------------------------------------------------------------------

  it('keeps a deleted 댓글 with 대댓글 as a placeholder and removes every other deleted comment (#45-5)', async () => {
    const comment = await written({ body: '지울 댓글' });
    const answer = await reply(comment.id, '남는 답', other);
    const alone = await written({ body: '혼자 지울 댓글' });
    const res = await remove(comment.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(commentDeletionSchema.parse(res.json<{ data: unknown }>().data)).toEqual({
      id: comment.id,
      placeholder: true,
    });
    expect(await remove(alone.id).then((one) => one.json<{ data: unknown }>().data)).toEqual({
      id: alone.id,
      placeholder: false,
    });
    expect(await shape()).toEqual([[`deleted:${comment.id}`, [answer.id]]]);
    // The placeholder is its id and nothing else, read off the raw answer (the schema's parse
    // would drop a key the answer should not have): no author, no time, no word.
    expect((await page()).data).toEqual([
      { comment: { state: 'deleted', id: comment.id }, replies: [answer], repliesNextCursor: null },
    ]);
    const body = (await listing()).body;
    expect(body).not.toContain('지울 댓글');
    // Nothing of the author is left to read: the one comment still shown is another's.
    for (const shown of await faceOf(author)) expect(body).not.toContain(shown);
    // A deleted 대댓글 leaves the thread; once nothing hangs under it, the placeholder goes too.
    const answerGone = await remove(answer.id, other);
    expect(answerGone.json<{ data: unknown }>().data).toEqual({
      id: answer.id,
      placeholder: false,
    });
    expect(await shape()).toEqual([]);
    // Never restored, and gone for its author too; the originals stay for operators.
    expect((await remove(comment.id)).statusCode).toBe(404);
    expect((await edit(comment.id, '되살리기')).statusCode).toBe(404);
    const rows = await t.db.select().from(schema.postComments);
    expect(rows.map((row) => [row.body, row.deletedAt !== null]).sort()).toEqual([
      ['남는 답', true],
      ['지울 댓글', true],
      ['혼자 지울 댓글', true],
    ]);
  });

  it('shows a hidden comment as a placeholder that takes no 대댓글 and no edit, and lets its author delete it', async () => {
    const comment = await written({ body: '숨길 댓글' });
    const answer = await reply(comment.id, '숨긴 댓글의 답', other);
    const hiddenAnswerParent = await written({ body: '다른 댓글' }, other);
    const hiddenAnswer = await reply(hiddenAnswerParent.id, '숨길 답');
    await hide('postComments', comment.id);
    await hide('postComments', hiddenAnswer.id);
    expect(await shape()).toEqual([
      [`hidden:${comment.id}`, [answer.id]],
      [hiddenAnswerParent.id, [`hidden:${hiddenAnswer.id}`]],
    ]);
    const { data } = await page();
    expect(data[0]?.comment).toEqual({ state: 'hidden', id: comment.id });
    expect(data[1]?.replies[0]).toEqual({ state: 'hidden', id: hiddenAnswer.id });
    const body = (await listing()).body;
    expect(body).not.toContain('숨길 댓글');
    expect(body).not.toContain('숨길 답');
    // Both of the author's comments are hidden: nothing of the author is left to read.
    for (const shown of await faceOf(author)) expect(body).not.toContain(shown);
    // No new 대댓글 under a hidden 댓글, nor through one of its 대댓글, nor to a hidden 대댓글.
    for (const parentId of [comment.id, answer.id, hiddenAnswer.id]) {
      const res = await write({ parentId }, other);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'COMMENT_NOT_ALLOWED',
        details: { reason: 'parent_hidden' },
      });
    }
    const editing = await edit(comment.id, '고쳐 보기');
    expect(editing.statusCode).toBe(409);
    expect(errorOf(editing)).toMatchObject({
      code: 'COMMENT_NOT_EDITABLE',
      details: { reason: 'hidden' },
    });
    // A 대댓글 under the hidden 댓글 stays its author's to edit (오너 결정 2026-10-20, 7-6).
    expect((await edit(answer.id, '고친 답', other)).statusCode).toBe(200);
    const deleting = await remove(comment.id);
    expect(deleting.json<{ data: unknown }>().data).toEqual({
      id: comment.id,
      placeholder: true,
    });
    // The author's deletion comes first: '삭제된 글입니다' from now on.
    expect((await shape())[0]).toEqual([`deleted:${comment.id}`, [answer.id]]);
  });

  it('takes no 대댓글 under a deleted 댓글’s placeholder, and answers NOT_FOUND for one gone', async () => {
    const comment = await written();
    const answer = await reply(comment.id, '답', other);
    const alone = await written();
    await remove(comment.id);
    await remove(alone.id);
    for (const parentId of [comment.id, answer.id]) {
      const res = await write({ parentId }, other);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'COMMENT_NOT_ALLOWED',
        details: { reason: 'parent_deleted' },
      });
    }
    const gone = await write({ parentId: alone.id }, other);
    expect(gone.statusCode).toBe(404);
    expect(errorOf(gone).details).toEqual([
      { path: ['parentId'], message: 'no such comment on this post' },
    ]);
    // A 대댓글 under the placeholder stays its author's to edit (오너 결정 2026-10-20, 7-6).
    expect((await edit(answer.id, '고친 답', other)).statusCode).toBe(200);
    // A deleted 대댓글 is gone, too.
    const deletedAnswer = await reply((await written()).id, '지울 답', other);
    await remove(deletedAnswer.id, other);
    expect((await write({ parentId: deletedAnswer.id })).statusCode).toBe(404);

    // A hidden 대댓글 keeps its deleted 댓글 as the placeholder, too: it shows as its own.
    const keptByHidden = await written();
    const hiddenAnswer = await reply(keptByHidden.id, '숨길 답', other);
    await hide('postComments', hiddenAnswer.id);
    const kept = await remove(keptByHidden.id);
    expect(kept.json<{ data: unknown }>().data).toEqual({ id: keptByHidden.id, placeholder: true });
    expect((await shape()).at(-1)).toEqual([
      `deleted:${keptByHidden.id}`,
      [`hidden:${hiddenAnswer.id}`],
    ]);
    expect(errorOf(await write({ parentId: keptByHidden.id }, other))).toMatchObject({
      code: 'COMMENT_NOT_ALLOWED',
      details: { reason: 'parent_deleted' },
    });
  });

  it('removes a 댓글 deleted after every 대댓글 under it was: nothing hangs under it', async () => {
    const comment = await written();
    const answer = await reply(comment.id, '먼저 지울 답', other);
    await remove(answer.id, other);
    const res = await remove(comment.id);
    expect(res.json<{ data: unknown }>().data).toEqual({ id: comment.id, placeholder: false });
    expect(await shape()).toEqual([]);
    const refused = await write({ parentId: comment.id }, other);
    expect(refused.statusCode).toBe(404);
    expect(errorOf(refused).details).toEqual([
      { path: ['parentId'], message: 'no such comment on this post' },
    ]);
    expect((await write({ parentId: answer.id }, other)).statusCode).toBe(404);
  });

  it('takes no comment on a hidden or deleted post, and keeps the comments under it readable', async () => {
    const comment = await written({ body: '남는 댓글' });
    await hide('posts', post.id);
    const onHidden = await write({}, other);
    expect(onHidden.statusCode).toBe(409);
    expect(errorOf(onHidden)).toMatchObject({
      code: 'COMMENT_NOT_ALLOWED',
      details: { reason: 'post_hidden' },
    });
    expect(errorOf(await write({ parentId: comment.id }, other))).toMatchObject({
      details: { reason: 'post_hidden' },
    });
    expect(await shape()).toEqual([[comment.id, []]]);
    // Its author edits it still: only new comments are refused there.
    expect((await edit(comment.id, '고친 댓글')).statusCode).toBe(200);

    const deletion = await send(
      'POST',
      `/posts/${post.id}/delete`,
      { expectedAccountId: author.id },
      author,
    );
    expect(deletion.json<{ data: unknown }>().data).toEqual({ id: post.id, placeholder: true });
    const onDeleted = await write({}, other);
    expect(onDeleted.statusCode).toBe(409);
    expect(errorOf(onDeleted)).toMatchObject({ details: { reason: 'post_deleted' } });
    expect(await shape()).toEqual([[comment.id, []]]);

    // A deleted post with nothing under it is gone: NOT_FOUND to read and to write.
    const bare = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    expect((await listing('', bare.id)).statusCode).toBe(404);
    expect((await write({}, other, bare.id)).statusCode).toBe(404);
  });

  // ---- what the comments change of the post ---------------------------------------------------

  it('keeps a deleted post as a placeholder while comments hang under it (#45-5)', async () => {
    const comment = await written();
    const answer = await reply(comment.id);
    const res = await send(
      'POST',
      `/posts/${post.id}/delete`,
      { expectedAccountId: author.id },
      author,
    );
    expect(res.json<{ data: unknown }>().data).toEqual({ id: post.id, placeholder: true });
    expect(await postPage()).toEqual({
      state: 'deleted',
      id: post.id,
      market: expect.objectContaining({ id: market.id }) as unknown,
      commentCount: 2,
    });
    // Out of the list still (ADR-0073 9-15, kept by the owner).
    expect(await card()).toBeUndefined();
    // A hidden comment keeps it too (it shows as its placeholder); a deleted one does not.
    await hide('postComments', answer.id);
    const lastShown = await remove(comment.id);
    expect(lastShown.json<{ data: unknown }>().data).toEqual({ id: comment.id, placeholder: true });
    expect((await postPage()).state).toBe('deleted');
    // Its comments are read, and it takes none: the same answer as the post's page.
    expect(await shape()).toEqual([[`deleted:${comment.id}`, [`hidden:${answer.id}`]]]);
    const refused = await write({}, other);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused)).toMatchObject({ details: { reason: 'post_deleted' } });
    await remove(answer.id);
    const gone = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(gone.statusCode).toBe(404);
    expect((await listing()).statusCode).toBe(404);

    // A post deleted while its only comment is hidden stays as its placeholder.
    const second = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const hidden = await createComment(t.db, { postId: second.id, authorId: other.id });
    await hide('postComments', hidden.id);
    const deletion = await send(
      'POST',
      `/posts/${second.id}/delete`,
      { expectedAccountId: author.id },
      author,
    );
    expect(deletion.json<{ data: unknown }>().data).toEqual({ id: second.id, placeholder: true });
    expect((await postPage(second.id)).state).toBe('deleted');
    expect(await shape(second.id)).toEqual([[`hidden:${hidden.id}`, []]]);
  });

  it('counts the comments the public reads, on the card and the post page', async () => {
    expect((await card())?.commentCount).toBe(0);
    // The 대댓글 by the other account: one person writes 5 comments a minute at most (#187).
    const comment = await written();
    const shownReply = await reply(comment.id, '답입니다', other);
    const hidden = await reply(comment.id, '답입니다', other);
    const deleted = await reply(comment.id, '답입니다', other);
    const deletedThread = await written();
    const underDeleted = await reply(deletedThread.id, '답입니다', other);
    const hiddenThread = await written();
    const underHidden = await reply(hiddenThread.id, '답입니다', other);
    await hide('postComments', hidden.id);
    await hide('postComments', hiddenThread.id);
    await remove(deleted.id, other);
    await remove(deletedThread.id);
    // Read in full: the 댓글, one 대댓글 under it, and the 대댓글 under the deleted and the hidden 댓글.
    expect((await card())?.commentCount).toBe(4);
    const shown = await postPage();
    expect(shown.state === 'published' && shown.commentCount).toBe(4);
    expect(await shape()).toEqual([
      [comment.id, [shownReply.id, `hidden:${hidden.id}`]],
      [`deleted:${deletedThread.id}`, [underDeleted.id]],
      [`hidden:${hiddenThread.id}`, [underHidden.id]],
    ]);
    // Another post's comments are its own.
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: other.id });
    expect((await card(elsewhere.id))?.commentCount).toBe(0);
  });

  it('reads a post’s count from its counter: neither the list, the market’s discussion (#47) nor the post page walks its comments to count them, however many (Codex review on PR #220, ADR-0074 7-33)', async () => {
    // 3,000 comments in view on the post and as many on another, the tables measured as autovacuum
    // would. Every statement the list and the post page run is explained as it runs: the list
    // reads no comment at all — each card's count is its post's row of `post_comment_counts` —
    // and the post page reads the comments only to ask whether any hangs under it, the first row
    // of two indexes (7-31). Before the counter, both counted every comment in view, the list once
    // per card.
    const MANY = 3_000;
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: author.id });
    for (const target of [post.id, elsewhere.id]) {
      await t.db.execute(sql`
        INSERT INTO post_comments (post_id, author_id, body)
        SELECT ${target}::uuid, ${other.id}::text, '댓글 ' || n FROM generate_series(1, ${MANY}) AS n`);
    }
    const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
    try {
      await owner.execute(sql`ANALYZE posts, post_comments, post_comment_counts`);
    } finally {
      await closeDb(owner);
    }
    const statements: { text: string; values: unknown[] }[] = [];
    const recording: Db = drizzle({
      client: t.db.$client,
      schema,
      casing: 'snake_case',
      logger: { logQuery: (text, values) => statements.push({ text, values }) },
    });
    const service = new PostsService(recording);
    /** The relations the statements `run` sends scan, and the rows of `post_comments` they read. */
    const readBy = async (run: () => Promise<unknown>) => {
      statements.length = 0;
      await run();
      const relations = new Set<string>();
      let commentRows = 0;
      const walk = (plan: ExplainedPlan) => {
        const relation = plan['Relation Name'];
        if (relation !== undefined) relations.add(relation);
        if (relation === 'post_comments') {
          commentRows +=
            (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops'];
        }
        for (const child of plan.Plans ?? []) walk(child);
      };
      for (const { text, values } of statements) {
        // A transaction's own statements (`begin …`, `commit` — #47's discussion reads its count
        // and its cards in one) read no table.
        if (!/^\s*select\b/i.test(text)) continue;
        const explained = await t.db.$client.query<{ 'QUERY PLAN': [{ Plan: ExplainedPlan }] }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
          values,
        );
        walk(explained.rows[0]!['QUERY PLAN'][0].Plan);
      }
      return { relations: [...relations].sort(), commentRows };
    };

    const listed = await service.list({ limit: 20 });
    expect(listed.items.map(({ id, commentCount }) => [id, commentCount]).sort()).toEqual(
      [
        [post.id, MANY],
        [elsewhere.id, MANY],
      ].sort(),
    );
    const listing = await readBy(() => service.list({ limit: 20 }));
    expect(listing.relations).toContain('post_comment_counts');
    expect(listing.relations).not.toContain('post_comments');
    // #47's discussion of the market reads its cards as the list does (ADR-0075).
    const discussed = await service.listForMarket(market.id, { limit: 20 });
    expect(discussed.items.map(({ id, commentCount }) => [id, commentCount]).sort()).toEqual(
      [
        [post.id, MANY],
        [elsewhere.id, MANY],
      ].sort(),
    );
    const discussion = await readBy(() => service.listForMarket(market.id, { limit: 20 }));
    expect(discussion.relations).toContain('post_comment_counts');
    expect(discussion.relations).not.toContain('post_comments');
    const shown = await service.get(post.id);
    expect(shown.state === 'published' && shown.commentCount).toBe(MANY);
    const reading = await readBy(() => service.get(post.id));
    expect(reading.relations).toContain('post_comment_counts');
    expect(reading.commentRows).toBeLessThanOrEqual(2);
  });

  // ---- editing --------------------------------------------------------------------------------

  it('edits the body, keeps each earlier version for operators and shows 수정됨; the same text changes nothing', async () => {
    const comment = await written({ body: '처음' });
    const res = await edit(comment.id, '  고친 댓글\n둘째 줄 ');
    expect(res.statusCode, res.body).toBe(200);
    const edited = publishedCommentSchema.parse(res.json<{ data: unknown }>().data);
    expect(edited).toMatchObject({
      id: comment.id,
      body: '고친 댓글\n둘째 줄',
      editedAt: expect.any(String) as unknown,
    });
    await edit(comment.id, '또 고친 댓글');
    const revisions = await t.db
      .select()
      .from(schema.postCommentRevisions)
      .orderBy(asc(schema.postCommentRevisions.id));
    expect(revisions.map((row) => row.body)).toEqual(['처음', '고친 댓글\n둘째 줄']);
    expect(revisions[0]?.writtenAt.toISOString()).toBe(comment.createdAt);
    expect(revisions[1]?.writtenAt.toISOString()).toBe(edited.editedAt);
    // The same text, as written or as sent again, is no edit.
    const [before] = await t.db
      .select()
      .from(schema.postComments)
      .where(eq(schema.postComments.id, comment.id));
    expect((await edit(comment.id, ' 또 고친 댓글 ')).statusCode).toBe(200);
    expect(await t.db.select().from(schema.postCommentRevisions)).toHaveLength(2);
    const [after] = await t.db
      .select()
      .from(schema.postComments)
      .where(eq(schema.postComments.id, comment.id));
    expect(after?.editedAt).toEqual(before?.editedAt);
    // Shown edited in the thread.
    expect((await page()).data[0]?.comment).toMatchObject({
      body: '또 고친 댓글',
      editedAt: expect.any(String) as unknown,
    });
  });

  it('lets only the author edit or delete, and never a deleted or unknown comment', async () => {
    const comment = await written({ body: '내 댓글' });
    expect((await edit(comment.id, '남이 고침', other)).statusCode).toBe(403);
    expect((await remove(comment.id, other)).statusCode).toBe(403);
    // The cookie's account, not the one the screen names, decides: a mismatch is refused first.
    for (const res of [
      await send(
        'PUT',
        `/comments/${comment.id}`,
        { body: 'x', expectedAccountId: other.id },
        author,
      ),
      await send('POST', `/comments/${comment.id}/delete`, { expectedAccountId: other.id }, author),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    const unknown = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
    expect((await edit(unknown, 'x')).statusCode).toBe(404);
    expect((await remove(unknown)).statusCode).toBe(404);
    expect((await edit('nope', 'x')).statusCode).toBe(400);
    const [row] = await t.db.select().from(schema.postComments);
    expect(row).toMatchObject({ body: '내 댓글', editedAt: null, deletedAt: null });
  });

  // ---- who writes -----------------------------------------------------------------------------

  it('lets an account that finished the onboarding write and edit, and any signed-in author delete', async () => {
    const newcomer = await signUpTestUser(t);
    const own = await createComment(t.db, {
      postId: post.id,
      authorId: newcomer.id,
      body: '처음',
    });
    for (const res of [await write({}, newcomer), await edit(own.id, '고침', newcomer)]) {
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('ONBOARDING_REQUIRED');
    }
    // Deleting one's own needs a session alone (ADR-0069 #45-12: it stays open in any state).
    const res = await remove(own.id, newcomer);
    expect(res.statusCode, res.body).toBe(200);
    expect((await write({}, null)).statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/comments/${own.id}/delete`,
          headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json' },
          payload: JSON.stringify({ expectedAccountId: newcomer.id }),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('checks the onboarding again inside the write itself, past the guard (#57-8)', async () => {
    // OnboardedGuard answers every request above before the service; this is the check that holds
    // the onboarding to the commit and where #185 and #187 plug in: CommentsService.checkWriter.
    const comments = t.app.get(CommentsService);
    const newcomer = await signUpTestUser(t);
    const refusal = { code: 'ONBOARDING_REQUIRED', status: 409 };
    await expect(comments.create(newcomer.id, post.id, null, '댓글')).rejects.toMatchObject(
      refusal,
    );
    expect(await t.db.select().from(schema.postComments)).toEqual([]);
    const own = await createComment(t.db, {
      postId: post.id,
      authorId: newcomer.id,
      body: '처음',
    });
    await expect(comments.update(newcomer.id, own.id, '고침')).rejects.toMatchObject(refusal);
    expect(await t.db.select().from(schema.postCommentRevisions)).toEqual([]);
    // Deleting checks no onboarding.
    expect(await comments.delete(newcomer.id, own.id)).toEqual({
      id: own.id,
      placeholder: false,
    });
  });

  it('shows an admin’s comment with 운영자 and every author by the current nickname', async () => {
    const comment = await written();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin', nickname: 'renamed_now' })
      .where(eq(schema.profiles.userId, author.id));
    const [thread] = (await page()).data;
    expect(thread?.comment).toMatchObject({
      id: comment.id,
      author: { nickname: 'renamed_now', isAdmin: true },
    });
  });

  it('writes without touching a balance, an order or a position (N05 §2)', async () => {
    await createUser(t.db);
    const before = await Promise.all([
      t.db.select().from(schema.balances).orderBy(asc(schema.balances.userId)),
      t.db.select().from(schema.ledgerEntries),
      t.db.select().from(schema.orders),
      t.db.select().from(schema.positions),
    ]);
    const comment = await written();
    await reply(comment.id);
    await edit(comment.id, '고침');
    await remove(comment.id);
    expect(
      await Promise.all([
        t.db.select().from(schema.balances).orderBy(asc(schema.balances.userId)),
        t.db.select().from(schema.ledgerEntries),
        t.db.select().from(schema.orders),
        t.db.select().from(schema.positions),
      ]),
    ).toEqual(before);
  });

  // ---- writes that meet -----------------------------------------------------------------------

  /**
   * Runs `whileHeld` while another connection holds the row locks `statements` take in an open
   * transaction — a write in flight — and commits it once the request waits on them.
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
      await waitForLockWaiter(holder, 'the comment write on the row another transaction holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  it('waits for a post’s deletion in flight and is refused after it, never landing under it', async () => {
    await written();
    const res = await whileLocked(
      [
        ['SELECT id FROM posts WHERE id = $1 FOR UPDATE', [post.id]],
        ['UPDATE posts SET deleted_at = now() WHERE id = $1', [post.id]],
      ],
      () => write({}, other),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ details: { reason: 'post_deleted' } });
    expect(await t.db.select().from(schema.postComments)).toHaveLength(1);
  });

  it('counts a comment written while the post’s deletion waited, answering with the placeholder', async () => {
    // The holder stands in for a comment being written, the post's row held shared as
    // CommentsService.create holds it: the author's deletion waits on the row and then counts the
    // comment. Its own row lock (FOR NO KEY UPDATE) is not what makes it wait here — its UPDATE
    // waits on the share lock as well — so this pins that the placeholder is decided after the wait
    // (ADR-0074).
    const comment = '1c7a7b4f-3d2e-4d9f-8a1b-2c3d4e5f6a71';
    const res = await whileLocked(
      [
        ['SELECT id FROM posts WHERE id = $1 FOR SHARE', [post.id]],
        [
          'INSERT INTO post_comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)',
          [comment, post.id, other.id, '먼저 쓴 댓글'],
        ],
      ],
      () => send('POST', `/posts/${post.id}/delete`, { expectedAccountId: author.id }, author),
    );
    expect(res.json<{ data: unknown }>().data).toEqual({ id: post.id, placeholder: true });
    expect((await postPage()).state).toBe('deleted');
  });

  it('waits for a 댓글’s deletion in flight and is refused after it; a deletion counts a 대댓글 it waited for', async () => {
    const comment = await written();
    await reply(comment.id, '답', other);
    const refused = await whileLocked(
      [
        ['SELECT id FROM post_comments WHERE id = $1 FOR UPDATE', [comment.id]],
        ['UPDATE post_comments SET deleted_at = now() WHERE id = $1', [comment.id]],
      ],
      () => write({ parentId: comment.id }, other),
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(errorOf(refused)).toMatchObject({ details: { reason: 'parent_deleted' } });

    // The deletion waits on a 대댓글 in flight and counts it — after the wait, as above.
    const lone = await written();
    const answer = '2d8b8c5a-4e3f-4eaa-9b2c-3d4e5f6a7b82';
    const deletion = await whileLocked(
      [
        ['SELECT id FROM post_comments WHERE id = $1 FOR SHARE', [lone.id]],
        [
          'INSERT INTO post_comments (id, post_id, parent_id, parent_created_at, author_id, body) SELECT $1::uuid, $2::uuid, id, created_at, $4::text, $5::text FROM post_comments WHERE id = $3::uuid',
          [answer, post.id, lone.id, other.id, '먼저 쓴 답'],
        ],
      ],
      () => remove(lone.id),
    );
    expect(deletion.json<{ data: unknown }>().data).toEqual({ id: lone.id, placeholder: true });
  });
});
