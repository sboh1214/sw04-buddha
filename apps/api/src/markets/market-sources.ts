import { schema, type Db } from '@buddha/db';
import { type MarketRuleItems, type MarketSource } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * A market's sources as its rule items carry them (#23, ADR-0097): the 1차 출처 and the 대체 출처
 * in priority order (ADR-0093 decision 2 #172 item 9).
 */
export type MarketSources = Pick<MarketRuleItems, 'primarySource' | 'fallbackSources'>;

/** A market with no `market_sources` row: no primary source, and '없음'. */
export const NO_SOURCES: MarketSources = { primarySource: null, fallbackSources: [] };

/**
 * A market's sources (#23), one statement beside `marketTagNames`: `market_sources` priority 0 is
 * the primary source, 1..3 the fallbacks in that order. The API writes no gap but a missing
 * primary (`replaceMarketSources`), and a row above 0 is a fallback whatever its number, so a gap
 * written elsewhere still reads as the ordered list. Through `executor`, so a write answers with
 * what it wrote.
 */
export async function readMarketSources(
  executor: Db | Tx,
  marketId: string,
): Promise<MarketSources> {
  const rows = await executor
    .select({
      priority: schema.marketSources.priority,
      name: schema.marketSources.name,
      url: schema.marketSources.url,
    })
    .from(schema.marketSources)
    .where(eq(schema.marketSources.marketId, marketId))
    .orderBy(asc(schema.marketSources.priority));
  const source = (row: (typeof rows)[number]): MarketSource => ({ name: row.name, url: row.url });
  const primary = rows.find((row) => row.priority === 0);
  return {
    primarySource: primary ? source(primary) : null,
    fallbackSources: rows.filter((row) => row.priority > 0).map(source),
  };
}

function sameSource(a: MarketSource | null, b: MarketSource | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.url === b.url;
}

/** Two source sets are one when they name the same sources, by name and address, in order. */
export function sameSources(a: MarketSources, b: MarketSources): boolean {
  return (
    sameSource(a.primarySource, b.primarySource) &&
    a.fallbackSources.length === b.fallbackSources.length &&
    a.fallbackSources.every((source, index) => sameSource(source, b.fallbackSources[index]!))
  );
}

/**
 * Writes `sources` as the market's whole set (#23), as `linkTags` writes its tags: the market's
 * `market_sources` rows are deleted and the set inserted, the primary source at priority 0 and the
 * fallbacks at 1..n in the order given — so the priorities have no gap but a missing primary. The
 * caller holds the market row FOR UPDATE, which every writer of a market's sources takes, so the
 * set it read is the set replaced. The table's CHECKs hold what `marketSourceSchema` refused at
 * entry (the scheme, the lengths, a source with both halves blank) whoever writes.
 */
export async function replaceMarketSources(
  tx: Tx,
  marketId: string,
  sources: MarketSources,
): Promise<void> {
  await tx.delete(schema.marketSources).where(eq(schema.marketSources.marketId, marketId));
  const rows = [
    ...(sources.primarySource === null ? [] : [{ ...sources.primarySource, priority: 0 }]),
    ...sources.fallbackSources.map((source, index) => ({ ...source, priority: index + 1 })),
  ];
  if (rows.length === 0) return;
  await tx.insert(schema.marketSources).values(
    rows.map((row) => ({
      marketId,
      priority: row.priority,
      name: row.name,
      url: row.url,
    })),
  );
}
