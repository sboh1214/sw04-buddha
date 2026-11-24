import type { RetentionPurgeOutcome } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import type { TestDb } from './harness.js';

/*
 * Fixtures of the visit records (#151, ADR-0170). buddha_app inserts a visit's account and market
 * only — its date is always the database clock's (migration 0082) — and may not write the
 * collection's start, so a dated visit and the start go through the table owner (`TestDb.asOwner`;
 * pass `t.asOwner`). Raw SQL only. The triggers still apply: an operating or a closed account's
 * visit is refused here too.
 */

type AsOwner = TestDb['asOwner'];

export interface CreateVisitInput {
  userId: string;
  marketId: string;
  /** The Korean date of the open, `YYYY-MM-DD`. */
  date: string;
}

/** One visit row at a chosen Korean date; a second one of the same day is merged (no throw). */
export async function createVisit(asOwner: AsOwner, input: CreateVisitInput): Promise<void> {
  await asOwner(
    `INSERT INTO market_visits (user_id, market_id, visit_date) VALUES ($1, $2, $3::date)
     ON CONFLICT DO NOTHING`,
    [input.userId, input.marketId, input.date],
  );
}

/**
 * The visit collection's start (`market_visit_collection`) at `at`, or no start (`null`) — what a
 * wipe leaves, and the test reset too.
 */
export async function setVisitCollectionStart(asOwner: AsOwner, at: Date | null): Promise<void> {
  await asOwner('DELETE FROM market_visit_collection');
  if (at !== null) {
    await asOwner('INSERT INTO market_visit_collection (started_at) VALUES ($1::timestamptz)', [
      at.toISOString(),
    ]);
  }
}

export interface RecordVisitPurgeInput {
  ranAt: Date;
  periodDays: number;
  count: number;
  /** Default `done`. */
  outcome?: RetentionPurgeOutcome;
}

/** A `retention_purges` row of kind `market_visits`, as a purge run writes one (buddha_app). */
export async function recordVisitPurge(db: Db, input: RecordVisitPurgeInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO retention_purges (kind, count, period_days, ran_at, outcome)
    VALUES ('market_visits', ${input.count}, ${input.periodDays},
            ${input.ranAt.toISOString()}::timestamptz, ${input.outcome ?? 'done'})`);
}

/** Every visit row, oldest date first, for assertions (dates as `YYYY-MM-DD`). */
export async function readVisits(
  db: Db,
): Promise<{ userId: string; marketId: string; date: string }[]> {
  const { rows } = await db.execute<{ userId: string; marketId: string; date: string }>(sql`
    SELECT user_id AS "userId", market_id AS "marketId", to_char(visit_date, 'YYYY-MM-DD') AS date
      FROM market_visits ORDER BY visit_date, user_id, market_id`);
  return rows;
}
