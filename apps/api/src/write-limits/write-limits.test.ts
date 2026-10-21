/**
 * 작성 빈도 제한 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187, decision 7) against
 * the docker `test` profile, through the routes that write: posts 3 in 10 minutes and 20 a day,
 * comments 5 a minute and 200 a day, edits of both together 10 in 10 minutes and 50 a day, image
 * uploads 50 a day with a profile image counted beside a post's. Pinned: the boundaries (the last
 * write a window takes passes, the next is refused and nothing is written), the windows' edges, a
 * deleted post counted, the person counted by the verified number's hash rather than the account,
 * an operator's account exempt but recorded (its uploads before their conversion too), an edit
 * that changes nothing not counted (a post's or a comment's), and the wait answered in whole
 * minutes. Earlier writes are recorded straight into `write_limit_events` at the times a case
 * needs. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createMarket,
  createPost,
  createWriteLimitEvent,
} from '@buddha/db/test';
import {
  WRITE_LIMIT_DAY_SECONDS,
  writeLimitedDetailsSchema,
  type WriteLimitAction,
  type WriteLimitedDetails,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { retryAfterSeconds } from './write-limits.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = WRITE_LIMIT_DAY_SECONDS * SECOND_MS;

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const photo = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
    .jpeg()
    .toBuffer();

describe('the wait a refusal answers (static)', () => {
  it('is whole minutes, rounded up, at least one', () => {
    expect(retryAfterSeconds(1)).toBe(60);
    expect(retryAfterSeconds(0)).toBe(60);
    expect(retryAfterSeconds(59_999)).toBe(60);
    expect(retryAfterSeconds(60_000)).toBe(60);
    expect(retryAfterSeconds(60_001)).toBe(120);
    expect(retryAfterSeconds(DAY_MS)).toBe(WRITE_LIMIT_DAY_SECONDS);
  });
});

describe.skipIf(!hasTestInfra)('write limits (integration, #187)', () => {
  let t: TestApp;
  let author: TestUser;
  let other: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;

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
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: unknown, who: TestUser) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...(payload as object) }),
    });
  const writePost = (who: TestUser = author, text = '근거입니다') =>
    send('POST', '/posts', { marketId: market.id, body: doc(text) }, who);
  const editPost = (postId: string, text: string, who: TestUser = author) =>
    send('PUT', `/posts/${postId}`, { body: doc(text) }, who);
  const writeComment = (postId: string, who: TestUser = author, body = '근거가 있나요?') =>
    send('POST', `/posts/${postId}/comments`, { body }, who);
  const editComment = (commentId: string, body: string, who: TestUser = author) =>
    send('PUT', `/comments/${commentId}`, { body }, who);
  const deletePost = (postId: string, who: TestUser = author) =>
    send('POST', `/posts/${postId}/delete`, {}, who);
  const uploadImage = async (who: TestUser = author) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${encodeURIComponent(who.id)}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/jpeg', cookie: who.cookie },
      payload: await photo(),
    });
  const uploadProfileImage = async (who: TestUser = author) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/profile-image?expectedAccountId=${encodeURIComponent(who.id)}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/jpeg', cookie: who.cookie },
      payload: await photo(),
    });

  const created = (res: { statusCode: number; body: string; json: <T>() => T }) => {
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ data: { id: string } }>().data;
  };
  /** The refusal's details, checked to be WRITE_LIMITED's 429. */
  const refusal = (res: { statusCode: number; body: string; json: <T>() => T }) => {
    expect(res.statusCode, res.body).toBe(429);
    const { error } = res.json<{ error: { code: string; details: unknown } }>();
    expect(error.code).toBe('WRITE_LIMITED');
    return writeLimitedDetailsSchema.parse(error.details);
  };

  /** The keyed hash of `who`'s verified number, as the API computes it. */
  const hashOf = async (who: TestUser) => {
    const [row] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, who.id));
    return t.app.get(PhoneHasher).hash(row!.phone);
  };
  /** Earlier writes of `who`'s number, `msAgo` each. */
  const earlier = async (who: TestUser, action: WriteLimitAction, msAgo: readonly number[]) => {
    const phoneHash = await hashOf(who);
    const now = Date.now();
    await t.db
      .insert(schema.writeLimitEvents)
      .values(msAgo.map((ms) => ({ phoneHash, action, createdAt: new Date(now - ms) })));
  };
  /** How many writes of `action` are recorded for `who`'s number. */
  const events = async (who: TestUser, action: WriteLimitAction) => {
    const phoneHash = await hashOf(who);
    return (await t.db.select().from(schema.writeLimitEvents)).filter(
      (row) => row.action === action && row.phoneHash === phoneHash,
    ).length;
  };
  const postCount = async () => (await t.db.select().from(schema.posts)).length;

  // ---- posts ------------------------------------------------------------------------------------

  it('takes 3 posts in 10 minutes and refuses the 4th, writing nothing, with when to write again', async () => {
    for (let index = 0; index < 3; index += 1) created(await writePost());
    const details = refusal(await writePost());
    // The first of the three leaves the window 10 minutes after it was written: a moment ago.
    expect(details).toEqual<WriteLimitedDetails>({
      reason: 'posts_10m',
      limit: 3,
      retryAfterSeconds: 600,
    });
    expect(await postCount()).toBe(3);
    expect(await events(author, 'post')).toBe(3);
    // Another person's posts are counted apart.
    created(await writePost(other));
  });

  it('counts a post its author deleted', async () => {
    for (let index = 0; index < 3; index += 1) {
      const post = created(await writePost());
      expect((await deletePost(post.id)).statusCode).toBe(200);
    }
    expect(refusal(await writePost()).reason).toBe('posts_10m');
    expect(await postCount()).toBe(3);
  });

  it('lets a write through once the window has room again, and names the wait to it', async () => {
    // One just out of the window, two in it: the third in the window passes.
    await earlier(author, 'post', [
      10 * MINUTE_MS + 5 * SECOND_MS,
      7 * MINUTE_MS + 30 * SECOND_MS,
      MINUTE_MS,
    ]);
    created(await writePost());
    // Now three in the window, the oldest 7½ minutes old: room again in 2½, rounded up to 3.
    expect(refusal(await writePost())).toEqual({
      reason: 'posts_10m',
      limit: 3,
      retryAfterSeconds: 180,
    });
  });

  it('refuses the 21st post of 24 hours, the longest wait when both windows are full', async () => {
    // Twenty in the last day, the oldest 23 hours ago less half a minute, none in 10 minutes.
    await earlier(author, 'post', [
      23 * HOUR_MS - 30 * SECOND_MS,
      ...Array.from({ length: 19 }, (_, index) => (index + 1) * HOUR_MS),
    ]);
    // A day's 21st write, its first leaving in an hour and half a minute: 61 minutes, rounded up.
    expect(refusal(await writePost())).toEqual({
      reason: 'posts_24h',
      limit: 20,
      retryAfterSeconds: 61 * 60,
    });
    // Both full — three in 10 minutes too: the day's wait is the longer, and it is what is answered.
    await earlier(author, 'post', [2 * MINUTE_MS, MINUTE_MS, 30 * SECOND_MS]);
    expect(refusal(await writePost()).reason).toBe('posts_24h');
    // A write a day old has left the window.
    await t.db.delete(schema.writeLimitEvents);
    await earlier(
      author,
      'post',
      Array.from({ length: 20 }, () => DAY_MS + MINUTE_MS),
    );
    created(await writePost());
  });

  it('counts the person by the verified number: the same number’s earlier account carries on', async () => {
    // Three posts of the number under an account that withdrew (only its hash is left).
    await createWriteLimitEvent(t.db, { phoneHash: await hashOf(author), action: 'post' });
    await createWriteLimitEvent(t.db, { phoneHash: await hashOf(author), action: 'post' });
    await createWriteLimitEvent(t.db, { phoneHash: await hashOf(author), action: 'post' });
    expect(refusal(await writePost()).reason).toBe('posts_10m');
    // A new account is not treated differently (#45-15): the other account writes as usual.
    created(await writePost(other));
  });

  it('exempts an operator’s account and still records its writes', async () => {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, author.id));
    for (let index = 0; index < 5; index += 1) created(await writePost());
    const phoneHash = await hashOf(author);
    const rows = await t.db
      .select()
      .from(schema.writeLimitEvents)
      .where(eq(schema.writeLimitEvents.phoneHash, phoneHash));
    expect(rows.map((row) => row.action)).toEqual(['post', 'post', 'post', 'post', 'post']);
    // Back to a member: the operator's writes count (ADR-0089's way for proposals).
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, author.id));
    expect(refusal(await writePost()).reason).toBe('posts_10m');
  });

  // ---- comments ---------------------------------------------------------------------------------

  it('takes 5 comments a minute, 댓글 and 대댓글 together, and 200 a day', async () => {
    const post = await createPost(t.db, { marketId: market.id, authorId: other.id });
    const first = created(await writeComment(post.id));
    for (let index = 0; index < 4; index += 1) {
      created(
        await send(
          'POST',
          `/posts/${post.id}/comments`,
          { body: '답', parentId: first.id },
          author,
        ),
      );
    }
    expect(refusal(await writeComment(post.id))).toEqual({
      reason: 'comments_1m',
      limit: 5,
      retryAfterSeconds: 60,
    });
    expect(await t.db.select().from(schema.postComments)).toHaveLength(5);
    // The day's: 200 older than a minute.
    await t.db.delete(schema.writeLimitEvents);
    await earlier(
      author,
      'comment',
      Array.from({ length: 200 }, (_, index) => 2 * MINUTE_MS + index * MINUTE_MS),
    );
    expect(refusal(await writeComment(post.id)).reason).toBe('comments_24h');
    // A post is not a comment: its own limits.
    created(await writePost());
  });

  // ---- edits ------------------------------------------------------------------------------------

  it('counts edits of posts and comments together, 10 in 10 minutes and 50 a day, never a no-op', async () => {
    const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
    await earlier(
      author,
      'edit',
      Array.from({ length: 8 }, () => MINUTE_MS),
    );
    // The 9th and the 10th: one of a post, one of a comment.
    expect((await editPost(post.id, '고친 글')).statusCode).toBe(200);
    expect((await editComment(comment.id, '고친 댓글')).statusCode).toBe(200);
    // The 11th is refused for either, and nothing changes.
    expect(refusal(await editPost(post.id, '또 고친 글'))).toMatchObject({
      reason: 'edits_10m',
      limit: 10,
    });
    expect(refusal(await editComment(comment.id, '또 고친 댓글')).reason).toBe('edits_10m');
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(1);
    expect(await t.db.select().from(schema.postCommentRevisions)).toHaveLength(1);
    // Sending what it already says is no edit: not refused, not counted — a comment's or a post's.
    expect((await editComment(comment.id, '고친 댓글')).statusCode).toBe(200);
    expect((await editPost(post.id, '고친 글')).statusCode).toBe(200);
    expect(await events(author, 'edit')).toBe(10);
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(1);
    // The day's: 50 older than 10 minutes.
    await t.db.delete(schema.writeLimitEvents);
    await earlier(
      author,
      'edit',
      Array.from({ length: 50 }, (_, index) => 11 * MINUTE_MS + index * MINUTE_MS),
    );
    expect(refusal(await editPost(post.id, '하루의 51번째')).reason).toBe('edits_24h');
    // Edits are not new writes: a new post still passes.
    created(await writePost());
  });

  // ---- uploads ----------------------------------------------------------------------------------

  it('takes 50 images a day, a profile image counted with a post’s, refusing before storing', async () => {
    await earlier(
      author,
      'upload',
      Array.from({ length: 49 }, (_, index) => HOUR_MS + index * MINUTE_MS),
    );
    // The 50th: a profile image.
    expect((await uploadProfileImage()).statusCode).toBe(200);
    const stored = t.storage.objects.size;
    const media = (await t.db.select().from(schema.mediaObjects)).length;
    // The 51st, of either kind, is refused and nothing is stored.
    expect(refusal(await uploadImage()).reason).toBe('uploads_24h');
    expect(refusal(await uploadProfileImage())).toMatchObject({ reason: 'uploads_24h', limit: 50 });
    expect(t.storage.objects.size).toBe(stored);
    expect(await t.db.select().from(schema.mediaObjects)).toHaveLength(media);
    // Another person uploads as usual.
    expect((await uploadImage(other)).statusCode).toBe(201);
  });

  it('exempts an operator’s uploads before converting them too, and still records them', async () => {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, author.id));
    await earlier(
      author,
      'upload',
      Array.from({ length: 50 }, () => HOUR_MS),
    );
    // Past the day's 50, both kinds pass: the check before the conversion lets an operator through
    // as the count under the lock does.
    expect((await uploadImage()).statusCode).toBe(201);
    expect((await uploadProfileImage()).statusCode).toBe(200);
    expect(await events(author, 'upload')).toBe(52);
    // Back to a member: refused for the uploads it made as an operator.
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, author.id));
    expect(refusal(await uploadImage()).reason).toBe('uploads_24h');
  });

  it('counts an upload under the number’s lock, so the last room goes to one of two at once', async () => {
    await earlier(
      author,
      'upload',
      Array.from({ length: 49 }, () => HOUR_MS),
    );
    const answers = await Promise.all([uploadImage(), uploadImage()]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 429]);
    expect(await t.db.select().from(schema.mediaObjects)).toHaveLength(1);
    // The refused one's object was removed again: only the stored image is in the store.
    expect(t.storage.objects.size).toBe(1);
    expect(await events(author, 'upload')).toBe(50);
  });

  it('holds a window against two posts at once', async () => {
    await earlier(author, 'post', [MINUTE_MS, MINUTE_MS]);
    const answers = await Promise.all([writePost(author, '하나'), writePost(author, '둘')]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 429]);
    expect(await postCount()).toBe(1);
  });
});
