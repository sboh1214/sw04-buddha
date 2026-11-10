import {
  CONTRACT_TERMS,
  MARKET_MAKER_CONCENTRATION_TOP_N_SETTING,
  RELEASE_SETTINGS,
  decodeKeyset,
  encodeKeyset,
  listMarketMakerMetricsQuerySchema,
  matchLine,
  reservedPnl,
  resultPnl,
  riskStage,
  worstLoss,
  type AdminMarketMakerMetrics,
  type AdminMarketMakerMetricsListItem,
  type AdminMarketMakerMetricsOverview,
  type BookOrder,
  type ByResult,
  type ListMarketMakerMetricsQuery,
  type MarketMakerStageSettingsResult,
  type MatchLineEntry,
  type ReleaseSettingsRegistry,
} from '@buddha/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { isHumanAccountSql } from './account-types.js';
import type { Db } from './client.js';
import { readMarketMakerRiskSnapshot } from './market-maker-risk.js';
import { readMarketMakerRuntime } from './market-maker-runtime.js';
import { readMarketMakerStageSettings } from './market-maker-settings.js';
import { checkMarketSettlementBooks } from './market-settlement.js';
import { readLiveBook } from './orders.js';
import { getReleaseSetting } from './release-settings.js';
import {
  balances,
  markets,
  marketSettlementSteps,
  positions,
  positionSettlements,
  profiles,
} from './schema/index.js';
import { clockTimestamp } from './tx-helpers.js';
import { readAdminTreasurySnapshot } from './treasury-snapshot.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Market = typeof markets.$inferSelect;
type Risk = AdminMarketMakerMetrics['risk'];
type Depth = AdminMarketMakerMetrics['depth']['bot'];

/** Same domain for a page and the whole subtotal. Empty accounts are not an allocation.
 * Historic direct capital counts even without #129 runtime/config; a full recall stays here.
 */
const funded = sql`(EXISTS (SELECT 1 FROM market_maker_allocations a WHERE a.market_id=${markets.id})
  OR EXISTS (SELECT 1 FROM ledger_entries e
    JOIN ledger_accounts f ON f.market_id=${markets.id} AND f.kind='market_maker_funds'
    JOIN ledger_accounts t ON t.kind='treasury'
    WHERE e.market_id=${markets.id} AND e.type IN ('BOT_ALLOCATION','BOT_RECALL','RECONCILIATION_CORRECTION')
      AND ((e.from_account_id=t.id AND e.to_account_id=f.id AND e.type IN ('BOT_ALLOCATION','RECONCILIATION_CORRECTION'))
        OR (e.from_account_id=f.id AND e.to_account_id=t.id AND e.type IN ('BOT_RECALL','RECONCILIATION_CORRECTION')))))`;

function wirePnl(pnl: ByResult<bigint>) {
  return { YES: String(pnl.YES), NO: String(pnl.NO), VOID: String(pnl.VOID) };
}

/** Use the canonical converted-price line, but aggregate quantities with bigint rather than
 * public bookLevels' number accumulator. No execution risk trim or hidden top-level cap.
 */
function levels(line: readonly MatchLineEntry[]): Depth['YES']['bids'] {
  const grouped: { priceCoin: number; qty: bigint }[] = [];
  for (const entry of line) {
    const last = grouped.at(-1);
    if (last?.priceCoin === entry.priceCoin) last.qty += BigInt(entry.order.remainingQty);
    else grouped.push({ priceCoin: entry.priceCoin, qty: BigInt(entry.order.remainingQty) });
  }
  return grouped.map(({ priceCoin, qty }) => ({ priceCoin, qty: String(qty) }));
}
function depth(book: readonly BookOrder[]): Depth {
  const one = (outcome: 'YES' | 'NO') => ({
    bids: levels(matchLine(book, outcome, 'sell')),
    asks: levels(matchLine(book, outcome, 'buy')),
  });
  return { YES: one('YES'), NO: one('NO') };
}

