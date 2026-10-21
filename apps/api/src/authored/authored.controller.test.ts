/**
 * 작성자별 글·댓글 목록 (#51, ADR-0080; ADR-0069 decision 2 #45-5, decision 3 #37-14 and #37-19,
 * decision 4 #51) against the docker `test` profile: the public profile's 글 and 댓글 tabs
 * (`GET /profiles/:publicId/posts`, `/comments`) and MY '내 글' (`GET /me/posts`, `/me/comments`).
 * Pinned: newest first, a page at a time on the (created at, id) keyset; the profile's lists hold
 * the member's posts and comments (대댓글 included) that are neither deleted nor hidden — on ended
 * and voided markets too, and comments under a hidden post or a deleted post's placeholder — and
 * exactly what the profile counts; anyone reads them, signed in or not, the same answer, naming the
 * member by the public face alone; an unknown or malformed public id is NOT_FOUND as the profile
 * is; a comment names its post by id alone when the post is a placeholder; MY lists the member's
 * own, the hidden ones marked (reason null until #50) and the deleted ones never, and only to the
 * member, who deletes a hidden one through the delete routes (MY's 삭제, owner decision
 * 2026-10-22); N04 §7: a post or comment deleted leaves both lists and the counts, and a public item
 * cleared leaves the profile. Nothing of the member's trading rides on an item. Skips when TEST_*
 * are unset.
 *
 * Not pinned here, because neither state exists yet: a withdrawn account's lists answering
 * NOT_FOUND (`memberIdOf` through `postAuthorOf`, #37-16) — #140 adds it — and a restricted
 * member's items staying in every list (#37-14: the lists read no sanction) — #185/#139 add it
 * (ADR-0080 결과 5).
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createComment,
  createCommentLike,
  createMarket,
  createMedia,
  createPost,
  createPostLike,
  createUser,
} from '@buddha/db/test';
import {
  authoredCommentSchema,
  myCommentSchema,
  myPostSchema,
  postSummarySchema,
  publicProfileSchema,
  type AuthoredComment,
  type MarketStatus,
  type MyComment,
  type MyPost,
  type PostSummary,
  type PublicProfile,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

/** A moment `seconds` after a fixed start: the lists' order is set by hand, never by the clock. */
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds));

