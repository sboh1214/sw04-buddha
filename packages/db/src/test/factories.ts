/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  ACCOUNT_CLOSURE_DECISION_REASON,
  AUTH_USER_NAME,
  CONSENT_ITEMS,
  PRICE_MAX,
  PRICE_MIN,
  currentConsentVersion,
  SETTLEMENT_STEPS,
  closedAccountEmail,
  readPostDocument,
  relatedMarketPair,
  type ImageContentType,
  type MarketStatus,
  type ModerationActionType,
  type ModerationReason,
  type PostDocument,
  type Outcome,
  type ReleaseSettingStatus,
  type ReportReason,
  type ReportStatus,
  type Role,
  type SettlementStep,
  type SettlementStepStatus,
  type LinkFlagReason,
  type WriteLimitAction,
} from '@buddha/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  account,
  adminActions,
  approvalRequests,
  balances,
  categories,
  commentLikes,
  consentRecords,
  fills,
  ledgerEntries,
  linkFlags,
  linkUses,
  marketLinks,
  marketSearches,
  marketSettlementSteps,
  marketWatchEvents,
  marketWatches,
  markets,
  mediaObjects,
  moderationActions,
  nicknameHolds,
  noticeImages,
  notices,
  orders,
  phoneVerifications,
  positions,
  postComments,
  postImages,
  postLikes,
  posts,
  profileInterestCategories,
  profileItemRemovals,
  profiles,
  releaseSettings,
  reports,
  session,
  startGrants,
  user,
  verification,
  writeLimitEvents,
} from '../schema/index.js';
import { storedReleaseSettingValue } from '../release-settings.js';
import { payStartGrant, recordStartGrant } from '../start-grants.js';

/** Short unique tag for generated emails/slugs/nicknames. */
const tag = () => randomUUID().replaceAll('-', '').slice(0, 8);

export interface CreateUserInput {
  id?: string;
  email?: string;
  name?: string;
  nickname?: string;
  role?: Role;
  /**
   * Balance the user should end up with. Every account is created with 0 and no ledger entry by
   * the trigger (migration 0031: no sign-up grant, #70); asking for more writes it as an
   * ADMIN_ADJUST entry, so the PLAN 5.6 invariant keeps holding. Omit to keep 0, as a new account.
   */
  balanceCoin?: bigint;
}

/**
 * Inserts a `user` row (better-auth table). The AFTER INSERT trigger (migration
 * 0002_user_profile_trigger) creates `profiles` + `balances` in the same transaction, exactly
 * as a real sign-up does; the factory then applies the requested nickname/role/balance.
 */
export async function createUser(db: Db, input: CreateUserInput = {}) {
  const id = input.id ?? randomUUID();
  const t = tag();
  const balanceCoin = input.balanceCoin ?? 0n;
  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .insert(user)
      .values({
        id,
        name: input.name ?? `tester ${t}`,
        email: input.email ?? `user-${t}@test.local`,
        emailVerified: true,
      })
      .returning();
    const [profile] = await tx
      .update(profiles)
      .set({ nickname: input.nickname ?? `user_${t}`, role: input.role ?? 'user' })
      .where(eq(profiles.userId, id))
      .returning();
    let [balance] = await tx.select().from(balances).where(eq(balances.userId, id));
    if (!userRow || !profile || !balance) {
      throw new Error('user trigger did not create profiles/balances (migration 0002 missing?)');
    }
    if (balanceCoin !== balance.availableCoin) {
      const delta = balanceCoin - balance.availableCoin;
      [balance] = await tx
        .update(balances)
        .set({ availableCoin: balanceCoin })
        .where(eq(balances.userId, id))
        .returning();
      await tx.insert(ledgerEntries).values({
        userId: id,
        type: 'ADMIN_ADJUST',
        amountCoin: delta,
        balanceAfterCoin: balanceCoin,
        memo: 'test factory: initial balance',
      });
    }
    return { user: userRow, profile, balance: balance! };
  });
}

export interface CreateCategoryInput {
  slug?: string;
  nameKo?: string;
  sortOrder?: number;
  isActive?: boolean;
  /** A sub-category names its parent; omitted (or null) makes a top-level one. */
  parentId?: number | null;
}

export async function createCategory(db: Db, input: CreateCategoryInput = {}) {
  const t = tag();
  const [row] = await db
    .insert(categories)
    .values({
      slug: input.slug ?? `cat-${t}`,
      nameKo: input.nameKo ?? `카테고리 ${t}`,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      parentId: input.parentId ?? null,
    })
    .returning();
  return row!;
}

export interface CreateMarketInput {
  /** Creator user id. A fresh admin user is created when omitted. */
  createdBy?: string;
  /** Category id. A fresh category is created when omitted. */
  categoryId?: number;
  slug?: string;
  title?: string;
  description?: string;
  rules?: string;
  resolutionSource?: string;
  status?: MarketStatus;
  /**
   * YES price of the last fill, 1..99. Default null: a market nobody traded has no price
   * (N02 §5). A test that needs a traded market sets it with the statistics below.
   */
  lastPrice?: number | null;
  /** Statistics overrides (list sorting tests). Default 0 like a market nobody traded. */
  volumeCoin?: bigint;
  tradeCount?: number;
  /**
   * The actual open time. Default: now for every status but `draft`, which has none (the admin
   * open path stamps it). A list-order test sets it, or sets `null` for a public market with no
   * open time, which 신규 puts after every opened market and 추천 after the opened markets of its
   * own 24-hour volume (the open time is 추천's tie-break; ADR-0065).
   */
  openAt?: Date | null;
  closeAt?: Date;
  /**
   * Resolution columns, stored as given and null by default: a test that needs a market
   * mid-settlement sets `status: 'resolved'` with a result. The factory writes no market event,
   * so `statusEventId` stays null unless given — the rank fallback of `statusSupersedes` is what
   * such a row orders by.
   */
  resolvedResult?: Outcome | null;
  resolvedAt?: Date | null;
  settledAt?: Date | null;
  statusEventId?: number | null;
  /**
   * `market_settlement_steps` rows (ADR-0046) as the real paths leave them: for `resolved`, one
   * `pending` row per SETTLEMENT_STEPS step (the judgement writes them); for `settled`, one `done`
   * row each, completed at `settledAt` (or now). Default true; `false` writes none — the state a
   * test of the worker's missing-row fallback starts from. Other statuses never get rows.
   */
  settlementSteps?: boolean;
}