async function riskOf(
  tx: Tx,
  market: Market,
  stage: MarketMakerStageSettingsResult,
  book: readonly BookOrder[],
): Promise<Risk> {
  const snapshot = await readMarketMakerRiskSnapshot(tx, market.id, book);
  if (snapshot.kind !== 'ready') return { kind: snapshot.kind, reason: snapshot.reason };
  const [balance] = await tx
    .select()
    .from(balances)
    .where(eq(balances.accountId, snapshot.fundsAccountId));
  // The caller's repeatable snapshot guarantees the row read by #128 still exists here.
  if (!balance) return { kind: 'inconsistent', reason: 'missing_balance' };
  const holdings = await tx.select().from(positions).where(eq(positions.marketId, market.id));
  const botHoldings = holdings.filter((p) => p.userId === snapshot.ownerId && !p.settled);
  const [coinStep] = await tx
    .select()
    .from(marketSettlementSteps)
    .where(
      and(eq(marketSettlementSteps.marketId, market.id), eq(marketSettlementSteps.step, 'coin')),
    );
  const paid =
    market.status === 'settled' || (market.status === 'settling' && coinStep?.status === 'done');
  if (paid) {
    const claims = await tx
      .select()
      .from(positionSettlements)
      .where(eq(positionSettlements.marketId, market.id));
    try {
      // SELECT-only common validation: do not label a damaged done marker as paid profit.
      await checkMarketSettlementBooks(tx, market, holdings, claims, true);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(`Market ${market.id} settlement:`))
        throw error;
      return { kind: 'inconsistent', reason: 'settlement_books' };
    }
  }
  if (market.status === 'cancelled') {
    const { rows } = await tx.execute<{ ready: boolean }>(sql`SELECT
      public.reconciliation_correction_obligation(${market.id}::uuid) IS NOT DISTINCT FROM 0::bigint
      AND NOT EXISTS(SELECT 1 FROM ledger_accounts a LEFT JOIN balances b ON b.account_id=a.id
        WHERE a.market_id=${market.id} AND a.kind='market_collateral'
          AND (b.account_id IS NULL OR b.available_coin<>0 OR b.locked_coin<>0 OR b.ledger_coin<>0)) AS ready`);
    if (
      !rows[0]?.ready ||
      book.length ||
      market.resolvedResult !== null ||
      holdings.some((p) => p.qty !== 0 || p.lockedQty !== 0 || p.costBasisCoin !== 0n)
    )
      return { kind: 'inconsistent', reason: 'cancelled_books' };
  }
  const pnl = resultPnl(snapshot.book, CONTRACT_TERMS);
  const reserved = reservedPnl(snapshot.book, snapshot.liveOrders, CONTRACT_TERMS);
  const loss = worstLoss(pnl);
  return {
    kind: 'ready',
    assets: {
      coin: String(snapshot.book.coin),
      availableCoin: String(balance.availableCoin),
      lockedCoin: String(balance.lockedCoin),
      yesQty: String(snapshot.book.yesQty),
      noQty: String(snapshot.book.noQty),
      yesLockedQty: String(botHoldings.find((p) => p.outcome === 'YES')?.lockedQty ?? 0),
      noLockedQty: String(botHoldings.find((p) => p.outcome === 'NO')?.lockedQty ?? 0),
    },
    capital: {
      investedCoin: String(snapshot.book.invested),
      recoveredCoin: String(snapshot.book.recovered),
    },
    maxLossCoin: String(snapshot.limits.maxLoss),
    worstLossCoin: String(loss),
    reservedWorstLossCoin: String(worstLoss(reserved)),
    utilizationBp: String((loss * 10_000n) / snapshot.limits.maxLoss),
    stage:
      stage.kind === 'ready' ? riskStage(loss, { ...snapshot.limits, ...stage.settings }) : null,
    stageStatus: stage.kind === 'ready' ? 'ready' : stage.reason,
    pnl:
      paid || market.status === 'cancelled'
        ? {
            kind: 'actual',
            amountCoin: String(
              snapshot.book.coin + snapshot.book.recovered - snapshot.book.invested,
            ),
            reason: paid ? 'paid' : 'cancelled',
            result: market.resolvedResult,
          }
        : {
            kind: 'scenarios',
            holdings: wirePnl(pnl),
            reserved: wirePnl(reserved),
            provisionalResult: market.resolvedResult,
          },
  };
}

async function concentration(
  tx: Tx,
  marketId: string,
  registry: ReleaseSettingsRegistry,
): Promise<AdminMarketMakerMetrics['concentration']> {
  const setting = await getReleaseSetting(tx, registry, MARKET_MAKER_CONCENTRATION_TOP_N_SETTING);
  const one = async (
    outcome: 'YES' | 'NO',
  ): Promise<AdminMarketMakerMetrics['concentration']['YES']> => {
    const where = and(
      eq(positions.marketId, marketId),
      eq(positions.outcome, outcome),
      eq(positions.settled, false),
      sql`${positions.qty}>0`,
      isHumanAccountSql(positions.userId),
    );
    const [total] = await tx
      .select({ qty: sql<string>`coalesce(sum(${positions.qty}::bigint),0)::text` })
      .from(positions)
      .where(where);
    const totalQty = BigInt(total!.qty);
    if (setting.value === null)
      return { totalQty: String(totalQty), topQty: null, topShareBp: null, holders: null };
    const top = await tx
      .select({ userId: positions.userId, nickname: profiles.nickname, qty: positions.qty })
      .from(positions)
      .leftJoin(profiles, eq(profiles.userId, positions.userId))
      .where(where)
      .orderBy(desc(positions.qty), positions.userId)
      .limit(setting.value);
    const topQty = top.reduce((sum, p) => sum + BigInt(p.qty), 0n);
    return {
      totalQty: String(totalQty),
      topQty: String(topQty),
      topShareBp: totalQty ? String((topQty * 10_000n) / totalQty) : null,
      holders: top.map((p) => ({
        userId: p.userId,
        nickname: p.nickname,
        qty: String(p.qty),
        shareBp: String((BigInt(p.qty) * 10_000n) / totalQty),
      })),
    };
  };
  return { setting, YES: await one('YES'), NO: await one('NO') };
}

