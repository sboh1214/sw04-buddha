/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIQUIDITY_B,
  SIGNUP_BONUS_P,
  INITIAL_PROB_BP_MAX,
  INITIAL_PROB_BP_MIN,
  PRICE_MAX,
  PRICE_MIN,
  type MarketStatus,
  type Role,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { balances, categories, ledgerEntries, markets, profiles, user } from '../schema/index.js';

/** Short unique tag for generated emails/slugs/nicknames. */
const tag = () => randomUUID().replaceAll('-', '').slice(0, 8);

export interface CreateUserInput {
  id?: string;
  email?: string;
  name?: string;
  nickname?: string;
  role?: Role;
  /**
   * Balance the user should end up with. Every account is created with SIGNUP_BONUS_P by the
   * trigger (migration 0004); asking for something else writes the difference as an
   * ADMIN_ADJUST entry, so the PLAN 5.6 invariant keeps holding. Omit to keep the bonus.
   */
  balanceP?: bigint;
}

/**
 * Inserts a `user` row (better-auth table). The AFTER INSERT trigger (migration
 * 0002_user_profile_trigger) creates `profiles` + `balances` in the same transaction, exactly
 * as a real sign-up does; the factory then applies the requested nickname/role/balance.
 */
export async function createUser(db: Db, input: CreateUserInput = {}) {
  const id = input.id ?? randomUUID();
  const t = tag();
  const balanceP = input.balanceP ?? SIGNUP_BONUS_P;
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
      .set({ nickname: input.nickname ?? `예측가_${t}`, role: input.role ?? 'user' })
      .where(eq(profiles.userId, id))
      .returning();
    let [balance] = await tx.select().from(balances).where(eq(balances.userId, id));
    if (!userRow || !profile || !balance) {
      throw new Error('user trigger did not create profiles/balances (migration 0002 missing?)');
    }
    if (balanceP !== balance.availableP) {
      const delta = balanceP - balance.availableP;
      [balance] = await tx
        .update(balances)
        .set({ availableP: balanceP })
        .where(eq(balances.userId, id))
        .returning();
      await tx.insert(ledgerEntries).values({
        userId: id,
        type: 'ADMIN_ADJUST',
        amountP: delta,
        balanceAfterP: balanceP,
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
  /** Initial YES probability in basis points, 1..9999 (default 5000). */
  initialProbBp?: number;
  /** LMSR liquidity parameter (default DEFAULT_LIQUIDITY_B). */
  liquidityB?: number;
  closeAt?: Date;
}

/**
 * Inserts a market with LMSR state initialised per PLAN 5.3:
 *   qYes = b * ln(p0 / (1 - p0)), qNo = 0, reserve = ceil(100 * b * ln 2),
 *   lastPrice = clamp(round(p0 * 100), 1, 99).
 * TODO(M3): replace the inline maths with `initState`/`priceOf` from @buddha/shared/lmsr.
 */
export async function createMarket(db: Db, input: CreateMarketInput = {}) {
  const t = tag();
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const categoryId = input.categoryId ?? (await createCategory(db)).id;
  const status = input.status ?? 'open';
  const initialProbBp = input.initialProbBp ?? 5000;
  if (initialProbBp < INITIAL_PROB_BP_MIN || initialProbBp > INITIAL_PROB_BP_MAX) {
    throw new RangeError(`initialProbBp must be 1..9999, got ${initialProbBp}`);
  }
  const b = input.liquidityB ?? DEFAULT_LIQUIDITY_B;
  const p0 = initialProbBp / 10_000;
  const qYes = b * Math.log(p0 / (1 - p0));
  const reserveP = BigInt(Math.ceil(100 * b * Math.LN2));
  const lastPrice = Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.round(p0 * 100)));
  const now = new Date();

  const [row] = await db
    .insert(markets)
    .values({
      slug: input.slug ?? `market-${t}`,
      title: input.title ?? `테스트 시장 ${t}`,
      description: input.description ?? null,
      rules: input.rules ?? '테스트용 정산 기준. 발표가 없으면 아니오로 정산한다.',
      resolutionSource: input.resolutionSource ?? 'https://example.com/source',
      categoryId,
      status,
      liquidityB: b.toFixed(6),
      qYes: qYes.toFixed(10),
      qNo: (0).toFixed(10),
      initialProbBp,
      reserveP,
      lastPrice,
      openAt: status === 'draft' ? null : now,
      closeAt: input.closeAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdBy,
    })
    .returning();
  return row!;
}
