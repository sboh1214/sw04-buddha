import { RETENTION_PURGE_KINDS } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';

/** RETENTION_PURGE_KINDS as the SQL list the CHECK holds the column to. */
const PURGE_KINDS_SQL = sql.raw(RETENTION_PURGE_KINDS.map((kind) => `'${kind}'`).join(', '));

/**
 * 경과 처리 기록 (#184, ADR-0069 decision 4 #184 «종류·건수·시각을 운영 기록으로 남긴다. 개인정보
 * 내용은 남기지 않는다»): what each run of the worker's `retention.purge` deleted — the kind, how
 * many and when, with the period it read — and nothing about whose. Written in the transaction that
 * deleted what it counts, so a count never names a deletion that did not commit nor misses one
 * that did: one row per batch that deleted something, or one row of 0 for a kind the run processed
 * and found nothing due in. A kind whose period is not approved is not processed and gets no row.
 *
 * An operational record, kept with no period (#57-18 «운영 기록은 기간 없이 보존한다»):
 * buddha_app may INSERT and SELECT only (migration 0042). Read at `GET /admin/retention-purges`.
 *
 * - `kind`: RETENTION_PURGE_KINDS.
 * - `period_days`: the period the run applied (the release setting's value at the run's start, or
 *   the nickname hold's fixed 30 days), so the record says which value deleted what (ADR-0055: a
 *   new value applies to the runs after the change).
 * - `ran_at`: the run's instant, the database clock at its start — the end of every period it
 *   applied (`retentionCutoffOf`). Every row of one run carries the same one.
 */
export const retentionPurges = pgTable(
  'retention_purges',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    kind: varchar({ length: 32 }).notNull(),
    count: integer().notNull(),
    periodDays: integer().notNull(),
    ranAt: timestampTz().notNull(),
  },
  (t) => [
    check('retention_purges_kind_check', sql`${t.kind} IN (${PURGE_KINDS_SQL})`),
    check('retention_purges_count_check', sql`${t.count} >= 0`),
    check('retention_purges_period_days_check', sql`${t.periodDays} >= 1`),
    /** `GET /admin/retention-purges`: newest first, with the row-comparison cursor. */
    index('retention_purges_ran_at_id_idx').on(desc(t.ranAt), desc(t.id)),
  ],
);
