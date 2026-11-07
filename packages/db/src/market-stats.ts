import { RECOMMENDED_VOLUME_HOURS, type MarketFillStats } from '@buddha/shared';
import { and, desc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.js';
import { fills, markets, orders } from './schema/index.js';

/*
 * 시장 통계 (#121, ADR-0116; ADR-0107 결정 1 #177 11–15항, 결정 4 #121 rows). The statistics on
 * `markets` — `last_price` (시장가격, the last fill's YES value), `last_fill_at` (its 갱신시각),
 * `volume_coin` (누적 거래량), `trade_count` and `trader_count` (사용자 참여자) — are written here
 * only, by `placeOrder` (orders.ts) in its transaction under the market's lock, once per intake
 * that filled. Nothing else writes them: the open, the transitions, the close and its expiry
 * (#120), a cancel (#178), the quote (#179), a judgement, a settlement, the seed
 * (market-stats-writes.test.ts). The price history is the `fills` rows themselves, so the chart,
 * the recent fills and these values read one record, and each value can be recounted from it —
 * fills never change (`fills_keep_record`; `MARKET_STATS_CHECK_SQL`, test/orders.ts) — for #132's
 * exclusions and #93's reconciliation. A person is judged by the account-type rule (#115) only,
 * as the book read already answered it (`OrderOwner.human`); this file never names the type.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Db | Tx;

type FillRow = typeof fills.$inferSelect;

/** The statistics' columns (drizzle's field names): `recordFillStats` is their one writer. */
export type MarketStatsColumn =
  'lastPrice' | 'lastFillAt' | 'volumeCoin' | 'tradeCount' | 'traderCount';

/**
 * What any other writer may set on a market row: every column but the statistics, which are
 * `never` rather than merely absent — TypeScript checks a missing key only on a fresh literal, so
 * a variable or a spread carrying `lastPrice` would pass an `Omit` alone. The status writers
 * (`transitionMarket`'s `set`), the admin create and edit, the supplement and the seed's column
 * helpers type their writes with it, so the compiler refuses a statistic there — the half of the
 * guard the static scan (market-stats-writes.test.ts) cannot read: an object handed to
 * `transitionMarket`, a variable or a spread passed to `.set(…)`/`.values(…)`. The scan pins each
 * such argument, so a new one is typed with this before it lands.
 */
export type MarketRowWrite = Partial<Omit<typeof markets.$inferInsert, MarketStatsColumn>> & {
  [K in MarketStatsColumn]?: never;
};

/**
 * How many of `humanOwnerIds` fill in `marketId` for the first time: those with no order there
 * with anything filled (`orders.filled_qty > 0`, either side of a fill — the basis of
 * `hasMarketFill`, #173 6항; #177 13항). Until #132 leaves abnormal fills out of the count it also
 * says #20's '사용자 체결 0건', which keeps counting every person's fill (#177 14항). The ids are
 * this intake's distinct people, already told apart by the rule (the incoming owner and each
 * resting owner its fills meet, `OrderOwner.human`).
 *
 * Call it under the market's lock, BEFORE the intake writes its order (which carries its filled
 * quantity) or fills any resting order: the lock serialises every fill of the market, so no other
 * transaction can make someone a participant in between, and the read sees exactly the fills
 * before this intake. Reads `orders_market_id_user_id_idx`.
 */
export async function newHumanParticipants(
  tx: Tx,
  marketId: string,
  humanOwnerIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(humanOwnerIds)];
  if (ids.length === 0) return 0;
  const before = await tx
    .selectDistinct({ userId: orders.userId })
    .from(orders)
    .where(
      and(eq(orders.marketId, marketId), inArray(orders.userId, ids), gt(orders.filledQty, 0)),
    );
  return ids.length - before.length;
}

export interface RecordFillStatsInput {
  marketId: string;
  /** The fills this intake recorded, every one of `marketId` (at least one). */
  fills: readonly FillRow[];
  /** `newHumanParticipants` of this intake, read before its first write. */
  newParticipants: number;
}

