import { RETENTION_PURGE_KINDS, RETENTION_PURGE_OUTCOMES } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';

/** RETENTION_PURGE_KINDS as the SQL list the CHECK holds the column to. */
const PURGE_KINDS_SQL = sql.raw(RETENTION_PURGE_KINDS.map((kind) => `'${kind}'`).join(', '));

/** RETENTION_PURGE_OUTCOMES as the SQL list the CHECK holds the column to. */
const PURGE_OUTCOMES_SQL = sql.raw(
  RETENTION_PURGE_OUTCOMES.map((outcome) => `'${outcome}'`).join(', '),
);

/**
 * 경과 처리 기록 (#184, ADR-0069 decision 4 #184 «종류·건수·시각을 운영 기록으로 남긴다. 개인정보
 * 내용은 남기지 않는다»): what each run of the worker's `retention.purge` deleted — the kind, how
 * many and when, with the period it read — and nothing about whose. Written in the transaction that
 * deleted what it counts, so a count never names a deletion that did not commit nor misses one
 * that did: one row per batch that deleted something, or one row of 0 for a kind the run processed
 * and found nothing due in, or one row of 0 marked `failed` for a kind the run gave up on (owner
 * decision 2026-10-24 14: «처리 기록에 '실패'와 시각»). A kind whose period is not approved is not
 * processed and gets no row.
 *
 * An operational record, kept with no period (#57-18 «운영 기록은 기간 없이 보존한다»):
 * buddha_app may INSERT and SELECT only (migration 0042). Read at `GET /admin/retention-purges`.
 *
 * - `kind`: RETENTION_PURGE_KINDS.
 * - `period_days`: the period the run applied (the release setting's value at the run's start, or
 *   the nickname hold's fixed 30 days), so the record says which value deleted what (ADR-0055: a
 *   new value applies to the runs after the change).
 * - `ran_at`: the run's instant, the database clock at its start — the end of every period it
 *   applied (`retentionCutoffOf`). Every row of one run carries the same one, a failure's too: the
 *   time a failure is shown with is its run's (the worker's log has the moment it failed).
 * - `outcome`: RETENTION_PURGE_OUTCOMES — `done` for what committed (and the 0 of a kind with
 *   nothing due), `failed` for a kind given up on, whose batch rolled back: its `count` is 0 (the
 *   CHECK), and what its earlier batches deleted is in their own `done` rows.
 */
export const retentionPurges = pgTable(
  'retention_purges',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    kind: varchar({ length: 32 }).notNull(),
    count: integer().notNull(),
    periodDays: integer().notNull(),
    ranAt: timestampTz().notNull(),
    outcome: varchar({ length: 16 }).notNull().default('done'),
  },
  (t) => [
    check('retention_purges_kind_check', sql`${t.kind} IN (${PURGE_KINDS_SQL})`),
    check('retention_purges_count_check', sql`${t.count} >= 0`),
    check('retention_purges_period_days_check', sql`${t.periodDays} >= 1`),
    /** A failure deleted nothing: its batch rolled back. */
    check(
      'retention_purges_outcome_check',
      sql`${t.outcome} IN (${PURGE_OUTCOMES_SQL}) AND (${t.outcome} <> 'failed' OR ${t.count} = 0)`,
    ),
    /** `GET /admin/retention-purges`: newest first, with the row-comparison cursor. */
    index('retention_purges_ran_at_id_idx').on(desc(t.ranAt), desc(t.id)),
  ],
);
