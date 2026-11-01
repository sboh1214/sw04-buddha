/**
 * A market's rule versions (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·15, decision 3 '#80
 * 보충의 형태'): the full text a version records, read from the market as it stands, and the one
 * writer of a version row — shared by the open (`openScheduledMarket`, v1), the API's supplement
 * approval and the test factories, so what a version holds cannot drift between them.
 */
import {
  changedRuleVersionItems,
  type MarketRuleContent,
  type MarketSource,
  type RuleVersionItem,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { marketRuleVersions, marketSources, markets } from './schema/index.js';
import type { StatementExecutor } from './tx-helpers.js';

type MarketRow = typeof markets.$inferSelect;
export type MarketRuleVersionRow = typeof marketRuleVersions.$inferSelect;

/** A read of either app: the pooled `Db` or a transaction handle. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;
/** A transaction handle that reads and inserts (never the pooled `Db`: it would split the work). */
type Writer = Pick<NodePgDatabase<typeof schema>, 'select' | 'insert'>;

/** The market columns of the version items: the title, the rule items' and the times'. */
type VersionColumns = Pick<
  MarketRow,
  | 'title'
  | 'description'
  | 'yesCondition'
  | 'noCondition'
  | 'eventDeadline'
  | 'fallbackCondition'
  | 'longDelayDays'
  | 'delayHandling'
  | 'scheduledOpenAt'
  | 'closeAt'
  | 'scheduledAnnouncementAt'
  | 'scheduledJudgementAt'
  | 'judgementTimeZone'
>;

/** A market's sources as the rule items carry them: the 1차 출처 and the 대체 출처 in order (#23). */
export interface RuleSources {
  primarySource: MarketSource | null;
  fallbackSources: MarketSource[];
}

/**
 * The transaction-local setting that lets a write change a versioned market's rules (migration
 * 0053's triggers): it holds the market's id while the supplement approval writes.
 */
export const RULE_SUPPLEMENT_SETTING = 'buddha.rule_supplement';

/**
 * Lets the rest of the caller's transaction change the rules of `marketId` once it has a rule
 * version — its version items, its `market_sources` rows and `markets.rule_version` — which
 * migration 0053's triggers otherwise refuse, whoever writes: `set_config(RULE_SUPPLEMENT_SETTING,
 * id, true)`, so it ends at COMMIT or ROLLBACK and names this one market (a later call names
 * another instead). Only the supplement approval calls it (#172 item 15: after the open the rules
 * change by an approved supplement alone), and the factories that make one. Call it on the
 * transaction handle, under `lockMarket`; the id is taken as its canonical text, as `lockMarket`
 * takes it, and a string that is not a uuid fails (22P02).
 */
export async function allowRuleSupplement(tx: StatementExecutor, marketId: string): Promise<void> {
  await tx.execute(
    sql`SELECT set_config(${RULE_SUPPLEMENT_SETTING}, (${marketId})::uuid::text, true)`,
  );
}

/**
 * A market's full rule text (`marketRuleContentSchema` of @buddha/shared) from its version columns
 * and its sources, in RULE_VERSION_ITEMS order: the texts as stored (blank ones blank), the
 * instants as ISO, the zone by its name.
 */
export function ruleContentOf(row: VersionColumns, sources: RuleSources): MarketRuleContent {
  return {
    title: row.title,
    description: row.description,
    yesCondition: row.yesCondition,
    noCondition: row.noCondition,
    eventDeadline: row.eventDeadline?.toISOString() ?? null,
    primarySource: sources.primarySource,
    fallbackSources: sources.fallbackSources,
    fallbackCondition: row.fallbackCondition,
    longDelayDays: row.longDelayDays,
    delayHandling: row.delayHandling,
    scheduledOpenAt: row.scheduledOpenAt?.toISOString() ?? null,
    closeAt: row.closeAt.toISOString(),
    scheduledAnnouncementAt: row.scheduledAnnouncementAt?.toISOString() ?? null,
    scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
    judgementTimeZone: row.judgementTimeZone,
  };
}

/**
 * A market's sources (#23): `market_sources` priority 0 is the primary, every row above it a
 * fallback in priority order — so a gap written outside the API still reads as the ordered list,
 * as the API's `readMarketSources` reads them.
 */
export async function readRuleSources(executor: Reader, marketId: string): Promise<RuleSources> {
  const rows = await executor
    .select({ priority: marketSources.priority, name: marketSources.name, url: marketSources.url })
    .from(marketSources)
    .where(eq(marketSources.marketId, marketId))
    .orderBy(asc(marketSources.priority));
  const source = (row: (typeof rows)[number]): MarketSource => ({ name: row.name, url: row.url });
  const primary = rows.find((row) => row.priority === 0);
  return {
    primarySource: primary ? source(primary) : null,
    fallbackSources: rows.filter((row) => row.priority > 0).map(source),
  };
}

async function readMarketRow(executor: Reader, marketId: string): Promise<MarketRow> {
  const [row] = await executor.select().from(markets).where(eq(markets.id, marketId));
  if (!row) throw new Error(`Market ${marketId} not found`);
  return row;
}

/**
 * A market's full rule text as it stands (`ruleContentOf` of its row and its sources), through
 * `executor` — inside the writer's transaction, so a version records what that transaction wrote.
 * Throws for an unknown market.
 */
export async function readRuleContent(
  executor: Reader,
  marketId: string,
): Promise<MarketRuleContent> {
  const row = await readMarketRow(executor, marketId);
  return ruleContentOf(row, await readRuleSources(executor, marketId));
}

/** A supplement's part of its version (#172 item 15); none for v1. */
export interface RuleVersionSupplement {
  /** The approved `market_supplement` request. */
  approvalId: string;
  /** Its requester, never the version's maker. */
  requestedBy: string;
  /** The supplement's reason, the request's: public in the history. */
  reason: string;
  /** 정산 영향 검토, the request's: admins only. */
  settlementImpact: string;
}

export interface InsertRuleVersionInput {
  marketId: string;
  /**
   * The version's number: the market's `rule_version`, which the caller has written first in the
   * same transaction — 1 at the open, the version before + 1 at a supplement's approval.
   */
  version: number;
  /**
   * When it began: the open's instant for v1, the approval's decision instant after (the database
   * clock read after the lock).
   */
  createdAt: Date;
  /** The open's actor for v1 (null for the worker's job), the approving admin after. */
  createdBy: string | null;
  /** Null for v1, the supplement's request, reason and review after. */
  supplement: RuleVersionSupplement | null;
}

/**
 * Records version `version` of a market's rules (#80): its full text read back from the market and
 * its sources as the caller's transaction has just written them (`readRuleContent`), never built
 * from a request — and, after v1, the items whose text differs from the version before
 * (`changedRuleVersionItems` against that row's content; RULE_VERSION_ITEMS order) with the
 * supplement's request, requester, reason and review. Returns the row inserted.
 *
 * Call it under `lockMarket` with the market row held FOR UPDATE, after writing the market — its
 * version items, its sources and `rule_version` = `version` — in the same transaction. It throws,
 * writing nothing, when the market's current version is not `version`, when v1 comes with a
 * supplement or a later one without, when the version before is missing, and when a supplement
 * changes nothing — each a caller's bug; the table's CHECKs and primary key hold the rest (one row
 * per number: a second v1 is a 23505).
 */
export async function insertRuleVersion(
  tx: Writer,
  input: InsertRuleVersionInput,
): Promise<MarketRuleVersionRow> {
  const { marketId, version, supplement } = input;
  if ((version === 1) !== (supplement === null)) {
    throw new Error(
      version === 1
        ? `Rule version 1 of market ${marketId} is the open's: it has no supplement`
        : `Rule version ${String(version)} of market ${marketId} needs its supplement`,
    );
  }
  const row = await readMarketRow(tx, marketId);
  if (row.ruleVersion !== version) {
    throw new Error(
      `Market ${marketId} is at rule version ${String(row.ruleVersion)}, not ${String(version)}: ` +
        'write the market first',
    );
  }
  const content = ruleContentOf(row, await readRuleSources(tx, marketId));
  let changedItems: RuleVersionItem[] = [];
  if (version > 1) {
    const [before] = await tx
      .select({ content: marketRuleVersions.content })
      .from(marketRuleVersions)
      .where(
        and(eq(marketRuleVersions.marketId, marketId), eq(marketRuleVersions.version, version - 1)),
      );
    if (!before) {
      throw new Error(`Market ${marketId} has no rule version ${String(version - 1)}`);
    }
    changedItems = changedRuleVersionItems(before.content, content);
    if (changedItems.length === 0) {
      throw new Error(`Rule version ${String(version)} of market ${marketId} changes nothing`);
    }
  }
  const [inserted] = await tx
    .insert(marketRuleVersions)
    .values({
      marketId,
      version,
      content,
      changedItems,
      reason: supplement?.reason ?? null,
      settlementImpact: supplement?.settlementImpact ?? null,
      approvalId: supplement?.approvalId ?? null,
      requestedBy: supplement?.requestedBy ?? null,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    })
    .returning();
  if (!inserted) throw new Error('market_rule_versions insert returned no row');
  return inserted;
}
