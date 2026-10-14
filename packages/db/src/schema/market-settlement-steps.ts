import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import { markets } from './markets.js';

/**
 * The settlement steps of a judged market (O-6, ADR-0046): a `resolved` market becomes
 * `settled` only once every step of SETTLEMENT_STEPS (@buddha/shared) is `done`.
 *
 * The admin's judgement inserts one `pending` row per step in its own transaction; the worker's
 * `finalizeMarket` runs the steps that are not `done` under the market lock and marks each
 * `done` with `completed_at`. A step that throws rolls its transaction back, and the worker then
 * records the attempt in a separate one — `attempts` + 1, `failed`, `last_error` — so the reason
 * a market stays `resolved` is readable without the worker's logs; the per-minute scan retries
 * it with no cap. `last_error` is kept after a later success.
 *
 * `step` and `status` are varchar validated by zod (the `market_events.type` convention), so #29
 * appends the `score` step without an enum migration. Not append-only: the worker updates rows.
 * No row for a voided market or one never judged.
 */
export const marketSettlementSteps = pgTable(
  'market_settlement_steps',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** SETTLEMENT_STEPS. */
    step: varchar({ length: 20 }).notNull(),
    /** SETTLEMENT_STEP_STATUSES. */
    status: varchar({ length: 20 }).notNull().default('pending'),
    /** Attempts that ran to a commit or a rollback. */
    attempts: integer().notNull().default(0),
    /** When the step committed; set exactly when `status = 'done'`. */
    completedAt: timestampTz(),
    /** First SETTLEMENT_STEP_ERROR_MAX characters of the last failed attempt's message. */
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.step] }),
    check('market_settlement_steps_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'market_settlement_steps_completed_at_check',
      sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);