/**
 * Inserts a market as the admin create path leaves it, in the given status: no price until a
 * fill (`lastPrice` null) and statistics at 0 unless given. Writes no tick and no event.
 */
export async function createMarket(db: Db, input: CreateMarketInput = {}) {
  const lastPrice = input.lastPrice ?? null;
  const inRange = (price: number) =>
    Number.isInteger(price) && price >= PRICE_MIN && price <= PRICE_MAX;
  if (lastPrice !== null && !inRange(lastPrice)) {
    throw new RangeError(`lastPrice must be an integer 1..99 or null, got ${String(lastPrice)}`);
  }
  const t = tag();
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const categoryId = input.categoryId ?? (await createCategory(db)).id;
  const status = input.status ?? 'open';
  const now = new Date();

  const [row] = await db
    .insert(markets)
    .values({
      slug: input.slug ?? `market-${t}`,
      title: input.title ?? `테스트 시장 ${t}`,
      description: input.description ?? null,
      rules: input.rules ?? '테스트용 규칙. 기한까지 사건이 일어나지 않으면 NO로 판정한다.',
      resolutionSource: input.resolutionSource ?? 'https://example.com/source',
      categoryId,
      status,
      lastPrice,
      volumeCoin: input.volumeCoin ?? 0n,
      tradeCount: input.tradeCount ?? 0,
      openAt: input.openAt !== undefined ? input.openAt : status === 'draft' ? null : now,
      closeAt: input.closeAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      resolvedResult: input.resolvedResult ?? null,
      resolvedAt: input.resolvedAt ?? null,
      settledAt: input.settledAt ?? null,
      statusEventId: input.statusEventId ?? null,
      createdBy,
    })
    .returning();
  const market = row!;
  if (input.settlementSteps !== false && (status === 'resolved' || status === 'settled')) {
    for (const step of SETTLEMENT_STEPS) {
      await createSettlementStep(db, {
        marketId: market.id,
        step,
        ...(status === 'settled'
          ? { status: 'done', attempts: 1, completedAt: input.settledAt ?? now }
          : {}),
      });
    }
  }
  return market;
}

export interface CreateSettlementStepInput {
  marketId: string;
  /** Default 'coin'. */
  step?: SettlementStep;
  /** Default 'pending'. `done` needs `completedAt` (a CHECK ties the two). */
  status?: SettlementStepStatus;
  /** Default 0. */
  attempts?: number;
  completedAt?: Date | null;
  lastError?: string | null;
}

/**
 * Inserts one `market_settlement_steps` row and nothing else (ADR-0046): a test that needs a
 * step in a given state — failed with an error, done — writes it here. The primary key
 * (market_id, step) applies, so a second row for one pair throws.
 */
export async function createSettlementStep(db: Db, input: CreateSettlementStepInput) {
  const [row] = await db
    .insert(marketSettlementSteps)
    .values({
      marketId: input.marketId,
      step: input.step ?? 'coin',
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      completedAt: input.completedAt ?? null,
      lastError: input.lastError ?? null,
    })
    .returning();
  return row!;
}

export interface CreatePositionInput {
  userId: string;
  marketId: string;
  outcome: Outcome;
  qty: number;
  /** Default 0. */
  costBasisCoin?: bigint;
  /** Default 0. */
  realizedPnlCoin?: bigint;
  /** Default false. */
  settled?: boolean;
}

/**
 * Inserts a `positions` row and nothing else: no ledger entry, no balance change, no market
 * statistics. That makes it right for tests of reads and settlement inputs (a holder exists),
 * and wrong for anything that audits the books (PLAN 5.6) — a test that needs a position the
 * ledger can explain writes the ledger entry and balance change that bought it as well.
 */
export async function createPosition(db: Db, input: CreatePositionInput) {
  const [row] = await db
    .insert(positions)
    .values({
      userId: input.userId,
      marketId: input.marketId,
      outcome: input.outcome,
      qty: input.qty,
      costBasisCoin: input.costBasisCoin ?? 0n,
      realizedPnlCoin: input.realizedPnlCoin ?? 0n,
      settled: input.settled ?? false,
    })
    .returning();
  return row!;
}

export interface CreateFillInput {
  marketId: string;
  /** Total Coin of the fill: what the 24-hour volume of 추천 sums (ADR-0065). */
  amountCoin: bigint;
  /** Default: the database clock. A volume-window test sets it. */
  createdAt?: Date;
  /** The taker. A fresh user is created when omitted. */
  userId?: string;
  /** The resting order's account. A fresh user is created when omitted. */
  makerId?: string;
  /** Default 'YES'. */
  outcome?: Outcome;
  /** Default 'buy'. */
  side?: 'buy' | 'sell';
  /** Default 1. */
  qty?: number;
}

/**
 * One execution as the CLOB will leave it (#119): a filled market order matched against a
 * resting limit order of another account, and the `fills` row between them — nothing routes an
 * order yet. No balance, position, ledger entry, tick or market statistic moves: a test that
 * needs those sets them itself (`createMarket`'s statistics). The two orders share the fill's
 * instant.
 */
