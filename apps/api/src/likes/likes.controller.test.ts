/**
 * 좋아요 (#49, ADR-0076; ADR-0069 decision 4 #49 rows, decision 7) against the docker `test`
 * profile: an account's likes of posts and comments, the counts the public reads, and what the
 * caller liked on a post page. Pinned: only an account that finished the onboarding likes, its own
 * too; liking and taking back are idempotent, and racing likes count once; one like per person —
 * per account and per verified number, so an account on a number a withdrawn account liked with
 * sees that like and cannot add one, while a live account's likes stay its own after an operator
 * moved it to a new number; a deleted or hidden target takes none and shows no count, a gone one is
 * NOT_FOUND, and a post of an ended market takes them; the counts are the same answer for
 * everyone and nobody's like rides on a public answer; a like never touches Coin, a balance, the
 * ledger, an order or a position, and never reorders the list. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createPhoneVerification,
  createPost,
  createUser,
} from '@buddha/db/test';
import {
  commentThreadSchema,
  likeStateSchema,
  myPostLikesSchema,
  postSchema,
  type CommentThread,
  type LikeState,
  type MyPostLikes,
  type Post,
  type PostSummary,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { LikesService } from './likes.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const UNKNOWN = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

describe.skipIf(!hasTestInfra)('/api/v1 likes (integration)', () => {
  let t: TestApp;
  let author: TestUser;
  let reader: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;
  let post: Awaited<ReturnType<typeof createPost>>;
  let comment: Awaited<ReturnType<typeof createComment>>;
  let reply: Awaited<ReturnType<typeof createComment>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    author = await signUpTestUser(t);
    reader = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: author.id });
    await completeOnboarding(t.db, { userId: reader.id });
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, { marketId: market.id, authorId: author.id, title: '근거 글' });
    comment = await createComment(t.db, { postId: post.id, authorId: author.id, body: '댓글' });
    reply = await createComment(t.db, {
      postId: post.id,
      authorId: reader.id,
      parentId: comment.id,
      body: '대댓글',
    });
  });

  const put = (url: string, payload: unknown, who: TestUser | null) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify(payload),
    });
  /** `PUT /posts/:postId/like` as `who`. */
  const likePost = (liked: boolean, who: TestUser | null = reader, postId = post.id) =>
    put(`/posts/${postId}/like`, { liked, expectedAccountId: who?.id ?? 'x' }, who);
  /** `PUT /comments/:commentId/like` as `who`. */
  const likeComment = (commentId: string, liked: boolean, who: TestUser | null = reader) =>
    put(`/comments/${commentId}/like`, { liked, expectedAccountId: who?.id ?? 'x' }, who);
  const stateOf = (res: { statusCode: number; body: string; json: <T>() => T }): LikeState => {
    expect(res.statusCode, res.body).toBe(200);
    return likeStateSchema.parse(res.json<{ data: unknown }>().data);
  };
  const errorOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; details?: unknown } }>().error;
  const mine = async (who: TestUser, postId = post.id): Promise<MyPostLikes> => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/likes/posts/${postId}`,
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return myPostLikesSchema.parse(res.json<{ data: unknown }>().data);
  };

  const read = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: cookie ? { cookie } : {} });
  const postPage = async (postId = post.id): Promise<Post> => {
    const res = await read(`/posts/${postId}`);
    expect(res.statusCode, res.body).toBe(200);
    return postSchema.parse(res.json<{ data: unknown }>().data);
  };
  const cards = async (): Promise<PostSummary[]> => {
    const res = await read('/posts');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: PostSummary[] }>().data;
  };
  const threads = async (postId = post.id): Promise<CommentThread[]> => {
    const res = await read(`/posts/${postId}/comments`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{ data: CommentThread[] }>().data;
    for (const thread of page) commentThreadSchema.parse(thread);
    return page;
  };
  /** The like counts the public reads: the card, the page, and each comment by id. */
  const counts = async () => {
    const page = await postPage();
    const comments = Object.fromEntries(
      (await threads()).flatMap(({ comment: one, replies }) =>
        [one, ...replies].map((c) => [c.id, c.state === 'published' ? c.likeCount : c.state]),
      ),
    );
    return {
      card: (await cards()).find((row) => row.id === post.id)?.likeCount,
      page: page.state === 'published' ? page.likeCount : page.state,
      comments,
    };
  };
  const rows = async () => ({
    posts: (await t.db.select().from(schema.postLikes)).map((row) => row.userId).sort(),
    comments: (await t.db.select().from(schema.commentLikes)).map((row) => row.userId).sort(),
  });
  /** The keyed hash of `who`'s verified number, as LikesService computes it. */
  const hashOf = async (who: TestUser) => {
    const [row] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, who.id));
    return t.app.get(PhoneHasher).hash(row!.phone);
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
  const deleteRow = async (table: 'posts' | 'postComments', id: string) => {
    if (table === 'posts') {
      await t.db.update(schema.posts).set({ deletedAt: new Date() }).where(eq(schema.posts.id, id));
    } else {
      await t.db
        .update(schema.postComments)
        .set({ deletedAt: new Date() })
        .where(eq(schema.postComments.id, id));
    }
  };

  // ---- liking and taking back -----------------------------------------------------------------

  it('likes a post, a 댓글 and a 대댓글 and takes each back, idempotently either way', async () => {
    expect(await counts()).toEqual({
      card: 0,
      page: 0,
      comments: { [comment.id]: 0, [reply.id]: 0 },
    });
    expect(stateOf(await likePost(true))).toEqual({ liked: true, likeCount: 1 });
    // A second like changes nothing (#49: one like per account and target).
    expect(stateOf(await likePost(true))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(reply.id, true))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(reply.id, true, author))).toEqual({
      liked: true,
      likeCount: 2,
    });
    expect(await counts()).toEqual({
      card: 1,
      page: 1,
      comments: { [comment.id]: 1, [reply.id]: 2 },
    });
    expect(await rows()).toEqual({
      posts: [reader.id],
      comments: [reader.id, reader.id, author.id].sort(),
    });
    expect(stateOf(await likePost(false))).toEqual({ liked: false, likeCount: 0 });
    // Taking back what is not there changes nothing either.
    expect(stateOf(await likePost(false))).toEqual({ liked: false, likeCount: 0 });
    expect(stateOf(await likeComment(reply.id, false))).toEqual({ liked: false, likeCount: 1 });
    expect(await counts()).toEqual({
      card: 0,
      page: 0,
      comments: { [comment.id]: 1, [reply.id]: 1 },
    });
    // Liked again: a new like, counted once.
    expect(stateOf(await likePost(true))).toEqual({ liked: true, likeCount: 1 });
  });

  it('lets an author like their own post and comment (#49)', async () => {
    expect(stateOf(await likePost(true, author))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true, author))).toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(await mine(author)).toEqual({ postLiked: true, likedCommentIds: [comment.id] });
  });

  it('counts a like once when the same account likes twice at the same time', async () => {
    const answers = await Promise.all([likePost(true), likePost(true), likePost(true)]);
    for (const res of answers) expect(stateOf(res).liked).toBe(true);
    const commentAnswers = await Promise.all([
      likeComment(comment.id, true),
      likeComment(comment.id, true),
    ]);
    for (const res of commentAnswers) expect(stateOf(res).liked).toBe(true);
    expect(await rows()).toEqual({ posts: [reader.id], comments: [reader.id] });
    expect((await counts()).card).toBe(1);
  });

  it('counts every account’s like exactly when many like at once', async () => {
    const likers = [reader, author];
    for (let i = 0; i < 4; i++) {
      const extra = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: extra.id });
      likers.push(extra);
    }
    await Promise.all(likers.map((who) => likePost(true, who)));
    expect((await counts()).card).toBe(likers.length);
    await Promise.all(likers.slice(0, 3).map((who) => likePost(false, who)));
    expect(await counts()).toMatchObject({ card: 3, page: 3 });
  });

  // ---- once per person -------------------------------------------------------------------------

  it('keeps one like per verified number: the same number on a new account sees it and cannot add one (decision 7)', async () => {
    const phone = '01055551234';
    const leaver = await createUser(t.db);
    await completeOnboarding(t.db, { userId: leaver.user.id, phone });
    // The leaver's like, as LikesService wrote it: by account and by the number's hash.
    const hash = t.app.get(PhoneHasher).hash(phone);
    await t.db
      .insert(schema.postLikes)
      .values({ postId: post.id, userId: leaver.user.id, phoneHash: hash });
    await t.db
      .insert(schema.commentLikes)
      .values({ commentId: comment.id, userId: leaver.user.id, phoneHash: hash });
    // The leaver withdraws (#140 deletes the number and keeps the likes, #37-17) and signs up again
    // on the same number.
    await t.db
      .delete(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, leaver.user.id));
    const returner = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: returner.id, phone });
    expect(await mine(returner)).toEqual({ postLiked: true, likedCommentIds: [comment.id] });
    // Liking again is the like already there: the count stays.
    expect(stateOf(await likePost(true, returner))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true, returner))).toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(await rows()).toEqual({ posts: [leaver.user.id], comments: [leaver.user.id] });
    // Taking it back takes the number's like, whichever account made it (7-3, a question for the
    // owner); then it may like anew. The post's and the comment's alike.
    expect(stateOf(await likePost(false, returner))).toEqual({ liked: false, likeCount: 0 });
    expect(stateOf(await likeComment(comment.id, false, returner))).toEqual({
      liked: false,
      likeCount: 0,
    });
    expect(await rows()).toEqual({ posts: [], comments: [] });
    expect(await mine(returner)).toEqual({ postLiked: false, likedCommentIds: [] });
    expect(stateOf(await likePost(true, returner))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true, returner))).toEqual({
      liked: true,
      likeCount: 1,
    });
    expect(await rows()).toEqual({ posts: [returner.id], comments: [returner.id] });
  });

  /** An operator's change of `who`'s number by hand (#57-3, docs/OPERATIONS.md). */
  const changeNumber = (who: TestUser, phone: string) =>
    t.db
      .update(schema.phoneVerifications)
      .set({ phone })
      .where(eq(schema.phoneVerifications.userId, who.id));

  it('keeps an account’s likes by the account when an operator changes its number by hand', async () => {
    expect(stateOf(await likePost(true))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true))).toEqual({ liked: true, likeCount: 1 });
    const before = await hashOf(reader);
    await changeNumber(reader, '01077778888');
    expect(await hashOf(reader)).not.toBe(before);
    expect(await mine(reader)).toEqual({ postLiked: true, likedCommentIds: [comment.id] });
    // A like again is the one there, under the old number's hash: still one row each.
    expect(stateOf(await likePost(true))).toEqual({ liked: true, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true))).toEqual({ liked: true, likeCount: 1 });
    expect(await rows()).toEqual({ posts: [reader.id], comments: [reader.id] });
    // Taken back by the account, though its number is not the one the rows carry.
    expect(stateOf(await likePost(false))).toEqual({ liked: false, likeCount: 0 });
    expect(stateOf(await likeComment(comment.id, false))).toEqual({ liked: false, likeCount: 0 });
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  it('never lets the next holder of a changed number read or take back the live account’s likes', async () => {
    const oldPhone = '01055556666';
    const holder = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: holder.id, phone: oldPhone });
    stateOf(await likePost(true, holder));
    stateOf(await likeComment(comment.id, true, holder));
    // An operator moves the holder to a new number; the carrier gives the old one to somebody else,
    // who verifies it on a new account. The holder's rows still carry the old number's hash.
    await changeNumber(holder, '01055557777');
    const next = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: next.id, phone: oldPhone });
    expect(await hashOf(next)).toBe(t.app.get(PhoneHasher).hash(oldPhone));
    // Not the newcomer's: nothing on its owner-only route, and its taking back removes nothing.
    expect(await mine(next)).toEqual({ postLiked: false, likedCommentIds: [] });
    expect(stateOf(await likePost(false, next))).toEqual({ liked: false, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, false, next))).toEqual({
      liked: false,
      likeCount: 1,
    });
    // Its like meets the number's primary key: answered as not liked, nothing written (7-3).
    expect(stateOf(await likePost(true, next))).toEqual({ liked: false, likeCount: 1 });
    expect(stateOf(await likeComment(comment.id, true, next))).toEqual({
      liked: false,
      likeCount: 1,
    });
    expect(await rows()).toEqual({ posts: [holder.id], comments: [holder.id] });
    // The live account still sees and holds its own.
    expect(await mine(holder)).toEqual({ postLiked: true, likedCommentIds: [comment.id] });
    expect(await counts()).toMatchObject({ card: 1, page: 1, comments: { [comment.id]: 1 } });
    // Once the holder takes its like back, the newcomer's own like goes in.
    stateOf(await likePost(false, holder));
    expect(stateOf(await likePost(true, next))).toEqual({ liked: true, likeCount: 1 });
    expect((await rows()).posts).toEqual([next.id]);
  });

  it('records the liker’s account and the keyed hash of its number, never the number', async () => {
    stateOf(await likePost(true));
    stateOf(await likeComment(reply.id, true));
    const [postLike] = await t.db.select().from(schema.postLikes);
    const [commentLike] = await t.db.select().from(schema.commentLikes);
    const hash = await hashOf(reader);
    expect(postLike).toMatchObject({ postId: post.id, userId: reader.id, phoneHash: hash });
    expect(commentLike).toMatchObject({ commentId: reply.id, userId: reader.id, phoneHash: hash });
  });

  // ---- what takes likes ------------------------------------------------------------------------

  it('takes likes on a post of a market in every public status, ended ones too (#49)', async () => {
    for (const status of ['closed', 'resolved', 'settled', 'voided'] as const) {
      const ended = await createMarket(t.db, { status });
      const there = await createPost(t.db, { marketId: ended.id, authorId: author.id });
      expect(stateOf(await likePost(true, reader, there.id)), status).toEqual({
        liked: true,
        likeCount: 1,
      });
    }
  });

  it('takes no like on a hidden or deleted post, nor a taking back, and shows its placeholder no count', async () => {
    stateOf(await likePost(true));
    stateOf(await likePost(true, author));
    await hide('posts', post.id);
    for (const liked of [true, false]) {
      const res = await likePost(liked);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'LIKE_NOT_ALLOWED',
        details: { reason: 'hidden' },
      });
    }
    // The placeholder as it goes out (not through the schema, which would drop a stray field).
    const rawPage = async () => {
      const res = await read(`/posts/${post.id}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ data: Record<string, unknown> }>().data;
    };
    expect(Object.keys(await rawPage()).sort()).toEqual(['commentCount', 'id', 'market', 'state']);
    expect((await rawPage()).state).toBe('hidden');
    // The likes stay: an operator who shows it again (#50) shows them again.
    expect((await rows()).posts).toHaveLength(2);
    await t.db.update(schema.posts).set({ hiddenAt: null }).where(eq(schema.posts.id, post.id));
    expect(await postPage()).toMatchObject({ state: 'published', likeCount: 2 });

    // Deleted while comments hang under it: the placeholder takes none.
    await deleteRow('posts', post.id);
    const res = await likePost(true);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: 'deleted' });
    expect(await rawPage()).toMatchObject({ state: 'deleted' });
    expect(Object.keys(await rawPage())).not.toContain('likeCount');
    // Deleted with nothing under it, and unknown: gone, as to the public.
    const lone = await createPost(t.db, { marketId: market.id, authorId: author.id });
    await deleteRow('posts', lone.id);
    for (const postId of [lone.id, UNKNOWN]) {
      const gone = await likePost(true, reader, postId);
      expect(gone.statusCode, gone.body).toBe(404);
      expect(errorOf(gone).code).toBe('NOT_FOUND');
    }
    expect((await likePost(true, reader, 'nope')).statusCode).toBe(400);
  });

  it('takes no like on a hidden comment or a deleted 댓글’s placeholder, and NOT_FOUND for one gone', async () => {
    const hiddenOne = await createComment(t.db, { postId: post.id, authorId: author.id });
    await hide('postComments', hiddenOne.id);
    const res = await likeComment(hiddenOne.id, true);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: 'hidden' });
    // A 댓글 deleted while its 대댓글 hangs under it is the placeholder: none, a taking back neither.
    stateOf(await likeComment(comment.id, true));
    await deleteRow('postComments', comment.id);
    for (const liked of [true, false]) {
      const refused = await likeComment(comment.id, liked);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(errorOf(refused).details).toEqual({ reason: 'deleted' });
    }
    // The 대댓글 under it is read in full, so it takes likes.
    expect(stateOf(await likeComment(reply.id, true))).toEqual({ liked: true, likeCount: 1 });
    const [thread] = await threads();
    expect(thread?.comment).toEqual({ state: 'deleted', id: comment.id });
    expect(thread?.replies[0]).toMatchObject({ id: reply.id, likeCount: 1 });
    // A deleted 대댓글, a deleted 댓글 with nothing under it and an unknown id are gone.
    const lone = await createComment(t.db, { postId: post.id, authorId: author.id });
    await deleteRow('postComments', lone.id);
    await deleteRow('postComments', reply.id);
    for (const commentId of [lone.id, reply.id, UNKNOWN]) {
      const gone = await likeComment(commentId, true);
      expect(gone.statusCode, gone.body).toBe(404);
    }
  });

  it('takes likes on a comment under a hidden or deleted post: the rule is the comment’s own', async () => {
    await hide('posts', post.id);
    expect(stateOf(await likeComment(comment.id, true))).toEqual({ liked: true, likeCount: 1 });
    await deleteRow('posts', post.id);
    expect(stateOf(await likeComment(reply.id, true))).toEqual({ liked: true, likeCount: 1 });
    const [thread] = await threads();
    expect(thread?.comment).toMatchObject({ likeCount: 1 });
  });

  // ---- who likes -------------------------------------------------------------------------------

  it('lets only an account that finished the onboarding like, and nobody signed out', async () => {
    const newcomer = await signUpTestUser(t);
    for (const res of [
      await likePost(true, newcomer),
      await likePost(false, newcomer),
      await likeComment(comment.id, true, newcomer),
    ]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res).code).toBe('ONBOARDING_REQUIRED');
    }
    expect((await likePost(true, null)).statusCode).toBe(401);
    expect((await likeComment(comment.id, true, null)).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/me/likes/posts/${post.id}` })).statusCode,
    ).toBe(401);
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  it('checks the onboarding again inside the like itself, past the guard (#57-8)', async () => {
    // OnboardedGuard answers every request above before the service; this is the check that holds
    // the onboarding to the commit: LikesService's own, not the writers' (#185 does not stop it).
    const likes = t.app.get(LikesService);
    // Verified but nothing else (no consent, no nickname confirmed — as an account a consent
    // revision asked again, #57-5): only `assertOnboarded` can refuse it, since the record the
    // like holds is there.
    const newcomer = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: newcomer.id });
    const refusal = {
      code: 'ONBOARDING_REQUIRED',
      status: 409,
      details: { steps: expect.arrayContaining(['consent', 'nickname']) as unknown },
    };
    for (const like of [
      () => likes.setPostLike(newcomer.id, post.id, true),
      () => likes.setCommentLike(newcomer.id, comment.id, true),
    ]) {
      const error: unknown = await like().catch((thrown: unknown) => thrown);
      expect(error).toMatchObject(refusal);
      expect((error as { details: { steps: string[] } }).details.steps).not.toContain(
        'verification',
      );
    }
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  it('likes only as the account the screen shows', async () => {
    for (const res of [
      await put(`/posts/${post.id}/like`, { liked: true, expectedAccountId: author.id }, reader),
      await put(
        `/comments/${comment.id}/like`,
        { liked: true, expectedAccountId: author.id },
        reader,
      ),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    for (const body of [
      { expectedAccountId: reader.id },
      { liked: 'yes', expectedAccountId: 'r' },
    ]) {
      expect((await put(`/posts/${post.id}/like`, body, reader)).statusCode).toBe(400);
    }
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  // ---- what the public reads -------------------------------------------------------------------

  it('shows the counts the same to everyone, and the caller’s own likes on the owner-only route', async () => {
    stateOf(await likePost(true));
    stateOf(await likeComment(reply.id, true));
    stateOf(await likeComment(comment.id, true, author));
    for (const url of ['/posts', `/posts/${post.id}`, `/posts/${post.id}/comments`]) {
      const anonymous = await read(url);
      expect(anonymous.statusCode, anonymous.body).toBe(200);
      // Nobody's like rides on a public answer: the liker's, the author's and nobody's are one.
      expect((await read(url, reader.cookie)).body, url).toBe(anonymous.body);
      expect((await read(url, author.cookie)).body, url).toBe(anonymous.body);
      expect(anonymous.body).not.toContain(reader.id);
      expect(anonymous.body).not.toContain('liked');
    }
    expect(await counts()).toEqual({
      card: 1,
      page: 1,
      comments: { [comment.id]: 1, [reply.id]: 1 },
    });
    expect(await mine(reader)).toEqual({ postLiked: true, likedCommentIds: [reply.id] });
    expect(await mine(author)).toEqual({ postLiked: false, likedCommentIds: [comment.id] });
    // Another post, or one that does not exist: the caller's rows say nothing.
    expect(await mine(reader, UNKNOWN)).toEqual({ postLiked: false, likedCommentIds: [] });
  });

  it('keeps the community list newest first, whatever the likes (#45-7, D5)', async () => {
    const older = post;
    const newer = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      createdAt: new Date(older.createdAt.getTime() + 1_000),
    });
    stateOf(await likePost(true, reader, older.id));
    stateOf(await likePost(true, author, older.id));
    expect((await cards()).map((row) => [row.id, row.likeCount])).toEqual([
      [newer.id, 0],
      [older.id, 2],
    ]);
  });

  it('likes without touching Coin, a balance, the ledger, an order or a position (D5, N05 §2)', async () => {
    await createUser(t.db);
    const state = () =>
      Promise.all([
        t.db.select().from(schema.balances).orderBy(asc(schema.balances.userId)),
        t.db.select().from(schema.ledgerEntries),
        t.db.select().from(schema.orders),
        t.db.select().from(schema.positions),
        t.db.select().from(schema.startGrants),
      ]);
    const before = await state();
    stateOf(await likePost(true));
    stateOf(await likePost(true, author));
    stateOf(await likeComment(comment.id, true));
    stateOf(await likePost(false));
    expect(await state()).toEqual(before);
  });

  // ---- likes that meet a deletion or a hiding --------------------------------------------------

  /**
   * Runs `whileHeld` while another connection holds the row locks `statements` take in an open
   * transaction — a deletion or a hiding in flight — and commits it once the request waits.
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
      await waitForLockWaiter(holder, 'the like on the row another transaction holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  it('waits for a post’s deletion or hiding in flight and is refused after it, never landing on it', async () => {
    const refused = await whileLocked(
      [
        ['SELECT id FROM posts WHERE id = $1 FOR UPDATE', [post.id]],
        ['UPDATE posts SET deleted_at = now() WHERE id = $1', [post.id]],
      ],
      () => likePost(true),
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(errorOf(refused).details).toEqual({ reason: 'deleted' });
    const other = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const hidden = await whileLocked(
      [['UPDATE posts SET hidden_at = now() WHERE id = $1', [other.id]]],
      () => likePost(true, reader, other.id),
    );
    expect(hidden.statusCode, hidden.body).toBe(409);
    expect(errorOf(hidden).details).toEqual({ reason: 'hidden' });
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  it('holds the liker’s number while it likes: a change of it in flight is waited for, an edit of the real name is not', async () => {
    // An operator's change of the number in flight: the like waits for it and is held by the new
    // number's hash (FOR KEY SHARE on the record — `phone` is UNIQUE, so changing it conflicts).
    const changed = await whileLocked(
      [
        [
          'UPDATE phone_verifications SET phone = $2 WHERE user_id = $1',
          [reader.id, '01066667777'],
        ],
      ],
      () => likePost(true),
    );
    expect(stateOf(changed).liked).toBe(true);
    const [like] = await t.db.select().from(schema.postLikes);
    expect(like?.phoneHash).toBe(t.app.get(PhoneHasher).hash('01066667777'));
    // The member's edit of the real name in flight does not hold a like up.
    const holder = await t.db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE phone_verifications SET real_name = $2 WHERE user_id = $1', [
        reader.id,
        '고친이름',
      ]);
      const answer = await Promise.race([
        likeComment(comment.id, true),
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000)),
      ]);
      expect(answer === 'waited' ? answer : stateOf(answer).liked).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('waits for a comment’s hiding in flight and is refused after it', async () => {
    const res = await whileLocked(
      [['UPDATE post_comments SET hidden_at = now() WHERE id = $1', [reply.id]]],
      () => likeComment(reply.id, true),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: 'hidden' });
    expect(await rows()).toEqual({ posts: [], comments: [] });
  });

  it('meets the same account’s like committing meanwhile and answers it as its own', async () => {
    // The twin request's row, written and not yet committed: the like does not see it, inserts,
    // waits on its key and, once it commits, conflicts — never a 500 (ON CONFLICT DO NOTHING),
    // and the read after the conflict finds the caller's like.
    const hash = await hashOf(reader);
    const onPost = await whileLocked(
      [
        [
          'INSERT INTO post_likes (post_id, user_id, phone_hash) VALUES ($1, $2, $3)',
          [post.id, reader.id, hash],
        ],
      ],
      () => likePost(true),
    );
    expect(stateOf(onPost)).toEqual({ liked: true, likeCount: 1 });
    const onComment = await whileLocked(
      [
        [
          'INSERT INTO comment_likes (comment_id, user_id, phone_hash) VALUES ($1, $2, $3)',
          [comment.id, reader.id, hash],
        ],
      ],
      () => likeComment(comment.id, true),
    );
    expect(stateOf(onComment)).toEqual({ liked: true, likeCount: 1 });
    expect(await rows()).toEqual({ posts: [reader.id], comments: [reader.id] });
  });
});