describe.skipIf(!hasTestInfra)('/api/v1 authored lists (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let other: TestUser;
  let publicId: string;
  let market: Awaited<ReturnType<typeof createMarket>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
    other = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    await completeOnboarding(t.db, { userId: other.id });
    const [row] = await t.db
      .select({ publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));
    publicId = row!.publicId;
    market = await createMarket(t.db, { title: '기준금리 인하' });
  });

  const get = (url: string, who: TestUser | null = null) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const send = (url: string, payload: unknown, who: TestUser, method: 'POST' | 'PUT' = 'POST') =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify(payload),
    });
  const pageOf = async <T>(url: string, who: TestUser | null = null): Promise<Page<T>> => {
    const res = await get(url, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page<T>>();
  };
  const profilePosts = async (query = '', id = publicId) => {
    const page = await pageOf<PostSummary>(`/profiles/${id}/posts${query}`);
    for (const item of page.data) postSummarySchema.parse(item);
    return page;
  };
  const profileComments = async (query = '', id = publicId) => {
    const page = await pageOf<AuthoredComment>(`/profiles/${id}/comments${query}`);
    for (const item of page.data) authoredCommentSchema.parse(item);
    return page;
  };
  const myPosts = async (who: TestUser = member, query = '') => {
    const page = await pageOf<MyPost>(`/me/posts${query}`, who);
    for (const item of page.data) myPostSchema.parse(item);
    return page;
  };
  const myComments = async (who: TestUser = member, query = '') => {
    const page = await pageOf<MyComment>(`/me/comments${query}`, who);
    for (const item of page.data) myCommentSchema.parse(item);
    return page;
  };
  const profile = async (): Promise<PublicProfile> => {
    const res = await get(`/profiles/${publicId}`);
    expect(res.statusCode, res.body).toBe(200);
    return publicProfileSchema.parse(res.json<{ data: unknown }>().data);
  };
  const ids = (page: { data: { id: string }[] }) => page.data.map((item) => item.id);
  const errorOf = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error;

  /** Every page of a list, following `nextCursor`, `limit` items at a time. */
  const allPages = async <T extends { id: string }>(
    read: (query: string) => Promise<Page<T>>,
    limit: number,
  ) => {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null
          ? `?limit=${String(limit)}`
          : `?limit=${String(limit)}&cursor=${encodeURIComponent(cursor)}`;
      const page: Page<T> = await read(query);
      pages.push(ids(page));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);
    return pages;
  };

  // ---- the profile's 글 tab ----------------------------------------------------------------------

  it('lists the member’s posts newest first, ended and voided markets included, never a deleted or hidden one (#37-14)', async () => {
    const markets: Record<Exclude<MarketStatus, 'draft'>, typeof market> = {
      open: market,
      closed: await createMarket(t.db, { status: 'closed' }),
      resolved: await createMarket(t.db, { status: 'resolved', resolvedResult: 'YES' }),
      settled: await createMarket(t.db, { status: 'settled', resolvedResult: 'NO' }),
      voided: await createMarket(t.db, { status: 'voided' }),
    };
    const write = (status: keyof typeof markets, seconds: number, extra = {}) =>
      createPost(t.db, {
        marketId: markets[status].id,
        authorId: member.id,
        title: `${status} 글`,
        createdAt: at(seconds),
        ...extra,
      });
    const open = await write('open', 1);
    const closed = await write('closed', 2);
    const resolved = await write('resolved', 3);
    const settled = await write('settled', 4);
    const voided = await write('voided', 5);
    // Deleted with a comment under it — the placeholder on its page — and with nothing: both out.
    const deletedWithReply = await write('open', 6, { deletedAt: at(60) });
    await createComment(t.db, { postId: deletedWithReply.id, authorId: other.id });
    await write('open', 7, { deletedAt: at(60) });
    // Hidden by an operator (#50 brings the action): out, deleted or not.
    await write('open', 8, { hiddenAt: at(60) });
    await write('open', 9, { hiddenAt: at(60), deletedAt: at(61) });
    // Another member's post: never on this profile.
    await createPost(t.db, { marketId: market.id, authorId: other.id, createdAt: at(10) });

    const page = await profilePosts();
    expect(ids(page)).toEqual([voided.id, settled.id, resolved.id, closed.id, open.id]);
    expect(page.data.map((item) => item.market.status)).toEqual([
      'voided',
      'settled',
      'resolved',
      'closed',
      'open',
    ]);
    expect(page.meta.nextCursor).toBeNull();
    // The profile counts what its tab lists (ADR-0078).
    expect((await profile()).postCount).toBe(page.data.length);
  });

  it('shows each post as the community card: the member by public face, the counts, the market it leads to', async () => {
    const media = await createMedia(t.db, { ownerId: member.id });
    const post = await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      title: '근거',
      text: '\n첫 줄\n\n둘째 줄',
      imageIds: [media.id],
      editedAt: new Date(),
    });
    // Two visible comments and a hidden one; three likes, one the member's own (a card counts it).
    await createComment(t.db, { postId: post.id, authorId: other.id });
    await createComment(t.db, { postId: post.id, authorId: member.id });
    await createComment(t.db, { postId: post.id, authorId: other.id, hiddenAt: new Date() });
    await createPostLike(t.db, { postId: post.id, userId: member.id });
    await createPostLike(t.db, { postId: post.id, userId: other.id });
    await createPostLike(t.db, { postId: post.id, userId: (await createUser(t.db)).user.id });

    const [item] = (await profilePosts()).data;
    const [profileRow] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));
    expect(item).toEqual({
      id: post.id,
      title: '근거',
      excerpt: '첫 줄\n둘째 줄',
      thumbnailUrl: `/api/v1/media/${media.id}`,
      author: {
        kind: 'member',
        publicId,
        nickname: profileRow!.nickname,
        imageUrl: null,
        isAdmin: false,
      },
      market: {
        id: market.id,
        slug: market.slug,
        title: '기준금리 인하',
        status: 'open',
        category: expect.objectContaining({ slug: expect.any(String) as unknown }) as unknown,
      },
      createdAt: post.createdAt.toISOString(),
      editedAt: expect.any(String) as unknown,
      commentCount: 2,
      likeCount: 3,
    });
    // The community list says the same of it.
    const community = await pageOf<PostSummary>('/posts');
    expect(community.data).toEqual([item]);
  });

  it('answers the same to anyone, signed in or not, and never names an account id (#37-1)', async () => {
    await createPost(t.db, { marketId: market.id, authorId: member.id });
    const post = await createPost(t.db, { marketId: market.id, authorId: other.id });
    await createComment(t.db, { postId: post.id, authorId: member.id });
    for (const path of ['posts', 'comments']) {
      const anonymous = await get(`/profiles/${publicId}/${path}`);
      expect(anonymous.statusCode, anonymous.body).toBe(200);
      expect((await get(`/profiles/${publicId}/${path}`, other)).body).toBe(anonymous.body);
      expect((await get(`/profiles/${publicId}/${path}`, member)).body).toBe(anonymous.body);
      expect(anonymous.body).not.toContain(member.id);
      expect(anonymous.body).not.toContain(other.id);
      // Nothing of trading rides on an item (N04 §2, N05 §2).
      expect(anonymous.body).not.toMatch(/position|order|balance|pnl|holding/i);
    }
  });

  it('marks the member an operator on an admin account’s items (#45-9)', async () => {
    const admin = await createUser(t.db, { role: 'admin' });
    const [row] = await t.db
      .select({ publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, admin.user.id));
    const post = await createPost(t.db, { marketId: market.id, authorId: admin.user.id });
    await createComment(t.db, { postId: post.id, authorId: admin.user.id });
    const [card] = (await profilePosts('', row!.publicId)).data;
    const [comment] = (await profileComments('', row!.publicId)).data;
    expect(card?.author).toMatchObject({ kind: 'member', isAdmin: true });
    expect(comment?.author).toMatchObject({ kind: 'member', isAdmin: true });
  });

  it('answers NOT_FOUND for an unknown or malformed public id, as the profile, and finds one typed in capitals', async () => {
    await createPost(t.db, { marketId: market.id, authorId: member.id });
    for (const path of ['posts', 'comments']) {
      for (const id of ['zzzzzzzzzz', 'nope', `${publicId}x`, '%20']) {
        const res = await get(`/profiles/${id}/${path}`);
        expect(res.statusCode, `${id} ${path}`).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      }
    }
    expect(ids(await profilePosts('', publicId.toUpperCase()))).toHaveLength(1);
  });

  // ---- the profile's 댓글 tab --------------------------------------------------------------------

  it('lists the member’s 댓글 and 대댓글 newest first, with the post and market each leads to (#37-14)', async () => {
    const ended = await createMarket(t.db, { status: 'settled', resolvedResult: 'YES' });
    const post = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      title: null,
      text: '\n\n제목 없는 글의 첫 줄\n둘째',
    });
    const endedPost = await createPost(t.db, {
      marketId: ended.id,
      authorId: other.id,
      title: '종료 시장의 글',
    });
    const hiddenPost = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      title: '숨긴 글의 제목',
      text: '숨긴 글의 본문',
      hiddenAt: at(100),
    });
    const deletedPost = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      title: '지운 글의 제목',
      text: '지운 글의 본문',
      deletedAt: at(100),
    });
    const write = (postId: string, seconds: number, extra = {}) =>
      createComment(t.db, { postId, authorId: member.id, createdAt: at(seconds), ...extra });
    const first = await write(post.id, 1);
    const othersComment = await createComment(t.db, {
      postId: post.id,
      authorId: other.id,
      createdAt: at(2),
    });
    const reply = await write(post.id, 3, { parentId: othersComment.id, editedAt: at(50) });
    const onEnded = await write(endedPost.id, 4);
    // A comment under a hidden post, and under a deleted post it keeps as the placeholder: read
    // in full on the post page, so listed — the post by its id alone.
    const underHidden = await write(hiddenPost.id, 5);
    const underDeleted = await write(deletedPost.id, 6);
    // Deleted (a 댓글 with a 대댓글 under it — its placeholder — and a 대댓글) and hidden: out.
    const deleted = await write(post.id, 7, { deletedAt: at(60) });
    await createComment(t.db, { postId: post.id, authorId: other.id, parentId: deleted.id });
    await write(post.id, 8, { parentId: othersComment.id, deletedAt: at(60) });
    await write(post.id, 9, { hiddenAt: at(60) });
    // A 대댓글 under the member's hidden 댓글 stays in view, and so on the profile.
    const hiddenThread = await write(post.id, 10, { hiddenAt: at(60) });
    const underHiddenThread = await createComment(t.db, {
      postId: post.id,
      authorId: member.id,
      parentId: hiddenThread.id,
      createdAt: at(11),
    });
    await createCommentLike(t.db, { commentId: reply.id, userId: other.id });
    await createCommentLike(t.db, { commentId: reply.id, userId: member.id });

    const page = await profileComments();
    expect(ids(page)).toEqual([
      underHiddenThread.id,
      underDeleted.id,
      underHidden.id,
      onEnded.id,
      reply.id,
      first.id,
    ]);
    const byId = new Map(page.data.map((item) => [item.id, item]));
    expect(byId.get(reply.id)).toMatchObject({
      parentId: othersComment.id,
      body: reply.body,
      editedAt: at(50).toISOString(),
      likeCount: 2,
      author: { kind: 'member', publicId, isAdmin: false },
      post: { state: 'published', id: post.id, title: null, excerpt: '제목 없는 글의 첫 줄\n둘째' },
      market: { id: market.id, status: 'open' },
    });
    expect(byId.get(first.id)).toMatchObject({ parentId: null, likeCount: 0, editedAt: null });
    expect(byId.get(onEnded.id)).toMatchObject({
      post: { state: 'published', id: endedPost.id, title: '종료 시장의 글' },
      market: { id: ended.id, status: 'settled' },
    });
    // The placeholders: the id alone, no word of the post.
    expect(byId.get(underHidden.id)?.post).toEqual({ state: 'hidden', id: hiddenPost.id });
    expect(byId.get(underDeleted.id)?.post).toEqual({ state: 'deleted', id: deletedPost.id });
    const body = JSON.stringify(page);
    for (const word of ['숨긴 글의', '지운 글의']) expect(body).not.toContain(word);
    // The profile counts what its tab lists (ADR-0078).
    expect((await profile()).commentCount).toBe(page.data.length);
  });

  // ---- pages ------------------------------------------------------------------------------------

  it('pages both tabs newest first on the (created at, id) keyset, without a repeat or a gap', async () => {
    const posts = [];
    const comments = [];
    for (let i = 0; i < 5; i++) {
      // Two at each instant: the id breaks the tie.
      const createdAt = at(Math.floor(i / 2));
      const post = await createPost(t.db, { marketId: market.id, authorId: member.id, createdAt });
      posts.push(post);
      comments.push(await createComment(t.db, { postId: post.id, authorId: member.id, createdAt }));
    }
    const newestFirst = (rows: { id: string; createdAt: Date }[]) =>
      [...rows]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .map((row) => row.id);
    type Reader = (query: string) => Promise<Page<{ id: string }>>;
    const lists: [Reader, { id: string; createdAt: Date }[]][] = [
      [(query) => profilePosts(query), posts],
      [(query) => profileComments(query), comments],
      [(query) => myPosts(member, query), posts],
      [(query) => myComments(member, query), comments],
    ];
    for (const [read, rows] of lists) {
      const pages = await allPages(read, 2);
      // A full last page carries no cursor: 더 보기 never loads an empty page.
      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(pages.flat()).toEqual(newestFirst(rows));
      expect(await allPages(read, 5)).toEqual([newestFirst(rows)]);
    }
    // A cursor that does not decode serves the first page.
    expect(ids(await profilePosts('?cursor=not-a-cursor&limit=2'))).toEqual(
      newestFirst(posts).slice(0, 2),
    );
    const tooMany = await get(`/profiles/${publicId}/posts?limit=101`);
    expect(tooMany.statusCode).toBe(400);
    expect(errorOf(tooMany).code).toBe('VALIDATION_ERROR');
  });

  // ---- MY 내 글 ----------------------------------------------------------------------------------

  it('lists the member’s own on MY, the hidden ones marked and the deleted ones never (#45-5, #51)', async () => {
    const media = await createMedia(t.db, { ownerId: member.id });
    const visible = await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      createdAt: at(1),
    });
    const hidden = await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      title: '숨긴 내 글',
      text: '내 글의 본문',
      imageIds: [media.id],
      createdAt: at(2),
      hiddenAt: at(30),
    });
    await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      createdAt: at(3),
      deletedAt: at(30),
    });
    await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      createdAt: at(4),
      hiddenAt: at(30),
      deletedAt: at(31),
    });
    const othersPost = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      createdAt: at(5),
    });
    const comment = await createComment(t.db, {
      postId: othersPost.id,
      authorId: member.id,
      createdAt: at(6),
    });
    const hiddenComment = await createComment(t.db, {
      postId: othersPost.id,
      authorId: member.id,
      body: '숨긴 내 댓글',
      createdAt: at(7),
      hiddenAt: at(30),
    });
    // Under the member's own hidden post: a placeholder to the public, its id alone here too.
    const underHidden = await createComment(t.db, {
      postId: hidden.id,
      authorId: member.id,
      createdAt: at(8),
    });
    await createComment(t.db, {
      postId: othersPost.id,
      authorId: member.id,
      createdAt: at(9),
      deletedAt: at(30),
    });
    await createComment(t.db, { postId: othersPost.id, authorId: other.id, createdAt: at(10) });

    const posts = await myPosts();
    expect(ids(posts)).toEqual([hidden.id, visible.id]);
    expect(posts.data[0]).toMatchObject({
      title: '숨긴 내 글',
      excerpt: '내 글의 본문',
      // `GET /media/:mediaId` serves no image of a hidden post: no thumbnail to point at.
      thumbnailUrl: null,
      hidden: { reason: null },
    });
    expect(posts.data[1]?.hidden).toBeNull();
    const comments = await myComments();
    expect(ids(comments)).toEqual([underHidden.id, hiddenComment.id, comment.id]);
    expect(comments.data.map((item) => item.hidden)).toEqual([null, { reason: null }, null]);
    expect(comments.data[0]?.post).toEqual({ state: 'hidden', id: hidden.id });
    expect(comments.data[1]).toMatchObject({ body: '숨긴 내 댓글' });

    // The profile leaves the hidden ones out, and nobody else's MY holds the member's.
    expect(ids(await profilePosts())).toEqual([visible.id]);
    expect(ids(await profileComments())).toEqual([underHidden.id, comment.id]);
    expect((await myPosts(other)).data.map((item) => item.id)).toEqual([othersPost.id]);
    expect(ids(await myComments(other))).toEqual([expect.any(String) as unknown]);
    expect(JSON.stringify(await myComments(other))).not.toContain('숨긴 내 댓글');
  });

  it('lets the member delete a hidden post and a hidden comment from MY through the delete routes (owner decision 2026-10-22)', async () => {
    // MY's '삭제' beside the '숨김' line sends the author's own delete routes, which take a hidden
    // item: after it, the item leaves MY, and what hung under it keeps its place.
    const hiddenPost = await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      title: '숨긴 내 글',
      createdAt: at(1),
      hiddenAt: at(30),
    });
    // Answered by another member: deleted, the post stays as '삭제된 글입니다' over that answer.
    await createComment(t.db, { postId: hiddenPost.id, authorId: other.id, createdAt: at(2) });
    // The member's own visible comment under it: MY's 댓글 tab names the post by its state.
    const underIt = await createComment(t.db, {
      postId: hiddenPost.id,
      authorId: member.id,
      createdAt: at(3),
    });
    const othersPost = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      createdAt: at(4),
    });
    const hiddenComment = await createComment(t.db, {
      postId: othersPost.id,
      authorId: member.id,
      body: '숨긴 내 댓글',
      createdAt: at(5),
      hiddenAt: at(30),
    });
    await createComment(t.db, {
      postId: othersPost.id,
      authorId: other.id,
      parentId: hiddenComment.id,
      createdAt: at(6),
    });

    expect(ids(await myPosts())).toEqual([hiddenPost.id]);
    expect((await myPosts()).data[0]?.hidden).toEqual({ reason: null });
    expect(ids(await myComments())).toEqual([hiddenComment.id, underIt.id]);
    expect((await myComments()).data[1]?.post).toEqual({ state: 'hidden', id: hiddenPost.id });
    // Hidden, neither is on the profile or in its counts; the comment under the post is.
    expect(await profile()).toMatchObject({ postCount: 0, commentCount: 1 });

    const post = await send(
      `/posts/${hiddenPost.id}/delete`,
      { expectedAccountId: member.id },
      member,
    );
    expect(post.statusCode, post.body).toBe(200);
    expect(post.json<{ data: unknown }>().data).toEqual({ id: hiddenPost.id, placeholder: true });
    const comment = await send(
      `/comments/${hiddenComment.id}/delete`,
      { expectedAccountId: member.id },
      member,
    );
    expect(comment.statusCode, comment.body).toBe(200);
    expect(comment.json<{ data: unknown }>().data).toEqual({
      id: hiddenComment.id,
      placeholder: true,
    });

    // Gone from MY; the comment under the post now names it as the deleted placeholder (the
    // author's deletion comes first, `publicStateOf`).
    expect((await myPosts()).data).toEqual([]);
    expect(ids(await myComments())).toEqual([underIt.id]);
    expect((await myComments()).data[0]?.post).toEqual({ state: 'deleted', id: hiddenPost.id });
    // The profile's counts and lists agree, as before: neither deleted item was in them.
    expect(await profile()).toMatchObject({ postCount: 0, commentCount: 1 });
    expect((await profilePosts()).data).toEqual([]);
    expect(ids(await profileComments())).toEqual([underIt.id]);
    // The public pages: the post is its deleted placeholder, the 댓글 too, over what hangs under.
    const page = await get(`/posts/${hiddenPost.id}`);
    expect(page.json<{ data: { state: string } }>().data.state).toBe('deleted');
    const threads = await pageOf<{ comment: { state: string; id: string }; replies: unknown[] }>(
      `/posts/${othersPost.id}/comments`,
    );
    expect(threads.data.map((thread) => thread.comment)).toEqual([
      { state: 'deleted', id: hiddenComment.id },
    ]);
    expect(threads.data[0]?.replies).toHaveLength(1);
    expect(JSON.stringify(threads)).not.toContain('숨긴 내 댓글');
    // A second press finds nothing (NOT_FOUND), as for any deleted item.
    const again = await send(
      `/posts/${hiddenPost.id}/delete`,
      { expectedAccountId: member.id },
      member,
    );
    expect(again.statusCode).toBe(404);
  });

  it('lets an account the onboarding has not finished delete its hidden comment: signed in is enough', async () => {
    // The comment route asks a session only (ADR-0074). The post route does too once this branch
    // sits on #46's answers (owner decision 2026-10-19 답 2, ADR-0073 9-16 there); on this base it
    // still asks the onboarding, so the post case joins this test with the restack (ADR-0080 결과 5).
    const fresh = await signUpTestUser(t);
    const othersPost = await createPost(t.db, { marketId: market.id, authorId: other.id });
    const hidden = await createComment(t.db, {
      postId: othersPost.id,
      authorId: fresh.id,
      hiddenAt: new Date(),
    });
    expect(ids(await myComments(fresh))).toEqual([hidden.id]);
    const res = await send(`/comments/${hidden.id}/delete`, { expectedAccountId: fresh.id }, fresh);
    expect(res.statusCode, res.body).toBe(200);
    expect((await myComments(fresh)).data).toEqual([]);
  });

  it('answers MY to its own session alone: signed out is UNAUTHENTICATED', async () => {
    for (const path of ['/me/posts', '/me/comments']) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    }
  });

  it('answers MY to an account the onboarding has not finished, as its own writing is its own', async () => {
    const fresh = await signUpTestUser(t);
    expect((await myPosts(fresh)).data).toEqual([]);
    expect((await myComments(fresh)).data).toEqual([]);
  });

  // ---- N04 §7: deletion (#37-19) -----------------------------------------------------------------

  it('takes a deleted post and a deleted comment off the profile, MY and the counts (N04 §7)', async () => {
    const document = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const written = await send(
      '/posts',
      {
        marketId: market.id,
        title: '지울 글',
        body: document('곧 지운다'),
        expectedAccountId: member.id,
      },
      member,
    );
    expect(written.statusCode, written.body).toBe(201);
    const postId = written.json<{ data: { id: string } }>().data.id;
    const othersPost = await createPost(t.db, { marketId: market.id, authorId: other.id });
    const commented = await send(
      `/posts/${othersPost.id}/comments`,
      { body: '지울 댓글', expectedAccountId: member.id },
      member,
    );
    expect(commented.statusCode, commented.body).toBe(201);
    const commentId = commented.json<{ data: { id: string } }>().data.id;
    // Someone answered the post: deleted, it stays as the placeholder on its page — and still
    // leaves every list (#45-5).
    await createComment(t.db, { postId, authorId: other.id });

    expect(ids(await profilePosts())).toEqual([postId]);
    expect(ids(await myPosts())).toEqual([postId]);
    expect(ids(await profileComments())).toEqual([commentId]);
    expect(ids(await myComments())).toEqual([commentId]);
    expect(await profile()).toMatchObject({ postCount: 1, commentCount: 1 });

    const deletedPost = await send(
      `/posts/${postId}/delete`,
      { expectedAccountId: member.id },
      member,
    );
    expect(deletedPost.statusCode, deletedPost.body).toBe(200);
    const deletedComment = await send(
      `/comments/${commentId}/delete`,
      { expectedAccountId: member.id },
      member,
    );
    expect(deletedComment.statusCode, deletedComment.body).toBe(200);

    expect((await profilePosts()).data).toEqual([]);
    expect((await myPosts()).data).toEqual([]);
    expect((await profileComments()).data).toEqual([]);
    expect((await myComments()).data).toEqual([]);
    expect(await profile()).toMatchObject({ postCount: 0, commentCount: 0 });
    const page = await get(`/posts/${postId}`);
    expect(page.json<{ data: { state: string } }>().data.state).toBe('deleted');
  });

  it('takes a cleared public item off the profile: the 소개 and an interest category (N04 §7)', async () => {
    const category = await createCategory(t.db, { slug: 'n04-economy', nameKo: '경제' });
    expect(
      (await send('/me/bio', { bio: '소개 한 줄', expectedAccountId: member.id }, member, 'PUT'))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await send(
          '/me/interest-categories',
          { categoryIds: [category.id], expectedAccountId: member.id },
          member,
          'PUT',
        )
      ).statusCode,
    ).toBe(200);
    expect(await profile()).toMatchObject({
      bio: '소개 한 줄',
      interestCategories: [expect.objectContaining({ slug: 'n04-economy' })],
    });

    expect(
      (await send('/me/bio', { bio: '', expectedAccountId: member.id }, member, 'PUT')).statusCode,
    ).toBe(200);
    expect(
      (
        await send(
          '/me/interest-categories',
          { categoryIds: [], expectedAccountId: member.id },
          member,
          'PUT',
        )
      ).statusCode,
    ).toBe(200);
    const cleared = await profile();
    expect(cleared.bio).toBeNull();
    expect(cleared.interestCategories).toEqual([]);
    expect(JSON.stringify(cleared)).not.toContain('소개 한 줄');
  });
});
