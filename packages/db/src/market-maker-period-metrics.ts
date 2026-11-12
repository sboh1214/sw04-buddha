import type { MarketMakerPeriodMetrics } from '@buddha/shared';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isHumanAccountTypeSql } from './account-types.js';
import type { Db } from './client.js';
import { marketEvents, marketMakerSupplyStates, user, type markets } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Market = typeof markets.$inferSelect;
const bp = (n: string, d: string) =>
  BigInt(d) === 0n ? null : String((BigInt(n) * 10_000n) / BigInt(d));

/** Read inside the current metrics' RR READ ONLY snapshot. No observation is created by GET. */
export async function readMarketMakerPeriodMetrics(
  tx: Tx,
  market: Market,
  asOf: Date,
): Promise<MarketMakerPeriodMetrics> {
  const unavailable: MarketMakerPeriodMetrics = {
    window: { from: market.openAt?.toISOString() ?? null, to: asOf.toISOString() },
    activity: { basis: 'recorded_orders', coverage: 'unavailable', bot: null, humanIoc: null },
    supply: {
      basis: 'posted_book',
      coverage: 'unavailable',
      observedFrom: null,
      observedTo: null,
      openMs: null,
      botGapMs: null,
      combinedGapMs: null,
    },
  };
  if (!market.openAt || market.openAt > asOf) return unavailable;
  const [closed] = await tx
    .select({ at: marketEvents.createdAt })
    .from(marketEvents)
    .where(
      and(
        eq(marketEvents.marketId, market.id),
        inArray(marketEvents.type, ['closed', 'cancelled']),
        gte(marketEvents.createdAt, market.openAt),
        lte(marketEvents.createdAt, asOf),
      ),
    )
    .orderBy(asc(marketEvents.createdAt), asc(marketEvents.id))
    .limit(1);
  const to = new Date(
    Math.min(asOf.getTime(), market.closeAt.getTime(), closed?.at.getTime() ?? Infinity),
  );
  // A posting's initial resting quantity excludes immediate incoming fills. A GTC self-trade
  // cancellation never posted its remainder. Subsequent resting fills are the same cohort's
  // numerator, so a repost is new quantity and an immediate fill is not invented posted supply.
  const participant = alias(user, 'u');
  const {
    rows: [activity],
  } = await tx.execute<{
    posted: string;
    filled: string;
    ioc: string;
    full: string;
  }>(sql`WITH cohort AS (
    SELECT o.*,${isHumanAccountTypeSql(participant.accountType)} AS human,
      coalesce((SELECT sum(f.qty::bigint) FROM fills f WHERE f.incoming_order_id=o.id),0) AS incoming,
      coalesce((SELECT sum(f.qty::bigint) FROM fills f WHERE f.resting_order_id=o.id),0) AS resting
    FROM orders o JOIN "user" u ON u.id=o.user_id
    WHERE o.market_id=${market.id} AND o.created_at>=${market.openAt} AND o.created_at<=${to}
  ) SELECT
    coalesce(sum(qty-incoming) FILTER(WHERE NOT human AND time_in_force='gtc'
      AND status<>'rejected' AND cancel_reason IS DISTINCT FROM 'self_trade'),0)::text AS posted,
    coalesce(sum(resting) FILTER(WHERE NOT human AND time_in_force='gtc'
      AND status<>'rejected' AND cancel_reason IS DISTINCT FROM 'self_trade'),0)::text AS filled,
    count(*) FILTER(WHERE human AND time_in_force='ioc')::text AS ioc,
    count(*) FILTER(WHERE human AND time_in_force='ioc' AND status='filled')::text AS full
    FROM cohort`);
  if (!activity) throw new Error('Market maker activity aggregate is missing');
  const result: MarketMakerPeriodMetrics = {
    ...unavailable,
    window: { from: market.openAt.toISOString(), to: to.toISOString() },
    activity: {
      basis: 'recorded_orders',
      coverage: market.openedLiquidityVersion === null ? 'partial' : 'complete',
      bot: {
        postedQty: activity.posted,
        filledQty: activity.filled,
        fillBp: bp(activity.filled, activity.posted),
      },
      humanIoc: {
        orders: activity.ioc,
        filledOrders: activity.full,
        fillBp: bp(activity.full, activity.ioc),
      },
    },
  };
  const [state] = await tx
    .select()
    .from(marketMakerSupplyStates)
    .where(eq(marketMakerSupplyStates.marketId, market.id));
  if (!state || state.firstObservedAt > to) return result;
  const from = new Date(Math.max(market.openAt.getTime(), state.firstObservedAt.getTime()));
  const {
    rows: [supply],
  } = await tx.execute<{ open: string; bot: string; combined: string }>(sql`
    WITH periods AS (
      SELECT started_at,ended_at,is_open,close_at,bot_yes_buy,bot_no_buy,yes_ask,no_ask
        FROM market_maker_supply_intervals WHERE market_id=${market.id}
      UNION ALL
      SELECT started_at,${to}::timestamptz,is_open,close_at,bot_yes_buy,bot_no_buy,yes_ask,no_ask
        FROM market_maker_supply_states WHERE market_id=${market.id}
    ), durations AS (
      SELECT greatest(0,extract(epoch FROM (least(ended_at,close_at,${to})-greatest(started_at,${from})))*1000)::bigint AS ms,
        bot_yes_buy AND bot_no_buy AS bot,yes_ask AND no_ask AS combined
      FROM periods WHERE is_open
    ) SELECT coalesce(sum(ms),0)::text AS open,
      coalesce(sum(ms) FILTER(WHERE NOT bot),0)::text AS bot,
      coalesce(sum(ms) FILTER(WHERE NOT combined),0)::text AS combined FROM durations`);
  if (!supply) throw new Error('Market maker supply aggregate is missing');
  result.supply = {
    basis: 'posted_book',
    coverage: state.firstObservedAt <= market.openAt ? 'complete' : 'partial',
    observedFrom: from.toISOString(),
    observedTo: to.toISOString(),
    openMs: supply.open,
    botGapMs: supply.bot,
    combinedGapMs: supply.combined,
  };
  return result;
}
