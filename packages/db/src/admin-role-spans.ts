import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/*
 * "관리자였던 때" (#96, ADR-0169; ADR-0167 95-1, 결정 5의 1, 결정 8의 1·2, 결과 5): whether an
 * account held the admin role at an instant, read from the grant and revoke records alone
 * (`admin_actions` `admin_grant`/`admin_revoke` on target type `user` — 95-1 "관리자 권한 부여·회수
 * 기록 기준"). Never from the current `profiles.role` and never inferred: an account with no record
 * reads as never admin (owner answer 96-10), one whose first record is a revoke as not admin before
 * it. The spans are half-open — admin from a grant's instant up to the next role change of the
 * account, so admin AT the grant and no longer AT the revoke. Role-change times strictly increase
 * across all accounts (`adminRoleChangeTimestamp`, role-boundary.ts), so the `(created_at, id)`
 * order has no tie in real data; `id` only makes it total.
 *
 * Used as `WITH ${adminSpansCte()}, …` and then `NOT ${wasAdminAtSql(id, at)}` in a WHERE, where
 * the planner makes it a hash anti-join on the account (the observation metrics, #151's two
 * visit-based ones included — 결정 8의 1 holds for them too). #151's visit writer
 * (`recordMarketVisit`) applies the same test at `clock_timestamp()`, so an admin's open is never
 * written and the write gate and the metrics agree on who was admin (ADR-0170, 96-10).
 */

/** The CTE `admin_spans(user_id, type, from_at, to_at)`: one row per role-change record. */
export function adminSpansCte(): SQL {
  return sql`admin_spans AS (
    SELECT a.target_id AS user_id, a.type, a.created_at AS from_at,
           coalesce(lead(a.created_at) OVER (PARTITION BY a.target_id
                                             ORDER BY a.created_at, a.id),
                    'infinity'::timestamptz) AS to_at
      FROM admin_actions a
     WHERE a.target_type = 'user' AND a.type IN ('admin_grant', 'admin_revoke')
  )`;
}

/**
 * SQL: whether `userId` held the admin role at `at` by the records — inside a grant's span
 * [grant, next role change). Needs `adminSpansCte()` in the statement's WITH.
 */
export function wasAdminAtSql(userId: SQLWrapper, at: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM admin_spans s
    WHERE s.type = 'admin_grant' AND s.user_id = ${userId}
      AND ${at} >= s.from_at AND ${at} < s.to_at)`;
}
