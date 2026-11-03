/**
 * 공개 프로필 (#41, ADR-0078; ADR-0069 decision 3 #37, decision 4 #41, decision 5, decision 7)
 * against the docker `test` profile: `GET /profiles/:publicId` and the 소개 of MY 설정
 * (`PUT /me/bio`). Pinned: anyone reads a profile, signed in or not, and every reader hears the
 * same answer; it holds the public items alone — the member's public face (public id, current
 * nickname, image, 운영자 mark), the 소개, the interest categories picked, the month joined in Korea
 * time and the counts of the visible posts, comments and the likes others gave them — and nothing
 * more of the account; the gap between that total and the items' own counts is the member's own
 * likes, which anyone can read (accepted by the owner, 2026-10-21 (2nd) answer 1); an unknown or
 * malformed public id is NOT_FOUND, a public id typed in capitals finds the member, and the old
 * link shows the new nickname; only the member writes the 소개 — plain text, 160 characters, line
 * breaks kept, blank clears it — through the account the screen shows, a new one once onboarded,
 * and nothing else of the account changes; an account a re-consent holds back clears its 소개 and
 * drops categories with sign-in only, and adds nothing (owner decision 2026-10-21 answer 2). Skips
 * when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createComment,
  createCommentLike,
  createConsents,
  createMarket,
  createPost,
  createPostLike,
  createUser,
} from '@buddha/db/test';
import {
  bioTooLongMessage,
  meSchema,
  onboardingRequiredDetailsSchema,
  publicProfileSchema,
  type Me,
  type PublicProfile,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

describe.skipIf(!hasTestInfra)('/api/v1/profiles and the 소개 (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let reader: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
    reader = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    await completeOnboarding(t.db, { userId: reader.id });
  });

  const publicIdOf = async (userId: string) => {
    const [row] = await t.db
      .select({ publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.publicId;
  };
  const read = (publicId: string, who: TestUser | null = null) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/${encodeURIComponent(publicId)}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const profileOf = async (publicId: string, who: TestUser | null = null) => {
    const res = await read(publicId, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: PublicProfile }>().data;
  };
  const putBio = (bio: unknown, who: TestUser | null = member, expectedAccountId?: string) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/bio',
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify({ bio, expectedAccountId: expectedAccountId ?? who?.id ?? 'x' }),
    });
  const meOf = async (who: TestUser): Promise<Me> => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data);
  };
  const errorOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; details?: unknown } }>().error;
  const putInterests = (categoryIds: number[], who: TestUser = member) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/interest-categories',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ categoryIds, expectedAccountId: who.id }),
    });
  /** The steps an ONBOARDING_REQUIRED refusal names, after checking it is one. */
  const stepsOf = (res: { statusCode: number; body: string; json: <T>() => T }) => {
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('ONBOARDING_REQUIRED');
    return onboardingRequiredDetailsSchema.parse(errorOf(res).details).steps;
  };

  // ---- the public profile -----------------------------------------------------------------------

  it('shows the public items alone, the same to anyone, signed in or not (#37-1, #37-3~#37-5)', async () => {
    const publicId = await publicIdOf(member.id);
    // Joined at 00:30 on 1 October in Korea, still 30 September in UTC: Korea's month.
    await t.db
      .update(schema.profiles)
      .set({
        nickname: '예측가',
        bio: '첫 줄\n\n셋째 줄',
        createdAt: new Date('2026-09-30T15:30:00.000Z'),
      })
      .where(eq(schema.profiles.userId, member.id));
    // A top-level category ordered after its sub-categories, as the seed's are (top-level 10~50,
    // sub-categories from 10 under each): it still comes first in its group.
    const economy = await createCategory(t.db, {
      slug: 'p-economy',
      nameKo: '경제',
      sortOrder: 40,
    });
    const science = await createCategory(t.db, { slug: 'p-science', nameKo: '과학', sortOrder: 0 });
    // Two top-level groups of the same order: each stays whole, the older one first.
    const culture = await createCategory(t.db, { slug: 'p-culture', nameKo: '문화', sortOrder: 0 });
    const housing = await createCategory(t.db, {
      slug: 'p-housing',
      nameKo: '부동산',
      sortOrder: 20,
      parentId: economy.id,
    });
    const jobs = await createCategory(t.db, {
      slug: 'p-jobs',
      nameKo: '고용',
      sortOrder: 10,
      parentId: economy.id,
    });
    const space = await createCategory(t.db, {
      slug: 'p-space',
      nameKo: '우주',
      parentId: science.id,
    });
    const film = await createCategory(t.db, {
      slug: 'p-film',
      nameKo: '영화',
      sortOrder: 10,
      parentId: culture.id,
    });
    // A sub-category picked without its top-level one; a retired one the list no longer offers,
    // and an active sub-category under it, which the list leaves out with it (7-4).
    const retired = await createCategory(t.db, { slug: 'p-retired', isActive: false });
    const orphan = await createCategory(t.db, {
      slug: 'p-orphan',
      nameKo: '닫힌 상위의 하위',
      parentId: retired.id,
    });
    await t.db.insert(schema.profileInterestCategories).values(
      [housing, film, economy, orphan, space, jobs, culture, retired].map((category) => ({
        userId: member.id,
        categoryId: category.id,
      })),
    );

    const anonymous = await profileOf(publicId);
    expect(publicProfileSchema.parse(anonymous)).toEqual(anonymous);
    expect(anonymous).toEqual({
      member: { kind: 'member', publicId, nickname: '예측가', imageUrl: null, isAdmin: false },
      bio: '첫 줄\n\n셋째 줄',
      // The list's order: the groups of sortOrder 0 (science's, then culture's, made after it)
      // before economy's, each whole; a top-level category before its sub-categories, whatever
      // their order; siblings by their order.
      interestCategories: [
        { slug: 'p-space', nameKo: '우주', parent: { slug: 'p-science', nameKo: '과학' } },
        { slug: 'p-culture', nameKo: '문화', parent: null },
        { slug: 'p-film', nameKo: '영화', parent: { slug: 'p-culture', nameKo: '문화' } },
        { slug: 'p-economy', nameKo: '경제', parent: null },
        { slug: 'p-jobs', nameKo: '고용', parent: { slug: 'p-economy', nameKo: '경제' } },
        { slug: 'p-housing', nameKo: '부동산', parent: { slug: 'p-economy', nameKo: '경제' } },
      ],
      joinedMonth: '2026-10',
      postCount: 0,
      commentCount: 0,
      receivedLikeCount: 0,
    });
    // Exactly these keys: nothing of the account rides along (#37-8, #37-11~#37-13).
    const raw = (await read(publicId)).json<{ data: Record<string, unknown> }>().data;
    expect(Object.keys(raw).sort()).toEqual(
      [
        'bio',
        'commentCount',
        'interestCategories',
        'joinedMonth',
        'member',
        'postCount',
        'receivedLikeCount',
      ].sort(),
    );
    const body = (await read(publicId)).body;
    for (const secret of [member.id, member.email]) expect(body).not.toContain(secret);
    // The member, another account and nobody hear the same answer.
    expect(await profileOf(publicId, member)).toEqual(anonymous);
    expect(await profileOf(publicId, reader)).toEqual(anonymous);
  });

  it('shows nothing for an unpicked list or an empty 소개, and 운영자 on an admin account', async () => {
    const admin = await createUser(t.db, { role: 'admin', nickname: '관리자_프로필' });
    const profile = await profileOf(admin.profile.publicId);
    expect(profile).toMatchObject({
      member: { nickname: '관리자_프로필', isAdmin: true },
      bio: null,
      interestCategories: [],
    });
    // An account that has not finished the onboarding still has its profile.
    const fresh = await createUser(t.db);
    expect((await profileOf(fresh.profile.publicId)).member.isAdmin).toBe(false);
  });

  it('answers NOT_FOUND for an unknown or malformed id, and finds an id typed in capitals', async () => {
    const publicId = await publicIdOf(member.id);
    const unknown = publicId === '2222222222' ? '3333333333' : '2222222222';
    for (const id of [unknown, 'x', member.id, `${publicId}a`, 'abcdefgh1o']) {
      const res = await read(id);
      expect({ id, status: res.statusCode, code: errorOf(res).code }).toEqual({
        id,
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect((await profileOf(publicId.toUpperCase())).member.publicId).toBe(publicId);
  });

  it('keeps the link when the nickname changes: the same person, the current nickname only (#37-2, #37-3)', async () => {
    const publicId = await publicIdOf(member.id);
    const before = (await profileOf(publicId)).member.nickname;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: member.cookie,
      },
      payload: JSON.stringify({ nickname: '새이름이다', expectedAccountId: member.id }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await read(publicId);
    expect(after.json<{ data: PublicProfile }>().data.member).toMatchObject({
      publicId,
      nickname: '새이름이다',
    });
    expect(after.body).not.toContain(before);
  });

  it('counts the visible posts and comments and the likes others gave them, never a deleted or hidden one (#37-4)', async () => {
    const publicId = await publicIdOf(member.id);
    const open = await createMarket(t.db);
    const cancelled = await createMarket(t.db, { status: 'cancelled' });
    const other = (await createUser(t.db)).user;
    const now = new Date();
    // Posts: two visible (one on a cancelled market, #37-14), one deleted, one hidden.
    const visible = await createPost(t.db, { marketId: open.id, authorId: member.id });
    const onCancelled = await createPost(t.db, { marketId: cancelled.id, authorId: member.id });
    const deletedPost = await createPost(t.db, {
      marketId: open.id,
      authorId: member.id,
      deletedAt: now,
    });
    const hiddenPost = await createPost(t.db, {
      marketId: open.id,
      authorId: member.id,
      hiddenAt: now,
    });
    // Another's post, under which the member comments.
    const theirs = await createPost(t.db, { marketId: open.id, authorId: other.id });
    // Comments: a 댓글 and a 대댓글 of the member's, a 대댓글 under another's deleted 댓글 and one
    // under the hidden post (both stay in view), a deleted 댓글 with a reply of another's under
    // it (its placeholder is nobody's comment) and a hidden one.
    const mine = await createComment(t.db, { postId: theirs.id, authorId: member.id });
    const reply = await createComment(t.db, {
      postId: theirs.id,
      authorId: member.id,
      parentId: mine.id,
    });
    const theirDeleted = await createComment(t.db, {
      postId: theirs.id,
      authorId: other.id,
      deletedAt: now,
    });
    const underDeleted = await createComment(t.db, {
      postId: theirs.id,
      authorId: member.id,
      parentId: theirDeleted.id,
    });
    const underHiddenPost = await createComment(t.db, {
      postId: hiddenPost.id,
      authorId: member.id,
    });
    const deletedComment = await createComment(t.db, {
      postId: theirs.id,
      authorId: member.id,
      deletedAt: now,
    });
    await createComment(t.db, {
      postId: theirs.id,
      authorId: other.id,
      parentId: deletedComment.id,
    });
    const hiddenComment = await createComment(t.db, {
      postId: theirs.id,
      authorId: member.id,
      hiddenAt: now,
    });
    // Also in view, so counted: a 댓글 under the member's deleted post, which keeps it as the
    // placeholder (ADR-0074), and a 대댓글 under another's hidden 댓글 (ADR-0074 7-5).
    const underDeletedPost = await createComment(t.db, {
      postId: deletedPost.id,
      authorId: member.id,
    });
    const theirHidden = await createComment(t.db, {
      postId: theirs.id,
      authorId: other.id,
      hiddenAt: now,
    });
    const underHidden = await createComment(t.db, {
      postId: theirs.id,
      authorId: member.id,
      parentId: theirHidden.id,
    });
    // Likes: anyone's counts (a withdrawn liker's would too, #37-17) but the member's own on their
    // own post or comment, which each item's count keeps and the total received leaves out (owner
    // decision 2026-10-21 answer 3).
    const likers = [reader.id, other.id, member.id];
    for (const userId of likers) await createPostLike(t.db, { postId: visible.id, userId });
    await createPostLike(t.db, { postId: onCancelled.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: reply.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: reply.id, userId: member.id });
    await createCommentLike(t.db, { commentId: underDeleted.id, userId: other.id });
    await createCommentLike(t.db, { commentId: underHiddenPost.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: underDeletedPost.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: underHidden.id, userId: reader.id });
    // The likes of what is no longer in view leave the total (owner decision 2026-10-20).
    await createPostLike(t.db, { postId: deletedPost.id, userId: reader.id });
    await createPostLike(t.db, { postId: hiddenPost.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: deletedComment.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: hiddenComment.id, userId: reader.id });
    // Another's posts and comments, and their likes, are not the member's.
    await createPostLike(t.db, { postId: theirs.id, userId: member.id });

    expect(await profileOf(publicId)).toMatchObject({
      postCount: 2,
      commentCount: 6,
      receivedLikeCount: 8,
    });
    // The items' own counts keep the member's likes: the post's 3, the 대댓글's 2.
    const postPage = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${visible.id}` });
    expect(postPage.json<{ data: { likeCount: number } }>().data.likeCount).toBe(3);
    const thread = await t.app.inject({
      method: 'GET',
      url: `/api/v1/posts/${theirs.id}/comments`,
    });
    expect(thread.statusCode, thread.body).toBe(200);
    const replyCount = thread
      .json<{ data: { replies: { id: string; likeCount?: number }[] }[] }>()
      .data.flatMap((item) => item.replies)
      .find((row) => row.id === reply.id)?.likeCount;
    expect(replyCount).toBe(2);
    // Deleting a post takes it and its likes off the profile (#37-19: 글 삭제의 프로필 반영) —
    // the other two of its likes; the member's own was never in the total.
    await t.db.update(schema.posts).set({ deletedAt: now }).where(eq(schema.posts.id, visible.id));
    expect(await profileOf(publicId)).toMatchObject({
      postCount: 1,
      commentCount: 6,
      receivedLikeCount: 6,
    });
  });

  it('lets anyone read the member’s own likes off the two public numbers (answer 3; accepted by the owner, 2026-10-21 (2nd) answer 1)', async () => {
    // The total leaves the member's own likes out while each item's count keeps them, so the gap
    // is exactly those likes (decision 7-3) — against ADR-0076's «누른 사람 목록 없음» for the
    // member's own likes, which the owner accepted as it is («이대로 둠», ADR-0078).
    const publicId = await publicIdOf(member.id);
    const market = await createMarket(t.db);
    const first = await createPost(t.db, { marketId: market.id, authorId: member.id });
    const second = await createPost(t.db, { marketId: market.id, authorId: member.id });
    await createPostLike(t.db, { postId: first.id, userId: reader.id });
    await createPostLike(t.db, { postId: first.id, userId: member.id });
    const likeCountOf = async (postId: string) => {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ data: { likeCount: number } }>().data.likeCount;
    };
    // To a visitor signed out, the post says 2 and the profile 1: the member liked their own post.
    expect(await likeCountOf(first.id)).toBe(2);
    expect((await profileOf(publicId)).receivedLikeCount).toBe(1);
    // And which one: the second post's count rises while the total stays.
    await createPostLike(t.db, { postId: second.id, userId: member.id });
    expect(await likeCountOf(second.id)).toBe(1);
    expect((await profileOf(publicId)).receivedLikeCount).toBe(1);
  });

  // ---- the 소개 of MY 설정 -----------------------------------------------------------------------

  it('sets, keeps and clears the member’s 소개, shown on the profile and in GET /me', async () => {
    const publicId = await publicIdOf(member.id);
    const before = await meOf(member);
    expect(before.profile.bio).toBeNull();
    const res = await putBio('  안녕하세요\r\n\r\n예측을 좋아합니다 https://example.com  ');
    expect(res.statusCode, res.body).toBe(200);
    const written = '안녕하세요\n\n예측을 좋아합니다 https://example.com';
    const me = meSchema.parse(res.json<{ data: unknown }>().data);
    expect(me.profile.bio).toBe(written);
    // Nothing else of the account changed: the 소개 is the one public item this writes.
    expect({ ...me, profile: { ...me.profile, bio: null } }).toEqual(before);
    expect((await profileOf(publicId)).bio).toBe(written);
    // The same text again changes nothing, the row included.
    const [{ updatedAt } = { updatedAt: new Date(0) }] = await t.db
      .select({ updatedAt: schema.profiles.updatedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));
    expect((await putBio(written)).statusCode).toBe(200);
    const [again] = await t.db
      .select({ updatedAt: schema.profiles.updatedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));
    expect(again?.updatedAt).toEqual(updatedAt);
    // 160 characters fit, line breaks counted.
    const longest = `${'가'.repeat(100)}\n${'😀'.repeat(59)}`;
    expect((await putBio(longest)).statusCode).toBe(200);
    expect((await meOf(member)).profile.bio).toBe(longest);
    // Blank and null clear it; the profile shows nothing.
    for (const blank of ['   \n ', null]) {
      await putBio('다시');
      const cleared = await putBio(blank);
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(meSchema.parse(cleared.json<{ data: unknown }>().data).profile.bio).toBeNull();
      expect((await profileOf(publicId)).bio).toBeNull();
    }
  });

  it('refuses a 소개 over 160 characters, naming it, and writes nothing', async () => {
    await putBio('그대로');
    const res = await putBio('가'.repeat(161));
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      code: 'VALIDATION_ERROR',
      message: expect.any(String) as unknown,
      details: [{ path: ['bio'], message: bioTooLongMessage(161) }],
    });
    expect((await meOf(member)).profile.bio).toBe('그대로');
    // A missing key is not a clearing.
    const missing = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/bio',
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: member.cookie,
      },
      payload: JSON.stringify({ expectedAccountId: member.id }),
    });
    expect(missing.statusCode).toBe(400);
    expect((await meOf(member)).profile.bio).toBe('그대로');
  });

  it('lets only the signed-in member write their own 소개, a new one once onboarded', async () => {
    await putBio('내 소개');
    // Nobody signed in.
    expect((await putBio('누구', null)).statusCode).toBe(401);
    // Another account's cookie naming the member: refused before anything is written.
    const other = await putBio('남의 소개', reader, member.id);
    expect(other.statusCode).toBe(403);
    expect(errorOf(other).details).toEqual([
      { path: ['expectedAccountId'], message: 'session belongs to another account' },
    ]);
    expect((await meOf(member)).profile.bio).toBe('내 소개');
    expect((await meOf(reader)).profile.bio).toBeNull();
    // An account that has not finished the onboarding only browses (#57-8): it writes no 소개.
    // Clearing asks sign-in only (answer 2), and a new account has nothing to clear: nothing changes.
    const fresh = await signUpTestUser(t);
    expect(stepsOf(await putBio('새 계정', fresh))).toEqual([
      'consent',
      'verification',
      'nickname',
    ]);
    expect((await putBio(null, fresh)).statusCode).toBe(200);
    expect((await meOf(fresh)).profile.bio).toBeNull();
  });

  it('lets an account a re-consent holds back clear its 소개 and drop categories, and add nothing (owner decision 2026-10-21 answer 2)', async () => {
    const publicId = await publicIdOf(member.id);
    const [a, b, c] = await Promise.all([
      createCategory(t.db),
      createCategory(t.db),
      createCategory(t.db),
    ]);
    expect((await putBio('내 소개')).statusCode).toBe(200);
    expect((await putInterests([a.id, b.id])).statusCode).toBe(200);
    // A revision that changed members' rights asks the consent again: the record the member agreed
    // to is one the list no longer holds (onboarding.controller.test.ts makes it the same way).
    await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, member.id));
    await createConsents(t.db, { userId: member.id, versions: { terms: 'draft-1999-01-01' } });
    expect((await meOf(member)).onboarding.nextStep).toBe('consent');
    const sorted = (ids: number[]) => [...ids].sort((x, y) => x - y);

    // New values wait for the consent: another 소개, a category added (even beside a dropped one).
    expect(stepsOf(await putBio('새 소개'))).toEqual(['consent']);
    expect(stepsOf(await putInterests([a.id, b.id, c.id]))).toEqual(['consent']);
    expect(stepsOf(await putInterests([a.id, c.id]))).toEqual(['consent']);
    let me = await meOf(member);
    expect(me.profile.bio).toBe('내 소개');
    expect(me.profile.interestCategoryIds).toEqual(sorted([a.id, b.id]));

    // Taking them off the public profile asks sign-in only: a category dropped, the 소개 cleared,
    // then every category.
    expect((await putInterests([a.id])).statusCode).toBe(200);
    const cleared = await putBio(null);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(meSchema.parse(cleared.json<{ data: unknown }>().data).profile.bio).toBeNull();
    expect((await profileOf(publicId)).interestCategories.map((row) => row.slug)).toEqual([a.slug]);
    expect((await putInterests([])).statusCode).toBe(200);
    me = await meOf(member);
    expect(me.profile).toMatchObject({ bio: null, interestCategoryIds: [] });
    expect(me.onboarding.nextStep).toBe('consent');
    expect(await profileOf(publicId)).toMatchObject({ bio: null, interestCategories: [] });
    // What changes nothing passes too; picking again waits for the consent.
    expect((await putBio('  ')).statusCode).toBe(200);
    expect((await putInterests([])).statusCode).toBe(200);
    expect(stepsOf(await putInterests([a.id]))).toEqual(['consent']);
  });
});
