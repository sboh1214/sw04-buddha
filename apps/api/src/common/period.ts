import { RECENT_PERIOD_HOURS, type RecentPeriod } from '@buddha/shared';
import { sql, type SQL } from 'drizzle-orm';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The `period` filter of a person's own lists (#124, ADR-0143; ADR-0135 G3·결과 4): the rows whose
 * time is within the last N × 24 hours of the instant the database reads them — `column > now() −
 * N hours`, so the window is `(now − N × 24h, now]` and a row exactly N × 24 hours old is
 * outside, as the 24-hour price's. `undefined` (no filter) when no period is asked.
 *
 * The clock is the database's `now()`, in the statement itself: no extra round trip, and never
 * the browser's or the API server's. The window is worked out again on every request and never
 * carried in a cursor: each list pages on a unique key, so pages neither overlap nor skip a row;
 * a row that left the window between two pages is left out of the later one — it no longer is
 * 'within N days of this read' — and a row that enters it is newer than every cursor. A
 * predicate only: the order and the cursor of the list stay as they are.
 *
 * `column` is the time the list is ordered by (an order's arrival, a fill's, a settlement's
 * payout). The hours are a BOUND PARAMETER from the closed table `RECENT_PERIOD_HOURS`.
 */
export function recentPeriodPredicate(
  column: AnyPgColumn,
  period: RecentPeriod | undefined,
): SQL | undefined {
  if (period === undefined) return undefined;
  return sql`${column} > now() - ${RECENT_PERIOD_HOURS[period]}::int * interval '1 hour'`;
}
