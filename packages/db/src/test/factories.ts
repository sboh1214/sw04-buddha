/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  CONSENT_ITEMS,
  PRICE_MAX,
  PRICE_MIN,
  currentConsentVersion,
  SETTLEMENT_STEPS,
  readPostDocument,
  relatedMarketPair,
  type ImageContentType,
  type MarketStatus,
  type PostDocument,
  type Outcome,
  type ReleaseSettingStatus,
  type Role,
  type SettlementStep,
  type SettlementStepStatus,
} from '@buddha/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  adminActions,
  balances,
  categories,
  consentRecords,
  fills,
  ledgerEntries,
  marketLinks,
  marketSearches,
  marketSettlementSteps,
  marketWatchEvents,
  marketWatches,
  markets,
  mediaObjects,
  orders,
  phoneVerifications,
  positions,
  postImages,
  posts,
  profiles,
  releaseSettings,
  user,
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
