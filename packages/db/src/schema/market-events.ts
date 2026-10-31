import { sql } from 'drizzle-orm';
import { bigserial, check, index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { marketStatusEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * Append-only market audit log (PLAN 5.2: every transition is recorded). buddha_app holds
 * INSERT/SELECT only. `type` values: MARKET_EVENT_TYPES in @buddha/shared.
 *
 * Every status change writes one row through `transitionMarket` (@buddha/db, #174): who
 * (`actor_id`, null for the worker), when (`created_at`, the DB clock after the market lock) and
 * the change itself (`from_status` → `to_status`), in the transaction that changes
 * `markets.status`. The `created` row has a `to_status` alone (the draft it wrote); a row that
 * changes no status (`rules_edited`) has neither.
 */
export const marketEvents = pgTable(
  'market_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    type: varchar({ length: 40 }).notNull(),
    /** Admin/user id, or null for the worker. No FK (PLAN 6.2): audit rows outlive accounts. */
    actorId: text(),
    /** The status the market left; null on `created` and on a row that changes no status. */
    fromStatus: marketStatusEnum(),
    /** The status the market entered; null on a row that changes no status. */
    toStatus: marketStatusEnum(),
    payload: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('market_events_market_id_created_at_idx').on(t.marketId, t.createdAt),
    check(
      'market_events_status_change_check',
      sql`${t.fromStatus} IS NULL OR (${t.toStatus} IS NOT NULL AND ${t.toStatus} <> ${t.fromStatus})`,
    ),
  ],
);