export async function createFill(db: Db, input: CreateFillInput) {
  const taker = input.userId ?? (await createUser(db)).user.id;
  const maker = input.makerId ?? (await createUser(db)).user.id;
  const outcome = input.outcome ?? 'YES';
  const side = input.side ?? 'buy';
  const qty = input.qty ?? 1;
  const at = input.createdAt === undefined ? {} : { createdAt: input.createdAt };
  return db.transaction(async (tx) => {
    const [resting] = await tx
      .insert(orders)
      .values({
        userId: maker,
        marketId: input.marketId,
        outcome: outcome === 'YES' ? 'NO' : 'YES',
        side: 'buy',
        type: 'limit',
        limitPrice: 50,
        qty,
        filledQty: qty,
        status: 'filled',
        idempotencyKey: randomUUID(),
        ...at,
      })
      .returning();
    const [order] = await tx
      .insert(orders)
      .values({
        userId: taker,
        marketId: input.marketId,
        outcome,
        side,
        type: 'market',
        qty,
        filledQty: qty,
        status: 'filled',
        idempotencyKey: randomUUID(),
        ...at,
      })
      .returning();
    const [fill] = await tx
      .insert(fills)
      .values({
        marketId: input.marketId,
        orderId: order!.id,
        counterpartyType: 'order',
        counterpartyOrderId: resting!.id,
        outcome,
        side,
        qty,
        amountCoin: input.amountCoin,
        priceAvgBp: Math.min(10_000, Math.round((Number(input.amountCoin) * 100) / qty)),
        ...at,
      })
      .returning();
    return fill!;
  });
}

export interface CreateWatchInput {
  userId: string;
  marketId: string;
  /**
   * When the watch began. Default: the database clock. A list-order test sets it, since watches
   * written in one test can share a millisecond.
   */
  watchedAt?: Date;
}

/**
 * A current watch (#89, ADR-0064) as the API's watch leaves it: the `market_watches` row and its
 * one `watch` event at the same instant, in one transaction. The primary key applies, so a second
 * watch of one pair throws — the API's own repeat writes nothing instead.
 */
export async function createWatch(db: Db, input: CreateWatchInput) {
  return db.transaction(async (tx) => {
    const [watch] = await tx
      .insert(marketWatches)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        ...(input.watchedAt === undefined ? {} : { watchedAt: input.watchedAt }),
      })
      .returning();
    const [event] = await tx
      .insert(marketWatchEvents)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        action: 'watch',
        createdAt: watch!.watchedAt,
      })
      .returning();
    return { watch: watch!, event: event! };
  });
}

export interface CreateSearchInput {
  userId: string;
  query: string;
  /**
   * When it was searched. Default: the database clock. A list-order test sets it, since searches
   * written in one test can share a millisecond.
   */
  searchedAt?: Date;
  /**
   * The row's id. Default: the database's random uuid. A test of a tie within one millisecond
   * sets it, since the larger id wins the tie (migration 0026) and random ones would leave which
   * is written first to chance.
   */
  id?: string;
}

/**
 * A recorded search (#15, ADR-0066) as `POST /me/search-history` leaves it: one `market_searches`
 * row, and its term in `market_search_terms` — which the database's insert trigger writes, for
 * this insert as for the API's (migration 0026), so the factory adds nothing of its own. The term
 * is stored as given; the API trims it first.
 */
export async function createSearch(db: Db, input: CreateSearchInput) {
  const [row] = await db
    .insert(marketSearches)
    .values({
      userId: input.userId,
      query: input.query,
      ...(input.searchedAt === undefined ? {} : { searchedAt: input.searchedAt }),
      ...(input.id === undefined ? {} : { id: input.id }),
    })
    .returning();
  return row!;
}

export interface CreateMarketLinkInput {
  /** Either end: the pair is stored once, smaller id first, whichever order is given. */
  marketId: string;
  relatedMarketId: string;
  /** The linking admin. A fresh admin is created when omitted. */
  createdBy?: string;
  /** Default: the database clock. An order test sets it, since links can share a millisecond. */
  createdAt?: Date;
}

/**
 * A link between two markets (#65, ADR-0068) as `POST /admin/markets/:id/related` leaves the
 * `market_links` row — and only the row: no `admin_actions` row, which the API writes beside it.
 * The pair is ordered here as the API orders it (`relatedMarketPair`), so a market can be linked
 * from either side; the same market twice throws, as the CHECK would.
 */
