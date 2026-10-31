import { desc, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { markets } from './markets.js';

/**
 * 관심 시장 (#89, ADR-0064): the markets an account watches NOW, one row per (account, market).
 * A watch inserts the row and an unwatch deletes it, each together with its `market_watch_events`
 * row in one transaction (WatchlistService); a repeated watch or an unwatch of nothing changes
 * neither table. Private to the account (#37): no public route reads either table, and nothing
 * counts a market's watchers in public (PRIVATE_DATA `watchlist`).
 *
 * The account FK is CASCADE like `profiles` and `phone_verifications`: a watch is a preference of
 * the account and nothing references it. The market FK is RESTRICT like every other reference to
 * a market (markets are never deleted). Only a public market can be watched; one that goes back to
 * DRAFT from SCHEDULED (#78·#21) keeps its rows.
 */
export const marketWatches = pgTable(
  'market_watches',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /**
     * When this watch began: the database clock of the watching transaction, the same `now()`
     * its event row carries. A watch ended and begun again is a new row with a new instant, so
     * MY's 최근 등록 순 (ADR-0061 decision 3) puts it first again.
     */
    watchedAt: timestampTz().defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.marketId] }),
    /**
     * `GET /me/watchlist`: one account's watches, newest first, with the row-comparison cursor
     * (`keysetPredicate` over `(watched_at, market_id)`, common/keyset.ts).
     */
    index('market_watches_user_id_watched_at_market_id_idx').on(
      t.userId,
      desc(t.watchedAt),
      desc(t.marketId),
    ),
    /** Who watches a market now: the alerts of #54 read it by market (the PK leads by account). */
    index('market_watches_market_id_idx').on(t.marketId),
  ],
);

/**
 * The history behind `market_watches` (#95: the owner keeps 등록·해제 as events; the list shows
 * only current watches). Append-only like `ledger_entries` and `payment_events`: buddha_app holds
 * INSERT/SELECT only (migration 0023). `action`: WATCH_EVENT_ACTIONS in @buddha/shared, held to
 * that list by a CHECK as well, since a row written wrong could never be corrected.
 *
 * Both FKs are RESTRICT like every append-only record's (`ledger_entries`, `admin_actions`,
 * `payment_events`): a row is never removed, so neither its account nor its market can be. No
 * account can be deleted today (better-auth's `deleteUser` is off, and the ledger already stops
 * it); whatever brings deletion decides what this history becomes.
 *
 * `id` is drawn when the event is inserted, not when it commits. It is in commit order only
 * within one (account, market) pair, whose writes the `market_watches` primary key queues one
 * behind the other. Nothing orders two accounts' writes on one market, or one account's on two
 * markets: event 10 can commit after event 11, and a reader between the two sees 11 without 10.
 * So a reader that pages by market or by account must not take the last `id` it saw as a
 * high-water mark (`id > lastSeen`) — it would skip 10 for good — unless the writes take a lock
 * that orders them first, as the ledger does with the balance row.
 */
export const marketWatchEvents = pgTable(
  'market_watch_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    action: varchar({ length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('market_watch_events_action_check', sql`${t.action} IN ('watch', 'unwatch')`),
    /** One market's watch history in `id` order (not commit order, above): #151 reads by market. */
    index('market_watch_events_market_id_id_idx').on(t.marketId, t.id),
    /** One account's history in `id` order (#151's 관심 등록 후 재방문 starts from a watch). */
    index('market_watch_events_user_id_id_idx').on(t.userId, t.id),
  ],
);
