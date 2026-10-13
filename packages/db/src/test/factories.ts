/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomUUID } from 'node:crypto';
import {
  PRICE_MAX,
  PRICE_MIN,
  SIGNUP_BONUS_COIN,
  SETTLEMENT_STEPS,
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
  ledgerEntries,
  marketSettlementSteps,
  markets,
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
      openAt: status === 'draft' ? null : now,
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
