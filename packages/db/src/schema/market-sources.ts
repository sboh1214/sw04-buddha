import { MARKET_SOURCE_MAX, MARKET_SOURCE_URL_MAX } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, smallint, uuid, varchar } from 'drizzle-orm/pg-core';
import { markets } from './markets.js';

/**
 * A market's sources (#23, ADR-0097; ADR-0093 decision 2 #172 item 9): priority 0 is the 1차 출처
 * (`primarySource`), priorities 1..3 the 대체 출처 in the order the judgement tries them
 * (`fallbackSources`, MARKET_FALLBACK_SOURCES_MAX). No row at 0 is a market with no primary
 * source; none above it is '없음'. The column is `priority`, not "rank": a rank names the scoring
 * the plan leaves out (#113, storage-names.test.ts). #152 picks a source by it — above 0 needs a
 * reason the primary could not be used — and #80's versions copy the sources in its order.
 *
 * A source is a name and an http(s) address, each at most 500 characters and stored as entered
 * (ADR-0093 decision 3 '#23 출처 주소'); a blank one is '' and is a missing item of the open-items
 * check, never NULL. The CHECKs hold what the API's `marketSourceSchema` refuses whoever writes:
 * the scheme (either case, as `~*` reads it) and a source with both halves blank. A write of a
 * market's sources deletes its rows and inserts the new set from an ordered list, under the
 * market's row lock, as `market_tags` does — so buddha_app keeps every privilege, and the
 * priorities have no gap but a missing primary. Markets are never deleted, so the reference
 * RESTRICTs.
 */
export const marketSources = pgTable(
  'market_sources',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** 0 = 1차 출처, 1..3 = 대체 출처 in priority order. */
    priority: smallint().notNull(),
    name: varchar({ length: MARKET_SOURCE_MAX }).notNull().default(''),
    /** '' while not filled in; otherwise http:// or https://. */
    url: varchar({ length: MARKET_SOURCE_URL_MAX }).notNull().default(''),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.priority] }),
    check('market_sources_priority_check', sql`${t.priority} BETWEEN 0 AND 3`),
    check('market_sources_url_check', sql`${t.url} = '' OR ${t.url} ~* '^https?://'`),
    check('market_sources_not_empty_check', sql`${t.name} <> '' OR ${t.url} <> ''`),
  ],
);
