import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  smallint,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { markets } from './markets.js';

/**
 * 태그 (#17, ADR-0093 decision 2 #172 item 2): one row per tag, shared by every category. An
 * operator makes one by typing a name no tag has while entering a market; two names that differ
 * only in case or the spaces around them are one tag. `name` is the spelling it was first made
 * with, normalised (`normalizeTagName` in @buddha/shared), and the one every market shows;
 * `name_key` is what makes two names one (`tagKey` — Postgres's `lower()` of it, the charset
 * holding no cased letter but Latin), generated so it never disagrees with the name, and what the
 * exact-match search compares a term with.
 *
 * A tag is never deleted or renamed: nothing manages tags but the market entry (migration 0049
 * revokes DELETE from buddha_app). One no market uses any more stays, unseen.
 */
export const tags = pgTable('tags', {
  id: serial().primaryKey(),
  name: varchar({ length: 20 }).notNull(),
  nameKey: varchar({ length: 20 })
    .notNull()
    .generatedAlwaysAs(sql`lower(name)`)
    .unique('tags_name_key_unique'),
  createdAt: createdAt(),
});

/**
 * A market's tags, `position` 1..5 in the order the operator entered them — the detail's order.
 * The CHECK and the unique position keep a market at MARKET_TAGS_MAX at most whatever writes it;
 * the minimum is the open-items check's, since a draft may have none. An edit of a market's tags
 * deletes its rows and inserts the new set. Markets and tags are never deleted, so both
 * references RESTRICT.
 */
export const marketTags = pgTable(
  'market_tags',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    tagId: integer()
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
    position: smallint().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.tagId] }),
    unique('market_tags_market_id_position_unique').on(t.marketId, t.position),
    check('market_tags_position_check', sql`${t.position} BETWEEN 1 AND 5`),
    // The search: the markets of one tag.
    index('market_tags_tag_id_market_id_idx').on(t.tagId, t.marketId),
  ],
);
