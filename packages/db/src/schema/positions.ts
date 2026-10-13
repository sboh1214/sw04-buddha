import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { updatedAt } from './columns.js';
import { outcomeEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * Per (user, market, outcome) holdings with cost-basis accounting (PLAN 5.4). Settlement
 * sets qty = 0, cost_basis_coin = 0, settled = true; finalize skips settled rows (idempotent).
 */
export const positions = pgTable(
  'positions',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    outcome: outcomeEnum().notNull(),
    qty: integer().notNull().default(0),
    costBasisCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    realizedPnlCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    settled: boolean().notNull().default(false),
    /**
     * Strictly increasing per row: 1 on insert, +1 on every ORM update (`$onUpdate` puts the
     * bump into the SET list of any `db.update()` that does not set it). Every write happens
     * under the market's advisory lock, so this is the row's commit order — the key a
     * `user:position` event carries, where a millisecond `ts` could tie (migration 0010).
     */
    version: integer()
      .notNull()
      .default(1)
      .$onUpdate(() => sql`"version" + 1`),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.marketId, t.outcome] }),
    index('positions_market_id_settled_idx').on(t.marketId, t.settled),
    check('positions_qty_check', sql`${t.qty} >= 0`),
    check('positions_cost_basis_coin_check', sql`${t.costBasisCoin} >= 0`),
  ],
);