/** Call in REPEATABLE READ READ ONLY; no ensure, advisory/row lock, audit or mutation occurs. */
export async function readMarketMakerMetrics(
  tx: Tx,
  marketId: string,
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
): Promise<AdminMarketMakerMetrics | null> {
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
  if (!market) return null;
  const asOf = (await clockTimestamp(tx)).toISOString();
  const book = await readLiveBook(tx, marketId);
  return {
    marketId: market.id,
    title: market.title,
    status: market.status,
    asOf,
    configVersion: market.currentLiquidityVersion,
    openedVersion: market.openedLiquidityVersion,
    risk: await riskOf(tx, market, await readMarketMakerStageSettings(tx, registry), book),
    depth: {
      bot: depth(book.filter((o) => !o.owner.human)),
      human: depth(book.filter((o) => o.owner.human)),
    },
    concentration: await concentration(tx, market.id, registry),
  };
}

/** All funded markets, not the current page; positive PnL never cancels another market's loss.
 * A missing/invalid market contributes to missing, not a fabricated zero or full total.
 */
export async function readMarketMakerMetricsOverview(
  tx: Tx,
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
): Promise<AdminMarketMakerMetricsOverview> {
  const rows = await tx.select().from(markets).where(funded).orderBy(markets.id);
  const asOf = (await clockTimestamp(tx)).toISOString();
  const stage = await readMarketMakerStageSettings(tx, registry);
  let loss = 0n,
    reserved = 0n,
    limit = 0n,
    ready = 0n,
    invested = 0n,
    recovered = 0n,
    funds = 0n;
  const missing: AdminMarketMakerMetricsOverview['missing'] = [];
  for (const market of rows) {
    const risk = await riskOf(tx, market, stage, await readLiveBook(tx, market.id));
    if (risk.kind !== 'ready') {
      missing.push({ marketId: market.id, ...risk });
      continue;
    }
    ready++;
    loss += BigInt(risk.worstLossCoin);
    reserved += BigInt(risk.reservedWorstLossCoin);
    limit += BigInt(risk.maxLossCoin);
    invested += BigInt(risk.capital.investedCoin);
    recovered += BigInt(risk.capital.recoveredCoin);
    funds += BigInt(risk.assets.coin);
  }
  const treasury = await readAdminTreasurySnapshot(tx);
  return {
    asOf,
    scope: 'funded_markets',
    marketCount: String(rows.length),
    readyCount: String(ready),
    complete: missing.length === 0 && treasury.status !== 'inconsistent',
    treasury,
    totals: {
      worstLossCoin: String(loss),
      reservedWorstLossCoin: String(reserved),
      maxLossCoin: String(limit),
      investedCoin: String(invested),
      recoveredCoin: String(recovered),
      fundsCoin: String(funds),
    },
    missing,
  };
}

/** Keyset pagination is only for the list; use the independent overview for whole-domain sums. */
export async function readMarketMakerMetricsPage(
  tx: Tx,
  input: Partial<ListMarketMakerMetricsQuery> = {},
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
): Promise<{ data: AdminMarketMakerMetricsListItem[]; meta: { nextCursor: string | null } }> {
  const query = listMarketMakerMetricsQuerySchema.parse(input);
  const cursor = decodeKeyset(query.cursor, 'uuid');
  const rows = await tx
    .select()
    .from(markets)
    .where(
      and(
        funded,
        cursor
          ? sql`(${markets.createdAt},${markets.id}) < (${cursor.createdAt.toISOString()}::timestamptz,${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(markets.createdAt), desc(markets.id))
    .limit(query.limit + 1);
  const asOf = (await clockTimestamp(tx)).toISOString();
  const stage = await readMarketMakerStageSettings(tx, registry);
  const data: AdminMarketMakerMetricsListItem[] = [];
  for (const market of rows.slice(0, query.limit)) {
    const runtime = await readMarketMakerRuntime(tx, market.id);
    data.push({
      marketId: market.id,
      title: market.title,
      status: market.status,
      asOf,
      configVersion: market.currentLiquidityVersion,
      openedVersion: market.openedLiquidityVersion,
      risk: await riskOf(tx, market, stage, await readLiveBook(tx, market.id)),
      runtime: runtime
        ? { desiredEnabled: runtime.desiredEnabled, state: runtime.state, reason: runtime.reason }
        : null,
    });
  }
  const last = rows[query.limit - 1];
  return {
    data,
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ createdAt: last.createdAt, id: last.id })
          : null,
    },
  };
}
