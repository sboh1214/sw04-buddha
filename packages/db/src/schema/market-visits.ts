import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { markets } from './markets.js';

/**
 * 방문 기록 (#151, ADR-0170; owner answers 151-3, 151-4, 151-5; ADR-0167 결정 6): one row per
 * account, public market and Korean date on which a signed-in, onboarded person who was not admin
 * by the records (96-10) opened that market's detail — and nothing else: no time, address,
 * device, referrer or cookie id (151-3 "IP·기기·유입 경로는 남기지 않고"; 결정 6 "조회 시각도 남기지
 * 않는다"). Read only by the two visit-based observation metrics (관심 등록 후 재방문, 결과 조회 —
 * observation-metrics.ts), never by a member, public or per-account admin answer (PRIVATE_DATA
 * `market-visits`, 95-10).
 *
 * - The one writer is `recordMarketVisit` (market-visits.ts), a raw INSERT naming `user_id` and
 *   `market_id` only: buddha_app holds INSERT on those two columns and no other (migration 0082),
 *   so `visit_date` is always the column default — the database clock's Korean date (ADR-0063) —
 *   and app code can never write a date. Drizzle's `.insert()` names every column and is refused.
 * - The primary key is the day's merge (95-4): a reload, a retry, a second tab or a second open the
 *   same day lands on the row already there (`ON CONFLICT DO NOTHING`). It leads by account, which
 *   serves the metrics' per-pair probes (account, market, date range).
 * - Triggers (0082): `market_visits_human_account` refuses an operating account's row (151-3,
 *   #115), `market_visits_open_account` a closed account's (the 0043 race: a request that passed
 *   the session check just before a closure committed).
 * - The one deleter is the worker's `retention.purge` step `marketVisits` (kind `market_visits`,
 *   setting `retention.market_visits`): every account's rows once the period has passed since
 *   00:00 KST of `visit_date` (ADR-0167 결정 8의 8). A closure deletes none (151-5), which is why
 *   both FKs are RESTRICT like `market_watch_events`' (accounts and markets are never deleted).
 *   buddha_app holds no UPDATE (a row never changes), so nothing can take a row lock on it.
 *
 * No drizzle relation names this table (relations.ts): a `with: { visits }` on an account or a
 * market would be a per-account read path.
 */
export const marketVisits = pgTable(
  'market_visits',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** The Korean date of the database clock at the insert (151-3 "한국 날짜로 하루 한 번"). */
    visitDate: date({ mode: 'string' })
      .notNull()
      .default(sql`((now() AT TIME ZONE 'Asia/Seoul')::date)`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.marketId, t.visitDate] }),
    /** The retention purge's `ORDER BY visit_date … LIMIT` over every account's rows. */
    index('market_visits_visit_date_idx').on(t.visitDate),
  ],
);

/**
 * When the visit records began to be kept (#151, ADR-0170; ADR-0167 결정 8의 7 "#151 배포 전의 주"):
 * at most one row (`id` is true or nothing), written by migration 0082 itself at the instant it
 * was applied — drizzle's journal keeps the authoring time, not the apply time. The metrics read
 * it as `visitsSince`: weeks starting before it are '자료 없음' for the two visit-based metrics
 * when it is later than the earliest account. A provenance marker, not an aggregate (95-8 "새 집계
 * 표나 작업은 필요 없다"): it holds no personal data and no count. buddha_app may only SELECT it;
 * a wipe (`db:wipe`, the test reset, deploy/reset-db.sh) empties it with every account, and the
 * metrics then apply no collection cut.
 */
export const marketVisitCollection = pgTable(
  'market_visit_collection',
  {
    id: boolean().primaryKey().default(true),
    startedAt: createdAt(),
  },
  (t) => [check('market_visit_collection_id_check', sql`${t.id}`)],
);
