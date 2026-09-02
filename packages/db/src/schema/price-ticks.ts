import { sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';
import { priceTickTriggerEnum } from './enums.js';
import { markets } from './markets.js';

/** Price history for charts (PLAN 7.1 /markets/:id/ticks). Monthly partitioning: M6. */
export const priceTicks = pgTable(
  'price_ticks',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    ts: timestampTz().notNull(),
    /** YES probability in basis points 0..10000. */
    pYesBp: integer().notNull(),
    trigger: priceTickTriggerEnum().notNull(),
  },
  (t) => [
    index('price_ticks_market_id_ts_idx').on(t.marketId, t.ts),
    check('price_ticks_p_yes_bp_check', sql`${t.pYesBp} BETWEEN 0 AND 10000`),
  ],
);
