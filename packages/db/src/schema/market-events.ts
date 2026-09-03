import { bigserial, index, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { markets } from './markets.js';

/**
 * Append-only market audit log (PLAN 5.2: every transition is recorded). buddha_app holds
 * INSERT/SELECT only. `type` values: MARKET_EVENT_TYPES in @buddha/shared.
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
    payload: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('market_events_market_id_created_at_idx').on(t.marketId, t.createdAt)],
);
