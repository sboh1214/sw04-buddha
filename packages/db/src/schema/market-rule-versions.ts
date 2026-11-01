import { RULE_VERSION_ITEMS, type MarketRuleContent } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { approvalRequests } from './approval-requests.js';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { markets } from './markets.js';

/** RULE_VERSION_ITEMS as the SQL array the CHECKs hold the item keys to. */
const VERSION_ITEMS_SQL = sql.raw(
  `ARRAY[${RULE_VERSION_ITEMS.map((item) => `'${item}'`).join(', ')}]::text[]`,
);

/**
 * 규칙 버전 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·15, decision 3 '#80 보충의 형태'):
 * every version of a market's rules, each the full text of RULE_VERSION_ITEMS of @buddha/shared —
 * the title, the rule items (#23) and the times (#22) — as it stood when the version began. Version
 * 1 is the content locked at the review, recorded by the open (`openScheduledMarket`) in its own
 * transaction; each approved supplement (`market_supplement` approval request, #171) adds the next
 * one, the full text with the changed items rewritten. Every version stays, the current one
 * included (`markets.rule_version` names it): the public detail shows the current text and the
 * history — each version's changed items, reason, time and full text — and the judgement follows
 * the last one (#172 item 7). A market opened before #80 has none (D4, no backfill).
 *
 * - `content`: the full text as the shared `marketRuleContentSchema` reads it — the sources as
 *   `{name, url}` in priority order, the instants as ISO, blank items blank — read back from the
 *   market row and its `market_sources` after the write (`readRuleContent`), never built from a
 *   request. jsonb, not columns: a version is never queried by an item, and the CHECK below holds
 *   only that every item is there.
 * - `changed_items`: the items whose text differs from the version before (RULE_VERSION_ITEMS
 *   order), none for v1. `reason` and `settlement_impact` (정산 영향 검토, admins only) are the
 *   supplement's, `approval_id` its approved request and `requested_by` its requester; all null
 *   for v1 (`market_rule_versions_supplement_check`).
 * - `created_by`: who made the version — the open's actor for v1 (null for the worker's job, an
 *   admin for an approval's or a reschedule's open), the approving admin for a supplement, never
 *   its requester. `created_at`: the open's instant for v1, the approval's decision instant after.
 *
 * Permanent facts (N04 §5): no retention, nothing deletes or rewrites one. buddha_app may INSERT
 * and SELECT only, and a trigger refuses an UPDATE or a DELETE whoever writes (migration 0053). The
 * market, the request and the accounts RESTRICT.
 */
export const marketRuleVersions = pgTable(
  'market_rule_versions',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    /** 1 from the open, then one more per approved supplement. */
    version: integer().notNull(),
    content: jsonb().$type<MarketRuleContent>().notNull(),
    changedItems: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text(),
    settlementImpact: text(),
    approvalId: uuid()
      .unique('market_rule_versions_approval_id_unique')
      .references(() => approvalRequests.id, { onDelete: 'restrict' }),
    requestedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    createdBy: text().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestampTz().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.version] }),
    check('market_rule_versions_version_check', sql`${t.version} >= 1`),
    /**
     * Version 1 is the open's: no request, reason, impact review or changed item. A later one is a
     * supplement's, with each of them and made by an admin other than its requester (the two-person
     * rule its request's CHECK holds too).
     */
    check(
      'market_rule_versions_supplement_check',
      sql`(${t.version} = 1) = (${t.approvalId} IS NULL) AND (${t.version} = 1) = (${t.requestedBy} IS NULL) AND (${t.version} = 1) = (${t.reason} IS NULL) AND (${t.version} = 1) = (${t.settlementImpact} IS NULL) AND (${t.version} = 1) = (cardinality(${t.changedItems}) = 0) AND (${t.version} = 1 OR (${t.createdBy} IS NOT NULL AND ${t.createdBy} <> ${t.requestedBy}))`,
    ),
    check(
      'market_rule_versions_reasons_check',
      sql`btrim(${t.reason}) IS DISTINCT FROM '' AND btrim(${t.settlementImpact}) IS DISTINCT FROM ''`,
    ),
    /** Item keys of RULE_VERSION_ITEMS only, no null among them. */
    check(
      'market_rule_versions_changed_items_check',
      sql`${t.changedItems} <@ ${VERSION_ITEMS_SQL}`,
    ),
    /** The full text: an object with every RULE_VERSION_ITEMS key. */
    check(
      'market_rule_versions_content_check',
      sql`jsonb_typeof(${t.content}) = 'object' AND ${t.content} ?& ${VERSION_ITEMS_SQL}`,
    ),
  ],
);
