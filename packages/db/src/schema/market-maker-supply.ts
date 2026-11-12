import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';
import { markets } from './markets.js';

/** Private observer work, consumed within the writing transaction at each deferred flush. */
export const marketMakerSupplyPending = pgTable('market_maker_supply_pending', {
  marketId: uuid()
    .primaryKey()
    .references(() => markets.id, { onDelete: 'restrict' }),
});

/** Non-personal posted-book observations, not executable quotes or worker uptime. */
const stateColumns = () => ({
  isOpen: boolean().notNull(),
  closeAt: timestampTz().notNull(),
  botYesBuy: boolean().notNull(),
  botNoBuy: boolean().notNull(),
  yesAsk: boolean().notNull(),
  noAsk: boolean().notNull(),
});

/** Only the deferred final-state observer writes this row. No historical backfill. */
export const marketMakerSupplyStates = pgTable(
  'market_maker_supply_states',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => markets.id, { onDelete: 'restrict' }),
    firstObservedAt: timestampTz().notNull(),
    firstObservedTxid: text().notNull(),
    startedAt: timestampTz().notNull(),
    lastObservedAt: timestampTz().notNull(),
    lastObservedTxid: text().notNull(),
    ...stateColumns(),
  },
  (t) => [
    check(
      'market_maker_supply_states_time_check',
      sql`${t.firstObservedAt} <= ${t.startedAt} AND ${t.startedAt} <= ${t.lastObservedAt}`,
    ),
  ],
);

/** Closed supply states remain after settlement; no identity or top-holder snapshot. */
export const marketMakerSupplyIntervals = pgTable(
  'market_maker_supply_intervals',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    startedAt: timestampTz().notNull(),
    endedAt: timestampTz().notNull(),
    appliedTxid: text().notNull(),
    ...stateColumns(),
  },
  (t) => [
    check('market_maker_supply_intervals_time_check', sql`${t.startedAt} <= ${t.endedAt}`),
    index('market_maker_supply_intervals_market_started_idx').on(t.marketId, t.startedAt, t.id),
    uniqueIndex('market_maker_supply_intervals_market_txid_idx').on(t.marketId, t.appliedTxid),
  ],
);
