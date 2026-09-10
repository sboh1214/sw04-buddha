import { sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';
import { priceTickTriggerEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * Price history for charts (PLAN 7.1 /markets/:id/ticks).
 *
 * ONE TABLE, not partitioned. PLAN 6.2 left "월 단위 파티셔닝은 M6에서 검토" against this line;
 * M6 reviewed it and decided against, with the reasons and the re-open triggers in ADR-0039.
 * The short version: three of the four read shapes are `ts <= boundary ORDER BY ts DESC LIMIT 1`
 * with no lower bound, which partition pruning cannot help — the executor would probe partitions
 * newest-to-oldest where today it makes one index descent, and that is the home page's sparkline.
 */
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
    // (market_id, ts, id): `GET /markets/:id/ticks` reads the newest TICKS_SCAN_MAX of a range
    // as one backward index scan (ORDER BY ts DESC, id DESC LIMIT n) — no sort node, whatever
    // the planner estimates for an incremental sort on (market_id, ts) alone (migration 0010).
    index('price_ticks_market_id_ts_id_idx').on(t.marketId, t.ts, t.id),
    check('price_ticks_p_yes_bp_check', sql`${t.pYesBp} BETWEEN 0 AND 10000`),
  ],
);
