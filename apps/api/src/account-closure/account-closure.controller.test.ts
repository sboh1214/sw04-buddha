/**
 * 탈퇴 (#140, ADR-0086; ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4
 * #140 rows, decision 7; owner decision 2026-10-23 on ADR-0085 결과 5) against the docker `test`
 * profile. Pinned: the member closes their own account at once on the typed '탈퇴' — the Coin left
 * forfeited by one '탈퇴 소멸' entry (the ledger still sums to the balance, now 0), the identifying
 * data deleted (real name and number, address, sign-in methods, sessions, public items, profile
 * image, watchlist, search history) while the records stay (ledger, start grant and its number,
 * code-send records, consent records, watch events, posts, comments, likes, reports), the public
 * face anonymised on every surface ('탈퇴한 사용자' with no profile link, the profile and its lists
 * 404 — N04 §7's third deletion check, #37-19), the nickname held unlinked for 30 days, a start
 * grant still waiting cancelled and its number freed, the account restriction requests about the
 * member closed as rejected '탈퇴'; the closed account signs in no more, and the same address and
 * number sign up again at once without a second start Coin. Refused while an admin, restricted,
 * holding an unsettled contract, paying or ordering — nothing changes then; another member's rows,
 * requests, contracts, payments and orders are neither touched nor counted. Asked twice at once,
 * it runs once. A request that passed SessionGuard before the closure committed writes nothing
 * (UNAUTHENTICATED), and operators can neither adjust nor grant the closed account. Skips when
 * TEST_* are unset.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createApprovalRequest,
  createCategory,
  createComment,
  createConsents,
  createMarket,
  createModerationAction,
  createPhoneVerification,
  createPosition,
  createPost,
  createPostLike,
  createProfileImage,
  createReport,
  createSearch,
  createStartGrant,
  createWatch,
} from '@buddha/db/test';
import {
  START_COIN_SETTING,
  accountClosureCheckSchema,
  accountClosureResultSchema,
  accountRestrictionRequestSchema,
  closedAccountEmail,
  type AccountClosureCheck,
  type AccountClosureResult,
  type AccountRestrictionRequest,
  type Me,
  type CommentThread,
  type PostSummary,
  type PublishedPost,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';
import { SearchHistoryService } from '../search-history/search-history.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { WatchlistService } from '../watchlist/watchlist.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const DAY_MS = 24 * 60 * 60 * 1_000;

type Res = { statusCode: number; body: string; json: <T>() => T };

describe.skipIf(!hasTestInfra)('/api/v1/me/closure (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let other: TestUser;
  let admin: TestUser;
  let second: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;

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
  });

  async function onboarded(phone?: string): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id, ...(phone ? { phone } : {}) });
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

  const post = (url: string, payload: Record<string, unknown>, who: TestUser) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const close = (who: TestUser, confirmation = '탈퇴') =>
    post('/me/closure', { confirmation }, who);
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
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const error = res.json<{ error: { code: string; details: unknown } }>().error;
    expect(error.code).toBe(code);
    return error.details;
  };
  const closed = async (who: TestUser) =>
    accountClosureResultSchema.parse(dataOf<AccountClosureResult>(await close(who)));
  const checkOf = async (who: TestUser) =>
    accountClosureCheckSchema.parse(dataOf<AccountClosureCheck>(await read('/me/closure', who)));

  async function profileOf(userId: string) {
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return profile!;
  }
  async function balanceOf(userId: string) {
    const [balance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return balance!;
  }
  const ledgerOf = (userId: string) =>
    t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  async function setAmount(value: number) {
    await t.app
      .get(ReleaseSettingsService)
      .change(admin.id, START_COIN_SETTING.key, { status: 'test', value, reason: '시험' });
  }
  /** The onboarding's nickname step through the API, the start Coin's trigger (#70). */
  const nicknameStep = async (who: TestUser) => {
    const nickname = (await profileOf(who.id)).nickname!;
    return dataOf<Me>(await post('/me/onboarding/nickname', { nickname }, who));
  };

  describe('closing the account', () => {
    it('forfeits the Coin, deletes the identifying data, keeps the records and anonymises every public surface (#57-16…18, #37-16…19)', async () => {
      const phone = '01012345678';
      const hash = t.app.get(PhoneHasher).hash(phone);
      await t.db
        .delete(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, member.id));
      await createPhoneVerification(t.db, { userId: member.id, phone, realName: '김탈퇴' });
      await createStartGrant(t.db, { userId: member.id, phoneHash: hash, amountCoin: 10_000n });
      const before = await profileOf(member.id);
      const nickname = before.nickname!;
      // The public items, and the image's object in the store.
      const image = await createProfileImage(t.db, { userId: member.id });
      await t.storage.put(image.storageKey, randomBytes(16), image.contentType);
      const category = await createCategory(t.db);
      // The public items, and a private setting of MY 설정: the time zone (owner decision
      // 2026-10-23 (3차) 6 — it goes too).
      await t.db
        .update(schema.profiles)
        .set({ bio: '탈퇴할 회원의 소개', timeZone: 'America/New_York' })
        .where(eq(schema.profiles.userId, member.id));
      await t.db
        .insert(schema.profileInterestCategories)
        .values({ userId: member.id, categoryId: category.id });
      // Private records: the watchlist and its event, a search, a code-send record, a nickname
      // given up earlier (held for the member), a password-reset token of better-auth's.
      await createWatch(t.db, { userId: member.id, marketId: market.id });
      await createSearch(t.db, { userId: member.id, query: '금리' });
      await t.db.insert(schema.phoneVerificationCodes).values({
        id: randomUUID(),
        userId: member.id,
        phone,
        realName: '김탈퇴',
        codeHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 180_000),
      });
      await t.db.insert(schema.nicknameHolds).values({ nickname: 'old_name', userId: member.id });
      await t.db.insert(schema.verification).values({
        id: randomUUID(),
        identifier: `reset-password:${randomUUID()}`,
        value: member.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      // The community: the member's post, a comment of theirs under another's post, a like each
      // way, and a report of theirs still waiting.
      const own = await createPost(t.db, {
        marketId: market.id,
        authorId: member.id,
        text: '내 근거',
      });
      const others = await createPost(t.db, {
        marketId: market.id,
        authorId: other.id,
        text: '남의 글',
      });
      const comment = await createComment(t.db, {
        postId: others.id,
        authorId: member.id,
        body: '탈퇴할 회원의 댓글',
      });
      await createPostLike(t.db, { postId: others.id, userId: member.id });
      await createPostLike(t.db, { postId: own.id, userId: other.id });
      const report = await createReport(t.db, {
        reporterId: member.id,
        reportedUserId: other.id,
        postId: others.id,
      });
      // Account restriction requests about the member: one waiting, one rejected, one retracted —
      // each with the payload AccountRestrictionService writes.
      const apply = {
        kind: 'account_restriction',
        targetType: 'user',
        targetId: member.id,
        requestedBy: admin.id,
        payload: {
          userId: member.id,
          reason: 'multi_account',
          note: '설명',
          days: 7,
          subject: null,
          memo: null,
        },
      };
      const waiting = await createApprovalRequest(t.db, apply);
      const rejected = await createApprovalRequest(t.db, {
        ...apply,
        decision: { status: 'rejected', by: second.id },
      });
      const retracted = await createApprovalRequest(t.db, { ...apply, retracted: {} });
      const consentsBefore = await t.db
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.userId, member.id));
      // Another member's rows of every kind the closure deletes, unlinks or closes — none of them
      // the member's, so every one stays as it is: a watch, a search, an interest category, a
      // nickname hold naming them, a password-reset token, an account restriction request about
      // them still waiting, and their sessions and sign-in methods.
      await createWatch(t.db, { userId: other.id, marketId: market.id });
      await createSearch(t.db, { userId: other.id, query: '환율' });
      await t.db
        .insert(schema.profileInterestCategories)
        .values({ userId: other.id, categoryId: category.id });
      await t.db.insert(schema.nicknameHolds).values({ nickname: 'others_old', userId: other.id });
      await t.db.insert(schema.verification).values({
        id: randomUUID(),
        identifier: `reset-password:${randomUUID()}`,
        value: other.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const aboutOther = await createApprovalRequest(t.db, {
        ...apply,
        targetId: other.id,
        payload: { ...apply.payload, userId: other.id },
      });
      const othersRows = async () => {
        const { marketWatches, marketSearches, profileInterestCategories, nicknameHolds } = schema;
        const { verification, session, account: accounts } = schema;
        return {
          watches: await t.db
            .select()
            .from(marketWatches)
            .where(eq(marketWatches.userId, other.id)),
          searches: await t.db
            .select()
            .from(marketSearches)
            .where(eq(marketSearches.userId, other.id)),
          interests: await t.db
            .select()
            .from(profileInterestCategories)
            .where(eq(profileInterestCategories.userId, other.id)),
          holds: await t.db.select().from(nicknameHolds).where(eq(nicknameHolds.userId, other.id)),
          resets: await t.db.select().from(verification).where(eq(verification.value, other.id)),
          sessions: await t.db
            .select({ id: session.id })
            .from(session)
            .where(eq(session.userId, other.id)),
          accounts: await t.db
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.userId, other.id)),
        };
      };
      const othersBefore = await othersRows();
      expect(Object.values(othersBefore).every((rows) => rows.length > 0)).toBe(true);

      // What the confirmation screen says first: the Coin to be forfeited, nothing refusing, and
      // that the start Coin was paid — the screen says its number gets none again (owner decision
      // 2026-10-23 (3차) 9).
      expect(await checkOf(member)).toEqual({
        availableCoin: '10000',
        refusals: [],
        restriction: null,
        startGrantReceived: true,
      });
      const result = await closed(member);
      expect(result.forfeitedCoin).toBe('10000');
      const closedAt = new Date(result.closedAt);

      // Signed out everywhere, and no way back in.
      errorOf(await read('/me', member), 401, 'UNAUTHENTICATED');
      await expect(
        t.auth.api.signInEmail({ body: { email: member.email, password: member.password } }),
      ).rejects.toThrow();

      // '탈퇴 소멸': one entry of the whole balance, the chain intact and the balance 0.
      const ledger = await ledgerOf(member.id);
      expect(ledger.map((e) => [e.type, e.amountCoin, e.refType, e.refId])).toEqual([
        ['START_GRANT', 10_000n, 'start_grant', expect.any(String)],
        ['CLOSURE_FORFEIT', -10_000n, 'account_closure', member.id],
      ]);
      expectLedgerChain(ledger, 0n);
      expect(await balanceOf(member.id)).toMatchObject({ availableCoin: 0n, lockedCoin: 0n });

      // The profile: closed, the public items and the time zone gone, the public id kept (never
      // shown again).
      const profile = await profileOf(member.id);
      expect(profile).toMatchObject({
        closedAt,
        nickname: null,
        bio: null,
        imageId: null,
        timeZone: null,
        publicId: before.publicId,
        role: 'user',
      });
      // Deleted at once.
      const count = async (rows: Promise<unknown[]>) => (await rows).length;
      const { phoneVerifications, account: accounts, session, verification } = schema;
      const { marketWatches, marketSearches, profileInterestCategories, mediaObjects } = schema;
      expect({
        verification: await count(
          t.db.select().from(phoneVerifications).where(eq(phoneVerifications.userId, member.id)),
        ),
        accounts: await count(t.db.select().from(accounts).where(eq(accounts.userId, member.id))),
        sessions: await count(t.db.select().from(session).where(eq(session.userId, member.id))),
        resetTokens: await count(
          t.db.select().from(verification).where(eq(verification.value, member.id)),
        ),
        watches: await count(
          t.db.select().from(marketWatches).where(eq(marketWatches.userId, member.id)),
        ),
        searches: await count(
          t.db.select().from(marketSearches).where(eq(marketSearches.userId, member.id)),
        ),
        interests: await count(
          t.db
            .select()
            .from(profileInterestCategories)
            .where(eq(profileInterestCategories.userId, member.id)),
        ),
        image: await count(t.db.select().from(mediaObjects).where(eq(mediaObjects.id, image.id))),
      }).toEqual({
        verification: 0,
        accounts: 0,
        sessions: 0,
        resetTokens: 0,
        watches: 0,
        searches: 0,
        interests: 0,
        image: 0,
      });
      expect(t.storage.objects.has(image.storageKey)).toBe(false);
      const [account] = await t.db.select().from(schema.user).where(eq(schema.user.id, member.id));
      expect(account).toMatchObject({
        email: closedAccountEmail(member.id),
        emailVerified: false,
        name: '',
        image: null,
      });

      // Kept: the start grant and its number (#57-1), the code-send record (ADR-0070), the consent
      // records (#57-18, operators only), the watch history (ADR-0064) — the watch ended by its
      // unwatch at the closure (owner decision 2026-10-23 (2차) 2) — the post and comment as
      // written, the likes (#37-17) and the report, still waiting to be processed.
      const [grant] = await t.db
        .select()
        .from(schema.startGrants)
        .where(eq(schema.startGrants.userId, member.id));
      expect(grant).toMatchObject({ cancelledAt: null, amountCoin: 10_000n });
      expect(
        await t.db
          .select({ releasedAt: schema.startGrantNumbers.releasedAt })
          .from(schema.startGrantNumbers)
          .where(eq(schema.startGrantNumbers.phoneHash, hash)),
      ).toEqual([{ releasedAt: null }]);
      expect(
        await t.db
          .select({ phone: schema.phoneVerificationCodes.phone })
          .from(schema.phoneVerificationCodes)
          .where(eq(schema.phoneVerificationCodes.userId, member.id)),
      ).toEqual([{ phone }]);
      expect(
        await t.db
          .select()
          .from(schema.consentRecords)
          .where(eq(schema.consentRecords.userId, member.id)),
      ).toEqual(consentsBefore);
      expect(
        await t.db
          .select({
            marketId: schema.marketWatchEvents.marketId,
            action: schema.marketWatchEvents.action,
            createdAt: schema.marketWatchEvents.createdAt,
          })
          .from(schema.marketWatchEvents)
          .where(eq(schema.marketWatchEvents.userId, member.id))
          .orderBy(asc(schema.marketWatchEvents.id)),
      ).toEqual([
        { marketId: market.id, action: 'watch', createdAt: expect.any(Date) as Date },
        { marketId: market.id, action: 'unwatch', createdAt: closedAt },
      ]);
      // The other member's watch history is left as it was: their watch stands.
      expect(
        await t.db
          .select({ action: schema.marketWatchEvents.action })
          .from(schema.marketWatchEvents)
          .where(eq(schema.marketWatchEvents.userId, other.id)),
      ).toEqual([{ action: 'watch' }]);
      const [kept] = await t.db
        .select({ authorId: schema.posts.authorId, bodyText: schema.posts.bodyText })
        .from(schema.posts)
        .where(eq(schema.posts.id, own.id));
      expect(kept).toEqual({ authorId: member.id, bodyText: '내 근거' });
      expect(
        await t.db
          .select({ id: schema.postLikes.postId })
          .from(schema.postLikes)
          .where(eq(schema.postLikes.userId, member.id)),
      ).toEqual([{ id: others.id }]);
      const [stillWaiting] = await t.db
        .select({ status: schema.reports.status })
        .from(schema.reports)
        .where(eq(schema.reports.id, report.id));
      expect(stillWaiting).toEqual({ status: 'pending' });

      // The nickname held from everybody, linked to nobody, for 30 days from the closure; the
      // hold the member had of an earlier one loses its link too.
      const holds = await t.db
        .select({
          nickname: schema.nicknameHolds.nickname,
          userId: schema.nicknameHolds.userId,
          releasedAt: schema.nicknameHolds.releasedAt,
        })
        .from(schema.nicknameHolds)
        .orderBy(asc(schema.nicknameHolds.id));
      expect(holds).toEqual([
        { nickname: 'old_name', userId: null, releasedAt: expect.any(Date) as Date },
        { nickname: 'others_old', userId: other.id, releasedAt: expect.any(Date) as Date },
        { nickname, userId: null, releasedAt: closedAt },
      ]);
      // Nothing of the other member's was deleted, unlinked or closed, and they are signed in.
      expect(await othersRows()).toEqual(othersBefore);
      expect(dataOf<Me>(await read('/me', other)).id).toBe(other.id);

      // The request waiting was closed as rejected by no admin, '탈퇴', at the closure; the two
      // closed before stay as they were.
      const requests = await t.db
        .select()
        .from(schema.approvalRequests)
        .orderBy(asc(schema.approvalRequests.requestedAt));
      expect(requests.find((r) => r.id === waiting.id)).toMatchObject({
        status: 'rejected',
        decidedBy: null,
        decisionReason: '탈퇴',
        decidedAt: closedAt,
      });
      expect(requests.find((r) => r.id === rejected.id)).toEqual(rejected);
      expect(requests.find((r) => r.id === retracted.id)).toEqual(retracted);
      // The request about the other member still waits for an operator.
      expect(requests.find((r) => r.id === aboutOther.id)).toEqual(aboutOther);
      const stillPending = dataOf<AccountRestrictionRequest[]>(
        await read('/admin/moderation/account-restriction-requests?status=pending', second),
      ).map((request) => accountRestrictionRequestSchema.parse(request));
      expect(stillPending.map((request) => request.id)).toEqual([aboutOther.id]);
      // Operators read it among the decided ones, closed by the closure, decided by nobody.
      const decided = dataOf<AccountRestrictionRequest[]>(
        await read('/admin/moderation/account-restriction-requests?status=decided', admin),
      ).map((request) => accountRestrictionRequestSchema.parse(request));
      expect(decided.find((r) => r.id === waiting.id)).toMatchObject({
        status: 'rejected',
        decidedBy: null,
        decisionReason: '탈퇴',
        closedByAccountClosure: true,
        user: { id: member.id, nickname: null },
      });
      expect(decided.find((r) => r.id === rejected.id)).toMatchObject({
        closedByAccountClosure: false,
        decidedBy: { id: second.id },
      });

      // Every public surface: '탈퇴한 사용자' with no link, the body and the like kept; the
      // profile, its lists and a report on it answer as for no account (#37-16, N04 §7).
      const list = dataOf<PostSummary[]>(await read('/posts'));
      expect(list.find((p) => p.id === own.id)?.author).toEqual({ kind: 'former_member' });
      const page = dataOf<PublishedPost>(await read(`/posts/${own.id}`));
      expect(page).toMatchObject({ author: { kind: 'former_member' }, likeCount: 1 });
      const othersPage = dataOf<PublishedPost>(await read(`/posts/${others.id}`));
      expect(othersPage.likeCount).toBe(1);
      const threads = dataOf<CommentThread[]>(await read(`/posts/${others.id}/comments`));
      expect(threads.find((thread) => thread.comment.id === comment.id)?.comment).toMatchObject({
        state: 'published',
        body: '탈퇴할 회원의 댓글',
        author: { kind: 'former_member' },
      });
      for (const url of [
        `/profiles/${before.publicId}`,
        `/profiles/${before.publicId}/posts`,
        `/profiles/${before.publicId}/comments`,
      ]) {
        errorOf(await read(url), 404, 'NOT_FOUND');
      }
      errorOf(
        await post(`/profiles/${before.publicId}/reports`, { reason: 'spam' }, other),
        404,
        'NOT_FOUND',
      );
      // Nothing that names the closed account reaches a public answer.
      for (const res of [
        await read('/posts'),
        await read(`/posts/${own.id}`),
        await read(`/posts/${others.id}/comments`),
      ]) {
        expect(res.body).not.toContain(nickname);
        expect(res.body).not.toContain(before.publicId);
        expect(res.body).not.toContain(member.id);
      }

      // The same address signs up again at once (#57-17); the same number verifies again, and
      // gets no start Coin: it received it (#57-1).
      const again = await signUpTestUser(t, { email: member.email });
      expect(again.id).not.toBe(member.id);
      await createConsents(t.db, { userId: again.id });
      await createPhoneVerification(t.db, { userId: again.id, phone });
      await setAmount(1_000);
      const me = await nicknameStep(again);
      expect(me.startGrant).toEqual({ status: 'number_used', amountCoin: null, grantedAt: null });
      expect(await ledgerOf(again.id)).toEqual([]);
      // That account received nothing: its own confirmation screen says nothing of the start Coin
      // (owner decision 2026-10-23 (3차) 9).
      expect((await checkOf(again)).startGrantReceived).toBe(false);
    });

    it('ends each watch it deletes with one unwatch at the closure, and writes none for a market already unwatched (owner decision 2026-10-23 (2차) 2)', async () => {
      const otherMarket = await createMarket(t.db, { title: '환율 상승' });
      const unwatchedMarket = await createMarket(t.db, { title: '유가 하락' });
      // Two watches standing, and a market watched and unwatched before: its history already
      // ends with an unwatch, and no watch row is left of it.
      await createWatch(t.db, { userId: member.id, marketId: market.id });
      await createWatch(t.db, { userId: member.id, marketId: otherMarket.id });
      const watchlist = t.app.get(WatchlistService);
      await watchlist.set(member.id, unwatchedMarket.id, true);
      await watchlist.set(member.id, unwatchedMarket.id, false);
      const { marketWatchEvents } = schema;
      const eventsOf = () =>
        t.db
          .select({
            id: marketWatchEvents.id,
            marketId: marketWatchEvents.marketId,
            action: marketWatchEvents.action,
            createdAt: marketWatchEvents.createdAt,
          })
          .from(marketWatchEvents)
          .where(eq(marketWatchEvents.userId, member.id))
          .orderBy(asc(marketWatchEvents.id));
      const before = await eventsOf();
      expect(before.map(({ marketId, action }) => [marketId, action])).toEqual([
        [market.id, 'watch'],
        [otherMarket.id, 'watch'],
        [unwatchedMarket.id, 'watch'],
        [unwatchedMarket.id, 'unwatch'],
      ]);

      const closedAt = new Date((await closed(member)).closedAt);

      // Every earlier event as it was, and after them exactly one unwatch at the closure's
      // instant for each watch the closure deleted — none for the market already unwatched.
      const after = await eventsOf();
      expect(after.slice(0, before.length)).toEqual(before);
      const byMarket = (a: { marketId: string }, b: { marketId: string }) =>
        a.marketId.localeCompare(b.marketId);
      expect(
        after
          .slice(before.length)
          .map(({ marketId, action, createdAt }) => ({ marketId, action, createdAt }))
          .sort(byMarket),
      ).toEqual(
        [market.id, otherMarket.id]
          .map((marketId) => ({ marketId, action: 'unwatch', createdAt: closedAt }))
          .sort(byMarket),
      );
      expect(
        await t.db
          .select()
          .from(schema.marketWatches)
          .where(eq(schema.marketWatches.userId, member.id)),
      ).toEqual([]);
    });

    it('closes the member’s waiting requests to change a restriction of theirs, and none of another member’s (owner decision 2026-10-23)', async () => {
      // Ended account restrictions refuse no closure. A cancellation is still asked of one ended
      // (ADR-0085), and a lift asked while one stood may wait past its end.
      const ended = (userId: string) =>
        createModerationAction(t.db, {
          userId,
          createdBy: admin.id,
          type: 'account_restriction',
          reason: 'multi_account',
          approvedBy: second.id,
          createdAt: new Date(Date.now() - 3 * DAY_MS),
          endsAt: new Date(Date.now() - DAY_MS),
        });
      const first = await ended(member.id);
      const earlier = await ended(member.id);
      const others = await ended(other.id);
      const cancel = accountRestrictionRequestSchema.parse(
        dataOf(
          await post(
            `/admin/moderation/actions/${first.id}/account-restriction/cancel`,
            { reason: '취소 사유' },
            admin,
          ),
        ),
      );
      const lift = (action: { id: string; userId: string }) =>
        createApprovalRequest(t.db, {
          kind: 'account_restriction_lift',
          targetType: 'moderation_action',
          targetId: action.id,
          requestedBy: admin.id,
          payload: { userId: action.userId, actionId: action.id },
        });
      const members = await lift(earlier);
      const othersLift = await lift(others);

      expect(await checkOf(member)).toMatchObject({ refusals: [], restriction: null });
      const closedAt = new Date((await closed(member)).closedAt);
      const rows = new Map(
        (await t.db.select().from(schema.approvalRequests)).map((row) => [row.id, row]),
      );
      for (const id of [cancel.id, members.id]) {
        expect(rows.get(id), id).toMatchObject({
          status: 'rejected',
          decidedBy: null,
          decisionReason: '탈퇴',
          decidedAt: closedAt,
        });
      }
      expect(rows.get(othersLift.id)).toEqual(othersLift);
      // The operators read the member's two among the decided ones, closed by the closure, and
      // the other member's still waiting. (The factory's approvals of the restrictions carry no
      // payload of the service's, so only the closure's are parsed.)
      const queue = async (status: 'pending' | 'decided') =>
        dataOf<AccountRestrictionRequest[]>(
          await read(`/admin/moderation/account-restriction-requests?status=${status}`, second),
        );
      expect(
        (await queue('decided'))
          .filter((request) => request.closedByAccountClosure)
          .map((request) => accountRestrictionRequestSchema.parse(request).id)
          .sort(),
      ).toEqual([cancel.id, members.id].sort());
      expect((await queue('pending')).map((request) => request.id)).toEqual([othersLift.id]);
    });

    it('takes a request about the member made while the closure runs after its commit, never between its look for the requests it closes and that commit', async () => {
      // An ended account restriction, which a cancellation may still be asked of (ADR-0085).
      const action = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'account_restriction',
        reason: 'multi_account',
        approvedBy: second.id,
        createdAt: new Date(Date.now() - 3 * DAY_MS),
        endsAt: new Date(Date.now() - DAY_MS),
      });
      const observer = await t.db.$client.connect();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = () => {};
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      // The member's balance held, so the closure stops on it: past the profile it holds FOR
      // UPDATE from its start, before it looks for the requests it closes.
      const balanceHeld = t.db.transaction(async (tx) => {
        await tx
          .select({ one: sql`1` })
          .from(schema.balances)
          .where(eq(schema.balances.userId, member.id))
          .for('update');
        held();
        await gate;
      });
      let closedAt: Date;
      let asked: Res;
      try {
        await holding;
        const closing = close(member);
        await waitForLockWaiter(observer, 'the closure behind the held balance');
        const asking = post(
          `/admin/moderation/actions/${action.id}/account-restriction/cancel`,
          { reason: '취소 사유' },
          admin,
        );
        // The request waits on the member's profile the closure holds; one that did not would
        // commit before the closure's commit and have it refused there (a request waiting).
        await waitForLockWaiter(observer, 'the request behind the closure’s profile lock', 2);
        release();
        await balanceHeld;
        closedAt = new Date(dataOf<AccountClosureResult>(await closing).closedAt);
        asked = await asking;
      } finally {
        release();
        observer.release();
      }
      // The closure committed, and the request came after it: about the closed member, waiting —
      // a cancellation of an earlier restriction is still taken about a closed member; only a new
      // action is refused (`closed`, owner decision 2026-10-23 (2차) 1, ADR-0086 7-28).
      const request = accountRestrictionRequestSchema.parse(dataOf(asked));
      expect(request.status).toBe('pending');
      const [row] = await t.db
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, request.id));
      expect(row!.requestedAt.getTime()).toBeGreaterThanOrEqual(closedAt.getTime());
      expect((await profileOf(member.id)).closedAt).toEqual(closedAt);
    });

    it('cancels a start grant still waiting and frees its number for the next account (owner decision 2026-10-18 on #70)', async () => {
      const phone = '01087654321';
      await t.db
        .delete(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, member.id));
      await createPhoneVerification(t.db, { userId: member.id, phone });
      await createStartGrant(t.db, {
        userId: member.id,
        phoneHash: t.app.get(PhoneHasher).hash(phone),
      });
      // Still waiting: nothing paid, so the screen says nothing of the start Coin (owner decision
      // 2026-10-23 (3차) 9) — the closure cancels it and the number may receive it again.
      expect((await checkOf(member)).startGrantReceived).toBe(false);
      const result = await closed(member);
      expect(result.forfeitedCoin).toBe('0');
      // Nothing was left to forfeit: no entry at all.
      expect(await ledgerOf(member.id)).toEqual([]);
      const [grant] = await t.db
        .select()
        .from(schema.startGrants)
        .where(eq(schema.startGrants.userId, member.id));
      // Cancelled by the closure's transaction (its own reading of the clock, after the closure's).
      expect(grant!.cancelledAt!.getTime()).toBeGreaterThanOrEqual(Date.parse(result.closedAt));
      expect(
        (await t.db.select().from(schema.startGrantNumbers)).map((row) => row.releasedAt),
      ).toEqual([grant!.cancelledAt]);

      const again = await signUpTestUser(t);
      await createConsents(t.db, { userId: again.id });
      await createPhoneVerification(t.db, { userId: again.id, phone });
      await setAmount(1_000);
      expect((await nicknameStep(again)).startGrant).toMatchObject({
        status: 'granted',
        amountCoin: '1000',
      });
    });

    it('carries the limits counted by number over to a new account of the same number (decision 7, ADR-0081 결과 5, ADR-0076)', async () => {
      const phone = '01011112222';
      const closing = await onboarded(phone);
      const target = await createPost(t.db, {
        marketId: market.id,
        authorId: other.id,
        text: '글',
      });
      const like = (who: TestUser, liked: boolean) =>
        t.app.inject({
          method: 'PUT',
          url: `/api/v1/posts/${target.id}/like`,
          headers: {
            origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            cookie: who.cookie,
          },
          payload: JSON.stringify({ liked, expectedAccountId: who.id }),
        });
      dataOf(await like(closing, true));
      dataOf(await post(`/posts/${target.id}/reports`, { reason: 'spam' }, closing), 201);
      await closed(closing);

      // The same number verified by a new account: the earlier like is its own (counted once,
      // and it may take it back), and the earlier report, still waiting, is its own too.
      const again = await onboarded(phone);
      expect(
        dataOf<{ postLiked: boolean }>(await read(`/me/likes/posts/${target.id}`, again)),
      ).toMatchObject({ postLiked: true });
      expect(dataOf<{ likeCount: number }>(await read(`/posts/${target.id}`)).likeCount).toBe(1);
      expect(
        errorOf(
          await post(`/posts/${target.id}/reports`, { reason: 'spam' }, again),
          409,
          'REPORT_NOT_ALLOWED',
        ),
      ).toEqual({ reason: 'duplicate' });
      expect(dataOf<{ liked: boolean; likeCount: number }>(await like(again, false))).toEqual({
        liked: false,
        likeCount: 0,
      });
    });

    it('closes an account that never finished the onboarding, with sign-in only', async () => {
      const fresh = await signUpTestUser(t);
      expect(await checkOf(fresh)).toEqual({
        availableCoin: '0',
        refusals: [],
        restriction: null,
        startGrantReceived: false,
      });
      expect((await closed(fresh)).forfeitedCoin).toBe('0');
      expect(await profileOf(fresh.id)).toMatchObject({ nickname: null });
    });

    it('closes a member with an ended restriction, a settled contract, a position sold out and finished payments, whatever another member holds', async () => {
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        createdAt: new Date(Date.now() - 3 * DAY_MS),
        endsAt: new Date(Date.now() - DAY_MS),
      });
      await createPosition(t.db, {
        userId: member.id,
        marketId: market.id,
        outcome: 'YES',
        qty: 5,
        settled: true,
      });
      // Sold out of a market not settled yet: no contract left to settle (qty > 0 only, #57-16).
      await createPosition(t.db, { userId: member.id, marketId: market.id, outcome: 'NO', qty: 0 });
      await t.db.insert(schema.payments).values({
        userId: member.id,
        amountCoin: 10_000n,
        priceKrw: 9_700,
        provider: 'mock',
        status: 'refunded',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      await t.db.insert(schema.orders).values({
        userId: member.id,
        marketId: market.id,
        outcome: 'YES',
        side: 'buy',
        type: 'market',
        qty: 1,
        filledQty: 1,
        status: 'filled',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      // Another member's unsettled contract, payment and refund in progress and waiting orders
      // refuse only that member's closure.
      await createPosition(t.db, { userId: other.id, marketId: market.id, outcome: 'YES', qty: 4 });
      for (const status of ['pending', 'refunding'] as const) {
        await t.db.insert(schema.payments).values({
          userId: other.id,
          amountCoin: 10_000n,
          priceKrw: 9_700,
          provider: 'mock',
          status,
          idempotencyKey: `closure-${randomUUID()}`,
        });
      }
      for (const [status, filledQty] of [
        ['open', 0],
        ['partially_filled', 1],
      ] as const) {
        await t.db.insert(schema.orders).values({
          userId: other.id,
          marketId: market.id,
          outcome: 'YES',
          side: 'buy',
          type: 'limit',
          limitPrice: 40,
          qty: 2,
          filledQty,
          status,
          timeInForce: 'gtc',
          idempotencyKey: `closure-${randomUUID()}`,
        });
      }
      expect(await checkOf(member)).toMatchObject({ refusals: [], restriction: null });
      await closed(member);
      expect((await profileOf(member.id)).closedAt).not.toBeNull();
      expect(await checkOf(other)).toMatchObject({
        refusals: ['unsettled_contracts', 'payment_in_progress', 'pending_orders'],
      });
    });

    it('accepts the confirmation with blanks around it and refuses any other word or account', async () => {
      errorOf(await close(member, '탈퇴합니다'), 400, 'VALIDATION_ERROR');
      errorOf(await close(member, ''), 400, 'VALIDATION_ERROR');
      errorOf(
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/me/closure',
          headers: {
            origin: TRUSTED_ORIGIN,
            'content-type': 'application/json',
            cookie: member.cookie,
          },
          payload: JSON.stringify({ confirmation: '탈퇴', expectedAccountId: other.id }),
        }),
        403,
        'FORBIDDEN',
      );
      errorOf(
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/me/closure',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ confirmation: '탈퇴', expectedAccountId: member.id }),
        }),
        401,
        'UNAUTHENTICATED',
      );
      expect((await profileOf(member.id)).closedAt).toBeNull();
      expect((await profileOf(other.id)).closedAt).toBeNull();
      await closed(member).then(() => undefined);
      expect((await profileOf(member.id)).closedAt).not.toBeNull();
    });

    it('closes once when asked twice at once', async () => {
      await createStartGrant(t.db, { userId: member.id, amountCoin: 5_000n });
      const answers = await Promise.all([close(member), close(member), close(member)]);
      const statuses = answers.map((res) => res.statusCode);
      // Each either waited for the first and answered what it did, or came after its commit and
      // found no session.
      expect(statuses.every((status) => status === 200 || status === 401)).toBe(true);
      expect(statuses).toContain(200);
      const results = answers
        .filter((res) => res.statusCode === 200)
        .map((res) => res.json<{ data: AccountClosureResult }>().data);
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(results[0]?.forfeitedCoin).toBe('5000');
      expect(
        (await ledgerOf(member.id)).filter((entry) => entry.type === 'CLOSURE_FORFEIT'),
      ).toHaveLength(1);
      expect(
        await t.db
          .select()
          .from(schema.nicknameHolds)
          .where(sql`${schema.nicknameHolds.userId} IS NULL`),
      ).toHaveLength(1);
    });
  });

  describe('what refuses a closure (#57-16, #57-17, decision 4 #140, decision 7)', () => {
    /** The refusal changed nothing: the account open, the balance and its sessions as they were. */
    async function expectOpen(who: TestUser) {
      expect((await profileOf(who.id)).closedAt).toBeNull();
      expect(dataOf<Me>(await read('/me', who)).id).toBe(who.id);
    }

    it('refuses an admin until the role is revoked', async () => {
      expect(await checkOf(admin)).toMatchObject({ refusals: ['admin'] });
      expect(errorOf(await close(admin), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({ reason: 'admin' });
      await expectOpen(admin);
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, admin.id));
      await closed(admin);
    });

    it('refuses while a writing restriction stands, naming its end', async () => {
      const endsAt = new Date(Date.now() + 3 * DAY_MS);
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt,
      });
      const restriction = { kind: 'writing', endsAt: endsAt.toISOString() };
      expect(await checkOf(member)).toMatchObject({ refusals: [], restriction });
      expect(errorOf(await close(member), 403, 'RESTRICTED')).toEqual(restriction);
      await expectOpen(member);
    });

    it('refuses while an account restriction stands, 무기한 until it is lifted', async () => {
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'account_restriction',
        reason: 'multi_account',
        approvedBy: second.id,
      });
      const restriction = { kind: 'account', endsAt: null };
      expect(await checkOf(member)).toMatchObject({ restriction });
      expect(errorOf(await close(member), 403, 'RESTRICTED')).toEqual(restriction);
      await expectOpen(member);
    });

    it('is not refused by an account restriction request still waiting (owner decision 2026-10-23)', async () => {
      await createApprovalRequest(t.db, {
        kind: 'account_restriction',
        targetType: 'user',
        targetId: member.id,
        requestedBy: admin.id,
      });
      expect(await checkOf(member)).toMatchObject({ refusals: [], restriction: null });
      await closed(member);
    });

    it('refuses an unsettled contract, a payment in progress and an order waiting, in that order', async () => {
      await createPosition(t.db, { userId: member.id, marketId: market.id, outcome: 'NO', qty: 3 });
      await t.db.insert(schema.payments).values({
        userId: member.id,
        amountCoin: 10_000n,
        priceKrw: 9_700,
        provider: 'mock',
        status: 'pending',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      await t.db.insert(schema.orders).values({
        userId: member.id,
        marketId: market.id,
        outcome: 'YES',
        side: 'buy',
        type: 'limit',
        limitPrice: 40,
        qty: 2,
        status: 'open',
        timeInForce: 'gtc',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      expect(await checkOf(member)).toMatchObject({
        refusals: ['unsettled_contracts', 'payment_in_progress', 'pending_orders'],
      });
      expect(errorOf(await close(member), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({
        reason: 'unsettled_contracts',
      });
      await t.db
        .update(schema.positions)
        .set({ settled: true })
        .where(eq(schema.positions.userId, member.id));
      expect(errorOf(await close(member), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({
        reason: 'payment_in_progress',
      });
      await t.db
        .update(schema.payments)
        .set({ status: 'failed' })
        .where(eq(schema.payments.userId, member.id));
      expect(errorOf(await close(member), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({
        reason: 'pending_orders',
      });
      await expectOpen(member);
    });

    it('refuses a refund in progress and a partly filled order, each on its own (decision 7, #178)', async () => {
      await t.db.insert(schema.payments).values({
        userId: member.id,
        amountCoin: 10_000n,
        priceKrw: 9_700,
        provider: 'mock',
        status: 'refunding',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      expect(await checkOf(member)).toMatchObject({ refusals: ['payment_in_progress'] });
      expect(errorOf(await close(member), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({
        reason: 'payment_in_progress',
      });
      await t.db
        .update(schema.payments)
        .set({ status: 'refunded' })
        .where(eq(schema.payments.userId, member.id));
      await t.db.insert(schema.orders).values({
        userId: member.id,
        marketId: market.id,
        outcome: 'NO',
        side: 'buy',
        type: 'limit',
        limitPrice: 60,
        qty: 3,
        filledQty: 1,
        status: 'partially_filled',
        timeInForce: 'gtc',
        idempotencyKey: `closure-${randomUUID()}`,
      });
      expect(await checkOf(member)).toMatchObject({ refusals: ['pending_orders'] });
      expect(errorOf(await close(member), 409, 'CLOSURE_NOT_ALLOWED')).toEqual({
        reason: 'pending_orders',
      });
      await expectOpen(member);
    });
  });

  describe('after the closure', () => {
    it('takes no balance adjustment or admin grant of an operator', async () => {
      await closed(member);
      errorOf(
        await post(
          `/admin/users/${member.id}/balance-adjust`,
          { amountCoin: '100', memo: '보정' },
          admin,
        ),
        409,
        'ACCOUNT_CLOSED',
      );
      expect(await ledgerOf(member.id)).toEqual([]);
      // Not `email_not_verified` (its address is unverified now): the account is closed for good.
      errorOf(
        await post('/admin/admins', { userId: member.id, reason: '운영 인원 추가' }, admin),
        409,
        'ACCOUNT_CLOSED',
      );
      expect((await profileOf(member.id)).role).toBe('user');
      expect(
        await t.db
          .select()
          .from(schema.adminActions)
          .where(eq(schema.adminActions.type, 'admin_grant')),
      ).toEqual([]);
    });

    it('takes no new warning, writing restriction or account restriction request, nor approves one, while a hiding stays open (owner decision 2026-10-23 (2차) 1)', async () => {
      const own = await createPost(t.db, {
        marketId: market.id,
        authorId: member.id,
        text: '탈퇴할 회원의 글',
      });
      await closed(member);
      const actionsOf = () =>
        t.db
          .select({ type: schema.moderationActions.type })
          .from(schema.moderationActions)
          .where(eq(schema.moderationActions.userId, member.id));
      const requestsAbout = () =>
        t.db
          .select({ id: schema.approvalRequests.id })
          .from(schema.approvalRequests)
          .where(eq(schema.approvalRequests.targetId, member.id));
      // Each new action against the closed account, with a subject of theirs or none.
      for (const [url, body] of [
        ['warn', { reason: 'spam', note: null, subject: null }],
        ['warn', { reason: 'spam', note: null, subject: { type: 'post', postId: own.id } }],
        ['writing-restriction', { reason: 'spam', note: null, days: 7, subject: null }],
        [
          'account-restriction',
          { reason: 'multi_account', note: '설명', days: 7, subject: null, memo: null },
        ],
      ] as const) {
        expect(
          errorOf(
            await post(`/admin/moderation/users/${member.id}/${url}`, body, admin),
            409,
            'MODERATION_NOT_ALLOWED',
          ),
          url,
        ).toEqual({ reason: 'closed' });
      }
      expect(await actionsOf()).toEqual([]);
      expect(await requestsAbout()).toEqual([]);

      // A request about the member left waiting past the closure (none is, the closure closes
      // them all — written here by hand) is not approved either, and stays to be rejected.
      const waiting = await createApprovalRequest(t.db, {
        kind: 'account_restriction',
        targetType: 'user',
        targetId: member.id,
        requestedBy: admin.id,
        payload: {
          userId: member.id,
          reason: 'multi_account',
          note: '설명',
          days: 7,
          subject: null,
          memo: null,
        },
      });
      expect(
        errorOf(
          await post(
            `/admin/moderation/account-restriction-requests/${waiting.id}/approve`,
            { reason: '승인' },
            second,
          ),
          409,
          'MODERATION_NOT_ALLOWED',
        ),
      ).toEqual({ reason: 'closed' });
      const [still] = await t.db
        .select({ status: schema.approvalRequests.status })
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, waiting.id));
      expect(still).toEqual({ status: 'pending' });
      expect(await actionsOf()).toEqual([]);
      dataOf(
        await post(
          `/admin/moderation/account-restriction-requests/${waiting.id}/reject`,
          { reason: '탈퇴한 회원' },
          second,
        ),
      );

      // The post stays public, so it is still hidden as any: not a new action against the account.
      dataOf(
        await post(`/admin/moderation/posts/${own.id}/hide`, { reason: 'spam', note: null }, admin),
      );
      expect(await actionsOf()).toEqual([{ type: 'hide' }]);
      // Nickname reset, 소개 and image: nothing to take away, as before.
      for (const url of ['nickname-reset', 'bio-clear', 'image-remove']) {
        expect(
          errorOf(
            await post(
              `/admin/moderation/users/${member.id}/${url}`,
              { reason: 'spam', note: null },
              admin,
            ),
            409,
            'MODERATION_NOT_ALLOWED',
          ),
          url,
        ).toEqual({ reason: 'nothing_to_remove' });
      }
    });

    it('keeps the closed account in the operators’ account list and leaves it out of the open accounts the admin grant searches (owner decision 2026-10-23 (2차) 5)', async () => {
      await closed(member);
      const ids = async (query: string) =>
        dataOf<{ id: string; nickname: string | null }[]>(
          await read(`/admin/users?${query}`, admin),
        ).map((user) => [user.id, user.nickname]);
      // Every account by default: the closed one beside the rest, with no nickname.
      expect(await ids(`q=${encodeURIComponent(`closed_${member.id}`)}`)).toEqual([
        [member.id, null],
      ]);
      const all = await ids('limit=100');
      expect(all).toContainEqual([member.id, null]);
      expect(all.map(([id]) => id)).toContain(other.id);
      // `open`: the grant's search finds no closed account at all, whatever it is searched by.
      expect(await ids(`q=${encodeURIComponent(`closed_${member.id}`)}&status=open`)).toEqual([]);
      const open = await ids('status=open&limit=100');
      expect(open.map(([id]) => id)).not.toContain(member.id);
      expect(open.map(([id]) => id)).toEqual(
        expect.arrayContaining([other.id, admin.id, second.id]),
      );
      // `closed`: only the closed ones.
      expect(await ids('status=closed&limit=100')).toEqual([[member.id, null]]);
      errorOf(await read('/admin/users?status=gone', admin), 400, 'VALIDATION_ERROR');
    });

    it('hands a cancelled nickname reset’s hold to nobody (ADR-0081 결과 5)', async () => {
      await t.db
        .update(schema.profiles)
        .set({ nickname: 'closing_one' })
        .where(eq(schema.profiles.userId, member.id));
      const reset = dataOf<{ id: string }>(
        await post(
          `/admin/moderation/users/${member.id}/nickname-reset`,
          { reason: 'impersonation' },
          admin,
        ),
      );
      await closed(member);
      dataOf(
        await post(`/admin/moderation/actions/${reset.id}/cancel`, { reason: '이의 인정' }, second),
      );
      const [hold] = await t.db
        .select({ userId: schema.nicknameHolds.userId })
        .from(schema.nicknameHolds)
        .where(eq(schema.nicknameHolds.actionId, reset.id));
      expect(hold).toEqual({ userId: null });
      // An operator's reset of a closed account has nothing to take away.
      errorOf(
        await post(
          `/admin/moderation/users/${member.id}/nickname-reset`,
          { reason: 'spam' },
          admin,
        ),
        409,
        'MODERATION_NOT_ALLOWED',
      );
    });

    it('keeps the reports the member filed in processing, and the operators process them', async () => {
      const others = await createPost(t.db, {
        marketId: market.id,
        authorId: other.id,
        text: '글',
      });
      const report = await createReport(t.db, {
        reporterId: member.id,
        reportedUserId: other.id,
        postId: others.id,
      });
      await closed(member);
      dataOf(
        await post(
          '/admin/reports/dismiss',
          { reportIds: [report.id], reason: '위반 아님' },
          admin,
        ),
      );
      const [processed] = await t.db
        .select({ status: schema.reports.status, reporterId: schema.reports.reporterId })
        .from(schema.reports)
        .where(eq(schema.reports.id, report.id));
      expect(processed).toEqual({ status: 'dismissed', reporterId: member.id });
    });

    it('names the closed member in the operators’ report queue without a nickname', async () => {
      const report = await createReport(t.db, { reporterId: other.id, reportedUserId: member.id });
      await closed(member);
      const queue = dataOf<
        { user: { id: string; nickname: string | null }; excerpt: string | null }[]
      >(await read('/admin/reports', admin));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ user: { id: member.id, nickname: null }, excerpt: null });
      expect(report.status).toBe('pending');
    });

    it('takes no watch, search, code send or 본인확인 of a request that passed SessionGuard before the closure committed (migration 0043)', async () => {
      // An account that had a code texted before it closed (the closure is sign-in only).
      const fresh = await signUpTestUser(t);
      await createConsents(t.db, { userId: fresh.id });
      const phones = t.app.get(PhoneVerificationService);
      const phone = '01055556666';
      await phones.requestCode(fresh.id, { realName: '김늦음', phone }, null);
      const code = t.sms.lastCodeTo(phone);
      await closed(fresh);
      await closed(member);
      const texted = t.sms.messages.length;
      const events = await t.db.select().from(schema.marketWatchEvents);
      const codes = await t.db.select().from(schema.phoneVerificationCodes);

      // The services such a request reaches, its session read before the closure's commit: each
      // write refused by the database, answered as the session that ended — as any later request.
      const ended = { code: 'UNAUTHENTICATED' };
      await expect(
        t.app.get(WatchlistService).set(member.id, market.id, true),
      ).rejects.toMatchObject(ended);
      await expect(t.app.get(SearchHistoryService).record(member.id, '금리')).rejects.toMatchObject(
        ended,
      );
      await expect(phones.confirm(fresh.id, code)).rejects.toMatchObject(ended);
      await expect(
        phones.requestCode(member.id, { realName: '김탈퇴', phone: '01077778888' }, null),
      ).rejects.toMatchObject(ended);

      // Nothing was left: no watch or its event, no search, no 본인확인 record, no code or text.
      for (const userId of [member.id, fresh.id]) {
        const { marketWatches, marketSearches, phoneVerifications } = schema;
        expect(
          await t.db.select().from(marketWatches).where(eq(marketWatches.userId, userId)),
        ).toEqual([]);
        expect(
          await t.db.select().from(marketSearches).where(eq(marketSearches.userId, userId)),
        ).toEqual([]);
        expect(
          await t.db.select().from(phoneVerifications).where(eq(phoneVerifications.userId, userId)),
        ).toEqual([]);
      }
      expect(await t.db.select().from(schema.marketWatchEvents)).toEqual(events);
      expect(await t.db.select().from(schema.phoneVerificationCodes)).toEqual(codes);
      expect(t.sms.messages).toHaveLength(texted);
      // So the number stays free: a new account verifies it at once (#57-17).
      const again = await signUpTestUser(t);
      await createConsents(t.db, { userId: again.id });
      await phones.requestCode(again.id, { realName: '김늦음', phone }, null);
      expect(await phones.confirm(again.id, t.sms.lastCodeTo(phone))).toMatchObject({ phone });
    });

    it('refuses a session or a sign-in method for the closed account in the database (migration 0043)', async () => {
      await closed(member);
      await expect(
        t.db.insert(schema.session).values({
          id: randomUUID(),
          token: randomUUID(),
          userId: member.id,
          expiresAt: new Date(Date.now() + DAY_MS),
          updatedAt: new Date(),
        }),
      ).rejects.toThrow();
      await expect(
        t.db.insert(schema.account).values({
          id: randomUUID(),
          issuer: 'local:credential',
          accountId: member.id,
          providerId: 'credential',
          userId: member.id,
          password: 'x:y',
          updatedAt: new Date(),
        }),
      ).rejects.toThrow();
      expect(
        await t.db
          .select()
          .from(schema.session)
          .where(and(eq(schema.session.userId, member.id))),
      ).toEqual([]);
    });
  });
});
