/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomInt, randomUUID } from 'node:crypto';
import {
  PRICE_MAX,
  PRICE_MIN,
  SIGNUP_BONUS_COIN,
  SETTLEMENT_STEPS,
  relatedMarketPair,
  type MarketStatus,
  type Outcome,
  type Role,
  type SettlementStep,
  type SettlementStepStatus,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  balances,
  categories,
  fills,
  ledgerEntries,
  marketLinks,
  marketSearches,
  marketSettlementSteps,
  marketWatchEvents,
  marketWatches,
  markets,
  orders,
  phoneVerifications,
  positions,
  profiles,
  user,
} from '../schema/index.js';

/** Short unique tag for generated emails/slugs/nicknames. */
const tag = () => randomUUID().replaceAll('-', '').slice(0, 8);

export interface CreateUserInput {
  id?: string;
  email?: string;
  name?: string;
  nickname?: string;
  role?: Role;
  /**
   * Balance the user should end up with. Every account is created with SIGNUP_BONUS_COIN by the
   * trigger (migration 0004); asking for something else writes the difference as an
   * ADMIN_ADJUST entry, so the PLAN 5.6 invariant keeps holding. Omit to keep the bonus.
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
  const balanceCoin = input.balanceCoin ?? SIGNUP_BONUS_COIN;
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
