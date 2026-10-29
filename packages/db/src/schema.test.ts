import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_RESTRICTION_REASONS,
  APPROVAL_STATUSES,
  CONSENT_ITEMS,
  COUNTERPARTY_TYPES,
  NICKNAME_HOLD_DAYS,
  NOTICE_PIN_LIMIT,
  LEDGER_ENTRY_TYPES,
  PUBLIC_ID_PATTERN,
  MARKET_STATUSES,
  MODERATION_REASONS,
  PRICE_TICK_TRIGGERS,
  RELEASE_SETTING_STATUSES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  currentConsentVersion,
  nicknameSchema,
  releaseSettingChangeBodySchema,
  releaseSettingChangePayloadSchema,
} from '@buddha/shared';
import { TransactionRollbackError, and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminActions,
  approvalRequests,
  auditFailures,
  balances,
  categories,
  commentLikes,
  consentRecords,
  fills,
  ledgerEntries,
  linkFlags,
  linkUses,
  marketLinks,
  marketSearchTerms,
  marketSearches,
  marketSettlementSteps,
  marketWatchEvents,
  marketWatches,
  markets,
  mediaDeletions,
  mediaObjects,
  moderationActions,
  nicknameHolds,
  noticeImages,
  noticeRevisions,
  notices,
  orders,
  paymentEvents,
  payments,
  phoneVerificationCodes,
  phoneVerificationRefusedSends,
  phoneVerifications,
  positions,
  postCommentCounts,
  postCommentRevisions,
  postComments,
  postImages,
  postLikes,
  postRevisions,
  posts,
  profileInterestCategories,
  profileItemRemovals,
  profiles,
  releaseSettings,
  reports,
  restrictionEndChanges,
  startGrantNumbers,
  startGrants,
  user,
  writeLimitEvents,
} from './schema/index.js';
import { closeDb, createDb } from './client.js';
import { storedReleaseSettingValue } from './release-settings.js';
import {
  completeOnboarding,
  createApprovalRequest,
  createCategory,
  createConsents,
  createMarket,
  createMarketLink,
  createComment,
  createCommentLike,
  createLinkFlag,
  createLinkUse,
  createMedia,
  createModerationAction,
  createNotice,
  createPhoneVerification,
  createPost,
  createPostLike,
  createPosition,
  createProfileImage,
  createReport,
  createSearch,
  createSettlementStep,
  createStartGrant,
  createUser,
  createWatch,
  createWriteLimitEvent,
  randomPhoneHash,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import {
  hasStandingConsent,
  isNicknameHeld,
  lockNicknames,
  missingOnboardingStepsOf,
  newestConsentRowsOf,
  readOnboarding,
} from './onboarding.js';
import { isPhoneVerified } from './phone-verification.js';
import {
  cancelStartGrant,
  payStartGrant,
  pendingStartGrantIds,
  recordStartGrant,
  startGrantHoldsNumber,
} from './start-grants.js';
import { lockAdminRoles } from './tx-helpers.js';

/**
 * Postgres SQLSTATE. drizzle-orm 0.45 wraps driver errors in DrizzleQueryError and keeps the
 * node-postgres error (with `.code`) in `cause`; `db.execute` throws it bare.
 */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint or index a 23505 names (node-postgres `error.constraint`). */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** The Postgres message (a trigger's RAISE), wrapped or bare like `sqlState`. */
function errorMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  return e?.cause?.message ?? e?.message ?? '';
}

describe.skipIf(!hasTestDb())('schema (integration, docker test profile)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('inserting a user row creates profile + balance through the trigger (PLAN 10.4)', async () => {
    await t.db.insert(user).values({ id: 'u-trigger', name: 'x', email: 'trigger@test.local' });
    const profile = await t.db.query.profiles.findFirst({
      where: eq(profiles.userId, 'u-trigger'),
    });
    const balance = await t.db.query.balances.findFirst({
      where: eq(balances.userId, 'u-trigger'),
    });
    // The #14 prefix (ADR-0052); the whole nickname passes the rule users are held to.
    expect(profile?.nickname).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
    expect(nicknameSchema.safeParse(profile?.nickname).success).toBe(true);
    expect(profile?.role).toBe('user');
    // Migration 0031 (#70): creating an account grants nothing — a zero balance and no ledger
    // entry, whatever the sign-up path. The start Coin comes from the start grant.
    expect(balance?.availableCoin).toBe(0n);
    expect(balance?.lockedCoin).toBe(0n);
    expect(
      await t.db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, 'u-trigger')),
    ).toEqual([]);
  });

  it('createUser applies nickname/role/balance and keeps the ledger invariant', async () => {
    const {
      user: u,
      profile,
      balance,
    } = await createUser(t.db, {
      nickname: '팩토리유저',
      role: 'admin',
      balanceCoin: 10_000n,
    });
    expect(profile.userId).toBe(u.id);
    expect(profile.nickname).toBe('팩토리유저');
    expect(profile.role).toBe('admin');
    expect(balance.availableCoin).toBe(10_000n);
    expect(balance.lockedCoin).toBe(0n);
    const [sum] = await t.db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountCoin}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, u.id));
    expect(BigInt(sum!.total)).toBe(10_000n);
  });

  it('round-trips bigint amounts beyond 2^53 exactly', async () => {
    const big = 2n ** 53n + 1n;
    const { user: u } = await createUser(t.db, { balanceCoin: big });
    const row = await t.db.query.balances.findFirst({ where: eq(balances.userId, u.id) });
    expect(row?.availableCoin).toBe(big);
  });

  it('rejects negative balances via CHECK', async () => {
    const { user: u } = await createUser(t.db);
    await expect(
      t.db.update(balances).set({ availableCoin: -1n }).where(eq(balances.userId, u.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('enforces unique nicknames, ignoring case (migration 0032, #57-6)', async () => {
    await createUser(t.db, { nickname: '중복닉' });
    await expect(createUser(t.db, { nickname: '중복닉' })).rejects.toSatisfy(
      (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'profiles_nickname_lower_unique',
    );
    await createUser(t.db, { nickname: 'Trader_Kim' });
    for (const variant of ['trader_kim', 'TRADER_KIM', 'Trader_Kim']) {
      await expect(createUser(t.db, { nickname: variant })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'profiles_nickname_lower_unique',
      );
    }
    // The exact-case constraint it replaced is gone.
    const { rows } = await t.db.execute<{ name: string }>(sql`
      SELECT conname AS name FROM pg_constraint WHERE conname = 'profiles_nickname_unique'`);
    expect(rows).toEqual([]);
  });

  describe('the onboarding (migration 0032, #58)', () => {
    /** Runs `body` in a transaction that is rolled back, so a seeded random() replays. */
    async function rolledBack<T>(
      body: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<T>,
    ) {
      let result: T | undefined;
      await t.db
        .transaction(async (tx) => {
          result = await body(tx);
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      return result as T;
    }

    /** The auto nickname a new account gets with random() seeded so, plus a hold set up first. */
    async function autoNickname(seed: number, hold?: typeof nicknameHolds.$inferInsert) {
      return rolledBack(async (tx) => {
        if (hold) await tx.insert(nicknameHolds).values(hold);
        await tx.execute(sql`SELECT setseed(${seed})`);
        const id = randomUUID();
        await tx.insert(user).values({ id, name: 'x', email: `${id}@test.local` });
        const [row] = await tx
          .select({ nickname: profiles.nickname })
          .from(profiles)
          .where(eq(profiles.userId, id));
        return row!.nickname;
      });
    }

    it('gives no other account a nickname held less than 30 days, the auto one included', async () => {
      const seed = 0.4242;
      const first = await autoNickname(seed);
      // The same seed draws the same first candidate: replayed, it is the nickname again.
      expect(await autoNickname(seed)).toBe(first);
      const { user: other } = await createUser(t.db);
      const day = 24 * 60 * 60 * 1_000;
      // Held by another account (in any case) or by a withdrawn one: the generator draws again.
      for (const hold of [
        { nickname: first, userId: other.id, releasedAt: new Date(Date.now() - day) },
        { nickname: first.toLowerCase(), userId: other.id },
        { nickname: first, userId: null },
      ]) {
        const next = await autoNickname(seed, hold);
        expect(next).not.toBe(first);
        expect(next).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
      }
      // A hold past its 30 days holds nothing.
      expect(NICKNAME_HOLD_DAYS).toBe(30);
      expect(
        await autoNickname(seed, {
          nickname: first,
          userId: other.id,
          releasedAt: new Date(Date.now() - (NICKNAME_HOLD_DAYS * day + 60_000)),
        }),
      ).toBe(first);
    });

    it('holds a nickname from other accounts only, ignoring case, for 30 days', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const day = 24 * 60 * 60 * 1_000;
      await t.db.insert(nicknameHolds).values([
        { nickname: 'Released_A', userId: a.id, releasedAt: new Date(Date.now() - 29 * day) },
        { nickname: 'old_one', userId: a.id, releasedAt: new Date(Date.now() - 31 * day) },
        { nickname: 'withdrawn', userId: null },
      ]);
      const held = (nickname: string, userId: string) =>
        t.db.transaction((tx) => isNicknameHeld(tx, nickname, userId));
      expect(await held('Released_A', b.id)).toBe(true);
      expect(await held('released_a', b.id)).toBe(true);
      // The account that gave it up may take it back.
      expect(await held('released_a', a.id)).toBe(false);
      expect(await held('old_one', b.id)).toBe(false);
      expect(await held('withdrawn', a.id)).toBe(true);
      expect(await held('never_used', b.id)).toBe(false);
    });

    it('locks a nickname ignoring case until the transaction ends', async () => {
      // pg_try_advisory_xact_lock on the key lock_nickname() takes: false while another holds it.
      const tryLock = (nickname: string) =>
        t.db.transaction(async (tx) => {
          const result = await tx.execute<{ locked: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(hashtext('buddha:nickname'), hashtext(lower(${nickname}))) AS locked`,
          );
          return result.rows[0]!.locked;
        });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = t.db.transaction(async (tx) => {
        await lockNicknames(tx, ['Foo_Bar', 'zeta', 'FOO_BAR']);
        locked();
        await released;
      });
      await lockTaken;
      expect(await tryLock('foo_bar')).toBe(false);
      expect(await tryLock('ZETA')).toBe(false);
      expect(await tryLock('other')).toBe(true);
      release();
      await holder;
      expect(await tryLock('foo_bar')).toBe(true);
    });

    it('makes the auto nickname’s generator wait on the lock of each candidate it draws', async () => {
      // The candidate a seeded sign-up draws first (replayed: the same seed draws it again).
      const seed = 0.1717;
      const first = await autoNickname(seed);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // Whoever gives `first` up holds its lock until the hold it writes commits (a change).
      const holder = t.db.transaction(async (tx) => {
        await lockNicknames(tx, [first.toLowerCase()]);
        locked();
        await released;
      });
      await lockTaken;
      const id = randomUUID();
      const signUp = t.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT setseed(${seed})`);
        await tx.insert(user).values({ id, name: 'x', email: `${id}@test.local` });
      });
      // The sign-up is parked on that lock (its trigger's `lock_nickname(candidate)`), not past it.
      const started = Date.now();
      for (;;) {
        const { rows } = await t.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock' AND wait_event = 'advisory'`);
        if ((rows[0]?.n ?? 0) > 0) break;
        if (Date.now() - started > 5_000) throw new Error('the sign-up never waited on the lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(
        await t.db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, id)),
      ).toEqual([]);
      release();
      await holder;
      await signUp;
      const [profile] = await t.db
        .select({ nickname: profiles.nickname })
        .from(profiles)
        .where(eq(profiles.userId, id));
      expect(profile?.nickname).toBe(first);
    });

    it('keeps consent records append-only, of the listed items, with their address and browser', async () => {
      const { user: u } = await createUser(t.db);
      const rows = await createConsents(t.db, {
        userId: u.id,
        marketing: true,
        clientIp: '2001:DB8::1',
        userAgent: 'Mozilla/5.0',
      });
      expect(rows.map((row) => [row.item, row.agreed])).toEqual(
        CONSENT_ITEMS.map((item) => [item, true]),
      );
      expect(rows[0]).toMatchObject({ clientIp: '2001:db8::1', userAgent: 'Mozilla/5.0' });
      await expect(
        t.db
          .update(consentRecords)
          .set({ agreed: false })
          .where(eq(consentRecords.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db
          .insert(consentRecords)
          .values({ userId: u.id, item: 'refund', version: 'v', agreed: true }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'consent_records_item_check',
      );
      // Kept past the account (restrict): a withdrawal keeps the user row (#140).
      await expect(t.db.delete(user).where(eq(user.id, u.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      // DELETE stays for the retention work (#184).
      await t.db.delete(consentRecords).where(eq(consentRecords.userId, u.id));
      expect(await t.db.select().from(consentRecords)).toEqual([]);
    });

    it('keeps one pick per category and account, gone with the category or the account', async () => {
      const { user: u } = await createUser(t.db);
      const parent = await createCategory(t.db, { slug: 'interest-parent', nameKo: '상위' });
      const child = await createCategory(t.db, {
        slug: 'interest-child',
        nameKo: '하위',
        parentId: parent.id,
      });
      await t.db.insert(profileInterestCategories).values([
        { userId: u.id, categoryId: parent.id },
        { userId: u.id, categoryId: child.id },
      ]);
      await expect(
        t.db.insert(profileInterestCategories).values({ userId: u.id, categoryId: child.id }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await t.db.delete(categories).where(eq(categories.id, child.id));
      expect(
        (await t.db.select().from(profileInterestCategories)).map((row) => row.categoryId),
      ).toEqual([parent.id]);
    });

    it('reads one newest row per item, however often an answer was changed', async () => {
      const { user: u } = await createUser(t.db);
      const { user: other } = await createUser(t.db);
      expect(await newestConsentRowsOf(t.db, u.id)).toEqual([]);
      await createConsents(t.db, { userId: u.id, versions: { terms: 'draft-1999-01-01' } });
      await createConsents(t.db, { userId: other.id, marketing: true });
      // The optional answer flipped many times over, then the terms agreed at the current version.
      await t.db.insert(consentRecords).values(
        Array.from({ length: 40 }, (_, index) => ({
          userId: u.id,
          item: 'marketing',
          version: currentConsentVersion('marketing'),
          agreed: index % 2 === 0,
        })),
      );
      await t.db.insert(consentRecords).values({
        userId: u.id,
        item: 'terms',
        version: currentConsentVersion('terms'),
        agreed: true,
      });
      const rows = await newestConsentRowsOf(t.db, u.id);
      // One row per item, oldest first — the account's own, the last of each.
      expect(rows.map((row) => [row.item, row.version, row.agreed])).toEqual([
        ['privacy', currentConsentVersion('privacy'), true],
        ['age', currentConsentVersion('age'), true],
        ['marketing', currentConsentVersion('marketing'), false],
        ['terms', currentConsentVersion('terms'), true],
      ]);
      expect(await hasStandingConsent(t.db, u.id)).toBe(true);
      expect((await readOnboarding(t.db, u.id))?.consents.map((c) => [c.item, c.agreed])).toEqual([
        ['terms', true],
        ['privacy', true],
        ['age', true],
        ['marketing', false],
      ]);
      // Each item is one lookup on the index, from the end of the account's entries of it (a table
      // this small would be scanned whole, so the planner is told not to).
      const plan = await t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN SELECT id FROM consent_records WHERE user_id = ${u.id} AND item = 'terms' ORDER BY id DESC LIMIT 1`,
        );
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan).toMatch(/Index (Only )?Scan Backward using consent_records_user_id_item_id_idx/);
      expect(plan).not.toMatch(/Sort/);
    });

    it('reads the onboarding: consent, 본인확인, nickname and interests, in order', async () => {
      const { user: u } = await createUser(t.db);
      expect(await readOnboarding(t.db, 'nobody')).toBeNull();
      expect(await missingOnboardingStepsOf(t.db, 'nobody')).toEqual([
        'consent',
        'verification',
        'nickname',
      ]);
      expect(await readOnboarding(t.db, u.id)).toEqual({
        progress: { consent: false, verification: false, nickname: false, interests: false },
        consents: [],
      });
      expect(await hasStandingConsent(t.db, u.id)).toBe(false);
      // An answer from before a revision that asked again does not stand (an unknown version).
      await createConsents(t.db, { userId: u.id, versions: { terms: 'draft-1999-01-01' } });
      expect(await hasStandingConsent(t.db, u.id)).toBe(false);
      expect(await missingOnboardingStepsOf(t.db, u.id)).toEqual([
        'consent',
        'verification',
        'nickname',
      ]);
      await createConsents(t.db, { userId: u.id, marketing: true });
      expect(await hasStandingConsent(t.db, u.id)).toBe(true);
      const read = await readOnboarding(t.db, u.id);
      // The newest answer to each item, in CONSENT_ITEMS order.
      expect(read?.consents.map((c) => [c.item, c.agreed])).toEqual([
        ['terms', true],
        ['privacy', true],
        ['age', true],
        ['marketing', true],
      ]);
      expect(await missingOnboardingStepsOf(t.db, u.id)).toEqual(['verification', 'nickname']);
      await completeOnboarding(t.db, { userId: u.id });
      expect(await missingOnboardingStepsOf(t.db, u.id)).toEqual([]);
      expect((await readOnboarding(t.db, u.id))?.progress).toEqual({
        consent: true,
        verification: true,
        nickname: true,
        interests: false,
      });
    });
  });

  it('createMarket writes a market with no price before its first fill, and relations resolve', async () => {
    const category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const market = await createMarket(t.db, { categoryId: category.id });
    expect(market.status).toBe('open');
    // N02 §5: no fill, no price — the direct AMM's initial probability is gone (#125).
    expect(market.lastPrice).toBeNull();
    expect(market.volumeCoin).toBe(0n);
    expect(market.tradeCount).toBe(0);
    expect(market).not.toHaveProperty('qYes');
    expect(market).not.toHaveProperty('mechanism');
    const withCategory = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { category: true, creator: { with: { profile: true } } },
    });
    expect(withCategory?.category.slug).toBe('economy');
    expect(withCategory?.creator.profile?.role).toBe('admin');
  });

  it('a watch and its event resolve their account and market, and both resolve them back (#89)', async () => {
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    await createWatch(t.db, { userId: u.id, marketId: market.id });
    const watch = await t.db.query.marketWatches.findFirst({
      where: eq(marketWatches.userId, u.id),
      with: { user: true, market: true },
    });
    expect(watch).toMatchObject({ user: { id: u.id }, market: { id: market.id } });
    const event = await t.db.query.marketWatchEvents.findFirst({
      where: eq(marketWatchEvents.userId, u.id),
      with: { user: true, market: true },
    });
    expect(event).toMatchObject({ action: 'watch', user: { id: u.id }, market: { id: market.id } });
    // The alerts (#54) and the measures (#151) read them from the market and from the account.
    const watchedMarket = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { watches: true, watchEvents: true },
    });
    expect(watchedMarket?.watches.map((row) => row.userId)).toEqual([u.id]);
    expect(watchedMarket?.watchEvents.map((row) => row.action)).toEqual(['watch']);
    const watcher = await t.db.query.user.findFirst({
      where: eq(user.id, u.id),
      with: { watches: true, watchEvents: true },
    });
    expect(watcher?.watches.map((row) => row.marketId)).toEqual([market.id]);
    expect(watcher?.watchEvents.map((row) => row.marketId)).toEqual([market.id]);
  });

  it('keeps a link once per unordered pair, never a market with itself, and reads it from both ends (#65)', async () => {
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    const [a, b] = [await createMarket(t.db), await createMarket(t.db)];
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    // Linked from the larger end, stored smaller first (`relatedMarketPair`): the CHECK and the
    // shared function agree on the order of two uuids.
    const link = await createMarketLink(t.db, {
      marketId: high.id,
      relatedMarketId: low.id,
      createdBy: admin,
    });
    expect(link).toMatchObject({ lowMarketId: low.id, highMarketId: high.id, createdBy: admin });
    // The same pair again — in either order — is the primary key's, and the reversed row is the
    // CHECK's: a pair cannot be written twice by spelling it the other way round.
    const insert = (lowMarketId: string, highMarketId: string) =>
      t.db.insert(marketLinks).values({ lowMarketId, highMarketId, createdBy: admin });
    const duplicate = await insert(low.id, high.id).catch((error: unknown) => error);
    expect(sqlState(duplicate)).toBe('23505');
    expect(sqlConstraint(duplicate)).toBe('market_links_low_market_id_high_market_id_pk');
    const reversed = await insert(high.id, low.id).catch((error: unknown) => error);
    expect(sqlState(reversed)).toBe('23514');
    expect(sqlConstraint(reversed)).toBe('market_links_order_check');
    const itself = await insert(a.id, a.id).catch((error: unknown) => error);
    expect(sqlConstraint(itself)).toBe('market_links_order_check');
    // A market's links are the rows where it is either end.
    const fromLow = await t.db.query.markets.findFirst({
      where: eq(markets.id, low.id),
      with: { linksAsLow: { with: { highMarket: true, creator: true } }, linksAsHigh: true },
    });
    expect(fromLow?.linksAsLow.map((row) => row.highMarket.id)).toEqual([high.id]);
    expect(fromLow?.linksAsLow[0]?.creator.id).toBe(admin);
    expect(fromLow?.linksAsHigh).toEqual([]);
    const fromHigh = await t.db.query.markets.findFirst({
      where: eq(markets.id, high.id),
      with: { linksAsHigh: { with: { lowMarket: true } } },
    });
    expect(fromHigh?.linksAsHigh.map((row) => row.lowMarket.id)).toEqual([low.id]);
    // Unlinking deletes the row: buddha_app keeps DELETE here (the history is admin_actions).
    const deleted = await t.db
      .delete(marketLinks)
      .where(eq(marketLinks.lowMarketId, low.id))
      .returning();
    expect(deleted).toHaveLength(1);
  });

  it('a recorded search resolves its account and back, and holds a term of 100 at most (#15)', async () => {
    const { user: u } = await createUser(t.db);
    const row = await createSearch(t.db, { userId: u.id, query: '금리' });
    const search = await t.db.query.marketSearches.findFirst({
      where: eq(marketSearches.id, row.id),
      with: { user: true },
    });
    expect(search).toMatchObject({ query: '금리', user: { id: u.id } });
    const searcher = await t.db.query.user.findFirst({
      where: eq(user.id, u.id),
      with: { searches: true },
    });
    expect(searcher?.searches.map((entry) => entry.query)).toEqual(['금리']);
    // The column is the API's bound (MARKET_SEARCH_TERM_MAX), in characters: a hundred Hangul
    // syllables fit, one more does not (22001).
    await createSearch(t.db, { userId: u.id, query: '가'.repeat(100) });
    await expect(createSearch(t.db, { userId: u.id, query: '가'.repeat(101) })).rejects.toSatisfy(
      (e) => sqlState(e) === '22001',
    );
  });

  it('keeps each term of an account at its newest search, through any insert or delete (#15, migration 0026)', async () => {
    const { user: u } = await createUser(t.db);
    const { user: other } = await createUser(t.db);
    const base = Date.now() - 60_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    type Term = { userId: string; query: string; searchId: string; searchedAt: Date };
    /** By account, then term, in JS: the expectations below are written in the same order. */
    const sorted = (rows: Term[]) =>
      rows.sort((a, b) => (`${a.userId}\u0000${a.query}` < `${b.userId}\u0000${b.query}` ? -1 : 1));
    const terms = async () =>
      sorted(
        await t.db
          .select({
            userId: marketSearchTerms.userId,
            query: marketSearchTerms.query,
            searchId: marketSearchTerms.searchId,
            searchedAt: marketSearchTerms.searchedAt,
          })
          .from(marketSearchTerms),
      );
    const term = (row: { userId: string; query: string; id: string; searchedAt: Date }): Term => ({
      userId: row.userId,
      query: row.query,
      searchId: row.id,
      searchedAt: row.searchedAt,
    });

    // Inserted out of order, as only a factory or a script would: the newest search wins, by its
    // time and then by its id within one millisecond, whichever was written last.
    const middle = await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(2) });
    await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(1) });
    expect(await terms()).toEqual([term(middle)]);
    // One millisecond, one term twice: the larger id wins. The ids are given, so one tie has its
    // larger id written first (환율) and the other second (물가) — 'the first write stays' and
    // 'the last write wins' each fail one of them, where random ids left it to a coin flip.
    const ids = () => [randomUUID(), randomUUID()].sort() as [string, string];
    const [fxLow, fxHigh] = ids();
    const fx = await createSearch(t.db, {
      id: fxHigh,
      userId: u.id,
      query: '환율',
      searchedAt: at(3),
    });
    await createSearch(t.db, { id: fxLow, userId: u.id, query: '환율', searchedAt: at(3) });
    const [cpiLow, cpiHigh] = ids();
    await createSearch(t.db, { id: cpiLow, userId: u.id, query: '물가', searchedAt: at(3) });
    const cpi = await createSearch(t.db, {
      id: cpiHigh,
      userId: u.id,
      query: '물가',
      searchedAt: at(3),
    });
    const newest = await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(4) });
    const theirs = await createSearch(t.db, { userId: other.id, query: '금리', searchedAt: at(5) });
    expect(await terms()).toEqual(sorted([term(newest), term(fx), term(cpi), term(theirs)]));

    // Deleting a term's newest search alone (no route does) points the term at the newest left.
    await t.db.delete(marketSearches).where(eq(marketSearches.id, newest.id));
    expect(await terms()).toEqual(sorted([term(middle), term(fx), term(cpi), term(theirs)]));
    // And when the newest left share a millisecond, at the larger id of them: a newer search of
    // 환율 and of 물가, deleted in one statement, hands each term back to its tie's larger id —
    // written first for 환율 and second for 물가, so neither the smaller id nor the order the
    // rows were written in can pass.
    const later = [
      await createSearch(t.db, { userId: u.id, query: '환율', searchedAt: at(6) }),
      await createSearch(t.db, { userId: u.id, query: '물가', searchedAt: at(6) }),
    ];
    expect(await terms()).toEqual(sorted([term(middle), ...later.map(term), term(theirs)]));
    await t.db.delete(marketSearches).where(
      inArray(
        marketSearches.id,
        later.map((row) => row.id),
      ),
    );
    expect(await terms()).toEqual(sorted([term(middle), term(fx), term(cpi), term(theirs)]));
    // Deleting every search of a term, as the delete route does, takes the term away — and only
    // that account's: the other account's search of the same term stays, and so does its term.
    await t.db
      .delete(marketSearches)
      .where(and(eq(marketSearches.userId, u.id), eq(marketSearches.query, '금리')));
    expect(await terms()).toEqual(sorted([term(fx), term(cpi), term(theirs)]));
    // A recorded search is never changed in place (migration 0026 revoked UPDATE).
    await expect(
      t.db.update(marketSearches).set({ query: '유가' }).where(eq(marketSearches.id, fx.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    // Clearing an account's searches, as the clear route does, takes all its terms away.
    await t.db.delete(marketSearches).where(eq(marketSearches.userId, u.id));
    expect(await terms()).toEqual([term(theirs)]);
  });

  describe('posts and their images (migration 0033, #46)', () => {
    it('gives every profile a public id of its own, of the public shape, kept apart from the account id', async () => {
      const accounts = await Promise.all(Array.from({ length: 20 }, () => createUser(t.db)));
      const ids = accounts.map(({ profile }) => profile.publicId);
      for (const id of ids) expect(id).toMatch(PUBLIC_ID_PATTERN);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(accounts[0]!.user.id);
      await expect(
        t.db
          .update(profiles)
          .set({ publicId: ids[1]! })
          .where(eq(profiles.userId, accounts[0]!.user.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'profiles_public_id_unique',
      );
      for (const bad of ['ABCDEFGH23', 'abcdefgh10', 'short']) {
        await expect(
          t.db
            .update(profiles)
            .set({ publicId: bad })
            .where(eq(profiles.userId, accounts[0]!.user.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'profiles_public_id_check',
        );
      }
    });

    it('stores a post with its text and images derived, and searches title and text together', async () => {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db, { status: 'closed' });
      const media = await createMedia(t.db, { ownerId: author.id });
      const post = await createPost(t.db, {
        marketId: market.id,
        authorId: author.id,
        title: '금리 전망',
        text: '첫 줄\n둘째 줄',
        imageIds: [media.id],
      });
      expect(post).toMatchObject({
        title: '금리 전망',
        bodyText: '첫 줄\n둘째 줄',
        imageIds: [media.id],
        searchText: '금리 전망\n첫 줄\n둘째 줄',
        editedAt: null,
        deletedAt: null,
        hiddenAt: null,
      });
      // Attached as the API attaches: the post's image row and the upload's time.
      expect(await t.db.select().from(postImages)).toEqual([
        { postId: post.id, mediaId: media.id, createdAt: expect.any(Date) as unknown },
      ]);
      const [attached] = await t.db.select().from(mediaObjects);
      expect(attached?.attachedAt).toBeInstanceOf(Date);
      // The search reads the generated column, case-insensitively, through the trigram index.
      const found = await t.db
        .select({ id: posts.id })
        .from(posts)
        .where(sql`${posts.searchText} ILIKE ${'%전망\n첫%'}`);
      expect(found).toEqual([{ id: post.id }]);
      const [index] = (
        await t.db.execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'posts_search_text_trgm_idx'`,
        )
      ).rows;
      expect(index?.indexdef).toContain('gin_trgm_ops');
      // The relations resolve both ways.
      const withAll = await t.db.query.posts.findFirst({
        where: eq(posts.id, post.id),
        with: {
          market: true,
          author: { with: { profile: true } },
          images: { with: { media: true } },
        },
      });
      expect(withAll?.market.id).toBe(market.id);
      expect(withAll?.author.profile?.publicId).toMatch(PUBLIC_ID_PATTERN);
      expect(withAll?.images.map((image) => image.media.id)).toEqual([media.id]);
    });

    it('refuses a blank title, a second post for one image and the removal of a post’s market or author', async () => {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db);
      await expect(
        createPost(t.db, { marketId: market.id, authorId: author.id, title: '   ' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'posts_title_check',
      );
      const media = await createMedia(t.db, { ownerId: author.id });
      await createPost(t.db, { marketId: market.id, authorId: author.id, imageIds: [media.id] });
      await expect(
        createPost(t.db, { marketId: market.id, authorId: author.id, imageIds: [media.id] }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'post_images_media_id_unique',
      );
      await expect(t.db.delete(user).where(eq(user.id, author.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      await expect(t.db.delete(markets).where(eq(markets.id, market.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
    });

    it('keeps an edit’s history append-only, deletable later by the retention work', async () => {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
      const [revision] = await t.db
        .insert(postRevisions)
        .values({
          postId: post.id,
          title: null,
          body: post.body,
          bodyText: post.bodyText,
          imageIds: [],
          writtenAt: post.createdAt,
        })
        .returning();
      await expect(
        t.db
          .update(postRevisions)
          .set({ bodyText: 'rewritten' })
          .where(eq(postRevisions.id, revision!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await t.db.delete(postRevisions).where(eq(postRevisions.id, revision!.id));
      expect(await t.db.select().from(postRevisions)).toEqual([]);
    });

    it('takes an upload of the listed kinds and types only, with a size', async () => {
      const { user: owner } = await createUser(t.db);
      const base = {
        ownerId: owner.id,
        kind: 'post_image',
        storageKey: 'post-images/x.png',
        contentType: 'image/png',
        byteSize: 1,
        width: 1,
        height: 1,
      };
      for (const [values, constraint] of [
        [{ kind: 'avatar' }, 'media_objects_kind_check'],
        [{ contentType: 'image/svg+xml' }, 'media_objects_content_type_check'],
        [{ byteSize: 0 }, 'media_objects_size_check'],
        [{ width: 0 }, 'media_objects_size_check'],
      ] as const) {
        await expect(t.db.insert(mediaObjects).values({ ...base, ...values })).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === constraint,
        );
      }
      await t.db.insert(mediaObjects).values(base);
      await expect(t.db.insert(mediaObjects).values(base)).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'media_objects_storage_key_unique',
      );
    });

    it('queues an object key for removal once, never with a negative count (media_deletions)', async () => {
      const [queued] = await t.db
        .insert(mediaDeletions)
        .values({ storageKey: 'post-images/x.png' })
        .returning();
      // Queued now, due now, refused by nothing yet.
      expect(queued).toMatchObject({ attempts: 0, lastError: null });
      expect(queued!.nextAttemptAt.getTime()).toBe(queued!.queuedAt.getTime());
      await expect(
        t.db.insert(mediaDeletions).values({ storageKey: 'post-images/x.png' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await expect(
        t.db.insert(mediaDeletions).values({ storageKey: 'post-images/y.png', attempts: -1 }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'media_deletions_attempts_check',
      );
    });
  });

  describe('comments under a post (migration 0034, #48)', () => {
    /** A post on an open market by a new account, and that account. */
    async function postFixture() {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
      return { author, market, post };
    }

    it('stores a 댓글 and a 대댓글 under it, the relations both ways', async () => {
      const { author, post } = await postFixture();
      const comment = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        body: '첫 줄\n둘째 줄',
      });
      const reply = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        parentId: comment.id,
      });
      expect(comment).toMatchObject({
        parentId: null,
        body: '첫 줄\n둘째 줄',
        editedAt: null,
        deletedAt: null,
        hiddenAt: null,
        isReply: false,
        parentIsReply: null,
      });
      expect(reply).toMatchObject({
        parentId: comment.id,
        parentCreatedAt: comment.createdAt,
        isReply: true,
        parentIsReply: false,
      });
      expect(comment.parentCreatedAt).toBeNull();
      const withAll = await t.db.query.postComments.findFirst({
        where: eq(postComments.id, comment.id),
        with: { post: true, author: true, replies: true },
      });
      expect(withAll?.post.id).toBe(post.id);
      expect(withAll?.author.id).toBe(author.id);
      expect(withAll?.replies.map((row) => row.id)).toEqual([reply.id]);
      const withParent = await t.db.query.postComments.findFirst({
        where: eq(postComments.id, reply.id),
        with: { parent: true },
      });
      expect(withParent?.parent?.id).toBe(comment.id);
      const postWith = await t.db.query.posts.findFirst({
        where: eq(posts.id, post.id),
        with: { comments: true },
      });
      expect(postWith?.comments.map((row) => row.id).sort()).toEqual([comment.id, reply.id].sort());
    });

    it('holds two layers whoever writes: a 대댓글’s parent is a 댓글 of the same post (#45-2)', async () => {
      const { author, market, post } = await postFixture();
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      const reply = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        parentId: comment.id,
      });
      const parentRefused = (e: unknown) =>
        sqlState(e) === '23503' && sqlConstraint(e) === 'post_comments_parent_fk';
      // A reply to a 대댓글.
      await expect(
        createComment(t.db, { postId: post.id, authorId: author.id, parentId: reply.id }),
      ).rejects.toSatisfy(parentRefused);
      // A reply under a 댓글 of another post.
      const other = await createPost(t.db, { marketId: market.id, authorId: author.id });
      await expect(
        createComment(t.db, { postId: other.id, authorId: author.id, parentId: comment.id }),
      ).rejects.toSatisfy(parentRefused);
      // A parent that does not exist, and a comment its own parent.
      await expect(
        createComment(t.db, {
          postId: post.id,
          authorId: author.id,
          parentId: randomUUID(),
          parentCreatedAt: comment.createdAt,
        }),
      ).rejects.toSatisfy(parentRefused);
      await expect(
        t.db
          .update(postComments)
          .set({ parentId: comment.id, parentCreatedAt: comment.createdAt })
          .where(eq(postComments.id, comment.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23503');
      // A 댓글 with a 대댓글 cannot become a 대댓글 itself, nor move to another post.
      const second = await createComment(t.db, { postId: post.id, authorId: author.id });
      await expect(
        t.db
          .update(postComments)
          .set({ parentId: second.id, parentCreatedAt: second.createdAt })
          .where(eq(postComments.id, comment.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23503');
      await expect(
        t.db.update(postComments).set({ postId: other.id }).where(eq(postComments.id, comment.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23503');
      // A 대댓글 carries its 댓글's time, exactly (the comment page walks the 대댓글 in their 댓글's
      // order by it, ADR-0074 decision 2): another time, none at all, and a 댓글 with one are
      // refused; the 댓글's own time cannot move from under its 대댓글.
      const off = new Date(comment.createdAt.getTime() + 1);
      await expect(
        createComment(t.db, {
          postId: post.id,
          authorId: author.id,
          parentId: comment.id,
          parentCreatedAt: off,
        }),
      ).rejects.toSatisfy(parentRefused);
      const timeMissing = (e: unknown) =>
        sqlState(e) === '23514' && sqlConstraint(e) === 'post_comments_parent_created_at_check';
      await expect(
        t.db.execute(
          sql`INSERT INTO post_comments (post_id, parent_id, author_id, body) VALUES (${post.id}, ${comment.id}, ${author.id}, 'x')`,
        ),
      ).rejects.toSatisfy(timeMissing);
      await expect(
        t.db
          .update(postComments)
          .set({ parentCreatedAt: null })
          .where(eq(postComments.id, reply.id)),
      ).rejects.toSatisfy(timeMissing);
      await expect(
        t.db
          .update(postComments)
          .set({ parentCreatedAt: second.createdAt })
          .where(eq(postComments.id, second.id)),
      ).rejects.toSatisfy(timeMissing);
      await expect(
        t.db.update(postComments).set({ createdAt: off }).where(eq(postComments.id, comment.id)),
      ).rejects.toSatisfy(parentRefused);
      // The generated keys are the database's: nobody writes them.
      await expect(
        t.db.execute(
          sql`INSERT INTO post_comments (post_id, author_id, body, is_reply) VALUES (${post.id}, ${author.id}, 'x', true)`,
        ),
      ).rejects.toSatisfy((e) => sqlState(e) === '428C9');
      expect(
        (await t.db.select({ id: postComments.id }).from(postComments)).map((row) => row.id).sort(),
      ).toEqual([comment.id, reply.id, second.id].sort());
    });

    it('refuses a blank body, a body over 1,000 characters and the removal of a comment’s post or author', async () => {
      const { author, post } = await postFixture();
      await expect(
        createComment(t.db, { postId: post.id, authorId: author.id, body: '   ' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'post_comments_body_check',
      );
      // 1,000 code points fit (an emoji is one, as `codePointLength` counts it); one more does not.
      await createComment(t.db, { postId: post.id, authorId: author.id, body: '😀'.repeat(1_000) });
      await expect(
        createComment(t.db, { postId: post.id, authorId: author.id, body: '가'.repeat(1_001) }),
      ).rejects.toSatisfy((e) => sqlState(e) === '22001');
      await expect(t.db.delete(posts).where(eq(posts.id, post.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      await expect(t.db.delete(user).where(eq(user.id, author.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
    });

    it('keeps an edit’s history append-only, deletable later by the retention work', async () => {
      const { author, post } = await postFixture();
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      const [revision] = await t.db
        .insert(postCommentRevisions)
        .values({ commentId: comment.id, body: comment.body, writtenAt: comment.createdAt })
        .returning();
      await expect(
        t.db
          .update(postCommentRevisions)
          .set({ body: 'rewritten' })
          .where(eq(postCommentRevisions.id, revision!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await t.db.delete(postCommentRevisions).where(eq(postCommentRevisions.id, revision!.id));
      expect(await t.db.select().from(postCommentRevisions)).toEqual([]);
    });

    it('pages from indexes that hold no deleted comment (Codex review on PR #220)', async () => {
      // The comment page and '답글 더 보기' walk these three (ADR-0074 decision 2 and 7-31): a
      // deleted 댓글 or 대댓글 is in none of them, so no history of written and deleted comments is
      // walked. This pins each index's predicate; that the statements read them, by their leading
      // columns, is comments.controller.test.ts's (rows read and pages touched, ADR-0074 decision 8).
      const { rows } = await t.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'post_comments' ORDER BY indexname`,
      );
      const defs = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
      expect(defs['post_comments_live_post_id_created_at_id_idx']).toContain(
        '(post_id, created_at, id) WHERE ((parent_id IS NULL) AND (deleted_at IS NULL))',
      );
      expect(defs['post_comments_live_post_id_parent_created_at_parent_id_idx']).toContain(
        '(post_id, parent_created_at, parent_id) WHERE ((parent_id IS NOT NULL) AND (deleted_at IS NULL))',
      );
      expect(defs['post_comments_live_parent_id_created_at_id_idx']).toContain(
        '(parent_id, created_at, id) WHERE ((parent_id IS NOT NULL) AND (deleted_at IS NULL))',
      );
      // No index of a post's or a thread's comments holds the deleted ones besides the key of the
      // parent's foreign key (whose leading post_id serves the operators' read of every comment).
      expect(Object.keys(defs).sort()).toEqual([
        'post_comments_author_id_created_at_idx',
        'post_comments_live_parent_id_created_at_id_idx',
        'post_comments_live_post_id_created_at_id_idx',
        'post_comments_live_post_id_parent_created_at_parent_id_idx',
        'post_comments_pkey',
        'post_comments_post_id_id_created_at_is_reply_unique',
      ]);
    });

    /**
     * Every post's kept count (`post_comment_counts`, 0 with no row) checked against its comments
     * counted afresh — neither deleted nor hidden, 댓글 and 대댓글 alike (ADR-0074 7-9) — and the
     * kept count of `postId`.
     */
    async function kept(postId: string): Promise<number> {
      const { rows } = await t.db.execute<{ id: string; kept: number; counted: number }>(sql`
        SELECT p.id, COALESCE(c.count, 0) AS kept,
               (SELECT count(*)::int FROM post_comments AS pc
                 WHERE pc.post_id = p.id AND pc.deleted_at IS NULL AND pc.hidden_at IS NULL) AS counted
        FROM posts AS p LEFT JOIN post_comment_counts AS c ON c.post_id = p.id`);
      for (const row of rows) expect(row.kept, `post ${row.id}`).toBe(row.counted);
      return rows.find((row) => row.id === postId)?.kept ?? Number.NaN;
    }
    const setComment = (commentId: string, values: Partial<typeof postComments.$inferInsert>) =>
      t.db.update(postComments).set(values).where(eq(postComments.id, commentId));

    it('keeps each post’s count of the comments in view through every write, in the write’s transaction (Codex review on PR #220, ADR-0074 7-33)', async () => {
      const { author, market, post } = await postFixture();
      const other = await createPost(t.db, { marketId: market.id, authorId: author.id });
      // No row until a comment is in view: the reads take 0.
      expect(await kept(post.id)).toBe(0);
      expect(await t.db.select().from(postCommentCounts)).toEqual([]);
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      const reply = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        parentId: comment.id,
      });
      expect(await kept(post.id)).toBe(2);
      // Written hidden or deleted: out of view, not counted.
      const writtenHidden = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        hiddenAt: new Date(),
      });
      const writtenDeleted = await createComment(t.db, {
        postId: post.id,
        authorId: author.id,
        deletedAt: new Date(),
      });
      expect(await kept(post.id)).toBe(2);
      await createComment(t.db, { postId: other.id, authorId: author.id });
      expect(await kept(other.id)).toBe(1);
      // An edit of the body moves nothing.
      await setComment(comment.id, { body: '고친 댓글', editedAt: new Date() });
      expect(await kept(post.id)).toBe(2);
      // The author's deletion takes one out; a later time on a deleted one moves nothing.
      await setComment(reply.id, { deletedAt: new Date() });
      expect(await kept(post.id)).toBe(1);
      await setComment(reply.id, { deletedAt: new Date(Date.now() + 1_000) });
      expect(await kept(post.id)).toBe(1);
      // Hiding (#50) takes one out and showing it again puts it back; a deleted one stays out
      // whether hidden or shown.
      await setComment(comment.id, { hiddenAt: new Date() });
      expect(await kept(post.id)).toBe(0);
      await setComment(comment.id, { hiddenAt: null });
      expect(await kept(post.id)).toBe(1);
      await setComment(reply.id, { hiddenAt: new Date() });
      await setComment(reply.id, { hiddenAt: null });
      expect(await kept(post.id)).toBe(1);
      // What was written hidden, shown; what was written deleted, back (no route does it — the
      // count follows whoever writes); both out at once in one statement.
      await setComment(writtenHidden.id, { hiddenAt: null });
      await setComment(writtenDeleted.id, { deletedAt: null });
      expect(await kept(post.id)).toBe(3);
      await setComment(writtenDeleted.id, { deletedAt: new Date(), hiddenAt: new Date() });
      expect(await kept(post.id)).toBe(2);
      // A 댓글 moved to another post (nothing hangs under it): one less here, one more there.
      await setComment(writtenHidden.id, { postId: other.id });
      expect(await kept(post.id)).toBe(1);
      expect(await kept(other.id)).toBe(2);
      // A hard delete (#184): one in view leaves the count, one out of view does not.
      await t.db.delete(postComments).where(eq(postComments.id, writtenHidden.id));
      expect(await kept(other.id)).toBe(1);
      await t.db.delete(postComments).where(eq(postComments.id, writtenDeleted.id));
      expect(await kept(post.id)).toBe(1);
      // In the write's transaction: rolled back, the count is as it was.
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(postComments).values({ postId: post.id, authorId: author.id, body: 'x' });
          tx.rollback();
        }),
      ).rejects.toBeInstanceOf(TransactionRollbackError);
      expect(await kept(post.id)).toBe(1);
    });

    it('lets buddha_app read the counts and change them only through the trigger, which runs as their owner', async () => {
      const { author, post } = await postFixture();
      await createComment(t.db, { postId: post.id, authorId: author.id });
      const refused = (e: unknown) => sqlState(e) === '42501';
      await expect(
        t.db
          .update(postCommentCounts)
          .set({ count: 9 })
          .where(eq(postCommentCounts.postId, post.id)),
      ).rejects.toSatisfy(refused);
      await expect(
        t.db.delete(postCommentCounts).where(eq(postCommentCounts.postId, post.id)),
      ).rejects.toSatisfy(refused);
      const { market } = await postFixture();
      const bare = await createPost(t.db, { marketId: market.id, authorId: author.id });
      await expect(
        t.db.insert(postCommentCounts).values({ postId: bare.id, count: 5 }),
      ).rejects.toSatisfy(refused);
      const { rows: grants } = await t.db.execute<{ privilege: string }>(sql`
        SELECT privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE grantee = 'buddha_app' AND table_schema = 'public' AND table_name = 'post_comment_counts'`);
      expect(grants.map((row) => row.privilege)).toEqual(['SELECT']);
      const { rows: functions } = await t.db.execute<{
        name: string;
        definer: boolean;
        config: string[] | null;
        owner: string;
      }>(sql`
        SELECT proname AS name, prosecdef AS definer, proconfig AS config,
               pg_get_userbyid(proowner) AS owner
        FROM pg_proc WHERE proname LIKE 'post_comment_counts_%' ORDER BY proname`);
      expect(functions).toEqual(
        ['post_comment_counts_clear', 'post_comment_counts_follow'].map((name) => ({
          name,
          definer: true,
          config: ['search_path=pg_catalog, public, pg_temp'],
          owner: 'buddha_migrate',
        })),
      );
      expect(await kept(post.id)).toBe(1);

      // Nor through a table of its own by the same name (Codex review on PR #220): PUBLIC may
      // create temporary tables, and a session's pg_temp is searched first for a relation unless
      // the search path names it, so a function reaching `post_comment_counts` by its bare name
      // would write buddha_app's table instead of the kept one. The functions name the table with
      // its schema and put pg_temp last.
      const session = createDb(testDbUrls()!.appUrl, { max: 1, applicationName: 'buddha-test' });
      try {
        await session.execute(sql`
          CREATE TEMP TABLE post_comment_counts (post_id uuid PRIMARY KEY, count integer NOT NULL DEFAULT 0)`);
        await session.execute(sql`GRANT ALL ON pg_temp.post_comment_counts TO PUBLIC`);
        const [shadowed] = await session
          .insert(postComments)
          .values({ postId: post.id, authorId: author.id, body: '같은 이름의 표' })
          .returning();
        expect(await kept(post.id)).toBe(2);
        await session
          .update(postComments)
          .set({ hiddenAt: sql`now()` })
          .where(eq(postComments.id, shadowed!.id));
        expect(await kept(post.id)).toBe(1);
        await session.delete(postComments).where(eq(postComments.id, shadowed!.id));
        expect(await kept(post.id)).toBe(1);
        const { rows: own } = await session.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_temp.post_comment_counts`,
        );
        expect(own).toEqual([{ n: 0 }]);
      } finally {
        await closeDb(session);
      }
    });

    it('counts comments written and taken out at the same time exactly: the writers of one post queue on its row', async () => {
      // Each writer holds its transaction open after its write, so the others' writes meet its
      // lock — the first comments of the post among them, when it has no row yet.
      const { author, post } = await postFixture();
      const WRITERS = 12;
      const pool = createDb(testDbUrls()!.appUrl, { max: WRITERS, applicationName: 'buddha-test' });
      try {
        await Promise.all(
          Array.from({ length: WRITERS }, (_, index) =>
            pool.transaction(async (tx) => {
              await tx
                .insert(postComments)
                .values({ postId: post.id, authorId: author.id, body: `동시 ${String(index)}` });
              await tx.execute(sql`SELECT pg_sleep(0.05)`);
            }),
          ),
        );
        expect(await kept(post.id)).toBe(WRITERS);
        const ids = await t.db
          .select({ id: postComments.id })
          .from(postComments)
          .where(eq(postComments.postId, post.id));
        await Promise.all(
          ids.map(({ id }, index) =>
            pool.transaction(async (tx) => {
              await tx
                .update(postComments)
                .set(index % 2 === 0 ? { deletedAt: sql`now()` } : { hiddenAt: sql`now()` })
                .where(eq(postComments.id, id));
              await tx.execute(sql`SELECT pg_sleep(0.05)`);
            }),
          ),
        );
        expect(await kept(post.id)).toBe(0);
      } finally {
        await closeDb(pool);
      }
    });

    it('goes with its post, refuses a count gone wrong, and empties with the comments’ TRUNCATE', async () => {
      const { author, post } = await postFixture();
      const shown = await createComment(t.db, { postId: post.id, authorId: author.id });
      await createComment(t.db, { postId: post.id, authorId: author.id, deletedAt: new Date() });
      expect(await kept(post.id)).toBe(1);
      // A post with comments cannot be removed; once they are (#184), it goes and its row with it.
      await expect(t.db.delete(posts).where(eq(posts.id, post.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      await t.db.delete(postComments).where(eq(postComments.postId, post.id));
      expect(await t.db.select().from(postCommentCounts)).toEqual([{ postId: post.id, count: 0 }]);
      await t.db.delete(posts).where(eq(posts.id, post.id));
      expect(await t.db.select().from(postCommentCounts)).toEqual([]);
      expect(shown.postId).toBe(post.id);

      const owner = createDb(testDbUrls()!.migrateUrl, { max: 1 });
      try {
        // A count whose row went missing (the owner removed it) is not quietly left wrong: a
        // comment of that post leaving the view is refused.
        const second = await postFixture();
        const lost = await createComment(t.db, {
          postId: second.post.id,
          authorId: second.author.id,
        });
        await owner.delete(postCommentCounts).where(eq(postCommentCounts.postId, second.post.id));
        await expect(setComment(lost.id, { deletedAt: new Date() })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000' && errorMessage(e).includes('never kept'),
        );
        // A count kept when the comments are emptied (Codex review on PR #220: the TRUNCATE
        // found the table empty, so it held without the statement trigger). `post_comments`'
        // CASCADE reaches post_comment_revisions only — the counts are the posts'.
        const third = await postFixture();
        await createComment(t.db, { postId: third.post.id, authorId: third.author.id });
        expect(await t.db.select().from(postCommentCounts)).toEqual([
          { postId: third.post.id, count: 1 },
        ]);
        await owner.execute(sql`TRUNCATE post_comments CASCADE`);
        expect(await t.db.select().from(postCommentCounts)).toEqual([]);
      } finally {
        await closeDb(owner);
      }
    });
  });

  describe('likes on posts and comments (migration 0035, #49)', () => {
    /** A post with a 댓글 under it, by a new account, and two other accounts that like them. */
    async function likeFixture() {
      const { user: author } = await createUser(t.db);
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      return { author, a, b, post, comment };
    }

    it('stores a like of a post and of a comment, the relations both ways', async () => {
      const { author, a, post, comment } = await likeFixture();
      const postLike = await createPostLike(t.db, { postId: post.id, userId: a.id });
      const commentLike = await createCommentLike(t.db, { commentId: comment.id, userId: a.id });
      expect(postLike).toMatchObject({ postId: post.id, userId: a.id });
      expect(postLike.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      expect(commentLike).toMatchObject({ commentId: comment.id, userId: a.id });
      // Liking one's own is allowed (#49): nothing here tells the author apart.
      await createPostLike(t.db, { postId: post.id, userId: author.id });
      const withLikes = await t.db.query.posts.findFirst({
        where: eq(posts.id, post.id),
        with: { likes: true },
      });
      expect(withLikes?.likes.map((row) => row.userId).sort()).toEqual([a.id, author.id].sort());
      const commentWith = await t.db.query.postComments.findFirst({
        where: eq(postComments.id, comment.id),
        with: { likes: { with: { user: true } } },
      });
      expect(commentWith?.likes.map((row) => row.user.id)).toEqual([a.id]);
      const likerWith = await t.db.query.user.findFirst({
        where: eq(user.id, a.id),
        with: { postLikes: true, commentLikes: true },
      });
      expect(likerWith?.postLikes.map((row) => row.postId)).toEqual([post.id]);
      expect(likerWith?.commentLikes.map((row) => row.commentId)).toEqual([comment.id]);
    });

    it('holds one like per verified number and one per account, whoever writes (decision 7)', async () => {
      const { a, b, post, comment } = await likeFixture();
      const hash = randomPhoneHash();
      await createPostLike(t.db, { postId: post.id, userId: a.id, phoneHash: hash });
      await createCommentLike(t.db, { commentId: comment.id, userId: a.id, phoneHash: hash });
      // The same number on another account — A withdrew and signed up again as B — likes nothing
      // twice.
      await expect(
        createPostLike(t.db, { postId: post.id, userId: b.id, phoneHash: hash }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'post_likes_phone_hash_post_id_pk',
      );
      await expect(
        createCommentLike(t.db, { commentId: comment.id, userId: b.id, phoneHash: hash }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'comment_likes_phone_hash_comment_id_pk',
      );
      // The same account on another number — changed outside the operator's procedure, which
      // carries the account's likes to the new number (ADR-0076) — neither.
      await expect(createPostLike(t.db, { postId: post.id, userId: a.id })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'post_likes_user_id_post_id_unique',
      );
      await expect(
        createCommentLike(t.db, { commentId: comment.id, userId: a.id }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'comment_likes_user_id_comment_id_unique',
      );
      // The same number on another post or comment is another like.
      const other = await createPost(t.db, { marketId: post.marketId, authorId: b.id });
      await createPostLike(t.db, { postId: other.id, userId: a.id, phoneHash: hash });
      expect(await t.db.select().from(postLikes)).toHaveLength(2);
      expect(await t.db.select().from(commentLikes)).toHaveLength(1);
    });

    it('takes a keyed hash only, and keeps the target and the liker while a like stands', async () => {
      const { a, post, comment } = await likeFixture();
      for (const phoneHash of ['01012345678', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
        await expect(
          createPostLike(t.db, { postId: post.id, userId: a.id, phoneHash }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'post_likes_phone_hash_check',
        );
        await expect(
          createCommentLike(t.db, { commentId: comment.id, userId: a.id, phoneHash }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'comment_likes_phone_hash_check',
        );
      }
      await createPostLike(t.db, { postId: post.id, userId: a.id });
      await createCommentLike(t.db, { commentId: comment.id, userId: a.id });
      // RESTRICT: a withdrawn account's likes stay and keep counting (#37-17), and nothing deletes
      // a liked post or comment.
      await expect(t.db.delete(user).where(eq(user.id, a.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      await expect(
        t.db.delete(postComments).where(eq(postComments.id, comment.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23503');
    });

    it('lets buddha_app insert and delete a like, never rewrite one', async () => {
      const { a, b, post, comment } = await likeFixture();
      await createPostLike(t.db, { postId: post.id, userId: a.id });
      await createCommentLike(t.db, { commentId: comment.id, userId: a.id });
      await expect(
        t.db.update(postLikes).set({ userId: b.id }).where(eq(postLikes.postId, post.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db
          .update(commentLikes)
          .set({ userId: b.id })
          .where(eq(commentLikes.commentId, comment.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // Unliking deletes the row; a repeated like after it is a new one.
      await t.db.delete(postLikes).where(eq(postLikes.postId, post.id));
      await t.db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id));
      await createPostLike(t.db, { postId: post.id, userId: a.id });
      expect((await t.db.select().from(postLikes)).map((row) => row.userId)).toEqual([a.id]);
      expect(await t.db.select().from(commentLikes)).toEqual([]);
    });
  });

  describe('notices (migration 0036, #138)', () => {
    it('stores a notice with its text and images derived, unpinned, and gives an image to one notice only', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const media = await createMedia(t.db, { ownerId: admin.id });
      const notice = await createNotice(t.db, {
        title: '점검 안내',
        text: '첫 줄\n둘째 줄',
        imageIds: [media.id],
      });
      expect(notice).toMatchObject({
        title: '점검 안내',
        bodyText: '첫 줄\n둘째 줄',
        imageIds: [media.id],
        editedAt: null,
        pinnedAt: null,
        pinSlot: null,
      });
      expect(await t.db.select().from(noticeImages)).toEqual([
        { noticeId: notice.id, mediaId: media.id, createdAt: expect.any(Date) as unknown },
      ]);
      const [attached] = await t.db.select().from(mediaObjects);
      expect(attached?.attachedAt).toBeInstanceOf(Date);
      // One notice per image, as one post per image. Whether a post may hold it too is not the
      // database's to say (no constraint spans post_images and notice_images): the API refuses it
      // (notices.controller.test.ts).
      await expect(createNotice(t.db, { imageIds: [media.id] })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'notice_images_media_id_unique',
      );
      // The relations resolve both ways.
      const withAll = await t.db.query.notices.findFirst({
        where: eq(notices.id, notice.id),
        with: { images: { with: { media: { with: { notice: true } } } } },
      });
      expect(withAll?.images.map((image) => image.media.notice?.noticeId)).toEqual([notice.id]);
    });

    it('requires a title with text', async () => {
      for (const title of ['', '   ']) {
        await expect(createNotice(t.db, { title })).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'notices_title_check',
        );
      }
    });

    it('holds the pin limit itself: a slot each, one to NOTICE_PIN_LIMIT, and a time with it', async () => {
      const pinned = [];
      for (let slot = 1; slot <= NOTICE_PIN_LIMIT; slot += 1) {
        pinned.push(await createNotice(t.db, { pinSlot: slot }));
      }
      expect(pinned.map((notice) => notice.pinnedAt)).toEqual(
        pinned.map(() => expect.any(Date) as unknown),
      );
      // A fourth pin has no slot to take, whoever writes: a slot taken, or one past the limit.
      await expect(createNotice(t.db, { pinSlot: 1 })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'notices_pin_slot_unique',
      );
      for (const slot of [0, NOTICE_PIN_LIMIT + 1]) {
        await expect(createNotice(t.db, { pinSlot: slot })).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'notices_pin_slot_check',
        );
      }
      // Pinned means a time and a slot together.
      const unpinned = await createNotice(t.db);
      await expect(
        t.db.update(notices).set({ pinnedAt: new Date() }).where(eq(notices.id, unpinned.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'notices_pinned_check',
      );
      await expect(
        t.db.update(notices).set({ pinSlot: null }).where(eq(notices.id, pinned[0]!.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'notices_pinned_check',
      );
      // Unpinning frees the slot for another notice; unpinned notices are as many as written.
      await t.db
        .update(notices)
        .set({ pinnedAt: null, pinSlot: null })
        .where(eq(notices.id, pinned[0]!.id));
      await t.db
        .update(notices)
        .set({ pinnedAt: new Date(), pinSlot: 1 })
        .where(eq(notices.id, unpinned.id));
      const [count] = await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(notices)
        .where(sql`${notices.pinSlot} IS NOT NULL`);
      expect(count?.n).toBe(NOTICE_PIN_LIMIT);
    });

    it('keeps an edit’s history append-only, and deletable should a later decision ask', async () => {
      const notice = await createNotice(t.db);
      const [revision] = await t.db
        .insert(noticeRevisions)
        .values({
          noticeId: notice.id,
          title: notice.title,
          body: notice.body,
          bodyText: notice.bodyText,
          imageIds: [],
          writtenAt: notice.createdAt,
        })
        .returning();
      await expect(
        t.db
          .update(noticeRevisions)
          .set({ bodyText: 'rewritten' })
          .where(eq(noticeRevisions.id, revision!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // A notice is not deleted while its history names it.
      await expect(t.db.delete(notices).where(eq(notices.id, notice.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
      // DELETE stays, as on post_revisions: the owner keeps a notice's history with no retention
      // period, so nothing deletes a version, and the database can still delete one should a later
      // decision ask (owner decision 2026-10-21, ADR-0077: «DB는 나중에 지울 수 있게»).
      await t.db.delete(noticeRevisions).where(eq(noticeRevisions.id, revision!.id));
      expect(await t.db.select().from(noticeRevisions)).toEqual([]);
    });
  });

  it('keeps a profile’s 소개 absent or with text, 160 characters at most (migration 0037, #41)', async () => {
    const { user: u, profile } = await createUser(t.db);
    // None until the member writes one: every new and existing profile.
    expect(profile.bio).toBeNull();
    const bioOf = async () =>
      (await t.db.select({ bio: profiles.bio }).from(profiles).where(eq(profiles.userId, u.id)))[0]
        ?.bio;
    // 160 characters, counted as code points (an emoji is one), line breaks kept.
    const longest = `${'😀'.repeat(80)}\n${'가'.repeat(79)}`;
    await t.db.update(profiles).set({ bio: longest }).where(eq(profiles.userId, u.id));
    expect(await bioOf()).toBe(longest);
    await expect(
      t.db
        .update(profiles)
        .set({ bio: `${longest}a` })
        .where(eq(profiles.userId, u.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '22001');
    for (const blank of ['', '   ']) {
      await expect(
        t.db.update(profiles).set({ bio: blank }).where(eq(profiles.userId, u.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'profiles_bio_check',
      );
    }
    // buddha_app writes it like the nickname and clears it with null.
    await t.db.update(profiles).set({ bio: null }).where(eq(profiles.userId, u.id));
    expect(await bioOf()).toBeNull();
  });

  describe('the profile image (migration 0038, #141)', () => {
    /** The image a profile names, read back. */
    const imageOf = async (userId: string) =>
      (
        await t.db
          .select({ imageId: profiles.imageId, imageKind: profiles.imageKind })
          .from(profiles)
          .where(eq(profiles.userId, userId))
      )[0];

    it('names a profile image of the profile’s own account, attached from the start', async () => {
      const { user: u, profile } = await createUser(t.db);
      // None until the member uploads one: every new and existing profile.
      expect(profile.imageId).toBeNull();
      expect(await imageOf(u.id)).toEqual({ imageId: null, imageKind: null });
      const image = await createProfileImage(t.db, { userId: u.id });
      expect(image).toMatchObject({ kind: 'profile_image', ownerId: u.id });
      expect(image.attachedAt).not.toBeNull();
      expect(await imageOf(u.id)).toEqual({ imageId: image.id, imageKind: 'profile_image' });
      // The relations resolve both ways.
      const withImage = await t.db.query.profiles.findFirst({
        where: eq(profiles.userId, u.id),
        with: { image: { with: { profile: true } } },
      });
      expect(withImage?.image?.id).toBe(image.id);
      expect(withImage?.image?.profile?.userId).toBe(u.id);
      // Cleared with null (a deletion, or an operator's removal that keeps the row, #50).
      await t.db.update(profiles).set({ imageId: null }).where(eq(profiles.userId, u.id));
      expect(await imageOf(u.id)).toEqual({ imageId: null, imageKind: null });
    });

    it('refuses another account’s image, a post’s image and a second profile for one image', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      // B's profile image, and an earlier one of B's that no profile names any more (as an
      // operator's removal keeps it, #50).
      const kept = await createProfileImage(t.db, { userId: b.id });
      const theirs = await createProfileImage(t.db, { userId: b.id });
      const postImage = await createMedia(t.db, { ownerId: a.id });
      // A post's image attached, as a post takes it, is still no profile image.
      await t.db
        .update(mediaObjects)
        .set({ attachedAt: new Date() })
        .where(eq(mediaObjects.id, postImage.id));
      for (const imageId of [kept.id, postImage.id, randomUUID()]) {
        await expect(
          t.db.update(profiles).set({ imageId }).where(eq(profiles.userId, a.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23503' && sqlConstraint(e) === 'profiles_image_fk',
        );
      }
      // The image B's profile names is refused before its owner is looked at: one profile's.
      await expect(
        t.db.update(profiles).set({ imageId: theirs.id }).where(eq(profiles.userId, a.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'profiles_image_id_unique',
      );
      expect(await imageOf(a.id)).toEqual({ imageId: null, imageKind: null });
      expect(await imageOf(b.id)).toEqual({ imageId: theirs.id, imageKind: 'profile_image' });
      // The generated kind cannot be written.
      await expect(
        t.db.execute(sql`UPDATE profiles SET image_kind = 'post_image' WHERE user_id = ${a.id}`),
      ).rejects.toSatisfy((e) => sqlState(e) === '428C9');
    });

    it('keeps a profile image attached, and removable only once no profile names it', async () => {
      const { user: u } = await createUser(t.db);
      const image = await createProfileImage(t.db, { userId: u.id });
      await expect(
        t.db.update(mediaObjects).set({ attachedAt: null }).where(eq(mediaObjects.id, image.id)),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' &&
          sqlConstraint(e) === 'media_objects_profile_image_attached_check',
      );
      await expect(
        t.db.insert(mediaObjects).values({
          ownerId: u.id,
          kind: 'profile_image',
          storageKey: `profile-images/${randomUUID()}.png`,
          contentType: 'image/png',
          byteSize: 1,
          width: 1,
          height: 1,
        }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' &&
          sqlConstraint(e) === 'media_objects_profile_image_attached_check',
      );
      await expect(
        t.db.delete(mediaObjects).where(eq(mediaObjects.id, image.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23503' && sqlConstraint(e) === 'profiles_image_fk',
      );
      // Let go of first, in the same transaction, as the member's replacement and deletion do.
      await t.db.transaction(async (tx) => {
        await tx.update(profiles).set({ imageId: null }).where(eq(profiles.userId, u.id));
        await tx.delete(mediaObjects).where(eq(mediaObjects.id, image.id));
      });
      expect(await t.db.select().from(mediaObjects)).toEqual([]);
    });
  });

  describe('reports and moderation actions (migration 0039, #50)', () => {
    async function moderationFixture() {
      const { user: author } = await createUser(t.db);
      const { user: reporter } = await createUser(t.db);
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      return { author, reporter, admin, post, comment };
    }

    it('labels its enums exactly like their shared tuples', async () => {
      const labels = async (name: string) =>
        (
          await t.db.execute<{ label: string }>(
            sql`SELECT enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = ${name} ORDER BY e.enumsortorder`,
          )
        ).rows.map((row) => row.label);
      // #139 (migration 0042): the two reasons only an account restriction takes, at the end.
      expect(await labels('report_reason')).toEqual([...MODERATION_REASONS]);
      expect(MODERATION_REASONS.slice(0, REPORT_REASONS.length)).toEqual([...REPORT_REASONS]);
      expect(await labels('report_target_type')).toEqual([...REPORT_TARGET_TYPES]);
      expect(await labels('report_status')).toEqual([...REPORT_STATUSES]);
    });

    it('stores a report on a post, a comment and a profile, each in its own shape', async () => {
      const { author, reporter, post, comment } = await moderationFixture();
      const onPost = await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        postId: post.id,
      });
      const onComment = await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        commentId: comment.id,
        reason: 'other',
        description: '저작권 침해',
      });
      const onProfile = await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        reason: 'impersonation',
      });
      expect([onPost.targetType, onComment.targetType, onProfile.targetType]).toEqual([
        'post',
        'comment',
        'profile',
      ]);
      // The generated key is the target as one text: the queue's group.
      expect([onPost.targetKey, onComment.targetKey, onProfile.targetKey]).toEqual([
        post.id,
        comment.id,
        author.id,
      ]);
      expect(onPost).toMatchObject({ status: 'pending', resolvedAt: null, actionId: null });
      // The wrong shapes, whoever writes.
      for (const values of [
        { targetType: 'post' as const, postId: null, commentId: null },
        { targetType: 'post' as const, postId: post.id, commentId: comment.id },
        { targetType: 'comment' as const, postId: post.id, commentId: null },
        { targetType: 'profile' as const, postId: post.id, commentId: null },
      ]) {
        await expect(
          t.db.insert(reports).values({
            ...values,
            reportedUserId: author.id,
            reporterId: reporter.id,
            reporterPhoneHash: randomPhoneHash(),
            reason: 'spam',
          }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_target_check',
        );
      }
      await expect(
        t.db.execute(sql`UPDATE reports SET target_key = 'x' WHERE id = ${onPost.id}`),
      ).rejects.toSatisfy((e) => sqlState(e) === '428C9');
    });

    it('refuses a report on oneself, a 기타 without a description and a hash that is not one', async () => {
      const { author, reporter, post } = await moderationFixture();
      await expect(
        createReport(t.db, { reporterId: author.id, reportedUserId: author.id, postId: post.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_not_own_check',
      );
      for (const description of [null, '  ']) {
        await expect(
          createReport(t.db, {
            reporterId: reporter.id,
            reportedUserId: author.id,
            postId: post.id,
            reason: 'other',
            description,
          }),
        ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      }
      await expect(
        createReport(t.db, {
          reporterId: reporter.id,
          reportedUserId: author.id,
          postId: post.id,
          reporterPhoneHash: 'A'.repeat(64),
        }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_phone_hash_check',
      );
    });

    it('holds one pending report per account and target, and takes another once it is processed (decision 7)', async () => {
      const { author, reporter, admin, post } = await moderationFixture();
      const first = await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        postId: post.id,
      });
      await expect(
        createReport(t.db, { reporterId: reporter.id, reportedUserId: author.id, postId: post.id }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'reports_pending_reporter_target_idx',
      );
      // The same account on the profile is another target.
      await createReport(t.db, { reporterId: reporter.id, reportedUserId: author.id });
      await t.db
        .update(reports)
        .set({
          status: 'dismissed',
          resolvedAt: new Date(),
          resolvedBy: admin.id,
          dismissalReason: '위반 아님',
        })
        .where(eq(reports.id, first.id));
      await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        postId: post.id,
      });
      expect(
        (await t.db.select().from(reports).where(eq(reports.postId, post.id))).map((r) => r.status),
      ).toEqual(expect.arrayContaining(['dismissed', 'pending']));
    });

    it('writes a processing once, with who and when, and never changes what was reported', async () => {
      const { author, reporter, admin, post } = await moderationFixture();
      const report = await createReport(t.db, {
        reporterId: reporter.id,
        reportedUserId: author.id,
        postId: post.id,
      });
      // A processing without its operator, time or reason is not one.
      for (const set of [
        { status: 'dismissed' as const, resolvedAt: new Date(), dismissalReason: '없음' },
        { status: 'dismissed' as const, resolvedAt: new Date(), resolvedBy: admin.id },
        { status: 'actioned' as const, resolvedAt: new Date(), resolvedBy: admin.id },
      ]) {
        await expect(
          t.db.update(reports).set(set).where(eq(reports.id, report.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_resolution_check',
        );
      }
      // The member reported never processes a report on themselves (decision 4 #50).
      await expect(
        t.db
          .update(reports)
          .set({
            status: 'dismissed',
            resolvedAt: new Date(),
            resolvedBy: author.id,
            dismissalReason: '없음',
          })
          .where(eq(reports.id, report.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_not_own_check',
      );
      await expect(
        t.db.update(reports).set({ reason: 'harassment' }).where(eq(reports.id, report.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('cannot change what was reported'));
      const action = await createModerationAction(t.db, {
        userId: author.id,
        createdBy: admin.id,
        postId: post.id,
      });
      await t.db
        .update(reports)
        .set({
          status: 'actioned',
          resolvedAt: new Date(),
          resolvedBy: admin.id,
          actionId: action.id,
        })
        .where(eq(reports.id, report.id));
      await expect(
        t.db
          .update(reports)
          .set({ status: 'dismissed', actionId: null, dismissalReason: '번복' })
          .where(eq(reports.id, report.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('was processed'));
      // Removed with the retention period (#184): buddha_app deletes.
      await t.db.delete(reports).where(eq(reports.id, report.id));
      expect(await t.db.select().from(reports)).toEqual([]);
    });

    it('takes a change of the hash alone, and only from the operator’s number change (owner decision 2026-10-21)', async () => {
      // docs/OPERATIONS.md moves the person's pending and recent reports onto the new number's hash
      // (ADR-0081): the keep-record trigger takes that change from the transaction that names the
      // account and the new hash (its SET LOCAL lines), and nothing else of the row with it.
      const { author, reporter, admin, post, comment } = await moderationFixture();
      await createPhoneVerification(t.db, { userId: reporter.id });
      const oldHash = randomPhoneHash();
      const newHash = randomPhoneHash();
      const pending = await createReport(t.db, {
        reporterId: reporter.id,
        reporterPhoneHash: oldHash,
        reportedUserId: author.id,
        postId: post.id,
      });
      const dismissed = await createReport(t.db, {
        reporterId: reporter.id,
        reporterPhoneHash: oldHash,
        reportedUserId: author.id,
        commentId: comment.id,
        status: 'dismissed',
        resolvedBy: admin.id,
        dismissalReason: '위반 아님',
      });
      const { user: someoneElse } = await createUser(t.db);
      await createPhoneVerification(t.db, { userId: someoneElse.id });
      const others = await createReport(t.db, {
        reporterId: someoneElse.id,
        reporterPhoneHash: oldHash,
        reportedUserId: author.id,
        postId: post.id,
      });
      const keeps = 'keeps the number it was sent with';
      const moveTo = (id: string, hash: string) =>
        sql`UPDATE reports SET reporter_phone_hash = ${hash} WHERE id = ${id}`;
      /** A transaction as the number change's: its SET LOCAL lines, then `body`. */
      const asNumberChange = (
        body: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<unknown>,
        settings: Record<string, string> = {
          'phone_change.user_id': reporter.id,
          'phone_change.new_hash': newHash,
        },
      ) =>
        t.db.transaction(async (tx) => {
          for (const [name, value] of Object.entries(settings)) {
            await tx.execute(sql`SELECT set_config(${name}, ${value}, true)`);
          }
          await body(tx);
        });
      // Any write of the app's: no setting names it.
      await expect(t.db.execute(moveTo(pending.id, newHash))).rejects.toSatisfy((e) =>
        errorMessage(e).includes(keeps),
      );
      // In the change: another hash, another account's report, or more than the hash — refused.
      await expect(
        asNumberChange((tx) => tx.execute(moveTo(pending.id, randomPhoneHash()))),
      ).rejects.toSatisfy((e) => errorMessage(e).includes(keeps));
      await expect(
        asNumberChange((tx) => tx.execute(moveTo(others.id, newHash))),
      ).rejects.toSatisfy((e) => errorMessage(e).includes(keeps));
      for (const more of [
        sql`reason = 'harassment'`,
        sql`description = '바꾼 설명'`,
        sql`status = 'dismissed', resolved_at = now(), resolved_by = ${admin.id}, dismissal_reason = '없음'`,
      ]) {
        await expect(
          asNumberChange((tx) =>
            tx.execute(
              sql`UPDATE reports SET reporter_phone_hash = ${newHash}, ${more} WHERE id = ${pending.id}`,
            ),
          ),
        ).rejects.toSatisfy((e) => errorMessage(e).includes("changes its number's hash alone"));
      }
      // The hash alone, of the account's reports — a processed one too.
      await asNumberChange(async (tx) => {
        await tx.execute(moveTo(pending.id, newHash));
        await tx.execute(moveTo(dismissed.id, newHash));
      });
      const after = await t.db.select().from(reports);
      const byId = new Map(after.map((row) => [row.id, row]));
      expect(byId.get(pending.id)).toEqual({ ...pending, reporterPhoneHash: newHash });
      expect(byId.get(dismissed.id)).toEqual({ ...dismissed, reporterPhoneHash: newHash });
      expect(byId.get(others.id)).toEqual(others);
      // Once the change names the old number's hash (#49's final procedure), a withdrawn account's
      // report on that number is the account's too; a live account's never is.
      const { user: withdrawn } = await createUser(t.db);
      const inherited = await createReport(t.db, {
        reporterId: withdrawn.id,
        reporterPhoneHash: oldHash,
        reportedUserId: author.id,
      });
      const withOld = {
        'phone_change.user_id': reporter.id,
        'phone_change.new_hash': newHash,
        'phone_change.old_hash': oldHash,
      };
      await expect(
        asNumberChange((tx) => tx.execute(moveTo(inherited.id, newHash))),
      ).rejects.toSatisfy((e) => errorMessage(e).includes(keeps));
      await expect(
        asNumberChange((tx) => tx.execute(moveTo(others.id, newHash)), withOld),
      ).rejects.toSatisfy((e) => errorMessage(e).includes(keeps));
      await asNumberChange((tx) => tx.execute(moveTo(inherited.id, newHash)), withOld);
      const [moved] = await t.db.select().from(reports).where(eq(reports.id, inherited.id));
      expect(moved).toEqual({ ...inherited, reporterPhoneHash: newHash });
      // The processing's rules hold as before around it: a processed report keeps its result.
      await expect(
        t.db.update(reports).set({ reason: 'harassment' }).where(eq(reports.id, dismissed.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('was processed'));
    });

    it('holds an action to its types, its subject’s shape, its reason and another operator', async () => {
      const { author, admin, post, comment } = await moderationFixture();
      const base = { userId: author.id, createdBy: admin.id, reason: 'spam' as const };
      await expect(
        t.db.insert(moderationActions).values({ ...base, type: 'ban' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_type_check',
      );
      for (const values of [
        { type: 'hide', postId: null, commentId: null },
        { type: 'hide', postId: post.id, commentId: comment.id },
        { type: 'warning', postId: post.id, commentId: comment.id },
        { type: 'bio_clear', postId: post.id, commentId: null },
      ]) {
        await expect(
          t.db.insert(moderationActions).values({ ...base, ...values }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_subject_check',
        );
      }
      await expect(
        t.db.insert(moderationActions).values({ ...base, type: 'warning', reason: 'other' }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_other_note_check',
      );
      await expect(
        t.db.insert(moderationActions).values({ ...base, type: 'warning', endsAt: new Date() }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_ends_at_check',
      );
      await expect(
        t.db.insert(moderationActions).values({ ...base, type: 'warning', createdBy: author.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_not_own_check',
      );
      // A warning about nothing, about a comment, and a hiding of each.
      await createModerationAction(t.db, { ...base, type: 'warning' });
      await createModerationAction(t.db, { ...base, type: 'warning', commentId: comment.id });
      await createModerationAction(t.db, { ...base, postId: post.id });
      await createModerationAction(t.db, { ...base, commentId: comment.id });
      expect(await t.db.select().from(moderationActions)).toHaveLength(4);
    });

    it('keeps one standing hiding per item, and writes a cancellation once', async () => {
      const { author, admin, post } = await moderationFixture();
      const { user: other } = await createUser(t.db, { role: 'admin' });
      const hide = await createModerationAction(t.db, {
        userId: author.id,
        createdBy: admin.id,
        postId: post.id,
      });
      await expect(
        createModerationAction(t.db, { userId: author.id, createdBy: other.id, postId: post.id }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' &&
          sqlConstraint(e) === 'moderation_actions_standing_post_hide_idx',
      );
      await expect(
        t.db
          .update(moderationActions)
          .set({ note: '다른 설명' })
          .where(eq(moderationActions.id, hide.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('cannot change what was done'));
      // The member never cancels an action on themselves either.
      await expect(
        t.db
          .update(moderationActions)
          .set({ cancelledAt: new Date(), cancelledBy: author.id, cancelReason: '이의 인정' })
          .where(eq(moderationActions.id, hide.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_not_own_check',
      );
      await expect(
        t.db
          .update(moderationActions)
          .set({ cancelledAt: new Date(), cancelledBy: other.id })
          .where(eq(moderationActions.id, hide.id)),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_cancellation_check',
      );
      await t.db
        .update(moderationActions)
        .set({ cancelledAt: new Date(), cancelledBy: other.id, cancelReason: '이의 인정' })
        .where(eq(moderationActions.id, hide.id));
      await expect(
        t.db
          .update(moderationActions)
          .set({ cancelReason: '다른 사유' })
          .where(eq(moderationActions.id, hide.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('was cancelled'));
      // Once cancelled, the item may be hidden again.
      await createModerationAction(t.db, {
        userId: author.id,
        createdBy: other.id,
        postId: post.id,
      });
    });

    it('keeps what a profile action took away, one item each, never rewritten', async () => {
      const { author, admin } = await moderationFixture();
      const image = await createProfileImage(t.db, { userId: author.id });
      await t.db.update(profiles).set({ imageId: null }).where(eq(profiles.userId, author.id));
      const removal = await createModerationAction(t.db, {
        userId: author.id,
        createdBy: admin.id,
        type: 'image_remove',
        removed: { imageId: image.id },
      });
      const [kept] = await t.db
        .select()
        .from(profileItemRemovals)
        .where(eq(profileItemRemovals.actionId, removal.id));
      expect(kept).toEqual({ actionId: removal.id, nickname: null, bio: null, imageId: image.id });
      // The image is the record's until #184 removes it.
      await expect(
        t.db.delete(mediaObjects).where(eq(mediaObjects.id, image.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23503');
      await expect(
        t.db
          .update(profileItemRemovals)
          .set({ imageId: null, bio: 'x' })
          .where(eq(profileItemRemovals.actionId, removal.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      const action = await createModerationAction(t.db, {
        userId: author.id,
        createdBy: admin.id,
        type: 'warning',
      });
      await expect(
        t.db.insert(profileItemRemovals).values({ actionId: action.id, nickname: 'a', bio: 'b' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'profile_item_removals_item_check',
      );
      await t.db.delete(profileItemRemovals).where(eq(profileItemRemovals.actionId, removal.id));
      await t.db.delete(mediaObjects).where(eq(mediaObjects.id, image.id));
    });

    it('names the nickname reset a hold came from: one hold an action, kept with it, and handed to the member alone (owner decision 2026-10-22)', async () => {
      const { author, reporter, admin } = await moderationFixture();
      const reset = await createModerationAction(t.db, {
        userId: author.id,
        createdBy: admin.id,
        type: 'nickname_reset',
        removed: { nickname: '사칭닉네임' },
      });
      const held = (nickname: string, userId: string) =>
        t.db.transaction((tx) => isNicknameHeld(tx, nickname, userId));
      // The reset's hold names no account: held from everybody, the member too (2026-10-21).
      const [hold] = await t.db
        .insert(nicknameHolds)
        .values({ nickname: '사칭닉네임', userId: null, actionId: reset.id })
        .returning();
      expect(await held('사칭닉네임', author.id)).toBe(true);
      expect(await held('사칭닉네임', reporter.id)).toBe(true);
      // One hold an action, and only an action there is.
      await expect(
        t.db
          .insert(nicknameHolds)
          .values({ nickname: '사칭닉네임', userId: null, actionId: reset.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'nickname_holds_action_id_unique',
      );
      await expect(
        t.db.insert(nicknameHolds).values({ nickname: '아무닉네임', actionId: randomUUID() }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23503' &&
          sqlConstraint(e) === 'nickname_holds_action_id_moderation_actions_id_fk',
      );
      // The action stays while its hold does (#184 removes the hold first).
      await t.db.delete(profileItemRemovals).where(eq(profileItemRemovals.actionId, reset.id));
      await expect(
        t.db.delete(moderationActions).where(eq(moderationActions.id, reset.id)),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23503' &&
          sqlConstraint(e) === 'nickname_holds_action_id_moderation_actions_id_fk',
      );
      // Handed to the member (the reset's cancellation): theirs to pick, nobody else's yet.
      await t.db
        .update(nicknameHolds)
        .set({ userId: author.id })
        .where(eq(nicknameHolds.id, hold!.id));
      expect(await held('사칭닉네임', author.id)).toBe(false);
      expect(await held('사칭닉네임', reporter.id)).toBe(true);
      expect(await held('사칭닉네임', admin.id)).toBe(true);
      // A member's own change names no action.
      const [own] = await t.db
        .insert(nicknameHolds)
        .values({ nickname: '내가버린닉', userId: author.id })
        .returning();
      expect(own?.actionId).toBeNull();
    });
  });

  describe('writing restrictions and the changes of their end (migration 0040, #185)', () => {
    const DAY = 24 * 60 * 60 * 1_000;

    async function restrictionFixture() {
      const { user: member } = await createUser(t.db);
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: member.id });
      const comment = await createComment(t.db, { postId: post.id, authorId: member.id });
      return { member, admin, post, comment };
    }
    /** A writing restriction given `ago` ms back for `term` ms (null: 무기한). */
    const restrict = (
      userId: string,
      createdBy: string,
      ago: number,
      term: number | null,
      extra: { postId?: string; commentId?: string } = {},
    ) => {
      const createdAt = new Date(Date.now() - ago);
      return createModerationAction(t.db, {
        userId,
        createdBy,
        type: 'writing_restriction',
        createdAt,
        endsAt: term === null ? null : new Date(createdAt.getTime() + term),
        ...extra,
      });
    };
    const setEnd = (id: string, endsAt: Date | null | ReturnType<typeof sql>) =>
      t.db.update(moderationActions).set({ endsAt }).where(eq(moderationActions.id, id));
    const onlyForward = (e: unknown) =>
      errorMessage(e).includes('only brings a standing restriction');

    it('takes a term or none, about one of the member’s items at most, never ending before it began', async () => {
      const { member, admin, post, comment } = await restrictionFixture();
      const base = {
        type: 'writing_restriction',
        userId: member.id,
        createdBy: admin.id,
        reason: 'spam' as const,
      };
      await restrict(member.id, admin.id, 0, 7 * DAY);
      await restrict(member.id, admin.id, 0, null);
      await restrict(member.id, admin.id, 0, DAY, { postId: post.id });
      await restrict(member.id, admin.id, 0, DAY, { commentId: comment.id });
      await expect(
        t.db.insert(moderationActions).values({ ...base, postId: post.id, commentId: comment.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_subject_check',
      );
      const at = new Date();
      await expect(
        t.db
          .insert(moderationActions)
          .values({ ...base, createdAt: at, endsAt: new Date(at.getTime() - 1) }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_ends_at_check',
      );
      // Nothing else has an end; the operator is never the member.
      for (const type of ['warning', 'hide', 'bio_clear']) {
        await expect(
          t.db.insert(moderationActions).values({
            ...base,
            type,
            postId: type === 'hide' ? post.id : null,
            endsAt: new Date(Date.now() + DAY),
          }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_ends_at_check',
        );
      }
      await expect(
        t.db.insert(moderationActions).values({ ...base, createdBy: member.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_not_own_check',
      );
      expect(
        await t.db
          .select()
          .from(moderationActions)
          .where(eq(moderationActions.type, 'writing_restriction')),
      ).toHaveLength(4);
    });

    it('brings a standing restriction’s end forward only — never back, never to 무기한, never to the past, never once ended', async () => {
      const { member, admin } = await restrictionFixture();
      const week = await restrict(member.id, admin.id, DAY, 7 * DAY);
      const sixDaysOn = new Date(week.createdAt.getTime() + 6 * DAY);
      await setEnd(week.id, new Date(week.createdAt.getTime() + 3 * DAY));
      // Back, to 무기한, to the past (after its start, before now): refused.
      await expect(setEnd(week.id, sixDaysOn)).rejects.toSatisfy(onlyForward);
      await expect(setEnd(week.id, null)).rejects.toSatisfy(onlyForward);
      await expect(setEnd(week.id, new Date(Date.now() - 60_000))).rejects.toSatisfy(onlyForward);
      // 무기한 to a term (감경 includes it).
      const indefinite = await restrict(member.id, admin.id, DAY, null);
      await setEnd(indefinite.id, new Date(Date.now() + DAY));
      // A lift: the end at the transaction's now; then it has ended, and nothing moves it again.
      await setEnd(week.id, sql`now()`);
      await expect(setEnd(week.id, new Date(Date.now() + 1_000))).rejects.toSatisfy(onlyForward);
      // One ended by its term is as closed.
      const ended = await restrict(member.id, admin.id, 2 * DAY, DAY);
      await expect(setEnd(ended.id, new Date(Date.now() + 1_000))).rejects.toSatisfy(onlyForward);
      // What was given stays: the reason, the operator, the time.
      await expect(
        t.db
          .update(moderationActions)
          .set({ note: '다른 설명' })
          .where(eq(moderationActions.id, indefinite.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('cannot change what was done'));
      // Another type's end never opens, and a cancelled restriction no longer changes.
      const warning = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'warning',
      });
      await expect(setEnd(warning.id, new Date(Date.now() + DAY))).rejects.toSatisfy(onlyForward);
      await t.db
        .update(moderationActions)
        .set({ cancelledAt: new Date(), cancelledBy: admin.id, cancelReason: '이의 인정' })
        .where(eq(moderationActions.id, indefinite.id));
      await expect(setEnd(indefinite.id, new Date(Date.now() + 1_000))).rejects.toSatisfy((e) =>
        errorMessage(e).includes('was cancelled'),
      );
      // A cancellation and an end change are never one write.
      const both = await restrict(member.id, admin.id, 0, 7 * DAY);
      await expect(
        t.db
          .update(moderationActions)
          .set({
            endsAt: new Date(Date.now() + DAY),
            cancelledAt: new Date(),
            cancelledBy: admin.id,
            cancelReason: '이의 인정',
          })
          .where(eq(moderationActions.id, both.id)),
      ).rejects.toSatisfy(onlyForward);
    });

    it('keeps each change of an end as made: earlier only, a kind and a reason, never rewritten', async () => {
      const { member, admin } = await restrictionFixture();
      const action = await restrict(member.id, admin.id, 0, 7 * DAY);
      const previousEndsAt = action.endsAt!;
      const endsAt = new Date(previousEndsAt.getTime() - 4 * DAY);
      const base = { actionId: action.id, createdBy: admin.id, reason: '이의 일부 인정' };
      const [change] = await t.db
        .insert(restrictionEndChanges)
        .values({ ...base, kind: 'shorten', previousEndsAt, endsAt })
        .returning();
      // From 무기한 to anything.
      await t.db
        .insert(restrictionEndChanges)
        .values({ ...base, kind: 'lift', previousEndsAt: null, endsAt: new Date() });
      await expect(
        t.db
          .insert(restrictionEndChanges)
          .values({ ...base, kind: 'extend', previousEndsAt, endsAt }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'restriction_end_changes_kind_check',
      );
      await expect(
        t.db
          .insert(restrictionEndChanges)
          .values({ ...base, kind: 'shorten', previousEndsAt: endsAt, endsAt: previousEndsAt }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'restriction_end_changes_earlier_check',
      );
      await expect(
        t.db
          .insert(restrictionEndChanges)
          .values({ ...base, kind: 'shorten', previousEndsAt, endsAt, reason: '   ' }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'restriction_end_changes_reason_check',
      );
      await expect(
        t.db
          .insert(restrictionEndChanges)
          .values({ ...base, kind: 'shorten', previousEndsAt, endsAt, actionId: randomUUID() }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23503' &&
          sqlConstraint(e) === 'restriction_end_changes_action_id_moderation_actions_id_fk',
      );
      // buddha_app never rewrites one (UPDATE revoked); the action stays while its changes do.
      await expect(
        t.db
          .update(restrictionEndChanges)
          .set({ reason: '다른 사유' })
          .where(eq(restrictionEndChanges.id, change!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(moderationActions).where(eq(moderationActions.id, action.id)),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23503' &&
          sqlConstraint(e) === 'restriction_end_changes_action_id_moderation_actions_id_fk',
      );
      // #184 removes the changes first, then the action.
      await t.db.delete(restrictionEndChanges).where(eq(restrictionEndChanges.actionId, action.id));
      await t.db.delete(moderationActions).where(eq(moderationActions.id, action.id));
    });
  });

  describe('write limits and repeated links (migration 0041, #187)', () => {
    /** A post with a 댓글 under it, by a new account. */
    async function linkFixture() {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
      const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
      return { author, post, comment };
    }

    it('records a counted write by number, kind and time only, never rewritten', async () => {
      const hash = randomPhoneHash();
      const event = await createWriteLimitEvent(t.db, { phoneHash: hash, action: 'post' });
      expect(event).toMatchObject({ phoneHash: hash, action: 'post' });
      for (const action of ['comment', 'edit', 'upload'] as const) {
        await createWriteLimitEvent(t.db, { phoneHash: hash, action });
      }
      await expect(
        t.db.insert(writeLimitEvents).values({ phoneHash: hash, action: 'report' as 'post' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'write_limit_events_action_check',
      );
      for (const phoneHash of ['01012345678', 'A'.repeat(64), 'a'.repeat(63)]) {
        await expect(createWriteLimitEvent(t.db, { phoneHash, action: 'post' })).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23514' && sqlConstraint(e) === 'write_limit_events_phone_hash_check',
        );
      }
      await expect(
        t.db
          .update(writeLimitEvents)
          .set({ action: 'edit' })
          .where(eq(writeLimitEvents.id, event.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // The worker's purge deletes a row once it left the longest window.
      await t.db.delete(writeLimitEvents).where(eq(writeLimitEvents.id, event.id));
      expect(await t.db.select().from(writeLimitEvents)).toHaveLength(3);
    });

    it('records a link use of exactly one post or comment, never rewritten', async () => {
      const { post, comment } = await linkFixture();
      const url = 'https://example.com/a';
      const onPost = await createLinkUse(t.db, { url, postId: post.id });
      await createLinkUse(t.db, { url, commentId: comment.id });
      await expect(createLinkUse(t.db, { url })).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'link_uses_target_check',
      );
      await expect(
        createLinkUse(t.db, { url, postId: post.id, commentId: comment.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'link_uses_target_check',
      );
      await expect(
        createLinkUse(t.db, { url, postId: post.id, phoneHash: 'x'.repeat(64) }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'link_uses_phone_hash_check',
      );
      await expect(
        t.db.update(linkUses).set({ url: 'https://b.example' }).where(eq(linkUses.id, onPost.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await t.db.delete(linkUses).where(eq(linkUses.id, onPost.id));
      expect(await t.db.select().from(linkUses)).toHaveLength(1);
    });

    it('keeps a review-list entry once per item, link and rule, changing only its mark, and lets it go', async () => {
      const { author, post, comment } = await linkFixture();
      const url = 'https://example.com/a';
      const flag = await createLinkFlag(t.db, { url, reason: 'same_account', postId: post.id });
      expect(flag.reviewActionId).toBeNull();
      // The same item, link and rule again: refused, the empty comment column notwithstanding.
      await expect(
        createLinkFlag(t.db, { url, reason: 'same_account', postId: post.id }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'link_flags_url_reason_target_unique',
      );
      await expect(
        createLinkFlag(t.db, { url, reason: 'same_account', commentId: comment.id }),
      ).resolves.toBeDefined();
      await expect(
        createLinkFlag(t.db, { url, reason: 'same_account', commentId: comment.id }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      // Another rule or another link is another entry.
      await createLinkFlag(t.db, { url, reason: 'many_accounts', postId: post.id });
      const other = await createLinkFlag(t.db, {
        url: 'https://b.example',
        reason: 'same_account',
        postId: post.id,
      });
      await expect(
        createLinkFlag(t.db, { url, reason: 'body_repeat' as 'same_account', postId: post.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'link_flags_reason_check',
      );
      await expect(createLinkFlag(t.db, { url, reason: 'same_account' })).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'link_flags_target_check',
      );
      // buddha_app updates the mark only (owner decision 2026-10-22).
      await expect(
        t.db.update(linkFlags).set({ url: 'https://c.example' }).where(eq(linkFlags.id, flag.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.update(linkFlags).set({ flaggedAt: new Date() }).where(eq(linkFlags.id, flag.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // The mark names an admin_actions row, and is set once.
      const mark = async () => {
        const [row] = await t.db
          .insert(adminActions)
          .values({
            adminId: author.id,
            type: 'link_flag_review',
            targetType: 'link',
            targetId: url,
          })
          .returning({ id: adminActions.id });
        return row!.id;
      };
      await expect(
        t.db
          .update(linkFlags)
          .set({ reviewActionId: randomUUID() })
          .where(eq(linkFlags.id, flag.id)),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23503' &&
          sqlConstraint(e) === 'link_flags_review_action_id_admin_actions_id_fk',
      );
      const first = await mark();
      await t.db.update(linkFlags).set({ reviewActionId: first }).where(eq(linkFlags.id, flag.id));
      for (const reviewActionId of [await mark(), null]) {
        await expect(
          t.db.update(linkFlags).set({ reviewActionId }).where(eq(linkFlags.id, flag.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      // The relations resolve both ways, the mark's too.
      const withPost = await t.db.query.linkFlags.findFirst({
        where: eq(linkFlags.id, flag.id),
        with: { post: true, comment: true, review: true },
      });
      expect(withPost?.post?.id).toBe(post.id);
      expect(withPost?.comment).toBeNull();
      expect(withPost?.review?.id).toBe(first);
      const markWith = await t.db.query.adminActions.findFirst({
        where: eq(adminActions.id, first),
        with: { linkFlags: true },
      });
      expect(markWith?.linkFlags.map((row) => row.id)).toEqual([flag.id]);
      const postWith = await t.db.query.posts.findFirst({
        where: eq(posts.id, post.id),
        with: { linkFlags: true },
      });
      expect(postWith?.linkFlags).toHaveLength(3);
      const commentWith = await t.db.query.postComments.findFirst({
        where: eq(postComments.id, comment.id),
        with: { linkFlags: true },
      });
      expect(commentWith?.linkFlags.map((row) => row.reason)).toEqual(['same_account']);
      // Deleted when its retention period ends (#184, owner decision 2026-10-22), marked or not;
      // the operator's admin_actions row stays.
      await t.db.delete(linkFlags).where(inArray(linkFlags.id, [flag.id, other.id]));
      expect(await t.db.select().from(linkFlags)).toHaveLength(2);
      expect(await t.db.select().from(adminActions).where(eq(adminActions.id, first))).toHaveLength(
        1,
      );
    });
  });

  describe('account restrictions and their approvals (migration 0042, #139)', () => {
    const DAY = 24 * 60 * 60 * 1_000;

    async function accountFixture() {
      const { user: member } = await createUser(t.db);
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const { user: second } = await createUser(t.db, { role: 'admin' });
      const market = await createMarket(t.db);
      const post = await createPost(t.db, { marketId: market.id, authorId: member.id });
      return { member, admin, second, post };
    }
    /** A request of `kind` about `target`, asked by `by` and, unless `decidedBy` is null, approved. */
    const approval = (
      kind: string,
      targetType: string,
      targetId: string,
      by: string,
      decidedBy: string | null,
      status: 'approved' | 'rejected' = 'approved',
    ) =>
      createApprovalRequest(t.db, {
        kind,
        targetType,
        targetId,
        requestedBy: by,
        ...(decidedBy === null ? {} : { decision: { status, by: decidedBy } }),
      });
    const base = (member: string, admin: string) => ({
      type: 'account_restriction' as const,
      userId: member,
      createdBy: admin,
      reason: 'abnormal_trading' as const,
      note: '이상 거래',
    });
    const needsApproval = (e: unknown) =>
      errorMessage(e).includes('needs another admin') ||
      errorMessage(e).includes('only by an approved request') ||
      errorMessage(e).includes('only with an approved change');

    it('takes the owner’s reasons for it with an explanation, and keeps reports and every other action to the report reasons', async () => {
      const { member, admin, second, post } = await accountFixture();
      for (const reason of ACCOUNT_RESTRICTION_REASONS) {
        await createModerationAction(t.db, {
          ...base(member.id, admin.id),
          reason,
          approvedBy: second.id,
        });
      }
      for (const reason of ['off_topic', 'rights_infringement'] as const) {
        const request = await approval(
          'account_restriction',
          'user',
          member.id,
          admin.id,
          second.id,
        );
        await expect(
          t.db
            .insert(moderationActions)
            .values({ ...base(member.id, admin.id), reason, approvalId: request.id }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_reason_check',
        );
      }
      const request = await approval('account_restriction', 'user', member.id, admin.id, second.id);
      await expect(
        t.db
          .insert(moderationActions)
          .values({ ...base(member.id, admin.id), note: null, approvalId: request.id }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_reason_check',
      );
      for (const reason of ['abnormal_trading', 'multi_account'] as const) {
        await expect(
          createModerationAction(t.db, { userId: member.id, createdBy: admin.id, reason }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_reason_check',
        );
        await expect(
          t.db.insert(reports).values({
            targetType: 'post',
            postId: post.id,
            reportedUserId: member.id,
            reporterId: admin.id,
            reporterPhoneHash: randomPhoneHash(),
            reason: reason as never,
          }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'reports_reason_check',
        );
      }
      expect(
        await t.db
          .select()
          .from(moderationActions)
          .where(eq(moderationActions.type, 'account_restriction')),
      ).toHaveLength(ACCOUNT_RESTRICTION_REASONS.length);
    });

    it('comes into force only by another admin’s approval of a request for it, each approval once (ADR-0056 1-7)', async () => {
      const { member, admin, second } = await accountFixture();
      const values = base(member.id, admin.id);
      // No approval at all: the trigger refuses it before the CHECK would.
      await expect(t.db.insert(moderationActions).values(values)).rejects.toSatisfy(needsApproval);
      // Pending, rejected, of another kind, asked by another admin, about another member, or
      // approved by the member: none puts it in force.
      const { user: other } = await createUser(t.db);
      const { user: memberAdmin } = await createUser(t.db, { role: 'admin' });
      const refused = [
        await approval('account_restriction', 'user', member.id, admin.id, null),
        await approval('account_restriction', 'user', member.id, admin.id, second.id, 'rejected'),
        await approval('account_restriction_lift', 'user', member.id, admin.id, second.id),
        await approval('account_restriction', 'user', member.id, second.id, admin.id),
        await approval('account_restriction', 'user', other.id, admin.id, second.id),
      ];
      for (const request of refused) {
        await expect(
          t.db.insert(moderationActions).values({ ...values, approvalId: request.id }),
        ).rejects.toSatisfy(needsApproval);
      }
      const own = await approval(
        'account_restriction',
        'user',
        memberAdmin.id,
        admin.id,
        memberAdmin.id,
      );
      await expect(
        t.db
          .insert(moderationActions)
          .values({ ...base(memberAdmin.id, admin.id), approvalId: own.id }),
      ).rejects.toSatisfy(needsApproval);
      const approved = await approval(
        'account_restriction',
        'user',
        member.id,
        admin.id,
        second.id,
      );
      await t.db.insert(moderationActions).values({ ...values, approvalId: approved.id });
      await expect(
        t.db.insert(moderationActions).values({ ...values, approvalId: approved.id }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'moderation_actions_approval_id_unique',
      );
      // Another type names no approval; the approval never changes once given.
      await expect(
        t.db.insert(moderationActions).values({
          ...values,
          type: 'writing_restriction',
          reason: 'spam',
          approvalId: (
            await approval('account_restriction', 'user', member.id, admin.id, second.id)
          ).id,
        }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'moderation_actions_approval_check',
      );
      const [action] = await t.db
        .select()
        .from(moderationActions)
        .where(eq(moderationActions.approvalId, approved.id));
      const another = await approval('account_restriction', 'user', member.id, admin.id, second.id);
      await expect(
        t.db
          .update(moderationActions)
          .set({ approvalId: another.id })
          .where(eq(moderationActions.id, action!.id)),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('cannot change what was done'));
    });

    it('brings its end forward only with an approved change, and is cancelled only by an approved request', async () => {
      const { member, admin, second } = await accountFixture();
      const createdAt = new Date(Date.now() - DAY);
      const action = await createModerationAction(t.db, {
        ...base(member.id, admin.id),
        createdAt,
        endsAt: new Date(createdAt.getTime() + 7 * DAY),
        approvedBy: second.id,
      });
      const shortened = new Date(createdAt.getTime() + 3 * DAY);
      // The end alone: refused at the commit, with no change row.
      await expect(
        t.db
          .update(moderationActions)
          .set({ endsAt: shortened })
          .where(eq(moderationActions.id, action.id)),
      ).rejects.toSatisfy(needsApproval);
      const change = {
        actionId: action.id,
        kind: 'shorten',
        previousEndsAt: action.endsAt,
        endsAt: shortened,
        reason: '이의 일부 인정',
        createdBy: admin.id,
      };
      // A change row with no approval, a pending one, or another action's: refused.
      await expect(t.db.insert(restrictionEndChanges).values(change)).rejects.toSatisfy(
        needsApproval,
      );
      const pending = await approval(
        'account_restriction_shorten',
        'moderation_action',
        action.id,
        admin.id,
        null,
      );
      await expect(
        t.db.insert(restrictionEndChanges).values({ ...change, approvalId: pending.id }),
      ).rejects.toSatisfy(needsApproval);
      const lift = await approval(
        'account_restriction_lift',
        'moderation_action',
        action.id,
        admin.id,
        second.id,
      );
      await expect(
        t.db.insert(restrictionEndChanges).values({ ...change, approvalId: lift.id }),
      ).rejects.toSatisfy(needsApproval);
      // The end and its approved change together: in force.
      const shorten = await approval(
        'account_restriction_shorten',
        'moderation_action',
        action.id,
        admin.id,
        second.id,
      );
      await t.db.transaction(async (tx) => {
        await tx
          .update(moderationActions)
          .set({ endsAt: shortened })
          .where(eq(moderationActions.id, action.id));
        await tx.insert(restrictionEndChanges).values({ ...change, approvalId: shorten.id });
      });
      // Changed once, the end still moves only with a change that gives it: alone (a time the
      // record trigger lets through — to come, and before the end now) …
      const again = new Date(Date.now() + 60_000);
      await expect(
        t.db
          .update(moderationActions)
          .set({ endsAt: again })
          .where(eq(moderationActions.id, action.id)),
      ).rejects.toSatisfy(needsApproval);
      // … or with an approved change that gives another end.
      const another = await approval(
        'account_restriction_shorten',
        'moderation_action',
        action.id,
        admin.id,
        second.id,
      );
      await expect(
        t.db.transaction(async (tx) => {
          await tx
            .update(moderationActions)
            .set({ endsAt: again })
            .where(eq(moderationActions.id, action.id));
          await tx.insert(restrictionEndChanges).values({
            ...change,
            previousEndsAt: shortened,
            endsAt: new Date(again.getTime() + 60_000),
            approvalId: another.id,
          });
        }),
      ).rejects.toSatisfy(needsApproval);
      // A writing restriction's change names none.
      const writing = await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: new Date(Date.now() + DAY),
      });
      await expect(
        t.db.insert(restrictionEndChanges).values({
          ...change,
          actionId: writing.id,
          previousEndsAt: writing.endsAt,
          endsAt: new Date(Date.now() + 60_000),
          approvalId: lift.id,
        }),
      ).rejects.toSatisfy((e) => errorMessage(e).includes('only an account restriction'));
      // Cancelled: only with an approved request to cancel this restriction.
      const cancel = { cancelledAt: new Date(), cancelledBy: admin.id, cancelReason: '이의 인정' };
      await expect(
        t.db.update(moderationActions).set(cancel).where(eq(moderationActions.id, action.id)),
      ).rejects.toSatisfy(needsApproval);
      await expect(
        t.db
          .update(moderationActions)
          .set({ ...cancel, cancelApprovalId: lift.id })
          .where(eq(moderationActions.id, action.id)),
      ).rejects.toSatisfy(needsApproval);
      const cancelRequest = await approval(
        'account_restriction_cancel',
        'moderation_action',
        action.id,
        admin.id,
        second.id,
      );
      await t.db
        .update(moderationActions)
        .set({ ...cancel, cancelApprovalId: cancelRequest.id })
        .where(eq(moderationActions.id, action.id));
      const [cancelled] = await t.db
        .select()
        .from(moderationActions)
        .where(eq(moderationActions.id, action.id));
      expect(cancelled).toMatchObject({ endsAt: shortened, cancelApprovalId: cancelRequest.id });
      // The factory's way: a cancelled account restriction names its cancellation's approval.
      await createModerationAction(t.db, {
        ...base(member.id, admin.id),
        approvedBy: second.id,
        cancelled: { at: new Date(), by: admin.id, reason: '취소', approvedBy: second.id },
      });
    });
  });

  describe('the direct AMM is gone (migration 0017, #125)', () => {
    it('has dropped its market columns, the slippage guards and market_mechanism', async () => {
      const { rows } = await t.db.execute<{ table: string; column: string }>(sql`
        SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (('markets', 'liquidity_b'), ('markets', 'q_yes'),
            ('markets', 'q_no'), ('markets', 'initial_prob_bp'), ('markets', 'reserve_p'),
            ('markets', 'mechanism'), ('orders', 'max_cost_p'), ('orders', 'min_proceeds_p'))`);
      expect(rows).toEqual([]);
      const types = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'market_mechanism'`,
      );
      expect(types.rows[0]?.n).toBe(0);
    });

    it('labels the recreated enums exactly like their shared tuples', async () => {
      async function labels(type: string): Promise<string[]> {
        const { rows } = await t.db.execute<{ label: string }>(sql`
          SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
          WHERE ty.typname = ${type} ORDER BY e.enumsortorder`);
        return rows.map((r) => r.label);
      }
      expect(await labels('ledger_entry_type')).toEqual([...LEDGER_ENTRY_TYPES]);
      expect(await labels('price_tick_trigger')).toEqual([...PRICE_TICK_TRIGGERS]);
      expect(await labels('counterparty_type')).toEqual([...COUNTERPARTY_TYPES]);
    });

    it('requires a fill to name the order it matched', async () => {
      const { user: u } = await createUser(t.db);
      const market = await createMarket(t.db);
      const [taker, maker] = await t.db
        .insert(orders)
        .values(
          ['taker-key', 'maker-key'].map((idempotencyKey) => ({
            userId: u.id,
            marketId: market.id,
            outcome: 'YES' as const,
            side: 'buy' as const,
            type: 'market' as const,
            qty: 1,
            status: 'open' as const,
            idempotencyKey,
          })),
        )
        .returning();
      const fill = {
        marketId: market.id,
        orderId: taker!.id,
        counterpartyType: 'order' as const,
        outcome: 'YES' as const,
        side: 'buy' as const,
        qty: 1,
        amountCoin: 52n,
        priceAvgBp: 5200,
      };
      await expect(t.db.insert(fills).values(fill)).rejects.toSatisfy(
        (e) => sqlState(e) === '23514',
      );
      await t.db.insert(fills).values({ ...fill, counterpartyOrderId: maker!.id });
      expect(await t.db.select().from(fills)).toHaveLength(1);
    });
  });

  describe('Coin names (migration 0018, #192)', () => {
    /** Columns (`table.column`), constraints and indexes of schema `public`. */
    async function names(): Promise<string[]> {
      const { rows } = await t.db.execute<{ name: string }>(sql`
        SELECT table_name || '.' || column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public'
        UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
      return rows.map((r) => r.name);
    }

    it('leaves no column, constraint or index named after P', async () => {
      // `p_yes_bp` is a probability in basis points, not an amount, and keeps its name.
      const pNamed = (await names()).filter((name) =>
        /(^|[._])p(_|$)/.test(name.replaceAll('p_yes_bp', '')),
      );
      expect(pNamed).toEqual([]);
    });

    it('renamed every amount column with its CHECK constraints and index', async () => {
      const coinNamed = (await names()).filter((name) => /_coin(_|$)/.test(name)).sort();
      expect(coinNamed).toEqual(
        [
          'balances.available_coin',
          'balances.locked_coin',
          'balances_available_coin_check',
          'balances_locked_coin_check',
          'charge_packages.amount_coin',
          'charge_packages_amount_coin_check',
          'coupon_redemptions.amount_coin',
          'coupons.amount_coin',
          'coupons_amount_coin_check',
          'fills.amount_coin',
          'fills.fee_coin',
          'fills_amount_coin_check',
          'fills_fee_coin_check',
          'ledger_entries.amount_coin',
          'ledger_entries.balance_after_coin',
          'markets.volume_coin',
          // `markets_status_volume_coin_id_idx` went with the volume order (migration 0024,
          // ADR-0065); #132 brings both back.
          'markets_volume_coin_check',
          'payments.amount_coin',
          'payments_amount_coin_check',
          'positions.cost_basis_coin',
          'positions.realized_pnl_coin',
          'positions_cost_basis_coin_check',
          // The start grant (migration 0031, #70): coined that way from the start.
          'start_grants.amount_coin',
          'start_grants_amount_coin_check',
        ].sort(),
      );
    });
  });

  describe('judgement and settlement steps (migration 0016, ADR-0046)', () => {
    it('labels market_status like MARKET_STATUSES, in order, with no dispute stage', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
        WHERE ty.typname = 'market_status' ORDER BY e.enumsortorder`);
      expect(rows.map((r) => r.label)).toEqual([...MARKET_STATUSES]);
    });

    it('has dropped disputes, its type and markets.dispute_until (O-8)', async () => {
      const { rows } = await t.db.execute<{
        disputes: string | null;
        disputeStatus: number;
        disputeUntil: number;
      }>(sql`
        SELECT to_regclass('public.disputes')::text AS "disputes",
          (SELECT count(*)::int FROM pg_type WHERE typname = 'dispute_status') AS "disputeStatus",
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'markets'
              AND column_name = 'dispute_until') AS "disputeUntil"`);
      expect(rows[0]).toEqual({ disputes: null, disputeStatus: 0, disputeUntil: 0 });
    });

    it('createMarket writes the steps a judged or settled market has, and no others', async () => {
      const settledAt = new Date('2026-10-01T03:00:00.000Z');
      const resolved = await createMarket(t.db, { status: 'resolved', resolvedResult: 'YES' });
      const settled = await createMarket(t.db, {
        status: 'settled',
        resolvedResult: 'NO',
        settledAt,
      });
      const bare = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      const open = await createMarket(t.db);
      const rows = await t.db.select().from(marketSettlementSteps);
      const of = (marketId: string) => rows.filter((r) => r.marketId === marketId);
      expect(of(resolved.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'pending',
          attempts: 0,
          completedAt: null,
          lastError: null,
        }),
      ]);
      expect(of(settled.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'done',
          attempts: 1,
          completedAt: settledAt,
        }),
      ]);
      expect(of(bare.id)).toEqual([]);
      expect(of(open.id)).toEqual([]);
    });

    it('keeps one row per (market, step) and ties done to completed_at', async () => {
      const market = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      await createSettlementStep(t.db, { marketId: market.id });
      await expect(createSettlementStep(t.db, { marketId: market.id })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505',
      );
      const other = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      // done without a completion instant, or a completion instant on a step not done: 23514.
      await expect(
        createSettlementStep(t.db, { marketId: other.id, status: 'done' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      await expect(
        createSettlementStep(t.db, {
          marketId: other.id,
          status: 'failed',
          completedAt: new Date(),
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      await expect(
        createSettlementStep(t.db, { marketId: other.id, attempts: -1 }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      // The worker updates the row in place: not append-only.
      await t.db
        .update(marketSettlementSteps)
        .set({ status: 'failed', attempts: 1, lastError: 'boom' })
        .where(eq(marketSettlementSteps.marketId, market.id));
      const [row] = await t.db
        .select()
        .from(marketSettlementSteps)
        .where(eq(marketSettlementSteps.marketId, market.id));
      expect(row).toMatchObject({ status: 'failed', attempts: 1, lastError: 'boom' });
    });
  });

  it('rejects out-of-range prices via CHECK but takes no price at all', async () => {
    const market = await createMarket(t.db);
    for (const lastPrice of [0, 100]) {
      await expect(
        t.db.update(markets).set({ lastPrice }).where(eq(markets.id, market.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
    }
    const [priced] = await t.db
      .update(markets)
      .set({ lastPrice: 52 })
      .where(eq(markets.id, market.id))
      .returning();
    expect(priced!.lastPrice).toBe(52);
    const [cleared] = await t.db
      .update(markets)
      .set({ lastPrice: null })
      .where(eq(markets.id, market.id))
      .returning();
    expect(cleared!.lastPrice).toBeNull();
  });

  it('createMarket accepts a last price and statistics overrides', async () => {
    const market = await createMarket(t.db, { lastPrice: 37, volumeCoin: 12_345n, tradeCount: 7 });
    expect(market.lastPrice).toBe(37);
    expect(market.volumeCoin).toBe(12_345n);
    expect(market.tradeCount).toBe(7);
    for (const lastPrice of [0, 100, 52.5]) {
      await expect(createMarket(t.db, { lastPrice }), String(lastPrice)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it('createPosition inserts a holdings row and nothing else', async () => {
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    const row = await createPosition(t.db, {
      userId: u.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 550n,
    });
    expect(row).toMatchObject({
      qty: 10,
      costBasisCoin: 550n,
      realizedPnlCoin: 0n,
      settled: false,
    });
    expect(await t.db.select().from(positions)).toHaveLength(1);
    // No ledger entry at all: the trigger grants nothing (migration 0031), and neither does this.
    const entries = await t.db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, u.id));
    expect(entries).toEqual([]);
  });

  it('positions.version starts at 1 and every ORM update bumps it (migration 0010)', async () => {
    // The ordering key of a user:position event: $onUpdate puts the bump into the SET list
    // of any db.update() that does not set it, so no writer can forget it.
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    const row = await createPosition(t.db, {
      userId: u.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 550n,
    });
    expect(row.version).toBe(1);
    const where = and(
      eq(positions.userId, u.id),
      eq(positions.marketId, market.id),
      eq(positions.outcome, 'YES'),
    );
    const [once] = await t.db.update(positions).set({ qty: 11 }).where(where).returning();
    expect(once!.version).toBe(2);
    const [twice] = await t.db.update(positions).set({ settled: true }).where(where).returning();
    expect(twice!.version).toBe(3);
  });

  it('orders: an idempotency key is unique per user, not across users (migration 0009)', async () => {
    const { user: a } = await createUser(t.db);
    const { user: b } = await createUser(t.db);
    const market = await createMarket(t.db);
    const order = (userId: string, idempotencyKey: string) => ({
      userId,
      marketId: market.id,
      outcome: 'YES' as const,
      side: 'buy' as const,
      type: 'market' as const,
      qty: 1,
      filledQty: 1,
      status: 'filled' as const,
      idempotencyKey,
    });
    await t.db.insert(orders).values(order(a.id, 'client-key'));
    // Client-minted keys collide across accounts; that must not block the second user.
    await t.db.insert(orders).values(order(b.id, 'client-key'));
    expect(await t.db.select().from(orders)).toHaveLength(2);
    await expect(t.db.insert(orders).values(order(a.id, 'client-key'))).rejects.toSatisfy(
      (e) =>
        sqlState(e) === '23505' && sqlConstraint(e) === 'orders_user_id_idempotency_key_unique',
    );
  });

  describe('PG payment columns and events (migrations 0014, 0015)', () => {
    const payment = (userId: string, overrides: Partial<typeof payments.$inferInsert> = {}) => ({
      userId,
      amountCoin: 10_000n,
      priceKrw: 9_700,
      provider: 'mock',
      idempotencyKey: `key-${randomUUID()}`,
      ...overrides,
    });

    it('stores the new statuses and leaves the PG columns null until they are known', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db.insert(payments).values(payment(u.id)).returning();
      expect(row).toMatchObject({
        status: 'pending',
        method: null,
        approvedAt: null,
        refundedAt: null,
        resultMessage: null,
      });
      // 0014's values are usable once the migration run has committed.
      for (const status of ['cancelled', 'refunding', 'refunded'] as const) {
        const [updated] = await t.db
          .update(payments)
          .set({ status })
          .where(eq(payments.id, row!.id))
          .returning();
        expect(updated!.status).toBe(status);
      }
    });

    it('lets a PG transaction id name one payment only, and any number have none', async () => {
      const { user: u } = await createUser(t.db);
      // Pending rows have no reference yet: the index is partial, so they never collide.
      await t.db.insert(payments).values([payment(u.id), payment(u.id)]);
      await t.db.insert(payments).values(payment(u.id, { providerRef: 'T0001' }));
      // The same id under another provider is another transaction.
      await t.db.insert(payments).values(payment(u.id, { provider: 'acme', providerRef: 'T0001' }));
      await expect(
        t.db.insert(payments).values(payment(u.id, { providerRef: 'T0001' })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'payments_provider_provider_ref_unique',
      );
    });

    it('records payment events with an empty payload by default and keeps their payment', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db.insert(payments).values(payment(u.id)).returning();
      const [event] = await t.db
        .insert(paymentEvents)
        .values({ paymentId: row!.id, type: 'return' })
        .returning();
      expect(event).toMatchObject({ type: 'return', resultCode: null, payload: {} });
      // ON DELETE RESTRICT: a payment with a PG history cannot disappear under it (23503).
      await expect(t.db.delete(payments).where(eq(payments.id, row!.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
    });

    it('keeps one verification per account and one account per number (#183, ADR-0070)', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      expect(await isPhoneVerified(t.db, a.id)).toBe(false);
      const row = await createPhoneVerification(t.db, { userId: a.id, phone: '01012345678' });
      expect(row).toMatchObject({ userId: a.id, phone: '01012345678', realName: '홍길동' });
      expect(await isPhoneVerified(t.db, a.id)).toBe(true);
      expect(await isPhoneVerified(t.db, b.id)).toBe(false);
      expect(await isPhoneVerified(t.db, 'no-such-account')).toBe(false);
      // A second row for the account, and the number for another account: both refused.
      await expect(
        t.db
          .insert(phoneVerifications)
          .values({ userId: a.id, phone: '01099998888', realName: '김철수' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await expect(
        t.db
          .insert(phoneVerifications)
          .values({ userId: b.id, phone: '01012345678', realName: '김철수' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'phone_verifications_phone_unique',
      );
      // Only the digits phoneSchema yields: another spelling of the number is not another number.
      for (const phone of ['010-999-88', '0212345678', '01512345678', '0101234567x']) {
        await expect(
          t.db.insert(phoneVerifications).values({ userId: b.id, phone, realName: '김철수' }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verifications_phone_check',
        );
      }
    });

    it('keeps the codes sent, their counts and their account (#183, ADR-0070)', async () => {
      const { user: u } = await createUser(t.db);
      const code = (values: Partial<typeof phoneVerificationCodes.$inferInsert> = {}) => ({
        id: randomUUID(),
        userId: u.id,
        phone: '01012345678',
        realName: '홍길동',
        codeHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 180_000),
        ...values,
      });
      const [row] = await t.db.insert(phoneVerificationCodes).values(code()).returning();
      // A send is `unknown` until the provider takes it (migration 0030).
      expect(row).toMatchObject({
        attempts: 0,
        consumedAt: null,
        clientIp: null,
        sendOutcome: 'unknown',
      });
      expect(row!.sentAt.getTime()).toBeLessThan(row!.expiresAt.getTime());
      // The client address is an inet (migration 0029): one spelling of an address, so the
      // per-address limit counts `2001:DB8:0::1` and `2001:db8::1` as the address they are.
      const [addressed] = await t.db
        .insert(phoneVerificationCodes)
        .values(code({ clientIp: '2001:DB8:0:0::1' }))
        .returning();
      expect(addressed!.clientIp).toBe('2001:db8::1');
      await expect(
        t.db.insert(phoneVerificationCodes).values(code({ clientIp: 'not-an-address' })),
      ).rejects.toSatisfy((e) => sqlState(e) === '22P02');
      await expect(
        t.db.insert(phoneVerificationCodes).values(code({ attempts: -1 })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verification_codes_attempts_check',
      );
      await expect(
        t.db
          .insert(phoneVerificationCodes)
          .values(code({ sentAt: new Date(), expiresAt: new Date(Date.now() - 1_000) })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verification_codes_expiry_check',
      );
      // What the provider said: taken, or not yet known. A refused send is not a row here.
      const [accepted] = await t.db
        .update(phoneVerificationCodes)
        .set({ sendOutcome: 'accepted' })
        .where(eq(phoneVerificationCodes.id, row!.id))
        .returning();
      expect(accepted!.sendOutcome).toBe('accepted');
      await expect(
        t.db.execute(
          sql`UPDATE phone_verification_codes SET send_outcome = 'refused' WHERE id = ${row!.id}`,
        ),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' &&
          sqlConstraint(e) === 'phone_verification_codes_send_outcome_check',
      );
    });

    it('keeps a refused send’s time alone, never changed (#183, migration 0030)', async () => {
      const attemptedAt = new Date(Date.now() - 60_000);
      const [row] = await t.db
        .insert(phoneVerificationRefusedSends)
        .values({ attemptedAt })
        .returning();
      // The time and an id: no account, number, name or address to keep.
      expect(Object.keys(row!).sort()).toEqual(['attemptedAt', 'id']);
      expect(row!.attemptedAt.getTime()).toBe(attemptedAt.getTime());
      await expect(
        t.db
          .update(phoneVerificationRefusedSends)
          .set({ attemptedAt: new Date() })
          .where(eq(phoneVerificationRefusedSends.id, row!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // Deleted by the API once older than the week the status reads.
      await t.db
        .delete(phoneVerificationRefusedSends)
        .where(eq(phoneVerificationRefusedSends.id, row!.id));
      expect(await t.db.select().from(phoneVerificationRefusedSends)).toEqual([]);
    });
  });

  it('$onUpdate refreshes updated_at through the ORM', async () => {
    const { profile } = await createUser(t.db);
    await new Promise((r) => setTimeout(r, 5));
    const [updated] = await t.db
      .update(profiles)
      .set({ nickname: '새닉네임' })
      .where(eq(profiles.userId, profile.userId))
      .returning();
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(profile.updatedAt.getTime());
  });

  describe('timestamptz precision (migration 0005)', () => {
    it('round-trips a shared now() through a JS Date, which every keyset cursor relies on', async () => {
      // One statement, so all three rows carry a single transaction `now()`. While the columns
      // kept microseconds, the Date read back here was strictly older than the stored value,
      // and a cursor built from it skipped the whole group — page 2 of a listing came back
      // empty (@buddha/shared encodeKeyset compares `created_at < cursor OR = cursor AND ...`).
      await t.db
        .insert(auditFailures)
        .values([1, 2, 3].map((n) => ({ kind: 'ledger_balance_mismatch', payload: { n } })));

      const rows = await t.db.select().from(auditFailures);
      expect(rows).toHaveLength(3);
      const stamp = rows[0]!.createdAt;
      expect(rows.map((row) => row.createdAt.getTime())).toEqual([
        stamp.getTime(),
        stamp.getTime(),
        stamp.getTime(),
      ]);

      // The Date is an exact representation, so the rows still match the timestamp they
      // reported — and no row is stranded between `stamp` and its true stored value.
      const matched = await t.db
        .select()
        .from(auditFailures)
        .where(eq(auditFailures.createdAt, stamp));
      expect(matched).toHaveLength(3);
      const older = await t.db
        .select()
        .from(auditFailures)
        .where(lt(auditFailures.createdAt, stamp));
      expect(older).toHaveLength(0);
    });
  });

  describe('release settings (migration 0020, #170)', () => {
    const key = 'test.period_hours';
    type State = { status: 'undecided' | 'proposal' | 'test' | 'approved'; value: unknown };

    /** Instants 1 ms apart at least, like the API's: an UPDATE must move `updated_at` forward. */
    let last = 0;
    function nextInstant(): Date {
      last = Math.max(Date.now(), last + 1);
      return new Date(last);
    }

    /**
     * The change the API makes: its admin_actions record and the row, in one transaction, at
     * `record.at` for the record and `rowAt` for the row (both a fresh instant by default). The
     * record's `before` is the state the row holds when the change starts — undecided with no
     * value when there is no row — unless `record.before` replaces it; `record.payloadKey`
     * replaces the key the payload names (the one the change log shows), and `record.reason` the
     * reason (left out of the payload when undefined).
     */
    async function change(
      adminId: string,
      after: State,
      record: {
        adminId?: string;
        after?: State;
        before?: unknown;
        at?: Date;
        payloadKey?: string;
        reason?: unknown;
      } = {},
      rowAt?: Date,
    ) {
      const at = rowAt ?? nextInstant();
      await t.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: releaseSettings.status, value: storedReleaseSettingValue })
          .from(releaseSettings)
          .where(eq(releaseSettings.key, key));
        const before: State = {
          status: current?.status ?? 'undecided',
          value: current?.value ?? null,
        };
        await tx.insert(adminActions).values({
          adminId: record.adminId ?? adminId,
          type: 'release_setting_change',
          targetType: 'release_setting',
          targetId: key,
          payload: {
            key: record.payloadKey ?? key,
            before: 'before' in record ? record.before : before,
            after: record.after ?? after,
            reason: 'reason' in record ? record.reason : '시험',
          },
          createdAt: record.at ?? at,
        });
        await tx
          .insert(releaseSettings)
          .values({ key, ...after, updatedAt: at, updatedBy: adminId })
          .onConflictDoUpdate({
            target: releaseSettings.key,
            set: { ...after, updatedAt: at, updatedBy: adminId },
          });
      });
    }

    it('labels release_setting_status like RELEASE_SETTING_STATUSES', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT unnest(enum_range(NULL::release_setting_status))::text AS label`);
      expect(rows.map((row) => row.label)).toEqual([...RELEASE_SETTING_STATUSES]);
    });

    it('stores a change made with its record, and every later one', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      await change(admin.id, { status: 'approved', value: { from: 1, to: 2 } });
      await change(admin.id, { status: 'undecided', value: null });
      // From a stored undecided row (its record's `before` is undecided with no value), and from
      // a string that is JSON text (the record keeps the string, not what it spells).
      await change(admin.id, { status: 'proposal', value: '"24"' });
      await change(admin.id, { status: 'test', value: 24 });
      const rows = await t.db.select().from(releaseSettings);
      expect(rows).toMatchObject([{ key, status: 'test', value: 24, updatedBy: admin.id }]);
      // Each record's `before` is the previous one's `after`.
      const records = await t.db
        .select({ payload: adminActions.payload })
        .from(adminActions)
        .orderBy(adminActions.createdAt);
      expect(records.map((r) => (r.payload as { before: unknown }).before)).toEqual([
        { status: 'undecided', value: null },
        { status: 'test', value: 48 },
        { status: 'approved', value: { from: 1, to: 2 } },
        { status: 'undecided', value: null },
        { status: 'proposal', value: '"24"' },
      ]);
    });

    it('refuses, at commit, a write whose record is missing or tells another story', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const { user: other } = await createUser(t.db, { role: 'admin' });
      // No record at all: a bare INSERT, and a bare UPDATE (moving the instant on) of a row that
      // has one.
      await expect(
        t.db.insert(releaseSettings).values({
          key,
          status: 'test',
          value: 48,
          updatedAt: nextInstant(),
          updatedBy: admin.id,
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      await change(admin.id, { status: 'test', value: 48 });
      await expect(
        t.db
          .update(releaseSettings)
          .set({ value: 72, updatedAt: nextInstant() })
          .where(eq(releaseSettings.key, key)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      // A record of another value, another actor or another instant, or one that targets this
      // key but names another in its payload (the key the change log would show).
      for (const record of [
        { after: { status: 'test', value: 24 } as State },
        { after: { status: 'approved', value: 72 } as State },
        { adminId: other.id },
        { at: nextInstant() },
        { payloadKey: 'test.other_hours' },
      ]) {
        await expect(change(admin.id, { status: 'test', value: 72 }, record)).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      // Each refused transaction rolled back whole: the first change and its record only.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
    });

    it('refuses, at commit, a record whose `before` is not the state the write replaced', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // A first write (INSERT) replaces the implicit undecided state: any other `before` — a
      // decided one, undecided with a value, a value left out, no `before` at all — is refused.
      for (const before of [
        { status: 'test', value: 48 },
        { status: 'undecided', value: 48 },
        { status: 'undecided' },
        undefined,
      ]) {
        await expect(change(admin.id, { status: 'test', value: 48 }, { before })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toEqual([]);
      expect(await t.db.select().from(adminActions)).toEqual([]);

      await change(admin.id, { status: 'test', value: 48 });
      // An UPDATE replaces the old row's status and value: the undecided state a first write
      // records, another status, another value or none are all refused.
      for (const before of [
        { status: 'undecided', value: null },
        { status: 'approved', value: 48 },
        { status: 'test', value: 24 },
        { status: 'test', value: '48' },
        { status: 'test' },
        undefined,
      ]) {
        await expect(
          change(admin.id, { status: 'approved', value: 72 }, { before }),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      // Each refused transaction rolled back whole: the first change and its record only.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);

      // The true `before` passes, compared as JSON (key order aside).
      await change(admin.id, { status: 'approved', value: { from: 1, to: 2.5 } });
      await change(
        admin.id,
        { status: 'undecided', value: null },
        { before: { value: { to: 2.5, from: 1 }, status: 'approved' } },
      );
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'undecided', value: null },
      ]);
      // From a stored undecided row too, only the undecided state with no value passes.
      await expect(
        change(admin.id, { status: 'test', value: 24 }, { before: { status: 'undecided' } }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      await change(admin.id, { status: 'test', value: 24 });
      expect(await t.db.select().from(adminActions)).toHaveLength(4);
    });

    it('refuses, at commit, a record whose reason the API would not take', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // The API's reason: a string of 1 to 500 characters once trimmed, trimmed as JavaScript
      // does and counted in code points as zod does. Left out, not a string, blank — in any white
      // space JavaScript trims — or longer is refused, at a first write and at an UPDATE alike.
      const refused: unknown[] = [
        undefined,
        null,
        42,
        true,
        ['시험'],
        { text: '시험' },
        '',
        '   ',
        '\t\n\u000b\f\r\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
        'x'.repeat(501),
        ` ${'x'.repeat(501)} `,
        '😀'.repeat(501),
      ];
      for (const reason of refused) {
        expect(releaseSettingChangeBodySchema.shape.reason.safeParse(reason).success).toBe(false);
        await expect(change(admin.id, { status: 'test', value: 48 }, { reason })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toEqual([]);
      expect(await t.db.select().from(adminActions)).toEqual([]);

      await change(admin.id, { status: 'test', value: 48 });
      for (const reason of refused) {
        await expect(change(admin.id, { status: 'test', value: 72 }, { reason })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);

      // What the API takes passes, white space around it aside, and every record reads as the
      // change log expects. A character past U+FFFF is one (two UTF-16 units, four bytes).
      const accepted = ['x', 'x'.repeat(500), `\u3000 ${'x'.repeat(500)}\n\t`, '😀'.repeat(500)];
      for (const [i, reason] of accepted.entries()) {
        expect(releaseSettingChangeBodySchema.shape.reason.safeParse(reason).success).toBe(true);
        await change(admin.id, { status: 'proposal', value: i }, { reason });
      }
      const records = await t.db
        .select({ payload: adminActions.payload })
        .from(adminActions)
        .orderBy(adminActions.createdAt);
      expect(records).toHaveLength(1 + accepted.length);
      for (const { payload } of records) {
        expect(releaseSettingChangePayloadSchema.safeParse(payload).success).toBe(true);
      }
    });

    it('refuses, at commit, a record whose payload key is not the key as a string', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // A key that spells a JSON literal (the key pattern allows `true`) is met by its string
      // only: the change log reads the payload key as a string.
      const literal = 'true';
      const write = (payloadKey: unknown) =>
        t.db.transaction(async (tx) => {
          const at = nextInstant();
          const after: State = { status: 'test', value: 48 };
          await tx.insert(adminActions).values({
            adminId: admin.id,
            type: 'release_setting_change',
            targetType: 'release_setting',
            targetId: literal,
            payload: {
              key: payloadKey,
              before: { status: 'undecided', value: null },
              after,
              reason: '시험',
            },
            createdAt: at,
          });
          await tx
            .insert(releaseSettings)
            .values({ key: literal, ...after, updatedAt: at, updatedBy: admin.id });
        });
      await expect(write(true)).rejects.toSatisfy((e) => sqlState(e) === '23000');
      expect(await t.db.select().from(adminActions)).toEqual([]);
      await write(literal);
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { key: literal, status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
    });

    it('refuses an UPDATE that does not move the instant forward: no record is replayed', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const first = nextInstant();
      await change(admin.id, { status: 'test', value: 48 }, {}, first);
      const second = nextInstant();
      await change(admin.id, { status: 'undecided', value: null }, {}, second);
      // Back on an undecided row, the first change's record matches putting its state back in
      // all but the instant — the state it replaced, its new state, actor and key — and is
      // refused; so is rewriting the current state at its own instant.
      for (const [state, at] of [
        [{ status: 'test', value: 48 }, first],
        [{ status: 'undecided', value: null }, second],
      ] as const) {
        await expect(
          t.db
            .update(releaseSettings)
            .set({ ...state, updatedAt: at, updatedBy: admin.id })
            .where(eq(releaseSettings.key, key)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      // A fresh change with its own record, written at an earlier instant than the row's: refused.
      await expect(
        change(admin.id, { status: 'proposal', value: 24 }, {}, new Date(first.getTime() - 1)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'undecided', value: null, updatedAt: second },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(2);
    });

    it('refuses an UPDATE that renames a key, even with the record of the new one', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      // Everything the record check looks at matches the renamed row; only the key moved.
      const renamed = 'test.other_hours';
      const at = nextInstant();
      const after: State = { status: 'approved', value: 72 };
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(adminActions).values({
            adminId: admin.id,
            type: 'release_setting_change',
            targetType: 'release_setting',
            targetId: renamed,
            payload: {
              key: renamed,
              before: { status: 'test', value: 48 },
              after,
              reason: '시험',
            },
            createdAt: at,
          });
          await tx
            .update(releaseSettings)
            .set({ key: renamed, ...after, updatedAt: at, updatedBy: admin.id })
            .where(eq(releaseSettings.key, key));
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      // The key keeps its row (it does not fall back to undecided), and no record was added.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { key, status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
    });

    it('ties the value to the status: none while undecided, never JSON null', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      for (const state of [
        { status: 'undecided', value: 24 },
        { status: 'approved', value: null },
        { status: 'proposal', value: sql`'null'::jsonb` },
      ] as const) {
        await expect(
          t.db.insert(releaseSettings).values({
            key,
            status: state.status,
            value: state.value,
            updatedAt: new Date(),
            updatedBy: admin.id,
          }),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23514' && sqlConstraint(e) === 'release_settings_value_status_check',
        );
      }
    });

    it('cannot DELETE a setting', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      await expect(
        t.db.delete(releaseSettings).where(eq(releaseSettings.key, key)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });
  });

  describe('approval requests (migration 0021, #171)', () => {
    async function request(requestedBy: string) {
      const [row] = await t.db
        .insert(approvalRequests)
        .values({
          kind: 'test_kind',
          targetType: 'market',
          targetId: randomUUID(),
          payload: { note: '시험' },
          requestedBy,
          requestReason: '요청 사유',
          requestedAt: new Date(),
        })
        .returning();
      return row!;
    }
    const decision = (decidedBy: string, status: 'approved' | 'rejected' = 'approved') => ({
      status,
      decidedBy,
      decisionReason: '결정 사유',
      decidedAt: new Date(),
    });

    it('labels approval_status like APPROVAL_STATUSES', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT unnest(enum_range(NULL::approval_status))::text AS label`);
      expect(rows.map((row) => row.label)).toEqual([...APPROVAL_STATUSES]);
    });

    it('takes one decision by another account, with its decider, reason and instant', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      expect(row).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null });
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id));
      const [decided] = await t.db.select().from(approvalRequests);
      expect(decided).toMatchObject({ status: 'approved', decidedBy: decider.id });
    });

    it('refuses a decision by the requester, whoever writes it', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const status of ['approved', 'rejected'] as const) {
        await expect(
          t.db
            .update(approvalRequests)
            .set(decision(requester.id, status))
            .where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23514' &&
            sqlConstraint(e) === 'approval_requests_decider_not_requester_check',
        );
      }
      // Not even inserted decided (the INSERT trigger refuses any decided row first).
      await expect(
        t.db.insert(approvalRequests).values({
          kind: 'test_kind',
          requestedBy: requester.id,
          requestReason: '요청 사유',
          requestedAt: new Date(),
          ...decision(requester.id),
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
    });

    it('inserts a request pending with no decision only, whoever writes it', async () => {
      // A decided row by another account satisfies every CHECK: inserting one would skip the
      // pending phase, and with it ApprovalService's check that the decider is an admin now.
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const base = {
        kind: 'test_kind',
        requestedBy: requester.id,
        requestReason: '요청 사유',
        requestedAt: new Date(),
      };
      for (const values of [
        { ...base, ...decision(decider.id, 'approved') },
        { ...base, ...decision(decider.id, 'rejected') },
        // Pending with a decision column set: refused before the CHECK would be.
        { ...base, decidedBy: decider.id },
        { ...base, decisionReason: '결정 사유' },
        { ...base, decidedAt: new Date() },
      ]) {
        await expect(
          t.db.insert(approvalRequests).values(values),
          JSON.stringify(Object.keys(values)),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23000' &&
            errorMessage(e).includes('must be inserted pending, with no decision'),
        );
      }
      expect(await t.db.select().from(approvalRequests)).toEqual([]);
      // Pending, given explicitly or by the default, is a request.
      await t.db.insert(approvalRequests).values({ ...base, status: 'pending' });
      await t.db.insert(approvalRequests).values(base);
      expect(await t.db.select().from(approvalRequests)).toHaveLength(2);
    });

    it('ties the decision columns to the status and requires non-blank reasons', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const set of [
        { status: 'approved' as const },
        { decidedBy: decider.id },
        { ...decision(decider.id), decisionReason: null },
        { ...decision(decider.id), decidedAt: null },
        { ...decision(decider.id), status: 'pending' as const },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_decision_check',
        );
      }
      await expect(
        t.db
          .update(approvalRequests)
          .set({ ...decision(decider.id), decisionReason: '  ' })
          .where(eq(approvalRequests.id, row.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_reasons_check',
      );
      await expect(
        t.db.insert(approvalRequests).values({
          kind: 'test_kind',
          requestedBy: requester.id,
          requestReason: ' ',
          requestedAt: new Date(),
        }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_reasons_check',
      );
    });

    it('never changes what was requested, nor a decided request', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const { user: other } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const set of [
        { kind: 'other_kind' },
        { targetId: randomUUID() },
        { payload: { note: '바꿈' } },
        { requestedBy: other.id },
        { requestReason: '다른 사유' },
        { requestedAt: new Date(0) },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id, 'rejected'))
        .where(eq(approvalRequests.id, row.id));
      // Decided once: another decision, another decider or back to pending are all refused.
      for (const set of [
        decision(decider.id, 'approved'),
        decision(other.id, 'rejected'),
        { status: 'pending' as const, decidedBy: null, decisionReason: null, decidedAt: null },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      expect(await t.db.select().from(approvalRequests)).toMatchObject([
        { status: 'rejected', decidedBy: decider.id, decisionReason: '결정 사유' },
      ]);
    });

    it('takes a retraction: retracted at its instant with no decision, and never changed after (migration 0042, #139)', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      const retraction = { status: 'retracted' as const, retractedAt: new Date() };
      // The retraction's instant comes with it and only with it, and no decision with it.
      for (const set of [
        { status: 'retracted' as const },
        { retractedAt: new Date() },
        { ...retraction, decidedBy: decider.id },
        { ...retraction, ...decision(decider.id) },
        { ...decision(decider.id), retractedAt: new Date() },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
          JSON.stringify(Object.keys(set)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_decision_check',
        );
      }
      // Never inserted retracted, nor pending with a retraction's instant.
      const base = {
        kind: 'test_kind',
        requestedBy: requester.id,
        requestReason: '요청 사유',
        requestedAt: new Date(),
      };
      await expect(
        t.db.insert(approvalRequests).values({ ...base, ...retraction }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      await expect(
        t.db.insert(approvalRequests).values({ ...base, retractedAt: new Date() }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_decision_check',
      );
      await t.db.update(approvalRequests).set(retraction).where(eq(approvalRequests.id, row.id));
      // Closed: no decision, no second retraction, not back to pending.
      for (const set of [
        { ...decision(decider.id), retractedAt: null },
        decision(decider.id, 'rejected'),
        { retractedAt: new Date() },
        { status: 'pending' as const, retractedAt: null },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      expect(await t.db.select().from(approvalRequests)).toMatchObject([
        { status: 'retracted', decidedBy: null, decisionReason: null, decidedAt: null },
      ]);
      // A decided request is not retracted either.
      const decided = await request(requester.id);
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, decided.id));
      await expect(
        t.db
          .update(approvalRequests)
          .set({ ...retraction, decidedBy: null, decisionReason: null, decidedAt: null })
          .where(eq(approvalRequests.id, decided.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
    });

    it('refuses a decision by an account that is not an admin as it decides, whoever writes it', async () => {
      // buddha_app keeps UPDATE: a write past ApprovalService must not make a member's (or a
      // revoked admin's) approval look like another admin's.
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: member } = await createUser(t.db);
      const { user: revoked } = await createUser(t.db, { role: 'admin' });
      await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, revoked.id));
      const row = await request(requester.id);
      for (const decider of [member.id, revoked.id]) {
        for (const status of ['approved', 'rejected'] as const) {
          await expect(
            t.db
              .update(approvalRequests)
              .set(decision(decider, status))
              .where(eq(approvalRequests.id, row.id)),
            `${decider} ${status}`,
          ).rejects.toSatisfy(
            (e) =>
              sqlState(e) === '23000' && errorMessage(e).includes('must be decided by an admin'),
          );
        }
      }
      expect(await t.db.select().from(approvalRequests)).toEqual([row]);
      // An admin's decision still goes through.
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id));
      expect(await t.db.select().from(approvalRequests)).toMatchObject([
        { status: 'approved', decidedBy: decider.id },
      ]);
    });

    it('reads the decider under the admin-roles lock, taken before the request row', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      // A revoke of the decider in flight: it holds the admin-roles lock exclusively and has
      // written the role, not committed yet.
      let revoked!: () => void;
      const revoking = new Promise<void>((resolve) => (revoked = resolve));
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => (commit = resolve));
      const revoke = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        await tx.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, decider.id));
        revoked();
        await committing;
      });
      await revoking;

      let settled = false;
      const deciding = t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id))
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => (settled = true));
      try {
        // The direct UPDATE waits on the role lock rather than reading the role the revoke has
        // not committed yet…
        let waiting = false;
        for (let attempt = 0; attempt < 250 && !waiting && !settled; attempt++) {
          const { rows } = await t.db.execute<{ waiting: number }>(sql`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'
              AND query ILIKE '%approval_requests%'`);
          waiting = (rows[0]?.waiting ?? 0) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        // …and holds no lock on the request row meanwhile: the lock comes first, as in
        // ApprovalService, so a decision through the service is not blocked behind it.
        await t.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM approval_requests WHERE id = ${row.id} FOR UPDATE NOWAIT`,
          );
        });
      } finally {
        commit();
        await revoke;
      }
      // Once the revoke commits, the decider is a member and the decision is refused.
      const error = await deciding;
      expect(sqlState(error)).toBe('23000');
      expect(errorMessage(error)).toContain('must be decided by an admin');
      expect(await t.db.select().from(approvalRequests)).toEqual([row]);
    });

    it('cannot DELETE a request', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      await expect(
        t.db.delete(approvalRequests).where(eq(approvalRequests.id, row.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });
  });

  describe('start grants (migration 0031, #70, ADR-0071)', () => {
    const amountOf = (amount: bigint | null) => () => Promise.resolve(amount);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    async function ledgerOf(userId: string) {
      return t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, userId))
        .orderBy(ledgerEntries.id);
    }

    async function numbersOf(grantId: string) {
      return t.db
        .select()
        .from(startGrantNumbers)
        .where(eq(startGrantNumbers.grantId, grantId))
        .orderBy(startGrantNumbers.createdAt, startGrantNumbers.source);
    }

    /** `recordStartGrant` in a transaction of its own, for an account with a 본인확인 record. */
    async function record(userId: string, phoneHash: string) {
      await createPhoneVerification(t.db, { userId }).catch(() => undefined);
      return t.db.transaction((tx) => recordStartGrant(tx, userId, phoneHash));
    }

    /** An operator's record of another number for the account's grant (docs/OPERATIONS.md). */
    async function recordOperatorNumber(grantId: string, phoneHash: string) {
      const [row] = await t.db
        .insert(startGrantNumbers)
        .values({ grantId, phoneHash, source: 'operator' })
        .returning();
      return row!;
    }

    it('records one grant per account, holding its number; a number counts for one grant', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const hash = randomPhoneHash();
      const first = await record(a.id, hash);
      expect(first.outcome).toBe('recorded');
      if (first.outcome !== 'recorded') throw new Error('not recorded');
      const [grant] = await t.db.select().from(startGrants);
      expect(grant).toMatchObject({
        id: first.grantId,
        userId: a.id,
        amountCoin: null,
        ledgerEntryId: null,
        grantedAt: null,
        cancelledAt: null,
      });
      expect(await numbersOf(first.grantId)).toEqual([
        expect.objectContaining({ phoneHash: hash, source: 'grant', releasedAt: null }),
      ]);
      // Again for the same account, with another number now (an operator changed it): its grant.
      expect(await record(a.id, randomPhoneHash())).toEqual({
        outcome: 'existing',
        grantId: first.grantId,
      });
      // The same number for another account (a re-signup after a withdrawal): nothing recorded.
      expect(await record(b.id, hash)).toEqual({ outcome: 'number_already_used' });
      expect(await t.db.select().from(startGrants)).toEqual([grant]);
      expect(await t.db.select().from(startGrantNumbers)).toHaveLength(1);
    });

    it('holds the rules in the constraints: per account, per live number, per grant', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const hash = randomPhoneHash();
      const grant = await createStartGrant(t.db, { userId: a.id, phoneHash: hash });
      const other = await createStartGrant(t.db, { userId: b.id });
      const violates =
        (constraint: string, state = '23505') =>
        (e: unknown) =>
          sqlState(e) === state && sqlConstraint(e) === constraint;
      // A second grant for the account.
      await expect(
        t.db.transaction(async (tx) => {
          const [row] = await tx.insert(startGrants).values({ userId: a.id }).returning();
          await tx
            .insert(startGrantNumbers)
            .values({ grantId: row!.id, phoneHash: randomPhoneHash(), source: 'grant' });
        }),
      ).rejects.toSatisfy(violates('start_grants_user_id_unique'));
      // The number held by another grant, whatever the source.
      for (const source of ['operator', 'grant'] as const) {
        await expect(
          t.db.insert(startGrantNumbers).values({ grantId: other.id, phoneHash: hash, source }),
        ).rejects.toSatisfy(violates('start_grant_numbers_phone_hash_live_idx'));
      }
      // A second number of the grant's own kind; the same number twice for one grant.
      await expect(
        t.db
          .insert(startGrantNumbers)
          .values({ grantId: grant.id, phoneHash: randomPhoneHash(), source: 'grant' }),
      ).rejects.toSatisfy(violates('start_grant_numbers_grant_id_source_grant_idx'));
      await expect(
        t.db
          .insert(startGrantNumbers)
          .values({ grantId: grant.id, phoneHash: hash, source: 'operator' }),
      ).rejects.toSatisfy(violates('start_grant_numbers_grant_id_phone_hash_pk'));
      // A hash is 64 lower-case hex characters, never a number in clear; a source is one of two.
      for (const phoneHash of ['01012345678', 'A'.repeat(64), 'a'.repeat(63)]) {
        await expect(
          t.db
            .insert(startGrantNumbers)
            .values({ grantId: grant.id, phoneHash, source: 'operator' }),
        ).rejects.toSatisfy(violates('start_grant_numbers_phone_hash_check', '23514'));
      }
      await expect(
        t.db.execute(
          sql`INSERT INTO start_grant_numbers (phone_hash, grant_id, source) VALUES (${randomPhoneHash()}, ${grant.id}, 'member')`,
        ),
      ).rejects.toSatisfy(violates('start_grant_numbers_source_check', '23514'));
      // A grant recorded without its number is refused when its transaction commits.
      const { user: c } = await createUser(t.db);
      await expect(t.db.insert(startGrants).values({ userId: c.id })).rejects.toSatisfy(
        (e) => sqlState(e) === '23000' && /recorded without its number/.test(errorMessage(e)),
      );
      expect(await t.db.select().from(startGrants).where(eq(startGrants.userId, c.id))).toEqual([]);
    });

    it('records an operator number beside the grant: both count, and the grant is still one', async () => {
      const { user: a } = await createUser(t.db);
      const first = randomPhoneHash();
      const second = randomPhoneHash();
      const grant = await createStartGrant(t.db, {
        userId: a.id,
        phoneHash: first,
        amountCoin: 100n,
      });
      await recordOperatorNumber(grant.id, second);
      expect((await numbersOf(grant.id)).map((n) => [n.phoneHash, n.source])).toEqual([
        [first, 'grant'],
        [second, 'operator'],
      ]);
      // A later account on either number gets nothing; the account has one grant and one entry.
      for (const hash of [first, second]) {
        const { user: later } = await createUser(t.db);
        expect(await record(later.id, hash)).toEqual({ outcome: 'number_already_used' });
      }
      expect(await t.db.select().from(startGrants)).toEqual([grant]);
      expect((await ledgerOf(a.id)).map((e) => e.type)).toEqual(['START_GRANT']);
    });

    it('records once when calls for one account, or for one number, come at the same time', async () => {
      const { user: a } = await createUser(t.db);
      await createPhoneVerification(t.db, { userId: a.id });
      const hash = randomPhoneHash();
      const same = await Promise.all(
        Array.from({ length: 4 }, () => t.db.transaction((tx) => recordStartGrant(tx, a.id, hash))),
      );
      expect(same.map((r) => r.outcome).sort()).toEqual([
        'existing',
        'existing',
        'existing',
        'recorded',
      ]);
      // Four accounts on one number at once (the constraint, not phone_verifications, decides).
      const accounts = await Promise.all(
        Array.from({ length: 4 }, async () => (await createUser(t.db)).user.id),
      );
      const shared = randomPhoneHash();
      const racing = await Promise.all(
        accounts.map((id) => t.db.transaction((tx) => recordStartGrant(tx, id, shared))),
      );
      expect(racing.map((r) => r.outcome).sort()).toEqual([
        'number_already_used',
        'number_already_used',
        'number_already_used',
        'recorded',
      ]);
      expect(await t.db.select().from(startGrants)).toHaveLength(2);
      expect(await t.db.select().from(startGrantNumbers)).toHaveLength(2);
    });

    it('pays a grant once: the balance, one START_GRANT entry and the row together', async () => {
      const { user: u } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: u.id });
      const first = await t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(10_000n)));
      expect(first.outcome).toBe('granted');
      if (first.outcome !== 'granted') throw new Error('not granted');
      expect(first.ledgerEntry).toMatchObject({
        userId: u.id,
        type: 'START_GRANT',
        amountCoin: 10_000n,
        balanceAfterCoin: 10_000n,
        refType: 'start_grant',
        refId: grant.id,
        memo: null,
      });
      expect(first.grant).toMatchObject({
        amountCoin: 10_000n,
        ledgerEntryId: first.ledgerEntry.id,
        grantedAt: first.ledgerEntry.createdAt,
        cancelledAt: null,
      });
      expect(first.balance.availableCoin).toBe(10_000n);
      // Again, with another amount: paid already, nothing written, the amount it got stays.
      const again = await t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(5_000n)));
      expect(again).toEqual({ outcome: 'already_granted', grant: first.grant });
      expect((await ledgerOf(u.id)).map((e) => [e.type, e.amountCoin])).toEqual([
        ['START_GRANT', 10_000n],
      ]);
    });

    it('leaves a grant pending while the amount is undecided, then pays the value set later', async () => {
      const { user: u } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: u.id });
      const waiting = await t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(null)));
      expect(waiting).toEqual({ outcome: 'pending', grant });
      expect(await ledgerOf(u.id)).toEqual([]);
      expect(await pendingStartGrantIds(t.db, 10)).toEqual([grant.id]);
      const paid = await t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(3_000n)));
      expect(paid.outcome).toBe('granted');
      expect(await pendingStartGrantIds(t.db, 10)).toEqual([]);
    });

    it('pays once when two transactions pay one grant at the same time', async () => {
      const { user: u } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: u.id });
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(10_000n))),
        ),
      );
      expect(outcomes.map((o) => o.outcome).sort()).toEqual([
        'already_granted',
        'already_granted',
        'already_granted',
        'granted',
      ]);
      expect((await ledgerOf(u.id)).map((e) => e.type)).toEqual(['START_GRANT']);
      const [balance] = await t.db.select().from(balances).where(eq(balances.userId, u.id));
      expect(balance!.availableCoin).toBe(10_000n);
    });

    it('lists pending grants oldest first, up to the limit, and no paid or cancelled one', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { user: u } = await createUser(t.db);
        ids.push((await createStartGrant(t.db, { userId: u.id })).id);
      }
      const { user: paid } = await createUser(t.db);
      await createStartGrant(t.db, { userId: paid.id, amountCoin: 100n });
      const { user: withdrew } = await createUser(t.db);
      await createStartGrant(t.db, { userId: withdrew.id });
      await t.db.transaction((tx) => cancelStartGrant(tx, withdrew.id));
      expect(await pendingStartGrantIds(t.db, 10)).toEqual(ids);
      expect(await pendingStartGrantIds(t.db, 2)).toEqual(ids.slice(0, 2));
    });

    it('records a grant pending only, and pays it through the CHECKs: all three columns, a positive amount', async () => {
      const { user: u } = await createUser(t.db, { balanceCoin: 100n });
      const [entry] = await ledgerOf(u.id);
      // Inserted with anything paid or cancelled: refused by migration 0031's insert trigger,
      // before the CHECKs (a BEFORE ROW trigger runs first) — a payment is the checked UPDATE.
      const insertRefused = (e: unknown) =>
        sqlState(e) === '23000' && /must be inserted pending/.test(errorMessage(e));
      for (const values of [
        { amountCoin: 100n },
        { grantedAt: new Date() },
        { ledgerEntryId: entry!.id },
        { cancelledAt: new Date() },
        { amountCoin: 100n, grantedAt: new Date() },
        { amountCoin: 0n, grantedAt: new Date(), ledgerEntryId: entry!.id },
      ]) {
        await expect(
          t.db.insert(startGrants).values({ userId: u.id, ...values }),
        ).rejects.toSatisfy(insertRefused);
      }
      // The CHECKs, on the one way to pay: an UPDATE of the pending row.
      const pending = await createStartGrant(t.db, { userId: u.id });
      for (const set of [{ amountCoin: 100n }, { ledgerEntryId: entry!.id }]) {
        await expect(
          t.db.update(startGrants).set(set).where(eq(startGrants.id, pending.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'start_grants_paid_check',
        );
      }
      // A zero payment by an entry that is otherwise its own: only the amount's CHECK refuses it.
      const [zero] = await t.db
        .insert(ledgerEntries)
        .values({
          userId: u.id,
          type: 'START_GRANT',
          amountCoin: 0n,
          balanceAfterCoin: 100n,
          refType: 'start_grant',
          refId: pending.id,
        })
        .returning();
      await expect(
        t.db
          .update(startGrants)
          .set({ amountCoin: 0n, ledgerEntryId: zero!.id, grantedAt: new Date() })
          .where(eq(startGrants.id, pending.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'start_grants_amount_coin_check',
      );
      // Paid and cancelled at once, by an entry that would pay it: the settled CHECK.
      const [own] = await t.db
        .insert(ledgerEntries)
        .values({
          userId: u.id,
          type: 'START_GRANT',
          amountCoin: 100n,
          balanceAfterCoin: 200n,
          refType: 'start_grant',
          refId: pending.id,
        })
        .returning();
      await expect(
        t.db
          .update(startGrants)
          .set({
            amountCoin: 100n,
            ledgerEntryId: own!.id,
            grantedAt: new Date(),
            cancelledAt: new Date(),
          })
          .where(eq(startGrants.id, pending.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'start_grants_settled_check',
      );
    });

    it('never takes a grant inserted paid, not even with an entry that would pay it', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db, { balanceCoin: 100n });
      const refused = (e: unknown) =>
        sqlState(e) === '23000' && /must be inserted pending/.test(errorMessage(e));
      // B's ADMIN_ADJUST entry of the same amount: the grant would say A got Coin B holds, and the
      // number would count as paid with no START_GRANT entry — for good, as the app cannot fix it.
      const [adjust] = await ledgerOf(b.id);
      await expect(
        t.db.insert(startGrants).values({
          userId: a.id,
          amountCoin: 100n,
          ledgerEntryId: adjust!.id,
          grantedAt: new Date(),
        }),
      ).rejects.toSatisfy(refused);
      // A's own START_GRANT entry naming the row to be: still refused, the row starts pending.
      const id = randomUUID();
      const [own] = await t.db
        .insert(ledgerEntries)
        .values({
          userId: a.id,
          type: 'START_GRANT',
          amountCoin: 100n,
          balanceAfterCoin: 100n,
          refType: 'start_grant',
          refId: id,
        })
        .returning();
      await expect(
        t.db.insert(startGrants).values({
          id,
          userId: a.id,
          amountCoin: 100n,
          ledgerEntryId: own!.id,
          grantedAt: new Date(),
        }),
      ).rejects.toSatisfy(refused);
      expect(await t.db.select().from(startGrants)).toEqual([]);
    });

    it('never rewrites a record, nor pays it with an entry that is not its own START_GRANT', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db, { balanceCoin: 700n });
      const pending = await createStartGrant(t.db, { userId: a.id });
      const another = await createStartGrant(t.db, { userId: b.id });
      // Each refusal is matched by its own message, so a case cannot pass on another check's.
      const identityRefused = (e: unknown) =>
        sqlState(e) === '23000' &&
        /its account and recording time never change/.test(errorMessage(e));
      const notItsOwn = (e: unknown) =>
        sqlState(e) === '23000' && /is paid only by its own START_GRANT/.test(errorMessage(e));
      const paidRefused = (e: unknown) =>
        sqlState(e) === '23000' &&
        /was paid at .*: a paid grant never changes/.test(errorMessage(e));
      // The account and the time it was recorded never change.
      for (const set of [{ userId: b.id }, { createdAt: new Date(0) }]) {
        await expect(
          t.db.update(startGrants).set(set).where(eq(startGrants.id, pending.id)),
        ).rejects.toSatisfy(identityRefused);
      }

      // Paid by an entry that is this grant's own START_GRANT in every field but one: each
      // condition of the trigger's check, on its own (ledger_entry_id is UNIQUE, so one entry each).
      const entry = async (values: Partial<typeof ledgerEntries.$inferInsert>) => {
        const [row] = await t.db
          .insert(ledgerEntries)
          .values({
            userId: a.id,
            type: 'START_GRANT',
            amountCoin: 700n,
            balanceAfterCoin: 700n,
            refType: 'start_grant',
            refId: pending.id,
            ...values,
          })
          .returning();
        return row!;
      };
      const payWith = (ledgerEntryId: number) =>
        t.db
          .update(startGrants)
          .set({ amountCoin: 700n, ledgerEntryId, grantedAt: new Date() })
          .where(eq(startGrants.id, pending.id));
      const [adjust] = await ledgerOf(b.id);
      const oneFieldOff: Partial<typeof ledgerEntries.$inferInsert>[] = [
        { userId: b.id }, // another account's: the grant would say A got Coin that B holds
        { type: 'ADMIN_ADJUST' }, // not a start grant
        { refType: 'admin_action' }, // pointing at something else
        { refId: another.id }, // another grant's
        { amountCoin: 50n, balanceAfterCoin: 50n }, // another amount
      ];
      for (const values of oneFieldOff) {
        await expect(payWith((await entry(values)).id)).rejects.toSatisfy(notItsOwn);
      }
      await expect(payWith(adjust!.id)).rejects.toSatisfy(notItsOwn);
      // The entry named is the one checked: with A's own START_GRANT entry in the ledger, naming
      // B's ADMIN_ADJUST of the same amount is still refused…
      const own = await entry({});
      await expect(payWith(adjust!.id)).rejects.toSatisfy(notItsOwn);
      // …and naming its own pays it (the check is not blind).
      await payWith(own.id);

      // A paid grant never changes again: not back to pending (the next run would pay it a second
      // START_GRANT entry), not to another entry that passes every other check, not another
      // amount, and it is never cancelled (its numbers stay used).
      await expect(
        t.db
          .update(startGrants)
          .set({ amountCoin: null, ledgerEntryId: null, grantedAt: null })
          .where(eq(startGrants.id, pending.id)),
      ).rejects.toSatisfy(paidRefused);
      await expect(payWith((await entry({})).id)).rejects.toSatisfy(paidRefused);
      await expect(
        t.db.update(startGrants).set({ amountCoin: 200n }).where(eq(startGrants.id, pending.id)),
      ).rejects.toSatisfy(paidRefused);
      await expect(
        t.db
          .update(startGrants)
          .set({ amountCoin: null, ledgerEntryId: null, grantedAt: null, cancelledAt: new Date() })
          .where(eq(startGrants.id, pending.id)),
      ).rejects.toSatisfy(paidRefused);
      // No row is ever deleted by the app, pending or paid, nor any number.
      for (const id of [another.id, pending.id]) {
        await expect(t.db.delete(startGrants).where(eq(startGrants.id, id))).rejects.toSatisfy(
          (e) => sqlState(e) === '42501',
        );
        await expect(
          t.db.delete(startGrantNumbers).where(eq(startGrantNumbers.grantId, id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      }
    });

    it('cancels a waiting grant and frees its numbers: the next account on the number is granted', async () => {
      const { user: a } = await createUser(t.db);
      const own = randomPhoneHash();
      const recorded = randomPhoneHash();
      const grant = await createStartGrant(t.db, { userId: a.id, phoneHash: own });
      await recordOperatorNumber(grant.id, recorded);
      // The withdrawal (#140): the 본인확인 record goes and the waiting grant is cancelled, in one
      // transaction.
      const result = await t.db.transaction(async (tx) => {
        await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, a.id));
        return cancelStartGrant(tx, a.id);
      });
      expect(result.outcome).toBe('cancelled');
      if (result.outcome !== 'cancelled') throw new Error('not cancelled');
      expect(result.grant).toMatchObject({ id: grant.id, cancelledAt: expect.any(Date) as Date });
      expect(result.grant.grantedAt).toBeNull();
      // Every number it held is released at the cancellation's instant, and kept as history.
      expect(result.released.map((n) => [n.phoneHash, n.releasedAt])).toEqual([
        [own, result.grant.cancelledAt],
        [recorded, result.grant.cancelledAt],
      ]);
      expect(await numbersOf(grant.id)).toEqual(result.released);
      // Never paid now, by any payer, whatever the amount; not pending any more.
      const paid = await t.db.transaction((tx) => payStartGrant(tx, grant.id, amountOf(10_000n)));
      expect(paid).toEqual({ outcome: 'cancelled', grant: result.grant });
      expect(await pendingStartGrantIds(t.db, 10)).toEqual([]);
      expect(await ledgerOf(a.id)).toEqual([]);
      // Again: nothing more.
      expect(await t.db.transaction((tx) => cancelStartGrant(tx, a.id))).toEqual({
        outcome: 'already_cancelled',
        grant: result.grant,
      });

      // The next account that verifies either number records its own grant, and is paid.
      for (const hash of [own, recorded]) {
        const { user: next } = await createUser(t.db);
        const again = await record(next.id, hash);
        expect(again.outcome).toBe('recorded');
        if (again.outcome !== 'recorded') throw new Error('not recorded');
        const pay = await t.db.transaction((tx) =>
          payStartGrant(tx, again.grantId, amountOf(10_000n)),
        );
        expect(pay.outcome).toBe('granted');
        expect((await ledgerOf(next.id)).map((e) => [e.type, e.amountCoin])).toEqual([
          ['START_GRANT', 10_000n],
        ]);
      }
      // The cancelled grant stays, with its released numbers.
      expect(await t.db.select().from(startGrants).where(eq(startGrants.id, grant.id))).toEqual([
        result.grant,
      ]);
    });

    it('cancels nothing that was paid, nor an account with no grant; a cancelled grant never changes', async () => {
      const { user: paid } = await createUser(t.db);
      const hash = randomPhoneHash();
      const grant = await createStartGrant(t.db, {
        userId: paid.id,
        phoneHash: hash,
        amountCoin: 100n,
      });
      expect(await t.db.transaction((tx) => cancelStartGrant(tx, paid.id))).toEqual({
        outcome: 'granted',
        grant,
      });
      // Still paid, its number still used: the next account on it gets nothing.
      expect(await t.db.select().from(startGrants)).toEqual([grant]);
      const { user: next } = await createUser(t.db);
      expect(await record(next.id, hash)).toEqual({ outcome: 'number_already_used' });
      const { user: none } = await createUser(t.db);
      expect(await t.db.transaction((tx) => cancelStartGrant(tx, none.id))).toEqual({
        outcome: 'none',
      });

      // A cancelled grant: not paid, not back to pending, its time never moved.
      const { user: gone } = await createUser(t.db);
      const waiting = await createStartGrant(t.db, { userId: gone.id });
      await t.db.transaction((tx) => cancelStartGrant(tx, gone.id));
      const cancelledRefused = (e: unknown) =>
        sqlState(e) === '23000' &&
        /was cancelled at .*: a cancelled grant never changes/.test(errorMessage(e));
      for (const set of [{ cancelledAt: null }, { cancelledAt: new Date(0) }]) {
        await expect(
          t.db.update(startGrants).set(set).where(eq(startGrants.id, waiting.id)),
        ).rejects.toSatisfy(cancelledRefused);
      }
    });

    it('keeps a number record to its release by its own grant’s cancellation', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: a.id });
      const [number] = await numbersOf(grant.id);
      const where = and(
        eq(startGrantNumbers.grantId, grant.id),
        eq(startGrantNumbers.phoneHash, number!.phoneHash),
      );
      const other = await createStartGrant(t.db, { userId: b.id });
      const fixed = (e: unknown) =>
        sqlState(e) === '23000' &&
        /its number, grant, source and recording time never change/.test(errorMessage(e));
      for (const set of [
        { phoneHash: randomPhoneHash() },
        { grantId: other.id },
        { source: 'operator' as const },
        { createdAt: new Date(0) },
      ]) {
        await expect(t.db.update(startGrantNumbers).set(set).where(where)).rejects.toSatisfy(fixed);
      }
      // Released only by the grant's cancellation, never by hand while the grant stands.
      await expect(
        t.db.update(startGrantNumbers).set({ releasedAt: new Date() }).where(where),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23000' &&
          /released only by the grant's cancellation/.test(errorMessage(e)),
      );
      // Inserted held only.
      await expect(
        t.db.insert(startGrantNumbers).values({
          grantId: grant.id,
          phoneHash: randomPhoneHash(),
          source: 'operator',
          releasedAt: new Date(),
        }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23000' && /must be inserted held/.test(errorMessage(e)),
      );
      // A cancelled grant records no number, and its released rows never change again.
      await t.db.transaction((tx) => cancelStartGrant(tx, a.id));
      await expect(recordOperatorNumber(grant.id, randomPhoneHash())).rejects.toSatisfy(
        (e) => sqlState(e) === '23000' && /it records no number/.test(errorMessage(e)),
      );
      await expect(
        t.db.update(startGrantNumbers).set({ releasedAt: null }).where(where),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23000' &&
          /was released at .*: a released number never changes/.test(errorMessage(e)),
      );
    });

    it('cancels or pays, never both, when a withdrawal and a payment meet', async () => {
      // The withdrawal first: the payment waits on the 본인확인 record, then finds it cancelled.
      const { user: a } = await createUser(t.db);
      const first = await createStartGrant(t.db, { userId: a.id });
      let resume!: () => void;
      const held = new Promise<void>((resolve) => (resume = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const withdrawal = t.db.transaction(async (tx) => {
        expect((await cancelStartGrant(tx, a.id)).outcome).toBe('cancelled');
        await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, a.id));
        entered();
        await held;
      });
      await inside;
      let paidAt: number | undefined;
      const payment = t.db
        .transaction((tx) => payStartGrant(tx, first.id, amountOf(10_000n)))
        .finally(() => (paidAt = Date.now()));
      await pause(150);
      expect(paidAt).toBeUndefined();
      resume();
      await withdrawal;
      expect((await payment).outcome).toBe('cancelled');
      expect(await ledgerOf(a.id)).toEqual([]);

      // The payment first: the withdrawal's cancellation waits, then finds it paid.
      const { user: b } = await createUser(t.db);
      const second = await createStartGrant(t.db, { userId: b.id });
      let release!: () => void;
      const paying = new Promise<void>((resolve) => (release = resolve));
      let paid!: () => void;
      const didPay = new Promise<void>((resolve) => (paid = resolve));
      const payer = t.db.transaction(async (tx) => {
        expect((await payStartGrant(tx, second.id, amountOf(10_000n))).outcome).toBe('granted');
        paid();
        await paying;
      });
      await didPay;
      let cancelledAt: number | undefined;
      const cancel = t.db
        .transaction((tx) => cancelStartGrant(tx, b.id))
        .finally(() => (cancelledAt = Date.now()));
      await pause(150);
      expect(cancelledAt).toBeUndefined();
      release();
      await payer;
      expect((await cancel).outcome).toBe('granted');
      expect((await ledgerOf(b.id)).map((e) => e.type)).toEqual(['START_GRANT']);

      // Two withdrawals' cancellations of one grant: one cancels.
      const { user: c } = await createUser(t.db);
      await createStartGrant(t.db, { userId: c.id });
      const both = await Promise.all([
        t.db.transaction((tx) => cancelStartGrant(tx, c.id)),
        t.db.transaction((tx) => cancelStartGrant(tx, c.id)),
      ]);
      expect(both.map((r) => r.outcome).sort()).toEqual(['already_cancelled', 'cancelled']);
    });

    /** A gate one transaction waits at until the test opens it. */
    function gate() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open, opened };
    }

    /**
     * How each of two meeting transactions ended: 'ok', or the SQLSTATE it failed with — 40P01 is
     * Postgres breaking a deadlock by aborting one of them (after deadlock_timeout, 1s).
     */
    async function endings(...steps: Promise<unknown>[]): Promise<string[]> {
      const settled = await Promise.allSettled(steps);
      return settled.map((r) =>
        r.status === 'fulfilled' ? 'ok' : (sqlState(r.reason) ?? errorMessage(r.reason)),
      );
    }

    it('takes the 본인확인 record before the grant, so a withdrawal and a payment never deadlock', async () => {
      // A withdrawal that cancels, then deletes the record (as #140 may, and the API tests do): the
      // payment waits on the record the cancellation holds. Were the cancellation not to take the
      // record first, the payment would hold it (KEY SHARE) waiting on the grant, and the
      // withdrawal's DELETE would wait on the payment: a deadlock.
      const { user: a } = await createUser(t.db);
      const first = await createStartGrant(t.db, { userId: a.id });
      const cancelled = gate();
      const deleteRecord = gate();
      const withdrawal = t.db.transaction(async (tx) => {
        expect((await cancelStartGrant(tx, a.id)).outcome).toBe('cancelled');
        cancelled.open();
        await deleteRecord.opened;
        await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, a.id));
      });
      await cancelled.opened;
      let paidAt: number | undefined;
      const payment = t.db
        .transaction((tx) => payStartGrant(tx, first.id, amountOf(10_000n)))
        .finally(() => (paidAt = Date.now()));
      await pause(150);
      const waited = paidAt === undefined;
      deleteRecord.open();
      expect(await endings(withdrawal, payment)).toEqual(['ok', 'ok']);
      expect(waited).toBe(true);
      expect((await payment).outcome).toBe('cancelled');
      expect(await ledgerOf(a.id)).toEqual([]);

      // A withdrawal that takes the record before anything else: the payment waits on the record,
      // not on the grant. Were the payment to lock the grant first (the first commit's order), the
      // cancellation would wait on the grant while the payment waits on the record: a deadlock.
      const { user: b } = await createUser(t.db);
      const second = await createStartGrant(t.db, { userId: b.id });
      const locked = gate();
      const cancel = gate();
      const withdrawing = t.db.transaction(async (tx) => {
        await tx
          .select({ held: sql`1` })
          .from(phoneVerifications)
          .where(eq(phoneVerifications.userId, b.id))
          .for('update');
        locked.open();
        await cancel.opened;
        expect((await cancelStartGrant(tx, b.id)).outcome).toBe('cancelled');
        await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, b.id));
      });
      await locked.opened;
      let payingDoneAt: number | undefined;
      const paying = t.db
        .transaction((tx) => payStartGrant(tx, second.id, amountOf(10_000n)))
        .finally(() => (payingDoneAt = Date.now()));
      await pause(150);
      const blocked = payingDoneAt === undefined;
      cancel.open();
      expect(await endings(withdrawing, paying)).toEqual(['ok', 'ok']);
      expect(blocked).toBe(true);
      expect((await paying).outcome).toBe('cancelled');
      expect(await ledgerOf(b.id)).toEqual([]);
    });

    it('orders an operator number and a cancellation of its grant: refused after, released if before', async () => {
      // An insert of its own (not OPERATOR_PHONE_CHANGE_SQL, whose UPDATE of the 본인확인 record
      // waits for the cancellation there already): the start_held trigger reads the grant FOR
      // SHARE, so it waits for the cancellation's commit and then sees it. Without that it would
      // read the grant as pending, and the release, which cannot see the uncommitted row, would
      // leave a live number on a cancelled grant — held for good (answer 2 frees it).
      const { user: a } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: a.id });
      const cancelled = gate();
      const commit = gate();
      const withdrawal = t.db.transaction(async (tx) => {
        expect((await cancelStartGrant(tx, a.id)).outcome).toBe('cancelled');
        cancelled.open();
        await commit.opened;
      });
      await cancelled.opened;
      const late = randomPhoneHash();
      let insertedAt: number | undefined;
      const inserting = recordOperatorNumber(grant.id, late).finally(
        () => (insertedAt = Date.now()),
      );
      await pause(150);
      const waited = insertedAt === undefined;
      commit.open();
      const [ended, refused] = await Promise.allSettled([withdrawal, inserting]);
      expect(ended.status).toBe('fulfilled');
      expect(refused.status).toBe('rejected');
      expect(
        refused.status === 'rejected' &&
          sqlState(refused.reason) === '23000' &&
          /it records no number/.test(errorMessage(refused.reason)),
      ).toBe(true);
      expect(waited).toBe(true);
      expect((await numbersOf(grant.id)).map((n) => [n.source, n.releasedAt !== null])).toEqual([
        ['grant', true],
      ]);

      // The operator's insert first, still open: the cancellation waits for it, then releases it
      // with the grant's own number, at the same instant.
      const { user: b } = await createUser(t.db);
      const other = await createStartGrant(t.db, { userId: b.id });
      const early = randomPhoneHash();
      const inserted = gate();
      const end = gate();
      const operator = t.db.transaction(async (tx) => {
        await tx
          .insert(startGrantNumbers)
          .values({ grantId: other.id, phoneHash: early, source: 'operator' });
        inserted.open();
        await end.opened;
      });
      await inserted.opened;
      let cancelledAt: number | undefined;
      const cancelling = t.db
        .transaction((tx) => cancelStartGrant(tx, b.id))
        .finally(() => (cancelledAt = Date.now()));
      await pause(150);
      const held = cancelledAt === undefined;
      end.open();
      expect(await endings(operator, cancelling)).toEqual(['ok', 'ok']);
      expect(held).toBe(true);
      const result = await cancelling;
      if (result.outcome !== 'cancelled') throw new Error(`not cancelled: ${result.outcome}`);
      expect(result.released.map((n) => [n.source, n.phoneHash, n.releasedAt])).toEqual([
        ['grant', expect.any(String), result.grant.cancelledAt],
        ['operator', early, result.grant.cancelledAt],
      ]);
      expect(
        await t.db
          .select()
          .from(startGrantNumbers)
          .where(and(eq(startGrantNumbers.phoneHash, early), isNull(startGrantNumbers.releasedAt))),
      ).toEqual([]);
    });

    it('frees a number to one new account, and only once the cancellation commits', async () => {
      /**
       * A withdrawal that cancels the grant holding `hash` and waits before it ends, with
       * `accounts` recording their grants on that number meanwhile: they wait on the number's
       * row until the withdrawal commits or rolls back (the live UNIQUE decides, not a read).
       */
      async function meet(hash: string, end: 'commit' | 'rollback', accounts: string[]) {
        const [owner] = await t.db
          .select({ userId: startGrants.userId })
          .from(startGrants)
          .innerJoin(startGrantNumbers, eq(startGrantNumbers.grantId, startGrants.id))
          .where(and(eq(startGrantNumbers.phoneHash, hash), isNull(startGrantNumbers.releasedAt)));
        let resume!: () => void;
        const held = new Promise<void>((resolve) => (resume = resolve));
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const rolledBack = new Error('the withdrawal failed');
        const withdrawal = t.db
          .transaction(async (tx) => {
            expect((await cancelStartGrant(tx, owner!.userId)).outcome).toBe('cancelled');
            entered();
            await held;
            if (end === 'rollback') throw rolledBack;
          })
          .catch((error: unknown) => {
            if (error !== rolledBack) throw error;
          });
        await inside;
        let recordedAt: number | undefined;
        const racing = Promise.all(
          accounts.map((id) => t.db.transaction((tx) => recordStartGrant(tx, id, hash))),
        ).finally(() => (recordedAt = Date.now()));
        await pause(150);
        expect(recordedAt).toBeUndefined();
        resume();
        await withdrawal;
        return (await racing).map((r) => r.outcome).sort();
      }
      const newAccounts = async (n: number) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          const { user } = await createUser(t.db);
          await createPhoneVerification(t.db, { userId: user.id });
          ids.push(user.id);
        }
        return ids;
      };

      // Committed: of three accounts on the number at once, one records its grant.
      const { user: a } = await createUser(t.db);
      const freed = randomPhoneHash();
      await createStartGrant(t.db, { userId: a.id, phoneHash: freed });
      expect(await meet(freed, 'commit', await newAccounts(3))).toEqual([
        'number_already_used',
        'number_already_used',
        'recorded',
      ]);
      const live = await t.db
        .select({ grantId: startGrantNumbers.grantId })
        .from(startGrantNumbers)
        .where(and(eq(startGrantNumbers.phoneHash, freed), isNull(startGrantNumbers.releasedAt)));
      expect(live).toHaveLength(1);

      // Rolled back: the grant still waits and holds the number, so the account gets nothing.
      const { user: b } = await createUser(t.db);
      const kept = randomPhoneHash();
      const grant = await createStartGrant(t.db, { userId: b.id, phoneHash: kept });
      expect(await meet(kept, 'rollback', await newAccounts(1))).toEqual(['number_already_used']);
      expect(await t.db.select().from(startGrants).where(eq(startGrants.id, grant.id))).toEqual([
        grant,
      ]);
      expect((await numbersOf(grant.id)).map((n) => n.releasedAt)).toEqual([null]);
    });

    it('pays nothing to a grant whose account lost its 본인확인 record by hand, and scans past it', async () => {
      const { user: gone } = await createUser(t.db);
      const { user: kept } = await createUser(t.db);
      const left = await createStartGrant(t.db, { userId: gone.id });
      const waiting = await createStartGrant(t.db, { userId: kept.id });
      // The record deleted with no cancellation (not a withdrawal, which cancels too).
      await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, gone.id));
      // Out of the scan, though it is the oldest: it would sort first for good otherwise.
      expect(await pendingStartGrantIds(t.db, 1)).toEqual([waiting.id]);
      const result = await t.db.transaction((tx) => payStartGrant(tx, left.id, amountOf(10_000n)));
      expect(result).toEqual({ outcome: 'unverified', grant: left });
      expect(await ledgerOf(gone.id)).toEqual([]);
      const [balance] = await t.db.select().from(balances).where(eq(balances.userId, gone.id));
      expect(balance!.availableCoin).toBe(0n);
      // Still pending, still holding its number.
      expect(await t.db.select().from(startGrants).where(eq(startGrants.id, left.id))).toEqual([
        left,
      ]);
      expect((await numbersOf(left.id)).map((n) => n.releasedAt)).toEqual([null]);
    });

    it('holds the 본인확인 record while it pays, so a withdrawal cannot delete it meanwhile', async () => {
      const { user: u } = await createUser(t.db);
      const grant = await createStartGrant(t.db, { userId: u.id });
      await t.db.transaction(async (tx) => {
        expect((await payStartGrant(tx, grant.id, amountOf(100n))).outcome).toBe('granted');
        await expect(
          t.db.transaction(async (other) => {
            await other.execute(sql`SET LOCAL lock_timeout = '200ms'`);
            await other.delete(phoneVerifications).where(eq(phoneVerifications.userId, u.id));
          }),
        ).rejects.toSatisfy((e) => sqlState(e) === '55P03');
        // The member's own edit of the real name is not held up (FOR KEY SHARE, not FOR SHARE).
        await t.db.transaction(async (other) => {
          await other.execute(sql`SET LOCAL lock_timeout = '200ms'`);
          await other
            .update(phoneVerifications)
            .set({ realName: '김철수' })
            .where(eq(phoneVerifications.userId, u.id));
        });
      });
    });

    it('keeps the record of a number when the number itself is deleted (#140, #57-18)', async () => {
      const { user: u } = await createUser(t.db);
      await createPhoneVerification(t.db, { userId: u.id, phone: '01055556666' });
      const grant = await createStartGrant(t.db, { userId: u.id, amountCoin: 100n });
      const numbers = await numbersOf(grant.id);
      // What a withdrawal will do to the number (#140): delete the verification row.
      await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, u.id));
      expect(await t.db.select().from(startGrants)).toEqual([grant]);
      expect(await numbersOf(grant.id)).toEqual(numbers);
    });

    it('says whether ANOTHER account’s grant holds a number, never the asking account’s own', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const { user: c } = await createUser(t.db);
      const hash = randomPhoneHash();
      // Nobody's grant holds it yet.
      expect(await startGrantHoldsNumber(t.db, hash, a.id)).toBe(false);
      await createStartGrant(t.db, { userId: a.id, phoneHash: hash });
      // A's own grant is not "the number went elsewhere" (a `GET /me` overlapping A's nickname
      // step can meet it, ADR-0072); to every other account it is.
      expect(await startGrantHoldsNumber(t.db, hash, a.id)).toBe(false);
      expect(await startGrantHoldsNumber(t.db, hash, b.id)).toBe(true);
      // Another number's grant says nothing of this one.
      await createStartGrant(t.db, { userId: c.id });
      expect(await startGrantHoldsNumber(t.db, randomPhoneHash(), b.id)).toBe(false);
      // A's grant cancelled while it waited (its withdrawal, owner decision 2026-10-18): the number
      // is released, free for the next account, and held by nobody's grant.
      await t.db.transaction((tx) => cancelStartGrant(tx, a.id));
      expect(await startGrantHoldsNumber(t.db, hash, b.id)).toBe(false);
    });
  });

  describe('buddha_app privileges (PLAN 6.4)', () => {
    it('can INSERT and SELECT ledger_entries but not UPDATE or DELETE', async () => {
      const { user: u } = await createUser(t.db, { balanceCoin: 500n });
      const rows = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, u.id))
        .orderBy(ledgerEntries.id);
      // The factory's 500 Coin (the trigger writes no entry since migration 0031).
      expect(rows.map((row) => row.type)).toEqual(['ADMIN_ADJUST']);
      await expect(
        t.db.update(ledgerEntries).set({ memo: 'x' }).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(ledgerEntries).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });

    it('cannot UPDATE/DELETE market_events, admin_actions or payment_events, can on other tables', async () => {
      const { rows } = await t.db.execute<{ table: string; privilege: string }>(sql`
        SELECT table_name AS "table", privilege_type AS privilege
        FROM information_schema.role_table_grants
        WHERE grantee = 'buddha_app' AND table_schema = 'public'
          AND table_name IN ('ledger_entries', 'market_events', 'admin_actions', 'payment_events',
            'balances', 'payments', 'phone_verifications', 'phone_verification_codes',
            'phone_verification_refused_sends',
            'market_settlement_steps', 'release_settings',
            'approval_requests', 'market_watches', 'market_watch_events', 'market_searches',
            'market_search_terms', 'market_links', 'consent_records', 'nickname_holds',
            'profile_interest_categories', 'post_likes', 'comment_likes',
            'write_limit_events', 'link_uses', 'link_flags')
        ORDER BY 1, 2`);
      const grants = Object.groupBy(rows, (r) => r.table);
      const privs = (table: string) => grants[table]?.map((r) => r.privilege).sort() ?? [];
      expect(privs('ledger_entries')).toEqual(['INSERT', 'SELECT']);
      expect(privs('market_events')).toEqual(['INSERT', 'SELECT']);
      expect(privs('admin_actions')).toEqual(['INSERT', 'SELECT']);
      // Migration 0015: the PG exchange log is append-only too.
      expect(privs('payment_events')).toEqual(['INSERT', 'SELECT']);
      expect(privs('balances')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('payments')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0028 (#183): the real name changes in place and the row goes with the account;
      // a code's wrong entries, its use and what the provider said (0030) are written in place,
      // and a send the provider refused is deleted (the rest are 본인확인 기록, #184's to delete).
      expect(privs('phone_verifications')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('phone_verification_codes')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0030: a refused send's time is written and deleted after a week, never changed.
      expect(privs('phone_verification_refused_sends')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      // Migration 0016: the worker updates a step's row in place.
      expect(privs('market_settlement_steps')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0020: a release setting is changed, never removed.
      expect(privs('release_settings')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      // Migration 0021: a two-person request is decided in place, never removed.
      expect(privs('approval_requests')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      // Migration 0023 (#89): an unwatch deletes the current row; the history is append-only.
      expect(privs('market_watches')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('market_watch_events')).toEqual(['INSERT', 'SELECT']);
      // Migration 0025 (#15): the member deletes a recorded search, one term or all of them; and
      // migration 0026 took UPDATE away — a recorded search is never changed in place, which is
      // what keeps market_search_terms exact. The term rows are written by the triggers, as
      // buddha_app, upsert included.
      expect(privs('market_searches')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('market_search_terms')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0027 (#65): an unlink deletes the pair's row; the history is admin_actions.
      expect(privs('market_links')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0032 (#58): a consent record is never rewritten, and goes only after its
      // retention period (#184); holds and interest picks are written and removed freely.
      expect(privs('consent_records')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('nickname_holds')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('profile_interest_categories')).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
      // Migration 0035 (#49): a like is inserted and an unlike deletes it, never rewritten.
      expect(privs('post_likes')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('comment_likes')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      // Migration 0041 (#187): a counted write and a link use are inserted and purged after a day
      // (or moved to a new number by deleting and inserting them again), never rewritten; a
      // review-list entry is inserted, marked once — its `review_action_id` only, a column grant —
      // and deleted after its retention period (owner decision 2026-10-22).
      expect(privs('write_limit_events')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('link_uses')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('link_flags')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      const { rows: columns } = await t.db.execute<{ column: string; privilege: string }>(sql`
        SELECT column_name AS "column", privilege_type AS privilege
        FROM information_schema.column_privileges
        WHERE grantee = 'buddha_app' AND table_schema = 'public' AND table_name = 'link_flags'
          AND privilege_type = 'UPDATE'`);
      expect(columns).toEqual([{ column: 'review_action_id', privilege: 'UPDATE' }]);
    });

    it('cannot UPDATE or DELETE a watch event, and refuses an action outside the list (#95)', async () => {
      const { user: u } = await createUser(t.db);
      const market = await createMarket(t.db);
      const { watch, event } = await createWatch(t.db, { userId: u.id, marketId: market.id });
      // The factory's pair shares one instant, as the API's transaction does.
      expect(event.createdAt.getTime()).toBe(watch.watchedAt.getTime());
      await expect(
        t.db
          .update(marketWatchEvents)
          .set({ action: 'unwatch' })
          .where(eq(marketWatchEvents.id, event.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(marketWatchEvents).where(eq(marketWatchEvents.id, event.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db
          .insert(marketWatchEvents)
          .values({ userId: u.id, marketId: market.id, action: 'favorite' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      // The current row goes with an unwatch, and a second row for one pair is refused.
      await expect(
        t.db.insert(marketWatches).values({ userId: u.id, marketId: market.id }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await t.db
        .delete(marketWatches)
        .where(and(eq(marketWatches.userId, u.id), eq(marketWatches.marketId, market.id)));
      expect(await t.db.select().from(marketWatches)).toEqual([]);
      expect(await t.db.select().from(marketWatchEvents)).toEqual([event]);
    });

    it('cannot UPDATE or DELETE a payment event', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db
        .insert(payments)
        .values({
          userId: u.id,
          amountCoin: 10_000n,
          priceKrw: 9_700,
          provider: 'mock',
          idempotencyKey: 'append-only',
        })
        .returning();
      const [event] = await t.db
        .insert(paymentEvents)
        .values({ paymentId: row!.id, type: 'notify', resultCode: '3001' })
        .returning();
      await expect(
        t.db.update(paymentEvents).set({ resultCode: 'x' }).where(eq(paymentEvents.id, event!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(paymentEvents).where(eq(paymentEvents.id, event!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });

    it('cannot create tables', async () => {
      await expect(t.db.execute(sql`CREATE TABLE should_fail (id int)`)).rejects.toSatisfy(
        (e) => sqlState(e) === '42501',
      );
    });
  });
});
