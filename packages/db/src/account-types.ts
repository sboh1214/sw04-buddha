import { randomUUID } from 'node:crypto';
import { AUTH_USER_NAME, MARKET_MAKER_ACCOUNT_EMAIL } from '@buddha/shared';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { user } from './schema/index.js';

/** A transaction handle of either app that writes and reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 계정 유형 (#115, ADR-0108; ADR-0107 결정 4 #115, 결정 2 #73 11항): the database side of the one
 * rule that says whether an account is a person's (`isHumanAccountType` in @buddha/shared, the SQL
 * functions of migration 0059), and the one place the 운영 마켓메이커 account is made and found.
 * Whoever counts or checks people — participants and volume (#121), '사용자 체결 0건' (#20·#120), a
 * fill's or an order's owner (#119), the self-trade group (#117), a 판정 이의's eligibility — asks
 * through these and never compares the type itself (the static test in account-types.test.ts).
 */

/**
 * SQL: whether the account `accountId` names is a person's — `is_human_account(id)`. False for
 * NULL, for an unknown id and for an operating account, so a ledger account with no owner (the
 * treasury, the collateral, #116) or the 운영 마켓메이커's is not a person's. A per-row filter: an
 * order's, a fill's or a position's `user_id`.
 */
export function isHumanAccountSql(accountId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`is_human_account(${accountId})`;
}

/**
 * SQL: the same rule over an account's type column already at hand — `is_human_account_type(…)`,
 * which the planner inlines: what a count over orders or fills joined to "user" uses (#121, #20).
 */
export function isHumanAccountTypeSql(accountType: SQLWrapper): SQL<boolean> {
  return sql<boolean>`is_human_account_type(${accountType})`;
}

/** Whether `accountId` is a person's account: false for an operating one and for no account. */
export async function isHumanAccount(executor: Reader, accountId: string): Promise<boolean> {
  const [human] = await executor
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, accountId), isHumanAccountTypeSql(user.accountType)))
    .limit(1);
  return human !== undefined;
}

/**
 * The 운영 마켓메이커 account's id, or null before the seed made it — what #116's funds per market,
 * #119's orders and #129's bot are owned by. Looked up by its type, never kept: #116's wipe empties
 * "user" and the next seed makes it again under a new id.
 */
export async function marketMakerAccountId(executor: Reader): Promise<string | null> {
  const [row] = await executor
    .select({ id: user.id })
    .from(user)
    .where(eq(user.accountType, 'market_maker'))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Makes the 운영 마켓메이커 account when it is missing (ADR-0107 결정 2 #73 11항: 시드가 없을 때만
 * 만들고) — the seed's step, and the test factory's — and returns its id, `created` when this call
 * made it. One `user` row of the type, `name` AUTH_USER_NAME as every account's, its address
 * MARKET_MAKER_ACCOUNT_EMAIL (no mail, no sign-in reaches it) unverified, and the database clock
 * for its times; the "user" trigger gives it no profile (migration 0059) and no ledger account of
 * its own (0060: its Coin is in each market's 마켓메이커 자금, `ensureLedgerAccount`). It writes
 * no sign-in method, no session, no admin action and no ledger entry, and the database
 * refuses it each of those (and a profile, a start grant and public activity) whoever asks.
 *
 * Race-safe with no lock: the address and `user_market_maker_uidx` are unique, so a second call
 * — another seed at once — inserts nothing and reads the first's row once it commits. Throws when
 * the address is held by an account that is not the 운영 마켓메이커, which no sign-up can make
 * (the credential endpoints refuse the domain).
 */
export async function ensureMarketMakerAccount(
  executor: Executor,
): Promise<{ id: string; created: boolean }> {
  const [made] = await executor
    .insert(user)
    .values({
      id: randomUUID(),
      name: AUTH_USER_NAME,
      email: MARKET_MAKER_ACCOUNT_EMAIL,
      emailVerified: false,
      accountType: 'market_maker',
    })
    .onConflictDoNothing()
    .returning({ id: user.id });
  if (made) return { id: made.id, created: true };
  const id = await marketMakerAccountId(executor);
  if (id === null) {
    throw new Error(
      `the market maker account's address ${MARKET_MAKER_ACCOUNT_EMAIL} is held by another account`,
    );
  }
  return { id, created: false };
}