export async function createMarketLink(db: Db, input: CreateMarketLinkInput) {
  const pair = relatedMarketPair(input.marketId, input.relatedMarketId);
  if (pair === undefined) throw new RangeError('a market cannot be linked to itself');
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const [row] = await db
    .insert(marketLinks)
    .values({
      ...pair,
      createdBy,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreatePhoneVerificationInput {
  userId: string;
  /** Digits only. Default: a random 010 number, so two verified accounts never share one. */
  phone?: string;
  /** Default: 홍길동. */
  realName?: string;
  /** Default: the database clock. */
  verifiedAt?: Date;
}

/** A random mobile number, digits only: 010 and eight digits. */
export function randomPhone(): string {
  return `010${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

/**
 * A completed 본인확인 (#183, ADR-0070) as a matched confirmation leaves it: the
 * `phone_verifications` row, and nothing of the code that was sent for it. For a test whose
 * subject needs a verified account rather than the verification itself; the number is UNIQUE, so
 * the same number twice throws, as a second account confirming it would be refused.
 */
export async function createPhoneVerification(db: Db, input: CreatePhoneVerificationInput) {
  const [row] = await db
    .insert(phoneVerifications)
    .values({
      userId: input.userId,
      phone: input.phone ?? randomPhone(),
      realName: input.realName ?? '홍길동',
      ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
    })
    .returning();
  return row!;
}

export interface CreateStartGrantInput {
  userId: string;
  /**
   * The keyed hash of the number (64 lower-case hex), recorded as the grant's own number. Default:
   * a random one, so two grants never share a number; a test about "the same number" passes the
   * API's hash of it, or one hash twice.
   */
  phoneHash?: string;
  /**
   * Pays it with this amount (the START_GRANT entry and the balance, through `payStartGrant`, as
   * the API and the worker pay). Omit for a grant still pending, as one recorded while the
   * release setting `grant.start_coin` was undecided.
   */
  amountCoin?: bigint;
}

/** A random keyed-hash-shaped value: 64 lower-case hex characters. */
export function randomPhoneHash(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A start grant (#70, ADR-0071) as the grant leaves it: the `start_grants` row and its number's
 * `start_grant_numbers` row (`source` 'grant'), recorded by `recordStartGrant`, pending, or paid
 * when `amountCoin` is given. A grant is recorded only for an account with a 본인확인 record, and
 * `payStartGrant` pays no other, so an account without one gets one (a random number, which the
 * random `phoneHash` need not match); a test of a withdrawn account deletes it afterwards. Does
 * not hash the number; a test whose subject is the grant itself goes through the API's
 * StartGrantService. Throws when the account has a grant already or the hash is held by another.
 */
export async function createStartGrant(db: Db, input: CreateStartGrantInput) {
  return db.transaction(async (tx) => {
    await tx
      .insert(phoneVerifications)
      .values({ userId: input.userId, phone: randomPhone(), realName: '홍길동' })
      .onConflictDoNothing({ target: phoneVerifications.userId });
    const recorded = await recordStartGrant(tx, input.userId, input.phoneHash ?? randomPhoneHash());
    if (recorded.outcome !== 'recorded') {
      throw new Error(`start grant not recorded: ${recorded.outcome}`);
    }
    const amountCoin = input.amountCoin;
    const paid = await payStartGrant(tx, recorded.grantId, () =>
      Promise.resolve(amountCoin ?? null),
    );
    if (amountCoin === undefined ? paid.outcome !== 'pending' : paid.outcome !== 'granted') {
      throw new Error(`start grant not left as asked: ${paid.outcome}`);
    }
    return paid.grant;
  });
}

export interface CreateConsentsInput {
  userId: string;
  /** The optional marketing item's answer. Default: not agreed. */
  marketing?: boolean;
  /** Versions to record instead of the current ones, by item (a record from before a revision). */
  versions?: Partial<Record<(typeof CONSENT_ITEMS)[number], string>>;
  clientIp?: string | null;
  userAgent?: string | null;
}

/**
 * The consent step as `POST /me/consents` records it (#58): one row per item, the required ones
 * agreed, at the current versions unless `versions` says otherwise. For a test whose subject needs
 * an account past its consent step rather than the step itself.
 */
export async function createConsents(db: Db, input: CreateConsentsInput) {
  return db
    .insert(consentRecords)
    .values(
      CONSENT_ITEMS.map((item) => ({
        userId: input.userId,
        item,
        version: input.versions?.[item] ?? currentConsentVersion(item),
        agreed: item === 'marketing' ? (input.marketing ?? false) : true,
        clientIp: input.clientIp ?? null,
        userAgent: input.userAgent ?? null,
      })),
    )
    .returning();
}

export interface CompleteOnboardingInput {
  userId: string;
  /** The 본인확인's number, digits only, when the account has no record yet. Default: random. */
  phone?: string;
  /** Also answer the interest categories step (with none). Default: false. */
  interests?: boolean;
}

/**
 * An account past the onboarding's three steps (#58) as the API leaves it, without the start
 * Coin: its consent records, a 본인확인 record (kept if it has one), and its nickname confirmed as
 * it is. For a test whose subject needs an onboarded account — an action #57-8 keeps from the rest
 * — rather than the onboarding itself; the start grant is `createStartGrant`'s.
 */
export async function completeOnboarding(db: Db, input: CompleteOnboardingInput) {
  await createConsents(db, { userId: input.userId });
  await db
    .insert(phoneVerifications)
    .values({ userId: input.userId, phone: input.phone ?? randomPhone(), realName: '홍길동' })
    .onConflictDoNothing({ target: phoneVerifications.userId });
  const [profile] = await db
    .update(profiles)
    .set({
      nicknameConfirmedAt: sql`now()`,
      ...(input.interests ? { interestsAnsweredAt: sql`now()` } : {}),
    })
    .where(eq(profiles.userId, input.userId))
    .returning();
  if (!profile) throw new Error(`no profile for ${input.userId}`);
  return profile;
}

export interface SetReleaseSettingInput {
  /** The admin the change is recorded under (release_settings.updated_by, admin_actions). */
  adminId: string;
  key: string;
  status: ReleaseSettingStatus;
  /** Null exactly while `undecided`. */
  value: unknown;
  /** Default: 시험. */
  reason?: string;
}

/**
 * A release setting changed as the admin screen changes it (#170, migration 0020): the row and its
 * `release_setting_change` record in one transaction, at an instant after the key's last change.
 * For a suite that needs an item's value where the API's ReleaseSettingsService is not at hand
 * (the worker); it checks neither the registry nor the item's schema.
 */
export async function setReleaseSetting(db: Db, input: SetReleaseSettingInput) {
  const { adminId, key, status, value } = input;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: releaseSettings.status,
        value: storedReleaseSettingValue,
        updatedAt: releaseSettings.updatedAt,
      })
      .from(releaseSettings)
      .where(eq(releaseSettings.key, key));
    const at = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() ?? 0) + 1));
    await tx.insert(adminActions).values({
      adminId,
      type: 'release_setting_change',
      targetType: 'release_setting',
      targetId: key,
      payload: {
        key,
        before: { status: current?.status ?? 'undecided', value: current?.value ?? null },
        after: { status, value },
        reason: input.reason ?? '시험',
      },
      createdAt: at,
    });
    const written = { status, value, updatedAt: at, updatedBy: adminId };
    await tx
      .insert(releaseSettings)
      .values({ key, ...written })
      .onConflictDoUpdate({ target: releaseSettings.key, set: written });
  });
}

export interface CreateMediaInput {
  ownerId: string;
  /** Default: image/webp. */
  contentType?: ImageContentType;
  /** Default: the database clock. The orphan cleanup's tests set an older one. */
  createdAt?: Date;
}

const EXTENSION_OF: Readonly<Record<ImageContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * An upload's row as `POST /media/images` leaves it (#46): a post image of `ownerId`, attached to
 * nothing. Only the row — the object is the test's store's to hold or not (@buddha/storage's
 * MemoryObjectStorage); its key is the API's shape, `post-images/<id>.<ext>`.
 */
export async function createMedia(db: Db, input: CreateMediaInput) {
  const id = randomUUID();
  const contentType = input.contentType ?? 'image/webp';
  const [row] = await db
    .insert(mediaObjects)
    .values({
      id,
      ownerId: input.ownerId,
      kind: 'post_image',
      storageKey: `post-images/${id}.${EXTENSION_OF[contentType]}`,
      contentType,
      byteSize: 1_024,
      width: 64,
      height: 48,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateProfileImageInput {
  userId: string;
  /** Default: image/webp. One of a profile image's three types (#37-6). */
  contentType?: Exclude<ImageContentType, 'image/gif'>;
}

/**
 * A profile image as `PUT /me/profile-image` leaves it (#141): an upload of `userId`'s of the
 * profile image's kind, 512px square (a large upload's), attached from the start, and the
 * profile's image — replacing the profile's earlier one, whose row stays as an operator's removal
 * leaves it (#50). Only the rows — the object is the test's store's to hold or not; its key is the
 * API's shape, `profile-images/<id>.<ext>`.
 */
export async function createProfileImage(db: Db, input: CreateProfileImageInput) {
  const id = randomUUID();
  const contentType = input.contentType ?? 'image/webp';
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mediaObjects)
      .values({
        id,
        ownerId: input.userId,
        kind: 'profile_image',
        storageKey: `profile-images/${id}.${EXTENSION_OF[contentType]}`,
        contentType,
        byteSize: 2_048,
        width: 512,
        height: 512,
        attachedAt: sql`now()`,
      })
      .returning();
    await tx.update(profiles).set({ imageId: id }).where(eq(profiles.userId, input.userId));
    return row!;
  });
}

export interface CreatePostInput {
  marketId: string;
  authorId: string;
  /** Default: none. */
  title?: string | null;
  /**
   * The body as text: one paragraph per line. Default: '근거 <tag>'. Ignored with `document`.
   */
  text?: string;
  /** The whole body, as `sanitizePostDocument` would have stored it. */
  document?: PostDocument;
  /**
   * Uploads (`createMedia`) the body shows after its paragraphs, in order: attached to the post
   * as the API attaches them. Ignored with `document`, whose own images are attached instead.
   */
  imageIds?: string[];
  /** Default: the database clock. A list's order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  deletedAt?: Date;
  hiddenAt?: Date;
}

/**
 * A post (#46) as `POST /posts` leaves it — the row with its body's text and images derived as the
 * API derives them (`readPostDocument`), and each image attached (`post_images`, the upload's
 * `attached_at`) — or, with the times, as an edit, a deletion or an operator's hiding left it.
 * No revision rows: an edit's history is the API's to write.
 */
export async function createPost(db: Db, input: CreatePostInput) {
  const document: PostDocument = input.document ?? {
    type: 'doc',
    content: [
      ...(input.text ?? `근거 ${tag()}`)
        .split('\n')
        .map((line) =>
          line === ''
            ? { type: 'paragraph' as const }
            : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] },
        ),
      ...(input.imageIds ?? []).map((mediaId) => ({ type: 'image' as const, attrs: { mediaId } })),
    ],
  };
  const read = readPostDocument(document);
  return db.transaction(async (tx) => {
    const [post] = await tx
      .insert(posts)
      .values({
        marketId: input.marketId,
        authorId: input.authorId,
        title: input.title ?? null,
        body: document,
        bodyText: read.text,
        imageIds: read.imageIds,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
        ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
        ...(input.hiddenAt === undefined ? {} : { hiddenAt: input.hiddenAt }),
      })
      .returning();
    if (read.imageIds.length > 0) {
      await tx
        .insert(postImages)
        .values(read.imageIds.map((mediaId) => ({ postId: post!.id, mediaId })));
      await tx
        .update(mediaObjects)
        .set({ attachedAt: sql`now()` })
        .where(inArray(mediaObjects.id, read.imageIds));
    }
    return post!;
  });
}

export interface CreateCommentInput {
  postId: string;
  authorId: string;
  /** The 댓글 a 대댓글 hangs under. Default: none — a 댓글. */
  parentId?: string | null;
  /**
   * That 댓글's `created_at`, which a 대댓글 carries. Default: read from the row `parentId` names (a
   * parent that is not there gives NULL, refused by `post_comments_parent_created_at_check`); a
   * test of the parent's foreign key sets it.
   */
  parentCreatedAt?: Date;
  /** Default: '댓글 <tag>'. Stored as given: the API's normalisation is the API's. */
  body?: string;
  /** Default: the database clock. An order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  deletedAt?: Date;
  hiddenAt?: Date;
}

/**
 * A comment (#48) as `POST /posts/:postId/comments` leaves it, or, with the times, as an edit, a
 * deletion or an operator's hiding left it. No revision rows: an edit's history is the API's to
 * write. The database holds the layers (a 대댓글's parent is a 댓글 of the same post) whoever
 * writes, this factory included.
 */
export async function createComment(db: Db, input: CreateCommentInput) {
  const [comment] = await db
    .insert(postComments)
    .values({
      postId: input.postId,
      authorId: input.authorId,
      parentId: input.parentId ?? null,
      parentCreatedAt:
        input.parentCreatedAt ??
        (input.parentId === undefined || input.parentId === null
          ? null
          : sql`(SELECT ${postComments.createdAt} FROM ${postComments} WHERE ${postComments.id} = ${input.parentId})`),
      body: input.body ?? `댓글 ${tag()}`,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
      ...(input.hiddenAt === undefined ? {} : { hiddenAt: input.hiddenAt }),
    })
    .returning();
  return comment!;
}

export interface CreateLikeInput {
  /** The account that likes. */
  userId: string;
  /**
   * The keyed hash of its number (64 lower-case hex). Default: a random one, so two likes never
   * share a number; a test about "the same number" passes one hash twice, or the API's hash of
   * the account's verified number.
   */
  phoneHash?: string;
  /** Default: the database clock. */
  createdAt?: Date;
}

/**
 * A like on a post (#49) as `PUT /posts/:postId/like` leaves it: the `post_likes` row. Checks
 * nothing the API checks (the onboarding, the post's state); the database holds once per number
 * and once per account, so a second like of either throws.
 */
export async function createPostLike(db: Db, input: CreateLikeInput & { postId: string }) {
  const [like] = await db
    .insert(postLikes)
    .values({
      postId: input.postId,
      userId: input.userId,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return like!;
}

/** A like on a 댓글 or a 대댓글 (#49), as `createPostLike` makes a post's. */
export async function createCommentLike(db: Db, input: CreateLikeInput & { commentId: string }) {
  const [like] = await db
    .insert(commentLikes)
    .values({
      commentId: input.commentId,
      userId: input.userId,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return like!;
}

export interface CreateNoticeInput {
  /** Default: '공지 <tag>'. */
  title?: string;
  /**
   * The body as text: one paragraph per line. Default: '공지 내용 <tag>'. Ignored with `document`.
   */
  text?: string;
  /** The whole body, as `sanitizePostDocument` would have stored it. */
  document?: PostDocument;
  /**
   * Uploads (`createMedia`) the body shows after its paragraphs, in order: attached to the notice
   * as the API attaches them. Ignored with `document`, whose own images are attached instead.
   */
  imageIds?: string[];
  /** Default: the database clock. A list's order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  /**
   * Pinned in this slot (1..NOTICE_PIN_LIMIT, the database holds the range and one notice per
   * slot), since `pinnedAt` (default: the database clock). Default: not pinned.
   */
  pinSlot?: number;
  pinnedAt?: Date;
}

/**
 * A notice (#138) as `POST /admin/notices` leaves it — the row with its body's text and images
 * derived as the API derives them, each image attached (`notice_images`, the upload's
 * `attached_at`) — or, with `pinSlot`, as a pin left it. No revision or audit rows: those are the
 * API's to write.
 */
export async function createNotice(db: Db, input: CreateNoticeInput = {}) {
  const document: PostDocument = input.document ?? {
    type: 'doc',
    content: [
      ...(input.text ?? `공지 내용 ${tag()}`)
        .split('\n')
        .map((line) =>
          line === ''
            ? { type: 'paragraph' as const }
            : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] },
        ),
      ...(input.imageIds ?? []).map((mediaId) => ({ type: 'image' as const, attrs: { mediaId } })),
    ],
  };
  const read = readPostDocument(document);
  return db.transaction(async (tx) => {
    const [notice] = await tx
      .insert(notices)
      .values({
        title: input.title ?? `공지 ${tag()}`,
        body: document,
        bodyText: read.text,
        imageIds: read.imageIds,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
        ...(input.pinSlot === undefined
          ? {}
          : { pinSlot: input.pinSlot, pinnedAt: input.pinnedAt ?? sql`now()` }),
      })
      .returning();
    if (read.imageIds.length > 0) {
      await tx
        .insert(noticeImages)
        .values(read.imageIds.map((mediaId) => ({ noticeId: notice!.id, mediaId })));
      await tx
        .update(mediaObjects)
        .set({ attachedAt: sql`now()` })
        .where(inArray(mediaObjects.id, read.imageIds));
    }
    return notice!;
  });
}

export interface CreateModerationActionInput {
  /** The member acted on. */
  userId: string;
  /** The operator. */
  createdBy: string;
  /** Default: `hide` with a post, `warning` without one. */
  type?: ModerationActionType;
  /** A hiding's post, or a warning's. */
  postId?: string;
  /** A hiding's comment, or a warning's. */
  commentId?: string;
  /** Default: `spam`. An `account_restriction` takes one of ACCOUNT_RESTRICTION_REASONS. */
  reason?: ModerationReason;
  /**
   * The explanation the member reads. Default: none (a `other` needs one), and for an
   * `account_restriction`, which always has one, '계정 제한 설명'.
   */
  note?: string | null;
  /** Default: the database clock. */
  createdAt?: Date;
  /**
   * A `writing_restriction`'s or an `account_restriction`'s end (#185, #139): null or left out for
   * 무기한. Nothing else has one.
   */
  endsAt?: Date | null;
  /**
   * An `account_restriction`'s approval (#139): the other admin who approves the request `createdBy`
   * asks for — a request of the kind `account_restriction` for the member, made and approved here
   * (migration 0042 refuses the row without one). Required for that type, refused for the others.
   */
  approvedBy?: string;
  /**
   * A cancellation: when, by whom and why — and for an `account_restriction`, the other admin who
   * approves the request to cancel it (`approvedBy`).
   */
  cancelled?: { at: Date; by: string; reason: string; approvedBy?: string };
  /**
   * What a profile action took away (#37-10): kept in `profile_item_removals` for the
   * `nickname_reset`, `bio_clear` and `image_remove` types. Default: a nickname, a 소개 or no image
   * — an `image_remove` needs its image id.
   */
  removed?: { nickname?: string; bio?: string; imageId?: string };
}

/**
 * A moderation action (#50) as an operator's route leaves the record: the `moderation_actions` row,
 * and for a profile action what it took away. Writes nothing else — not `hidden_at`, nor the
 * profile — so a test sets the item's state itself (`createPost({ hiddenAt })`).
 */
export async function createModerationAction(db: Db, input: CreateModerationActionInput) {
  const type = input.type ?? (input.postId || input.commentId ? 'hide' : 'warning');
  const account = type === 'account_restriction';
  if (account !== (input.approvedBy !== undefined)) {
    throw new Error(
      'createModerationAction: approvedBy is an account_restriction’s, and its alone',
    );
  }
  return db.transaction(async (tx) => {
    const id = randomUUID();
    const approvalId = account
      ? (
          await createApprovalRequest(tx as unknown as Db, {
            kind: 'account_restriction',
            targetType: 'user',
            targetId: input.userId,
            requestedBy: input.createdBy,
            ...(input.createdAt === undefined ? {} : { requestedAt: input.createdAt }),
            decision: { status: 'approved', by: input.approvedBy! },
          })
        ).id
      : null;
    const cancelled = input.cancelled;
    if (account && cancelled !== undefined && cancelled.approvedBy === undefined) {
      throw new Error('createModerationAction: an account restriction is cancelled by an approval');
    }
    const cancelApprovalId =
      account && cancelled !== undefined
        ? (
            await createApprovalRequest(tx as unknown as Db, {
              kind: 'account_restriction_cancel',
              targetType: 'moderation_action',
              targetId: id,
              requestedBy: cancelled.by,
              requestedAt: cancelled.at,
              decision: { status: 'approved', by: cancelled.approvedBy! },
            })
          ).id
        : null;
    const [action] = await tx
      .insert(moderationActions)
      .values({
        id,
        type,
        userId: input.userId,
        postId: input.postId ?? null,
        commentId: input.commentId ?? null,
        reason: input.reason ?? 'spam',
        note: input.note ?? (account ? '계정 제한 설명' : null),
        createdBy: input.createdBy,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        endsAt: input.endsAt ?? null,
        approvalId,
        ...(cancelled === undefined
          ? {}
          : {
              cancelledAt: cancelled.at,
              cancelledBy: cancelled.by,
              cancelReason: cancelled.reason,
              cancelApprovalId,
            }),
      })
      .returning();
    const removed = input.removed;
    if (type === 'nickname_reset' || type === 'bio_clear' || type === 'image_remove') {
      await tx.insert(profileItemRemovals).values({
        actionId: action!.id,
        nickname: type === 'nickname_reset' ? (removed?.nickname ?? `old_${tag()}`) : null,
        bio: type === 'bio_clear' ? (removed?.bio ?? `소개 ${tag()}`) : null,
        imageId: type === 'image_remove' ? (removed?.imageId ?? null) : null,
      });
    }
    return action!;
  });
}

export interface CreateApprovalRequestInput {
  /** The two-person rule's kind (approvals.ts), a consumer's: `account_restriction` and the rest. */
  kind: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown> | null;
  /** The admin who asks. */
  requestedBy: string;
  /** Default: '요청 사유'. */
  reason?: string;
  /** Default: the database clock. */
  requestedAt?: Date;
  /**
   * The decision, by an admin other than the requester (migration 0021 refuses the rest), a
   * millisecond after the request unless `at` is given. Left out: pending.
   */
  decision?: { status: 'approved' | 'rejected'; by: string; reason?: string; at?: Date };
  /**
   * Retracted by its requester instead (#139, migration 0042), a millisecond after the request
   * unless `at` is given. Not with `decision`.
   */
  retracted?: { at?: Date };
}

/**
 * A two-person rule request (#171), pending, decided or retracted — inserted pending and closed by
 * the one UPDATE migration 0021 allows, as ApprovalService does. The deciding account must hold
 * the admin role (the trigger reads it).
 */
export async function createApprovalRequest(db: Db, input: CreateApprovalRequestInput) {
  const requestedAt =
    input.requestedAt ??
    (await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
  const at = new Date(requestedAt);
  const [request] = await db
    .insert(approvalRequests)
    .values({
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      payload: input.payload ?? null,
      requestedBy: input.requestedBy,
      requestReason: input.reason ?? '요청 사유',
      requestedAt: at,
    })
    .returning();
  if (input.retracted !== undefined) {
    if (input.decision !== undefined) {
      throw new Error('createApprovalRequest: a request is decided or retracted, not both');
    }
    const [retracted] = await db
      .update(approvalRequests)
      .set({
        status: 'retracted',
        retractedAt: input.retracted.at ?? new Date(at.getTime() + 1),
      })
      .where(eq(approvalRequests.id, request!.id))
      .returning();
    return retracted!;
  }
  if (input.decision === undefined) return request!;
  const [decided] = await db
    .update(approvalRequests)
    .set({
      status: input.decision.status,
      decidedBy: input.decision.by,
      decisionReason: input.decision.reason ?? '결정 사유',
      decidedAt: input.decision.at ?? new Date(at.getTime() + 1),
    })
    .where(eq(approvalRequests.id, request!.id))
    .returning();
  return decided!;
}

export interface CreateReportInput {
  reporterId: string;
  /** The member reported: the item's author, the profile's member. */
  reportedUserId: string;
  /** A post's report. */
  postId?: string;
  /** A comment's report. Neither: a profile's. */
  commentId?: string;
  /** Default: a random hash, so two reports never share a number. */
  reporterPhoneHash?: string;
  /** Default: `spam`. */
  reason?: ReportReason;
  /** Default: none (an `other` needs one). */
  description?: string | null;
  /** Default: the database clock. */
  createdAt?: Date;
  /** Default: `pending`. A processed one needs `resolvedBy`, and `actionId` or `dismissalReason`. */
  status?: ReportStatus;
  resolvedAt?: Date;
  resolvedBy?: string;
  actionId?: string;
  dismissalReason?: string;
}

/**
 * A report (#50) as `POST …/reports` leaves it, or, with the processing, as an operator left it.
 * Checks nothing the API checks (the onboarding, the target's state, the daily limit); the
 * database holds the shape, one pending report per account and target, and nobody reporting
 * themselves.
 */
export async function createReport(db: Db, input: CreateReportInput) {
  const targetType = input.postId ? 'post' : input.commentId ? 'comment' : 'profile';
  const status = input.status ?? 'pending';
  const [report] = await db
    .insert(reports)
    .values({
      targetType,
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      reportedUserId: input.reportedUserId,
      reporterId: input.reporterId,
      reporterPhoneHash: input.reporterPhoneHash ?? randomPhoneHash(),
      reason: input.reason ?? 'spam',
      description: input.description ?? null,
      status,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(status === 'pending'
        ? {}
        : {
            resolvedAt: input.resolvedAt ?? new Date(),
            resolvedBy: input.resolvedBy ?? null,
            actionId: input.actionId ?? null,
            dismissalReason: input.dismissalReason ?? null,
          }),
    })
    .returning();
  return report!;
}

export interface CreateWriteLimitEventInput {
  /** The writer's number as its keyed hash (64 lower-case hex). Default: a random one. */
  phoneHash?: string;
  action: WriteLimitAction;
  /** Default: the database clock. A window test sets an earlier time. */
  createdAt?: Date;
}

/**
 * A write the limits count (#187, ADR-0083), as the API's WriteLimitsService leaves it: the
 * `write_limit_events` row only — no post, comment or image behind it, which the limits never read.
 * For a test that needs a number's earlier writes, at the times it names.
 */
export async function createWriteLimitEvent(db: Db, input: CreateWriteLimitEventInput) {
  const [row] = await db
    .insert(writeLimitEvents)
    .values({
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      action: input.action,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateLinkUseInput {
  /** The link in `normaliseLink`'s form; stored as given. */
  url: string;
  phoneHash?: string;
  /** Exactly one of the two: the post or the comment that took the link. */
  postId?: string;
  commentId?: string;
  /** Default: now. */
  usedAt?: Date;
}

/** A link a post or a comment took (#187), as the API's LinkReviewService records it. */
export async function createLinkUse(db: Db, input: CreateLinkUseInput) {
  const [row] = await db
    .insert(linkUses)
    .values({
      url: input.url,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      usedAt: input.usedAt ?? new Date(),
    })
    .returning();
  return row!;
}

export interface CreateLinkFlagInput {
  url: string;
  reason: LinkFlagReason;
  postId?: string;
  commentId?: string;
  /** Default: the database clock. */
  flaggedAt?: Date;
  /** The operator's mark that covered it (an admin_actions row); default none. */
  reviewActionId?: string;
}

/** An entry of the repeated-link review list (#187), as the API's LinkReviewService writes one. */
export async function createLinkFlag(db: Db, input: CreateLinkFlagInput) {
  const [row] = await db
    .insert(linkFlags)
    .values({
      url: input.url,
      reason: input.reason,
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      reviewActionId: input.reviewActionId ?? null,
      ...(input.flaggedAt === undefined ? {} : { flaggedAt: input.flaggedAt }),
    })
    .returning();
  return row!;
}

/**
 * A member's closure of the account (#140) as the API's AccountClosureService leaves it, in one
 * transaction — for a test whose subject needs a closed account rather than the closure itself
 * (a read, an audit): a waiting start grant cancelled (its numbers freed by migration 0031's
 * trigger), the Coin left forfeited by a CLOSURE_FORFEIT entry, the nickname held unlinked and the
 * holds naming the account unlinked, the profile closed without its public items, the interest
 * categories, the profile image's row (its object is the test's store's), the 본인확인 record,
 * the watchlist, the search history, the sessions, sign-in methods and reset tokens gone, the
 * address replaced and the name and photo emptied, and the account restriction requests about
 * the member still waiting rejected by no admin, '탈퇴'. Returns the closure's instant. Throws
 * where migration 0041 would refuse the commit (Coin reserved, say).
 */
export async function closeAccount(db: Db, userId: string): Promise<Date> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .for('update');
    if (!profile?.nickname) throw new Error(`closeAccount: ${userId} is not an open account`);
    const closedAt = (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`))
      .rows[0]!.now;
    const at = new Date(closedAt);
    await tx
      .update(startGrants)
      .set({ cancelledAt: at })
      .where(
        and(
          eq(startGrants.userId, userId),
          sql`${startGrants.grantedAt} IS NULL AND ${startGrants.cancelledAt} IS NULL`,
        ),
      );
    const [balance] = await tx
      .select()
      .from(balances)
      .where(eq(balances.userId, userId))
      .for('update');
    if (balance!.availableCoin > 0n) {
      await tx.insert(ledgerEntries).values({
        userId,
        type: 'CLOSURE_FORFEIT',
        amountCoin: -balance!.availableCoin,
        balanceAfterCoin: 0n,
        refType: 'account_closure',
        refId: userId,
        createdAt: at,
      });
      await tx.update(balances).set({ availableCoin: 0n }).where(eq(balances.userId, userId));
    }
    await tx.update(nicknameHolds).set({ userId: null }).where(eq(nicknameHolds.userId, userId));
    await tx
      .insert(nicknameHolds)
      .values({ nickname: profile.nickname, userId: null, releasedAt: at });
    await tx
      .update(profiles)
      .set({ closedAt: at, nickname: null, bio: null, imageId: null })
      .where(eq(profiles.userId, userId));
    await tx.delete(profileInterestCategories).where(eq(profileInterestCategories.userId, userId));
    if (profile.imageId !== null) {
      await tx.delete(mediaObjects).where(eq(mediaObjects.id, profile.imageId));
    }
    await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
    await tx.delete(marketWatches).where(eq(marketWatches.userId, userId));
    await tx.delete(marketSearches).where(eq(marketSearches.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(verification).where(eq(verification.value, userId));
    await tx
      .update(user)
      .set({
        email: closedAccountEmail(userId),
        emailVerified: false,
        name: AUTH_USER_NAME,
        image: null,
      })
      .where(eq(user.id, userId));
    const actions = tx
      .select({ id: sql<string>`${moderationActions.id}::text` })
      .from(moderationActions)
      .where(eq(moderationActions.userId, userId));
    await tx
      .update(approvalRequests)
      .set({
        status: 'rejected',
        decisionReason: ACCOUNT_CLOSURE_DECISION_REASON,
        decidedAt: sql`greatest(${at}::timestamptz, ${approvalRequests.requestedAt} + interval '1 millisecond')`,
      })
      .where(
        and(
          eq(approvalRequests.status, 'pending'),
          sql`((${approvalRequests.kind} = 'account_restriction' AND ${approvalRequests.targetType} = 'user' AND ${approvalRequests.targetId} = ${userId})
            OR (${approvalRequests.kind} IN ('account_restriction_shorten', 'account_restriction_lift', 'account_restriction_cancel')
                AND ${approvalRequests.targetType} = 'moderation_action'
                AND ${approvalRequests.targetId} IN (${actions})))`,
        ),
      );
    return at;
  });
}
