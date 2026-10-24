/**
 * 작성 제한 (#185, ADR-0082; ADR-0069 decision 2 #45-12, #45-14, decision 3 #37-9, decision 4 #185
 * rows, decision 7) against the docker `test` profile. Pinned: an operator restricts a member's
 * writing for 1, 3, 7 or 30 days or 무기한, from the report queue (a subject, whose pending reports
 * it resolves) or directly, with a reason, recorded with the operator and the time; under it the
 * member writes no post, 댓글 or 대댓글, edits none of their own, uploads no post image and gives no
 * public profile item a new value — RESTRICTED with the end (null for 무기한) — while deleting their
 * own, likes, reports, the 관심 등록, clearing a public item, the time zone and every read stay
 * open; a term ends by itself at its end (compared, nothing runs); restricted again, the one that
 * ends later governs; an operator lifts it early or brings its end forward (감경, 무기한 to a term
 * included) with a reason, each change recorded, and cancels it; never on themselves. The member
 * reads the end as it stands, '조기 해제됨' or '감경됨' and the end it was given, never the reason nor
 * the operator (owner decision 2026-10-23 answer 4); the operator's member page lists every
 * restriction standing (answer 1). A write in flight holds the member's profile until it commits,
 * so a restriction committed before it is read and none slips past. Nothing of it is public. Skips
 * when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createComment,
  createFill,
  createMarket,
  createModerationAction,
  createNotice,
  createPosition,
  createPost,
} from '@buddha/db/test';
import {
  WRITING_RESTRICTION_DAYS,
  adminModerationActionSchema,
  adminUserModerationSchema,
  myModerationActionSchema,
  myReportSchema,
  myRestrictionSchema,
  restrictedDetailsSchema,
  type AdminModerationAction,
  type MyModerationAction,
  type RestrictedDetails,
} from '@buddha/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { PUBLIC_ROUTES } from '../surface/registry.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { pngOf } from '../test/png.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter } from '../test/wait.js';
import { writingRestrictionOf } from './restrictions.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

type Res = { statusCode: number; body: string; json: <T>() => T };

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe.skipIf(!hasTestInfra)('/api/v1 writing restriction (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let other: TestUser;
  let admin: TestUser;
  let second: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;
  let post: Awaited<ReturnType<typeof createPost>>;
  let comment: Awaited<ReturnType<typeof createComment>>;
  let othersPost: Awaited<ReturnType<typeof createPost>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await onboarded();
    other = await onboarded();
    admin = await anAdmin();
    second = await anAdmin();
    market = await createMarket(t.db, { title: '기준금리 인하' });
    post = await createPost(t.db, {
      marketId: market.id,
      authorId: member.id,
      title: '근거 글',
      text: '본문 첫 줄',
    });
    comment = await createComment(t.db, { postId: post.id, authorId: member.id, body: '댓글' });
    othersPost = await createPost(t.db, {
      marketId: market.id,
      authorId: other.id,
      text: '남의 글',
    });
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

  const call = (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload: Record<string, unknown>,
    who: TestUser,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const send = (url: string, payload: Record<string, unknown>, who: TestUser) =>
    call('POST', url, payload, who);
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
  /** The RESTRICTED refusal's details: a 403 with the kind and the end. */
  const restrictedOf = (res: Res): RestrictedDetails => {
    expect(res.statusCode, res.body).toBe(403);
    const error = res.json<{ error: { code: string; details: unknown } }>().error;
    expect(error.code).toBe('RESTRICTED');
    return restrictedDetailsSchema.parse(error.details);
  };
  const restrict = async (
    days: number | null,
    who: TestUser = member,
    extra: Record<string, unknown> = {},
    by: TestUser = admin,
  ) =>
    actionOf(
      await send(
        `/admin/moderation/users/${who.id}/writing-restriction`,
        { reason: 'spam', note: '같은 링크 반복', days, ...extra },
        by,
      ),
    );
  const myActions = async (who: TestUser = member): Promise<MyModerationAction[]> =>
    dataOf<unknown[]>(await read('/me/moderation/actions', who)).map((item) =>
      myModerationActionSchema.parse(item),
    );
  const audits = (type: string) =>
    t.db.select().from(schema.adminActions).where(eq(schema.adminActions.type, type));
  const rows = async (table: typeof schema.posts | typeof schema.postComments) =>
    (await t.db.select({ n: count() }).from(table))[0]!.n;

  // ---- each write the member makes --------------------------------------------------------------

  const newPost = (who: TestUser = member) =>
    send('/posts', { marketId: market.id, title: '새 글', body: doc('새 본문') }, who);
  const editPost = (who: TestUser = member, postId = post.id) =>
    call('PUT', `/posts/${postId}`, { title: '고친 글', body: doc('고친 본문') }, who);
  const newComment = (who: TestUser = member) =>
    send(`/posts/${post.id}/comments`, { body: '새 댓글' }, who);
  const newReply = (who: TestUser = member) =>
    send(`/posts/${post.id}/comments`, { body: '새 대댓글', parentId: comment.id }, who);
  const editComment = (who: TestUser = member) =>
    call('PUT', `/comments/${comment.id}`, { body: '고친 댓글' }, who);
  const uploadImage = (who: TestUser = member) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${encodeURIComponent(who.id)}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/png', cookie: who.cookie },
      // Not an image at all: refused before it is looked at, or IMAGE_NOT_ALLOWED after.
      payload: Buffer.from('not an image'),
    });

  describe('what it blocks and what it leaves open', () => {
    it('refuses every new post, 댓글, 대댓글 and edit of one’s own, and a post image, with its end; nothing written', async () => {
      const action = await restrict(1);
      expect(action).toMatchObject({
        type: 'writing_restriction',
        user: { id: member.id },
        subject: null,
        reason: { code: 'spam', note: '같은 링크 반복' },
        createdBy: { id: admin.id },
        cancelledAt: null,
        endChanges: [],
      });
      // 1 day: 24 hours from its own time (WRITING_RESTRICTION_DAYS).
      expect(Date.parse(action.endsAt!) - Date.parse(action.createdAt)).toBe(DAY_MS);
      const othersComment = await createComment(t.db, {
        postId: othersPost.id,
        authorId: other.id,
        body: '남의 댓글',
      });
      const posts = await rows(schema.posts);
      const comments = await rows(schema.postComments);
      const counts = () =>
        t.db.select().from(schema.postCommentCounts).orderBy(asc(schema.postCommentCounts.postId));
      const countsBefore = await counts();
      const expected: RestrictedDetails = { kind: 'writing', endsAt: action.endsAt };
      expect(restrictedOf(await newPost())).toEqual(expected);
      expect(restrictedOf(await editPost())).toEqual(expected);
      expect(restrictedOf(await newComment())).toEqual(expected);
      expect(restrictedOf(await newReply())).toEqual(expected);
      expect(restrictedOf(await editComment())).toEqual(expected);
      // #48's per-post counter (`post_comment_counts`, its trigger) moved for none of them.
      expect(await counts()).toEqual(countsBefore);
      expect(restrictedOf(await uploadImage())).toEqual(expected);
      // Asked first: another's post, a hidden post of one's own and an unknown one say the same.
      expect(restrictedOf(await editPost(member, othersPost.id))).toEqual(expected);
      await t.db
        .update(schema.posts)
        .set({ hiddenAt: new Date() })
        .where(eq(schema.posts.id, post.id));
      expect(restrictedOf(await editPost())).toEqual(expected);
      // A 댓글's edit the same (7-5: the profile before the comment's row): another's, and a hidden
      // one of one's own, are RESTRICTED before FORBIDDEN or COMMENT_NOT_EDITABLE.
      expect(
        restrictedOf(await call('PUT', `/comments/${othersComment.id}`, { body: 'x' }, member)),
      ).toEqual(expected);
      await t.db
        .update(schema.postComments)
        .set({ hiddenAt: new Date() })
        .where(eq(schema.postComments.id, comment.id));
      expect(restrictedOf(await editComment())).toEqual(expected);
      expect(await rows(schema.posts)).toBe(posts);
      expect(await rows(schema.postComments)).toBe(comments);
      const [kept] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
      expect(kept).toMatchObject({ title: '근거 글', editedAt: null });
      const [keptComment] = await t.db
        .select()
        .from(schema.postComments)
        .where(eq(schema.postComments.id, comment.id));
      expect(keptComment).toMatchObject({ body: '댓글', editedAt: null });
      const [keptOthers] = await t.db
        .select()
        .from(schema.postComments)
        .where(eq(schema.postComments.id, othersComment.id));
      expect(keptOthers).toMatchObject({ body: '남의 댓글', editedAt: null });
      expect(await t.db.select().from(schema.mediaObjects)).toEqual([]);
      // Somebody else writes as before (the restriction is the member's).
      const others = await send(`/posts/${othersPost.id}/comments`, { body: '남의 댓글' }, other);
      expect(others.statusCode, others.body).toBe(201);
    });

    it('leaves deleting one’s own, likes, reports, the 관심 등록 and reading open (#45-12)', async () => {
      await restrict(null);
      const like = await call('PUT', `/posts/${othersPost.id}/like`, { liked: true }, member);
      expect(like.statusCode, like.body).toBe(200);
      const commentLike = await call(
        'PUT',
        `/comments/${comment.id}/like`,
        { liked: true },
        member,
      );
      expect(commentLike.statusCode, commentLike.body).toBe(200);
      const report = await send(`/posts/${othersPost.id}/reports`, { reason: 'spam' }, member);
      myReportSchema.parse(dataOf(report, 201));
      const watch = await call('PUT', `/me/watchlist/${market.id}`, { watched: true }, member);
      expect(watch.statusCode, watch.body).toBe(200);
      expect((await read(`/posts/${post.id}`)).statusCode).toBe(200);
      expect((await read('/posts', member)).statusCode).toBe(200);
      const deletedComment = await send(`/comments/${comment.id}/delete`, {}, member);
      expect(deletedComment.statusCode, deletedComment.body).toBe(200);
      const deletedPost = await send(`/posts/${post.id}/delete`, {}, member);
      expect(deletedPost.statusCode, deletedPost.body).toBe(200);
    });

    it('refuses no notice of a restricted operator, its images included; `purpose=notice` is an admin’s alone (owner decision 2026-10-23 answer 13)', async () => {
      // An operator another operator restricted (7-9): their posts, comments and post images stay
      // refused, as a member's.
      const { endsAt } = await restrict(7, second);
      const png = pngOf(8, 8);
      const uploadAs = (who: TestUser, purpose?: string) =>
        t.app.inject({
          method: 'POST',
          url:
            `/api/v1/media/images?expectedAccountId=${encodeURIComponent(who.id)}` +
            (purpose === undefined ? '' : `&purpose=${purpose}`),
          headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/png', cookie: who.cookie },
          payload: png,
        });
      const stored = async () =>
        (await t.db.select({ n: count() }).from(schema.mediaObjects))[0]!.n;
      expect(restrictedOf(await uploadAs(second))).toEqual({ kind: 'writing', endsAt });
      expect(restrictedOf(await uploadAs(second, 'post'))).toEqual({ kind: 'writing', endsAt });
      restrictedOf(await newPost(second));
      restrictedOf(await newComment(second));
      expect(await stored()).toBe(0);
      // A notice's image goes up, and the notice that holds it is written, edited and pinned.
      const image = dataOf<{ id: string }>(await uploadAs(second, 'notice'), 201);
      const admin2 = (method: 'POST' | 'PUT', url: string, payload?: unknown) =>
        t.app.inject({
          method,
          url: `/api/v1${url}`,
          headers: {
            origin: TRUSTED_ORIGIN,
            cookie: second.cookie,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
        });
      const withImage = {
        type: 'doc',
        content: [...doc('점검 사진').content, { type: 'image', attrs: { mediaId: image.id } }],
      };
      const notice = dataOf<{ id: string }>(
        await admin2('POST', '/admin/notices', { title: '점검 안내', body: withImage }),
        201,
      );
      const edited = await admin2('PUT', `/admin/notices/${notice.id}`, {
        title: '점검 안내(고침)',
        body: withImage,
        expectedEditedAt: null,
      });
      expect(edited.statusCode, edited.body).toBe(200);
      const pinned = await admin2('POST', `/admin/notices/${notice.id}/pin`);
      expect(pinned.statusCode, pinned.body).toBe(200);
      expect((await read(`/notices/${notice.id}`)).statusCode).toBe(200);
      expect((await read(`/media/${image.id}`)).statusCode).toBe(200);
      // The notice's image is no way past the restriction into a post.
      restrictedOf(await send('/posts', { marketId: market.id, body: withImage }, second));
      // Only an admin says an image is a notice's — a restricted member (`member`) or not (`other`);
      // nothing stored.
      await restrict(1);
      for (const who of [member, other]) {
        const refused = await uploadAs(who, 'notice');
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
          code: 'FORBIDDEN',
          details: [{ path: ['purpose'] }],
        });
      }
      expect(await stored()).toBe(1);
      // An operator not restricted uploads a post's image as before.
      expect((await uploadAs(admin)).statusCode).toBe(201);
    });

    it('keeps public profile items from new values and lets them be cleared; the time zone stays (#37-9, decision 7)', async () => {
      const [a, b] = await Promise.all([createCategory(t.db), createCategory(t.db)]);
      expect((await call('PUT', '/me/bio', { bio: '처음 소개' }, member)).statusCode).toBe(200);
      expect(
        (await call('PUT', '/me/interest-categories', { categoryIds: [a.id] }, member)).statusCode,
      ).toBe(200);
      const action = await restrict(7);
      const expected: RestrictedDetails = { kind: 'writing', endsAt: action.endsAt };
      expect(restrictedOf(await call('PATCH', '/me', { nickname: '새이름' }, member))).toEqual(
        expected,
      );
      expect(restrictedOf(await call('PUT', '/me/bio', { bio: '새 소개' }, member))).toEqual(
        expected,
      );
      expect(
        restrictedOf(
          await call('PUT', '/me/interest-categories', { categoryIds: [a.id, b.id] }, member),
        ),
      ).toEqual(expected);
      const [profile] = await t.db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      expect(profile).toMatchObject({ bio: '처음 소개' });
      // Clearing: the picks dropped, the 소개 emptied; a private setting changes.
      expect(
        (await call('PUT', '/me/interest-categories', { categoryIds: [] }, member)).statusCode,
      ).toBe(200);
      expect((await call('PUT', '/me/bio', { bio: null }, member)).statusCode).toBe(200);
      const zone = await call('PUT', '/me/time-zone', { timeZone: 'Asia/Tokyo' }, member);
      expect(zone.statusCode, zone.body).toBe(200);
      // The profile opens as before, and says nothing of the restriction (#45-12, #37-8).
      const page = await read(`/profiles/${profile!.publicId}`);
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toMatch(/restrict|sanction|writing_restriction/i);
    });

    it('leaves what the member wrote where it was: the post, its comments and the profile’s 글·댓글 tabs (#45-12 «그대로 둔다», ADR-0080)', async () => {
      await restrict(null);
      const [profile] = await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      const ids = (res: Res) => dataOf<{ id: string }[]>(res).map((item) => item.id);
      expect(ids(await read(`/profiles/${profile!.publicId}/posts`))).toContain(post.id);
      expect(ids(await read(`/profiles/${profile!.publicId}/comments`))).toContain(comment.id);
      expect(dataOf<{ state: string }>(await read(`/posts/${post.id}`)).state).toBe('published');
      // And the member's own MY '내 글' still lists them.
      expect(ids(await read('/me/posts', member))).toContain(post.id);
      expect(ids(await read('/me/comments', member))).toContain(comment.id);
    });

    it('is nowhere in a public answer, whoever reads it: no value of it, no field it adds or changes (#45-12, #37-8: an internal risk flag)', async () => {
      // Every public GET of the registry (PUBLIC_ROUTES), its path naming the member's market,
      // post, 댓글 (its 대댓글 page — #48 — holding the member's 대댓글) and profile, and a pinned
      // notice (#138) — read by anyone, by another member and by the member, before and while a
      // restriction stands. private-data.test.ts seeds none that stands (its A writes), so this
      // is the check of the standing state GUARDS.md points to.
      const [profile] = await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, member.id));
      await createComment(t.db, {
        postId: post.id,
        authorId: member.id,
        parentId: comment.id,
        body: '대댓글',
      });
      const notice = await createNotice(t.db, { title: '점검 안내', pinSlot: 1 });
      const params: Readonly<Record<string, string>> = {
        id: market.id,
        idOrSlug: market.slug,
        postId: post.id,
        commentId: comment.id,
        publicId: profile!.publicId,
        mediaId: randomUUID(),
        noticeId: notice.id,
      };
      const urls = Object.keys(PUBLIC_ROUTES)
        .filter((key) => key.startsWith('GET '))
        .map((key) =>
          key.slice('GET '.length).replace(/:(\w+)/g, (_, name: string) => {
            const value = params[name];
            if (value === undefined) throw new Error(`no value for :${name} in ${key}`);
            return value;
          }),
        );
      expect(urls).toEqual(
        expect.arrayContaining([
          `/posts/${post.id}`,
          `/comments/${comment.id}/replies`,
          `/notices/${notice.id}`,
          `/profiles/${profile!.publicId}`,
          `/profiles/${profile!.publicId}/posts`,
          `/profiles/${profile!.publicId}/comments`,
        ]),
      );
      // What moves with the clock alone: the health's uptime and probes, a price series' window.
      const VOLATILE = new Set(['uptimeSeconds', 'checks', 'from', 'to', 'points']);
      const stable = (body: string): string => {
        try {
          return JSON.stringify(JSON.parse(body), (key, value: unknown) =>
            VOLATILE.has(key) ? undefined : value,
          );
        } catch {
          return body;
        }
      };
      const readers: readonly [string, TestUser | undefined][] = [
        ['anyone', undefined],
        ['another member', other],
        ['the member', member],
      ];
      const answers = async (): Promise<string[]> => {
        const out: string[] = [];
        for (const url of urls) {
          for (const [label, who] of readers) {
            const res = await read(url, who);
            out.push(`${label} ${url} ${String(res.statusCode)} ${stable(res.body)}`);
          }
        }
        return out;
      };
      const before = await answers();
      const note = `내부 표지 ${randomUUID()}`;
      for (const days of [30, null] as const) {
        const action = await restrict(days, member, { note });
        const after = await answers();
        // Not a field more nor a value changed — a flag such as `canComment: false` or
        // `mutedUntil` would show here, whatever its name.
        expect(after).toEqual(before);
        const markers = [
          action.id,
          note,
          ...(action.endsAt === null ? [] : [action.endsAt, String(Date.parse(action.endsAt))]),
        ];
        for (const answer of after) {
          expect(answer).not.toMatch(/restrict|sanction/i);
          for (const marker of markers) expect(answer).not.toContain(marker);
        }
      }
    });

    it('answers the member, and only the member, the restriction that governs: its kind and end as a refusal names them', async () => {
      const mine = async (who: TestUser = member) =>
        myRestrictionSchema.parse(dataOf(await read('/me/moderation/restriction', who)));
      expect(await mine()).toEqual({ restriction: null });
      const week = await restrict(7);
      await restrict(1);
      expect(await mine()).toEqual({ restriction: { kind: 'writing', endsAt: week.endsAt } });
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: week.endsAt });
      const indefinite = await restrict(null);
      expect(await mine()).toEqual({ restriction: { kind: 'writing', endsAt: null } });
      // Nothing of who gave it or why (#45-13); another member reads their own — none.
      const body = (await read('/me/moderation/restriction', member)).body;
      expect(body).not.toContain(admin.id);
      expect(body).not.toContain('같은 링크 반복');
      expect(await mine(other)).toEqual({ restriction: null });
      expect((await read('/me/moderation/restriction')).statusCode).toBe(401);
      // However many actions come after it: the banner's read is not the actions' first page.
      for (let i = 0; i < 21; i += 1) {
        actionOf(
          await send(`/admin/moderation/users/${member.id}/warn`, { reason: 'spam' }, admin),
        );
      }
      expect((await myActions()).map((action) => action.id)).not.toContain(indefinite.id);
      expect(await mine()).toEqual({ restriction: { kind: 'writing', endsAt: null } });
      // Lifted, the week governs again; cancelled, none.
      actionOf(
        await send(`/admin/moderation/actions/${indefinite.id}/lift`, { reason: '해제' }, admin),
      );
      expect(await mine()).toEqual({ restriction: { kind: 'writing', endsAt: week.endsAt } });
      for (const action of await t.db
        .select({ id: schema.moderationActions.id })
        .from(schema.moderationActions)
        .where(
          and(
            eq(schema.moderationActions.userId, member.id),
            eq(schema.moderationActions.type, 'writing_restriction'),
          ),
        )) {
        if (action.id === indefinite.id) continue;
        actionOf(
          await send(`/admin/moderation/actions/${action.id}/cancel`, { reason: '취소' }, admin),
        );
      }
      expect(await mine()).toEqual({ restriction: null });
    });

    it('leaves trading as it was: the balance, the ledger, the orders and the holdings read as before, untouched by restricting, 감경, lifting and cancelling (#185 acceptance; orders are placed from M9)', async () => {
      const [balance] = await t.db
        .select()
        .from(schema.balances)
        .where(eq(schema.balances.userId, member.id));
      await t.db
        .update(schema.balances)
        .set({ availableCoin: balance!.availableCoin + 12_345n })
        .where(eq(schema.balances.userId, member.id));
      await t.db.insert(schema.ledgerEntries).values({
        userId: member.id,
        type: 'ADMIN_ADJUST',
        amountCoin: 12_345n,
        balanceAfterCoin: balance!.availableCoin + 12_345n,
        memo: '작성 제한 시험',
      });
      await createFill(t.db, { marketId: market.id, amountCoin: 610n, userId: member.id, qty: 10 });
      await createPosition(t.db, {
        userId: member.id,
        marketId: market.id,
        outcome: 'YES',
        qty: 10,
        costBasisCoin: 610n,
      });
      const trading = async () => {
        const answers = [];
        for (const url of ['/me', '/me/ledger', '/me/positions', '/me/orders']) {
          const res = await read(url, member);
          expect(res.statusCode, `${url} ${res.body}`).toBe(200);
          answers.push(res.body);
        }
        const { balances, ledgerEntries, orders, positions } = schema;
        return {
          answers,
          rows: await Promise.all([
            t.db.select().from(balances).where(eq(balances.userId, member.id)),
            t.db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, member.id)),
            t.db.select().from(orders).where(eq(orders.userId, member.id)),
            t.db.select().from(positions).where(eq(positions.userId, member.id)),
          ]),
        };
      };
      const before = await trading();
      for (const list of before.rows) expect(list.length).toBeGreaterThan(0);
      const indefinite = await restrict(null);
      expect(await trading()).toEqual(before);
      actionOf(
        await send(
          `/admin/moderation/actions/${indefinite.id}/shorten`,
          { endsAt: new Date(Date.now() + DAY_MS).toISOString(), reason: '감경' },
          admin,
        ),
      );
      expect(await trading()).toEqual(before);
      actionOf(
        await send(`/admin/moderation/actions/${indefinite.id}/lift`, { reason: '해제' }, admin),
      );
      expect(await trading()).toEqual(before);
      const week = await restrict(7);
      expect(await trading()).toEqual(before);
      actionOf(
        await send(`/admin/moderation/actions/${week.id}/cancel`, { reason: '취소' }, admin),
      );
      expect(await trading()).toEqual(before);
    });
  });

  describe('its end', () => {
    it('ends by itself at its end: the time is compared, nothing runs (#45-12)', async () => {
      // Ended a moment ago: open. Ending in a minute: refused with that end.
      const createdAt = new Date(Date.now() - DAY_MS - 1_000);
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        createdAt,
        endsAt: new Date(createdAt.getTime() + DAY_MS),
      });
      expect((await newComment()).statusCode).toBe(201);
      const soon = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: new Date(Date.now() + 60_000),
      });
      expect(restrictedOf(await newComment())).toEqual({
        kind: 'writing',
        endsAt: soon.endsAt!.toISOString(),
      });
    });

    it('holds until its end by the database clock and not at it', async () => {
      const [{ ends }] = (
        await t.db.execute<{ ends: string }>(
          // Half a second from the database clock, at the column's millisecond.
          `SELECT (extract(epoch FROM clock_timestamp() + interval '500 milliseconds') * 1000)::bigint::text AS ends`,
        )
      ).rows as [{ ends: string }];
      const endsAt = new Date(Number(ends));
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt,
      });
      expect(await writingRestrictionOf(t.db, member.id)).toEqual({
        kind: 'writing',
        endsAt: endsAt.toISOString(),
      });
      while (Date.now() <= endsAt.getTime() + 50) await sleep(25);
      expect(await writingRestrictionOf(t.db, member.id)).toBeNull();
      expect((await newComment()).statusCode).toBe(201);
    });

    it('keeps whichever ends later when restricted again, 무기한 over any term (#45-12)', async () => {
      const week = await restrict(7);
      const day = await restrict(1);
      // Both recorded; the week governs.
      expect((await myActions()).map((action) => action.id).sort()).toEqual(
        [day.id, week.id].sort(),
      );
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: week.endsAt });
      const month = await restrict(30);
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: month.endsAt });
      const indefinite = await restrict(null);
      expect(indefinite.endsAt).toBeNull();
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: null });
      // The member's page lists every one standing, each to lift, shorten or cancel on its own
      // (owner decision 2026-10-23 answer 1) — all of the member's actions, not a page of them:
      // twenty-one warnings after the four leave every one on it (a page of twenty, as the record
      // of every action reads, would drop them).
      for (let i = 0; i < 21; i += 1) {
        actionOf(
          await send(`/admin/moderation/users/${member.id}/warn`, { reason: 'spam' }, admin),
        );
      }
      const { actions: listed } = adminUserModerationSchema.parse(
        dataOf(await read(`/admin/moderation/users/${member.id}`, admin)),
      );
      expect(listed).toHaveLength(25);
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      expect(
        listed
          .filter((action) => action.type === 'writing_restriction')
          .map((action) => ({
            id: action.id,
            endsAt: action.endsAt,
            cancelledAt: action.cancelledAt,
          }))
          .sort(byId),
      ).toEqual(
        [indefinite, month, day, week]
          .map((action) => ({ id: action.id, endsAt: action.endsAt, cancelledAt: null }))
          .sort(byId),
      );
      // Lifting the one with no end leaves the month's; the oldest, under all those warnings, is
      // lifted as well.
      actionOf(
        await send(`/admin/moderation/actions/${indefinite.id}/lift`, { reason: '해제' }, admin),
      );
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: month.endsAt });
      const weekLifted = actionOf(
        await send(`/admin/moderation/actions/${week.id}/lift`, { reason: '해제' }, admin),
      );
      expect(weekLifted.endChanges.map((change) => change.kind)).toEqual(['lift']);
      expect(restrictedOf(await newPost())).toEqual({ kind: 'writing', endsAt: month.endsAt });
    });

    it('takes the four terms and 무기한 only', async () => {
      for (const days of WRITING_RESTRICTION_DAYS) {
        const action = await restrict(days);
        expect(Date.parse(action.endsAt!) - Date.parse(action.createdAt)).toBe(days * DAY_MS);
      }
      for (const days of [0, 2, 14, 31, -1, '7']) {
        const res = await send(
          `/admin/moderation/users/${member.id}/writing-restriction`,
          { reason: 'spam', days },
          admin,
        );
        expect(res.statusCode, String(days)).toBe(400);
      }
      // The term is always said: 무기한 is `null`, never left out.
      const unsaid = await send(
        `/admin/moderation/users/${member.id}/writing-restriction`,
        { reason: 'spam' },
        admin,
      );
      expect(unsaid.statusCode).toBe(400);
    });
  });

  describe('lifting, 감경 and cancelling', () => {
    it('lifts early with a reason: it ends now, kept on the record as given (#45-12)', async () => {
      const action = await restrict(7);
      const lifted = actionOf(
        await send(
          `/admin/moderation/actions/${action.id}/lift`,
          { reason: ' 소명 확인 ' },
          second,
        ),
      );
      expect(lifted).toMatchObject({
        id: action.id,
        type: 'writing_restriction',
        createdBy: { id: admin.id },
        createdAt: action.createdAt,
        cancelledAt: null,
        reason: { code: 'spam', note: '같은 링크 반복' },
      });
      expect(Date.parse(lifted.endsAt!)).toBeLessThan(Date.parse(action.endsAt!));
      expect(lifted.endChanges).toHaveLength(1);
      expect(lifted.endChanges[0]).toMatchObject({
        kind: 'lift',
        previousEndsAt: action.endsAt,
        endsAt: lifted.endsAt,
        reason: '소명 확인',
        createdBy: { id: second.id },
        createdAt: lifted.endsAt,
      });
      expect((await newPost()).statusCode).toBe(201);
      // The member reads the end it has now, that it was lifted early and the end it was given
      // (owner decision 2026-10-23 answer 4) — never who changed it or why.
      const [mine] = await myActions();
      expect(mine).toMatchObject({
        id: action.id,
        endsAt: lifted.endsAt,
        endChange: { kind: 'lift', originalEndsAt: action.endsAt },
        cancelledAt: null,
      });
      // Given about nothing in particular: about nothing, as a warning — not '내 프로필'.
      expect(mine?.subject).toBeNull();
      const body = (await read('/me/moderation/actions', member)).body;
      expect(body).not.toContain('소명 확인');
      expect(body).not.toContain(second.id);
      const [audit] = await audits('moderation_restriction_lift');
      expect(audit).toMatchObject({
        adminId: second.id,
        targetType: 'moderation_action',
        targetId: action.id,
        payload: {
          actionId: action.id,
          userId: member.id,
          previousEndsAt: action.endsAt,
          endsAt: lifted.endsAt,
          reason: '소명 확인',
        },
      });
      // Ended now: nothing more to lift or shorten.
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${action.id}/lift`, { reason: '다시' }, admin),
        ),
      ).toBe('ended');
    });

    it('brings the end forward (감경), 무기한 to a term included, earlier and still to come only (#45-14)', async () => {
      const indefinite = await restrict(null);
      const shorten = (endsAt: Date, by: TestUser = admin) =>
        send(
          `/admin/moderation/actions/${indefinite.id}/shorten`,
          { endsAt: endsAt.toISOString(), reason: '이의 일부 인정' },
          by,
        );
      const inThreeDays = new Date(Date.now() + 3 * DAY_MS);
      const shortened = actionOf(await shorten(inThreeDays));
      expect(shortened.endsAt).toBe(inThreeDays.toISOString());
      expect(restrictedOf(await newComment())).toEqual({
        kind: 'writing',
        endsAt: inThreeDays.toISOString(),
      });
      // Not earlier than the end now, or not to come: refused, nothing changed.
      expect(refusalOf(await shorten(new Date(inThreeDays.getTime() + HOUR_MS)))).toBe(
        'not_earlier',
      );
      expect(refusalOf(await shorten(inThreeDays))).toBe('not_earlier');
      expect(refusalOf(await shorten(new Date(Date.now() - 1_000)))).toBe('end_passed');
      const inAnHour = new Date(Date.now() + HOUR_MS);
      const again = actionOf(await shorten(inAnHour, second));
      expect(
        again.endChanges.map((change) => ({
          kind: change.kind,
          previousEndsAt: change.previousEndsAt,
          endsAt: change.endsAt,
          reason: change.reason,
          by: change.createdBy?.id,
        })),
      ).toEqual([
        {
          kind: 'shorten',
          previousEndsAt: null,
          endsAt: inThreeDays.toISOString(),
          reason: '이의 일부 인정',
          by: admin.id,
        },
        {
          kind: 'shorten',
          previousEndsAt: inThreeDays.toISOString(),
          endsAt: inAnHour.toISOString(),
          reason: '이의 일부 인정',
          by: second.id,
        },
      ]);
      expect(await audits('moderation_restriction_shorten')).toHaveLength(2);
      // The member: the end now, 감경됨 and the end it was given (무기한) — not the end between,
      // nor how many times (owner decision 2026-10-23 answer 4).
      const [mine] = await myActions();
      expect(mine?.endsAt).toBe(inAnHour.toISOString());
      expect(mine?.endChange).toEqual({ kind: 'shorten', originalEndsAt: null });
      const memberBody = (await read('/me/moderation/actions', member)).body;
      expect(memberBody).not.toContain('이의 일부 인정');
      expect(memberBody).not.toContain(inThreeDays.toISOString());
      expect(memberBody).not.toContain(second.id);
      const rejected = await send(
        `/admin/moderation/actions/${indefinite.id}/shorten`,
        { endsAt: 'tomorrow', reason: '이의' },
        admin,
      );
      expect(rejected.statusCode).toBe(400);
      const noReason = await send(
        `/admin/moderation/actions/${indefinite.id}/shorten`,
        { endsAt: inAnHour.toISOString(), reason: '  ' },
        admin,
      );
      expect(noReason.statusCode).toBe(400);
      // Lifted after its 감경: 조기 해제됨, the end it was given still 무기한.
      const lifted = actionOf(
        await send(`/admin/moderation/actions/${indefinite.id}/lift`, { reason: '해제' }, admin),
      );
      const [after] = await myActions();
      expect(after).toMatchObject({
        endsAt: lifted.endsAt,
        endChange: { kind: 'lift', originalEndsAt: null },
      });
    });

    it('refuses another type, a cancelled one and the acting operator’s own', async () => {
      const warning = actionOf(
        await send(`/admin/moderation/users/${member.id}/warn`, { reason: 'spam' }, admin),
      );
      const future = new Date(Date.now() + HOUR_MS).toISOString();
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${warning.id}/lift`, { reason: 'x' }, admin),
        ),
      ).toBe('not_restriction');
      expect(
        refusalOf(
          await send(
            `/admin/moderation/actions/${warning.id}/shorten`,
            { endsAt: future, reason: 'x' },
            admin,
          ),
        ),
      ).toBe('not_restriction');
      const action = await restrict(7);
      actionOf(
        await send(`/admin/moderation/actions/${action.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${action.id}/lift`, { reason: 'x' }, admin),
        ),
      ).toBe('cancelled');
      // An operator under a restriction another gave: they neither lift nor shorten it themselves.
      const onAdmin = await restrict(7, admin, {}, second);
      expect(
        refusalOf(
          await send(`/admin/moderation/actions/${onAdmin.id}/lift`, { reason: 'x' }, admin),
        ),
      ).toBe('own');
      expect(
        refusalOf(
          await send(
            `/admin/moderation/actions/${onAdmin.id}/shorten`,
            { endsAt: future, reason: 'x' },
            admin,
          ),
        ),
      ).toBe('own');
      // Nor restrict themselves.
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${admin.id}/writing-restriction`,
            { reason: 'spam', days: 1 },
            admin,
          ),
        ),
      ).toBe('own');
      // Read by that operator: the operators who acted and changed it are withheld.
      const lifted = actionOf(
        await send(`/admin/moderation/actions/${onAdmin.id}/lift`, { reason: '해제' }, second),
      );
      expect(lifted.endChanges[0]?.createdBy).toEqual(expect.objectContaining({ id: second.id }));
      const page = adminUserModerationSchema.parse(
        dataOf(await read(`/admin/moderation/users/${admin.id}`, admin)),
      );
      const seen = page.actions.find((item) => item.id === onAdmin.id)!;
      expect(seen).toMatchObject({ aboutViewer: true, createdBy: null });
      expect(seen.endChanges).toEqual([expect.objectContaining({ kind: 'lift', createdBy: null })]);
      expect(await audits('moderation_restriction_lift')).toHaveLength(1);
    });

    it('ends at once when cancelled, the end it had kept on the record', async () => {
      const action = await restrict(30);
      expect(restrictedOf(await newPost()).endsAt).toBe(action.endsAt);
      const cancelled = actionOf(
        await send(`/admin/moderation/actions/${action.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      expect(cancelled).toMatchObject({ endsAt: action.endsAt, cancelReason: '이의 인정' });
      expect((await newPost()).statusCode).toBe(201);
      const [mine] = await myActions();
      expect(mine).toMatchObject({ id: action.id, endsAt: action.endsAt, endChange: null });
      expect(mine?.cancelledAt).not.toBeNull();
      // Lifted, then cancelled: the member's answer still says how its end was brought forward —
      // it was; only the screen draws none of it for a cancelled one (7-17, `myEndChangeView`).
      const week = await restrict(7);
      const lifted = actionOf(
        await send(`/admin/moderation/actions/${week.id}/lift`, { reason: '해제' }, admin),
      );
      actionOf(
        await send(`/admin/moderation/actions/${week.id}/cancel`, { reason: '이의 인정' }, admin),
      );
      const [liftedMine] = await myActions();
      expect(liftedMine).toMatchObject({
        id: week.id,
        endsAt: lifted.endsAt,
        endChange: { kind: 'lift', originalEndsAt: week.endsAt },
      });
      expect(liftedMine?.cancelledAt).not.toBeNull();
    });

    it('orders a restriction’s changes by the end each gave, not by their time: changes in one millisecond read as made (answer 4)', async () => {
      // Two operators one behind the other on the action's lock can read one millisecond of the
      // clock (or an earlier one, should it step back), and the ids are random. 무기한 → 3 days →
      // lifted, and 무기한 → 7 days → 3 days, each change made through the API.
      const inSevenDays = new Date(Date.now() + 7 * DAY_MS);
      const inThreeDays = new Date(Date.now() + 3 * DAY_MS);
      const shorten = async (actionId: string, endsAt: Date) =>
        actionOf(
          await send(
            `/admin/moderation/actions/${actionId}/shorten`,
            { endsAt: endsAt.toISOString(), reason: '이의 일부 인정' },
            admin,
          ),
        );
      const lifted = await restrict(null);
      await shorten(lifted.id, inThreeDays);
      const liftedEnd = actionOf(
        await send(`/admin/moderation/actions/${lifted.id}/lift`, { reason: '해제' }, admin),
      ).endsAt;
      const twice = await restrict(null);
      await shorten(twice.id, inSevenDays);
      await shorten(twice.id, inThreeDays);
      // Rewritten to one time, each later change's id before the first's: an order by time and id
      // reads them backwards. (buddha_app deletes and inserts them; it never updates one.)
      const { restrictionEndChanges } = schema;
      const written = await t.db.select().from(restrictionEndChanges);
      expect(written).toHaveLength(4);
      const at = new Date(Math.max(...written.map((row) => row.createdAt.getTime())));
      await t.db.delete(restrictionEndChanges);
      await t.db.insert(restrictionEndChanges).values(
        written.map((row) => ({
          ...row,
          id: `${row.previousEndsAt === null ? 'ffffffff' : '00000000'}-0000-4000-8000-00000000000${row.actionId === lifted.id ? '1' : '2'}`,
          createdAt: at,
        })),
      );
      // The member: 조기 해제됨 after its 감경, and twice 감경됨 — the end each was given 무기한.
      const mine = new Map((await myActions()).map((action) => [action.id, action]));
      expect(mine.get(lifted.id)).toMatchObject({
        endsAt: liftedEnd,
        endChange: { kind: 'lift', originalEndsAt: null },
      });
      expect(mine.get(twice.id)).toMatchObject({
        endsAt: inThreeDays.toISOString(),
        endChange: { kind: 'shorten', originalEndsAt: null },
      });
      // The operators: each restriction's changes in the order they were made.
      const { actions } = adminUserModerationSchema.parse(
        dataOf(await read(`/admin/moderation/users/${member.id}`, admin)),
      );
      const changesOf = (actionId: string) =>
        actions
          .find((action) => action.id === actionId)
          ?.endChanges.map((change) => [change.kind, change.previousEndsAt, change.endsAt]);
      expect(changesOf(lifted.id)).toEqual([
        ['shorten', null, inThreeDays.toISOString()],
        ['lift', inThreeDays.toISOString(), liftedEnd],
      ]);
      expect(changesOf(twice.id)).toEqual([
        ['shorten', null, inSevenDays.toISOString()],
        ['shorten', inSevenDays.toISOString(), inThreeDays.toISOString()],
      ]);
    });

    it('reads a restriction’s end and how it was brought forward at one instant: a lift committed while the member’s read waits is read whole', async () => {
      const action = await restrict(7);
      // Another connection holds the end changes' table, so a read of it waits, and meanwhile
      // lifts the restriction as `changeEnd` does — the end and its change row — and commits.
      // Read in two statements, the end before it would come with '조기 해제됨': '진행 중' and
      // lifted on one card.
      const holder = await t.db.$client.connect();
      let open = true;
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE restriction_end_changes IN ACCESS EXCLUSIVE MODE');
        const pending = read('/me/moderation/actions', member);
        await waitForLockWaiter(holder, 'the member’s actions on the end changes');
        const { rows } = await holder.query<{ ends_at: Date }>(
          `UPDATE moderation_actions SET ends_at = date_trunc('milliseconds', now())
            WHERE id = $1 RETURNING ends_at`,
          [action.id],
        );
        const liftedAt = rows[0]!.ends_at;
        await holder.query(
          `INSERT INTO restriction_end_changes
             (action_id, kind, previous_ends_at, ends_at, reason, created_by, created_at)
           VALUES ($1, 'lift', $2, $3, '해제', $4, $3)`,
          [action.id, action.endsAt, liftedAt, second.id],
        );
        await holder.query('COMMIT');
        open = false;
        const [mine] = dataOf<unknown[]>(await pending).map((item) =>
          myModerationActionSchema.parse(item),
        );
        expect(mine).toMatchObject({
          id: action.id,
          endsAt: liftedAt.toISOString(),
          endChange: { kind: 'lift', originalEndsAt: action.endsAt },
        });
      } finally {
        if (open) await holder.query('ROLLBACK');
        holder.release();
      }
    });
  });

  describe('giving it', () => {
    it('comes from the report queue: a subject’s pending reports are resolved, recorded with the operator and time', async () => {
      const filed = myReportSchema.parse(
        dataOf(await send(`/posts/${post.id}/reports`, { reason: 'spam' }, other), 201),
      );
      const action = await restrict(3, member, { subject: { type: 'post', postId: post.id } });
      expect(action).toMatchObject({
        subject: { type: 'post', postId: post.id },
        reportCount: 1,
      });
      const [report] = await t.db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.id, filed.id));
      expect(report).toMatchObject({
        status: 'actioned',
        actionId: action.id,
        resolvedBy: admin.id,
      });
      const [audit] = await audits('moderation_writing_restriction');
      expect(audit).toMatchObject({
        adminId: admin.id,
        targetType: 'moderation_action',
        targetId: action.id,
        payload: {
          actionId: action.id,
          userId: member.id,
          subject: { type: 'post', postId: post.id },
          days: 3,
          endsAt: action.endsAt,
          reason: 'spam',
          note: '같은 링크 반복',
          reportIds: [filed.id],
        },
      });
      // The member reads what it is about, its reason and end — never the operator nor the report.
      const [mine] = await myActions();
      expect(mine).toEqual({
        id: action.id,
        type: 'writing_restriction',
        reason: { code: 'spam', note: '같은 링크 반복' },
        subject: { type: 'post', id: post.id, title: '근거 글', excerpt: '본문 첫 줄' },
        createdAt: action.createdAt,
        endsAt: action.endsAt,
        endChange: null,
        cancelledAt: null,
      });
      // Another member's item is not theirs; an unknown member is NOT_FOUND.
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${member.id}/writing-restriction`,
            { reason: 'spam', days: 1, subject: { type: 'post', postId: othersPost.id } },
            admin,
          ),
        ),
      ).toBe('not_theirs');
      const unknown = await send(
        '/admin/moderation/users/nobody-at-all/writing-restriction',
        { reason: 'spam', days: 1 },
        admin,
      );
      expect(unknown.statusCode).toBe(404);
      // '기타' needs the note the member reads.
      const other_ = await send(
        `/admin/moderation/users/${member.id}/writing-restriction`,
        { reason: 'other', days: 1 },
        admin,
      );
      expect(other_.statusCode).toBe(400);
      // Members cannot give one.
      const byMember = await send(
        `/admin/moderation/users/${other.id}/writing-restriction`,
        { reason: 'spam', days: 1 },
        member,
      );
      expect(byMember.statusCode).toBe(403);
    });

    it('takes a 댓글 or the profile for its subject, as a warning does: their pending reports resolved (ADR-0081 7-9)', async () => {
      const publicId = (
        await t.db
          .select({ publicId: schema.profiles.publicId })
          .from(schema.profiles)
          .where(eq(schema.profiles.userId, member.id))
      )[0]!.publicId;
      const onComment = myReportSchema.parse(
        dataOf(await send(`/comments/${comment.id}/reports`, { reason: 'spam' }, other), 201),
      );
      const onProfile = myReportSchema.parse(
        dataOf(
          await send(`/profiles/${publicId}/reports`, { reason: 'impersonation' }, other),
          201,
        ),
      );
      const reportOf = async (id: string) =>
        (await t.db.select().from(schema.reports).where(eq(schema.reports.id, id)))[0];
      const auditOf = async (id: string) =>
        (await audits('moderation_writing_restriction')).find((row) => row.targetId === id);

      // About the 댓글: kept on the action, its report resolved, the member reads it.
      const aboutComment = await restrict(1, member, {
        subject: { type: 'comment', commentId: comment.id },
      });
      expect(aboutComment).toMatchObject({
        subject: { type: 'comment', commentId: comment.id, postId: post.id },
        reportCount: 1,
      });
      const [commentRow] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, aboutComment.id));
      expect(commentRow).toMatchObject({ commentId: comment.id, postId: null });
      expect(await reportOf(onComment.id)).toMatchObject({
        status: 'actioned',
        actionId: aboutComment.id,
      });
      expect((await reportOf(onProfile.id))?.status).toBe('pending');
      expect((await auditOf(aboutComment.id))?.payload).toMatchObject({
        subject: { type: 'comment', commentId: comment.id },
        reportIds: [onComment.id],
      });
      expect((await myActions()).find((action) => action.id === aboutComment.id)?.subject).toEqual({
        type: 'comment',
        id: comment.id,
        postId: post.id,
        excerpt: '댓글',
      });

      // About the profile: its reports resolved, no subject kept — the member reads one about
      // nothing in particular, as a warning about the profile (ADR-0081 7-9).
      const aboutProfile = await restrict(1, member, { subject: { type: 'profile' } });
      expect(aboutProfile).toMatchObject({ subject: null, reportCount: 1 });
      const [profileRow] = await t.db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, aboutProfile.id));
      expect(profileRow).toMatchObject({ commentId: null, postId: null });
      expect(await reportOf(onProfile.id)).toMatchObject({
        status: 'actioned',
        actionId: aboutProfile.id,
      });
      expect((await auditOf(aboutProfile.id))?.payload).toMatchObject({
        subject: { type: 'profile' },
        reportIds: [onProfile.id],
      });
      expect(
        (await myActions()).find((action) => action.id === aboutProfile.id)?.subject,
      ).toBeNull();

      // Another member's 댓글 is not theirs.
      const othersComment = await createComment(t.db, {
        postId: othersPost.id,
        authorId: other.id,
        body: '남의 댓글',
      });
      expect(
        refusalOf(
          await send(
            `/admin/moderation/users/${member.id}/writing-restriction`,
            { reason: 'spam', days: 1, subject: { type: 'comment', commentId: othersComment.id } },
            admin,
          ),
        ),
      ).toBe('not_theirs');
    });

    it('waits for a write in flight, taking the member’s profile before the item it is about (7-4, 7-5)', async () => {
      // A restriction and an edit of the post it is about, at once: one order, no deadlock — the
      // edit commits before it or is refused by it.
      const [restricted, edited] = await Promise.all([
        send(
          `/admin/moderation/users/${member.id}/writing-restriction`,
          { reason: 'spam', days: 1, subject: { type: 'post', postId: post.id } },
          second,
        ),
        editPost(),
      ]);
      expect(restricted.statusCode, restricted.body).toBe(200);
      expect([200, 403]).toContain(edited.statusCode);

      // Another connection holds the member's profile as a write in flight does (`assertWriter`).
      const holder = await t.db.$client.connect();
      let open = true;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM profiles WHERE user_id = $1 FOR KEY SHARE', [member.id]);
        const pending = send(
          `/admin/moderation/users/${member.id}/writing-restriction`,
          { reason: 'spam', days: 1, subject: { type: 'post', postId: post.id } },
          admin,
        );
        // The restriction waits on that profile: FOR UPDATE, which no lighter lock is (a
        // NO KEY UPDATE or a SHARE would let a write that read 'no restriction' commit after it).
        await waitForLockWaiter(holder, 'the restriction on the member’s profile');
        // And it has not taken the post yet: the profile comes first, the order every post and
        // comment write takes them in (`assertWriter` before the item's row), so an edit of the
        // post it names cannot deadlock with it.
        await holder.query('SELECT id FROM posts WHERE id = $1 FOR UPDATE NOWAIT', [post.id]);
        await holder.query('ROLLBACK');
        open = false;
        const action = actionOf(await pending);
        expect(action.subject).toEqual({ type: 'post', postId: post.id });
      } finally {
        if (open) await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('holds from its commit: a write in flight holds the member’s profile, and one after reads it', async () => {
      // Another connection gives the restriction: the member's profile locked as
      // ModerationService locks it, the row written, not yet committed.
      const holder = await t.db.$client.connect();
      let committed = false;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE', [member.id]);
        await holder.query(
          `INSERT INTO moderation_actions (type, user_id, reason, created_by, ends_at)
           VALUES ('writing_restriction', $1, 'spam', $2, now() + interval '1 day')`,
          [member.id, admin.id],
        );
        const pending = newComment();
        // The comment waits on the profile (`assertWriter`), then reads the committed restriction.
        await waitForLockWaiter(holder, 'the comment on the member’s profile');
        await holder.query('COMMIT');
        committed = true;
        const res = await pending;
        expect(restrictedOf(res).kind).toBe('writing');
      } finally {
        if (!committed) await holder.query('ROLLBACK');
        holder.release();
      }
      expect(
        await t.db
          .select()
          .from(schema.postComments)
          .where(
            and(
              eq(schema.postComments.authorId, member.id),
              eq(schema.postComments.body, '새 댓글'),
            ),
          ),
      ).toEqual([]);
    });
  });
});
