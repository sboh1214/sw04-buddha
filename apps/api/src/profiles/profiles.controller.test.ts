/**
 * 공개 프로필 (#41, ADR-0078; ADR-0069 decision 3 #37, decision 4 #41, decision 5, decision 7)
 * against the docker `test` profile: `GET /profiles/:publicId` and the 소개 of MY 설정
 * (`PUT /me/bio`). Pinned: anyone reads a profile, signed in or not, and every reader hears the
 * same answer; it holds the public items alone — the member's public face (public id, current
 * nickname, image, 운영자 mark), the 소개, the interest categories picked, the month joined in Korea
 * time and the counts of the visible posts, comments and the likes they hold — and nothing more of
 * the account; an unknown or malformed public id is NOT_FOUND, a public id typed in capitals finds
 * the member, and the old link shows the new nickname; only the member writes the 소개 — plain
 * text, 160 characters, line breaks kept, blank clears it — once onboarded, through the account the
 * screen shows, and nothing else of the account changes. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createComment,
  createCommentLike,
  createMarket,
  createPost,
  createPostLike,
  createUser,
} from '@buddha/db/test';
import {
  bioTooLongMessage,
  meSchema,
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

  it('counts the visible posts and comments and the likes on them, never a deleted or hidden one (#37-4)', async () => {
    const publicId = await publicIdOf(member.id);
    const open = await createMarket(t.db);
    const voided = await createMarket(t.db, { status: 'voided' });
    const other = (await createUser(t.db)).user;
    const now = new Date();
    // Posts: two visible (one on a voided market, #37-14), one deleted, one hidden.
    const visible = await createPost(t.db, { marketId: open.id, authorId: member.id });
    const onVoided = await createPost(t.db, { marketId: voided.id, authorId: member.id });
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
    // Likes: the member's own on their own post counts like anyone's, so the total is the sum of
    // the counts each item shows (ADR-0078 7-3); a withdrawn liker's would count too (#37-17).
    const likers = [reader.id, other.id, member.id];
    for (const userId of likers) await createPostLike(t.db, { postId: visible.id, userId });
    await createPostLike(t.db, { postId: onVoided.id, userId: reader.id });
    await createCommentLike(t.db, { commentId: reply.id, userId: reader.id });
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
      receivedLikeCount: 9,
    });
    // Deleting a post takes it and its likes off the profile (#37-19: 글 삭제의 프로필 반영).
    await t.db.update(schema.posts).set({ deletedAt: now }).where(eq(schema.posts.id, visible.id));
    expect(await profileOf(publicId)).toMatchObject({
      postCount: 1,
      commentCount: 6,
      receivedLikeCount: 6,
    });
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

  it('lets only the signed-in, onboarded member write their own 소개', async () => {
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
    // An account that has not finished the onboarding only browses (#57-8).
    const fresh = await signUpTestUser(t);
    const refused = await putBio('새 계정', fresh);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('ONBOARDING_REQUIRED');
    expect((await meOf(fresh)).profile.bio).toBeNull();
  });
});
