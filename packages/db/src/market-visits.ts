import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isHumanAccountTypeSql } from './account-types.js';
import { adminSpansCte, wasAdminAtSql } from './admin-role-spans.js';
import type { Db } from './client.js';
import { isPublicMarketStatusSql } from './public-market.js';
import { markets, user } from './schema/index.js';

/*
 * 방문 기록 쓰기 (#151, ADR-0170; owner answers 151-3, 151-4; ADR-0167 결정 6): the one writer of
 * `market_visits`. Called only by the API's `POST /me/market-visits` (MarketVisitsService), whose
 * guards have already checked the session, the expected account (ADR-0092) and the onboarding
 * (`OnboardedGuard` — 151-4's basis is the 처리방침 notice the onboarding consent carries); this
 * writer checks what the metrics read: a public market, a person's account (#115), and not admin
 * at this instant by the grant and revoke records (96-10 — the same `wasAdminAtSql` the metrics
 * exclude cohorts by, so the write gate and the read side never disagree; `profiles.role` is not
 * read, and an account with the role but no record is a member here as there).
 */

/** Anything that runs a statement: the pooled `Db` or a transaction handle. */
type Executor = Pick<Db, 'execute'>;

export interface RecordMarketVisitInput {
  userId: string;
  /** A uuid (the route's body schema checks it). */
  marketId: string;
}

/**
 * What `recordMarketVisit` did:
 * - `recorded`: a new row for today's Korean date;
 * - `merged`: the account already had today's row for that market (95-4) — nothing written;
 * - `excluded`: an operating account, an account admin now by the records, or no such account —
 *   nothing written (151-3); the route answers 204 all the same, so its answer says nothing of it;
 * - `not_found`: no public market with that id (the route answers NOT_FOUND, as every public read
 *   of a DRAFT or REVIEW market does).
 */
export type RecordMarketVisitResult = 'recorded' | 'merged' | 'excluded' | 'not_found';

const u = alias(user, 'u');
const m = alias(markets, 'm');

/**
 * Records that `userId` opened `marketId`'s detail today (KST): one statement, READ COMMITTED, a
 * raw INSERT naming `user_id` and `market_id` only — buddha_app holds INSERT on those two columns
 * alone (migration 0082), so the date is the column default, the database clock's Korean date,
 * and drizzle's `.insert()` (which names every column) would be refused. The day's repeat is
 * merged by the primary key (`ON CONFLICT DO NOTHING`).
 *
 * The admin check reads the records at `clock_timestamp()`; no role lock is taken: a grant
 * committing concurrently is after this statement, and the row carries no time anyway. The
 * triggers refuse an operating account's row (the SQL filter already leaves it out) and a closed
 * account's — the latter raised with the trigger's name (`market_visits_open_account`) for the
 * caller to answer as the session that ended (the 0043 race).
 */
export async function recordMarketVisit(
  db: Executor,
  input: RecordMarketVisitInput,
): Promise<RecordMarketVisitResult> {
  const { rows } = await db.execute<{ found: boolean; eligible: boolean; written: number }>(sql`
    WITH ${adminSpansCte()},
    target AS (
      SELECT m.id AS market_id, u.id AS user_id,
             coalesce(${isHumanAccountTypeSql(u.accountType)}, false)
               AND NOT ${wasAdminAtSql(sql`u.id`, sql`clock_timestamp()`)} AS eligible
        FROM markets m LEFT JOIN "user" u ON u.id = ${input.userId}
       WHERE m.id = ${input.marketId} AND ${isPublicMarketStatusSql(m.status)}
    ),
    written AS (
      INSERT INTO market_visits (user_id, market_id)
      SELECT t.user_id, t.market_id FROM target t WHERE t.eligible
      ON CONFLICT (user_id, market_id, visit_date) DO NOTHING
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM target) AS found,
           coalesce((SELECT t.eligible FROM target t), false) AS eligible,
           (SELECT count(*) FROM written)::int AS written`);
  const [row] = rows;
  if (!row?.found) return 'not_found';
  if (!row.eligible) return 'excluded';
  return row.written > 0 ? 'recorded' : 'merged';
}