/**
 * The market's statistics after an intake's fills, in one UPDATE, read back (the `market:tick` the
 * caller publishes after COMMIT, @buddha/shared `marketTickEvent`):
 *
 * - `last_price`, `last_fill_at`: the YES value and the server time of the last fill by
 *   (`created_at`, `id`) — an intake's fills share one instant, so the last in walk order (#177
 *   11항: a NO fill at 37 is 63, a pair mint one fill at 100 − its NO price);
 * - `volume_coin` += Σ `amount_coin` (#177 12항: each match once, at the incoming contract's price
 *   × qty — the sum of the public recent fills' amounts), `trade_count` += the fills;
 * - `trader_count` += `newParticipants` (#177 13항; never fewer).
 *
 * Relative increments under the market's lock, after the intake's fills (a duplicate fill key
 * throws before, and the whole intake rolls back). `updated_at` is left as it is: a fill is no
 * edit of the market, and that instant is the `ts` a republished `market:status` carries.
 * RangeError on an empty list: an intake that filled nothing writes nothing here.
 */
export async function recordFillStats(
  tx: Tx,
  input: RecordFillStatsInput,
): Promise<MarketFillStats> {
  const { marketId, newParticipants } = input;
  if (input.fills.length === 0) throw new RangeError('an intake with no fill records no statistic');
  if (!(Number.isInteger(newParticipants) && newParticipants >= 0)) {
    throw new RangeError(`new participants must be a count, got ${String(newParticipants)}`);
  }
  let last = input.fills[0]!;
  let volume = 0n;
  for (const fill of input.fills) {
    if (fill.marketId !== marketId) {
      throw new RangeError(`fill ${String(fill.id)} is not of market ${marketId}`);
    }
    volume += fill.amountCoin;
    const at = fill.createdAt.getTime();
    const lastAt = last.createdAt.getTime();
    if (at > lastAt || (at === lastAt && fill.id > last.id)) last = fill;
  }
  const [row] = await tx
    .update(markets)
    .set({
      lastPrice: last.yesPriceCoin,
      lastFillAt: last.createdAt,
      volumeCoin: sql`${markets.volumeCoin} + ${volume}`,
      tradeCount: sql`${markets.tradeCount} + ${input.fills.length}`,
      traderCount: sql`${markets.traderCount} + ${newParticipants}`,
      // A fill is not an edit: drizzle's `$onUpdate` would stamp the host clock here.
      updatedAt: sql`${markets.updatedAt}`,
    })
    .where(eq(markets.id, marketId))
    .returning({
      lastPrice: markets.lastPrice,
      lastFillAt: markets.lastFillAt,
      volumeCoin: markets.volumeCoin,
      tradeCount: markets.tradeCount,
      traderCount: markets.traderCount,
    });
  if (row === undefined) throw new RangeError(`market ${marketId} does not exist`);
  return {
    lastPrice: row.lastPrice!,
    lastFillAt: row.lastFillAt!,
    volumeCoin: row.volumeCoin,
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
  };
}

/**
 * `RECOMMENDED_VOLUME_HOURS` hours before the database clock, to the millisecond (ADR-0065's
 * `asOf` rule, as `marketOrder`'s first page reads it): the instant `Market.lastPrice24hAgo` is
 * read at (ADR-0107 결정 4 #121 '변화량'). The closed end beside 추천's `(asOf − 24h, asOf]`: a
 * fill exactly 24 hours old is the baseline and not in the 24-hour volume.
 */
export const DAY_AGO: SQL = sql`date_trunc('milliseconds', now())
  - make_interval(hours => ${RECOMMENDED_VOLUME_HOURS})`;

/**
 * The 시장가격 of `marketId` as of `at` (a timestamptz expression, read inside the statement): the
 * YES value of the last fill at or before it by (`created_at`, `id`), or null when it had none —
 * the open's 50% is never a price (N02 §5). One backward descent of
 * `fills_market_id_created_at_id_idx`. The change badge's baseline (`DAY_AGO`); #146's alerts
 * and #64's chart may read it at other instants.
 */
export async function marketPriceAt(
  executor: Reader,
  marketId: string,
  at: SQL,
): Promise<number | null> {
  const [row] = await executor
    .select({ yesPriceCoin: fills.yesPriceCoin })
    .from(fills)
    .where(and(eq(fills.marketId, marketId), lte(fills.createdAt, at)))
    .orderBy(desc(fills.createdAt), desc(fills.id))
    .limit(1);
  return row?.yesPriceCoin ?? null;
}
