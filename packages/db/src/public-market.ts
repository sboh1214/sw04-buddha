import { PUBLIC_MARKET_STATUSES } from '@buddha/shared';
import { inArray, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * SQL: whether a market in `status` is public (ADR-0093 decision 1 item 12, #174): a status users
 * see (`PUBLIC_MARKET_STATUSES`), so DRAFT and REVIEW — the admin's alone — are on no list and
 * answer NOT_FOUND, the same as an id that does not exist. The one definition of that predicate:
 * the API's `isPublicMarket()` (every public read of a market) and the visit writer
 * (`recordMarketVisit`, #151) both apply it, the writer over its own alias (`m.status`).
 */
export function isPublicMarketStatusSql(status: SQLWrapper): SQL {
  return inArray(status, [...PUBLIC_MARKET_STATUSES]);
}
