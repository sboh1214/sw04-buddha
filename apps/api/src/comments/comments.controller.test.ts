/**
 * 댓글·대댓글 (#48, ADR-0074; ADR-0069 decision 2 #45-2…#45-5) against the docker `test` profile: a
 * post's comments and their authors' writes, and what the comments change of the post (its
 * placeholder and its count). Pinned: anyone reads and only an account that finished the
 * onboarding writes or edits, while deleting one's own needs a session alone; two layers, a reply
 * to a 대댓글 joining its 댓글; oldest first, a page of 댓글 at a time with all their 대댓글; plain
 * text, trimmed, line breaks kept, 1,000 characters; the author by public face only; edits keep
 * the operators' history; deletion and hiding as #45-5 says, for comments and now for posts; a
 * hidden or deleted post or 댓글 takes no new comment; writing never touches a balance, an order or
 * a position. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createPost,
  createUser,
} from '@buddha/db/test';
import {
  COMMENT_BODY_EMPTY_MESSAGE,
  commentBodyTooLongMessage,
  commentDeletionSchema,
  commentThreadSchema,
  postSchema,
  publishedCommentSchema,
  type CommentThread,
  type Post,
  type PostSummary,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { CommentsService } from './comments.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type ThreadPage = { data: CommentThread[]; meta: { nextCursor: string | null } };

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

  it('pages 댓글 oldest first with every 대댓글 under each, ties by id, no deleted one taking a place', async () => {
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
    // A cursor that does not decode serves the first page.
    expect((await page('limit=2&cursor=garbage')).data.map(({ comment }) => comment.id)).toEqual([
      a.id,
      b!.id,
    ]);
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
      { comment: { state: 'deleted', id: comment.id }, replies: [answer] },
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
    const comment = await written();
    const shownReply = await reply(comment.id);
    const hidden = await reply(comment.id);
    const deleted = await reply(comment.id);
    const deletedThread = await written();
    const underDeleted = await reply(deletedThread.id);
    const hiddenThread = await written();
    const underHidden = await reply(hiddenThread.id);
    await hide('postComments', hidden.id);
    await hide('postComments', hiddenThread.id);
    await remove(deleted.id);
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
    // comment. Its own FOR UPDATE is not what makes it wait here — its UPDATE waits on the share
    // lock as well — so this pins that the placeholder is decided after the wait (ADR-0074).
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
          'INSERT INTO post_comments (id, post_id, parent_id, author_id, body) VALUES ($1, $2, $3, $4, $5)',
          [answer, post.id, lone.id, other.id, '먼저 쓴 답'],
        ],
      ],
      () => remove(lone.id),
    );
    expect(deletion.json<{ data: unknown }>().data).toEqual({ id: lone.id, placeholder: true });
  });
});
