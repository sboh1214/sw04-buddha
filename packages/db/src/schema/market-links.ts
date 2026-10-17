import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { markets } from './markets.js';

/**
 * 관련 시장 (#65, ADR-0068): the pairs of markets an admin has linked, one row per UNORDERED pair.
 * A link is two-way (ADR-0061 decision 1, item 19) — linking A to B shows B on A's detail and A on
 * B's — so it is stored once, as the pair's smaller id and its larger one, and read from either
 * end: a market's related markets are the `high` of the rows where it is `low` and the `low` of
 * the rows where it is `high` (RelatedMarketsService). Two rows for one pair, or a market linked to
 * itself, cannot be written: the primary key is the pair and a CHECK holds `low < high`.
 *
 * Unlinking deletes the row, so buddha_app keeps every privilege on it. The history is the admin
 * audit log: each link and unlink that changed something writes its `admin_actions` row
 * (`market_link` / `market_unlink`, both ids in the payload) in the same transaction — the actor
 * and the time, which is all the owner asked to record (no reason, no approval). `created_by` and
 * `created_at` say who made the link that stands now, for the admin's list.
 *
 * Both market FKs are RESTRICT like every other reference to a market (markets are never
 * deleted), and so is the admin's, like `admin_actions.admin_id`. A link names no status: it can be
 * made and removed in any status of either market (ADR-0061 decision 3, #65), and which of them a
 * detail shows is the reader's filter (RELATED_MARKET_STATUSES).
 */
export const marketLinks = pgTable(
  'market_links',
  {
    lowMarketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    highMarketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** The admin who made this link; the audit row of the link names the same admin. */
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The database clock of the linking transaction, the `created_at` of its audit row. */
    createdAt: createdAt(),
  },
  (t) => [
    /** The pair, once; its leading `low_market_id` serves the rows where a market is `low`. */
    primaryKey({ columns: [t.lowMarketId, t.highMarketId] }),
    /** The rows where a market is `high`: the other half of reading a market's links. */
    index('market_links_high_market_id_idx').on(t.highMarketId),
    /** One order per pair, and never a market with itself (`relatedMarketPair`, @buddha/shared). */
    check('market_links_order_check', sql`${t.lowMarketId} < ${t.highMarketId}`),
  ],
);
