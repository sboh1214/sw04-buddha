import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  applyBuy,
  applySell,
  decodeKeyset,
  encodeKeyset,
  mechanismFor,
  parseQuantity,
  sameTradeTerms,
  serializePAmount,
  serializeQuantity,
  tradeTerms,
  type Fill,
  type LmsrState,
  type MarketRealtimeEvent,
  type MarketStats,
  type Order,
  type Position,
  type PositionState,
  type PositionStatus,
  type Quote,
  type TradeBody,
  type TradeResult,
  type TradeTerms,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { and, asc, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { assertTradable } from '../markets/market.service.js';
import { lockMarket } from '../markets/market-lock.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { toBalance, type Page } from '../wallet/wallet.service.js';

type MarketRow = typeof schema.markets.$inferSelect;
type OrderRow = typeof schema.orders.$inferSelect;
type FillRow = typeof schema.fills.$inferSelect;
type PositionRow = typeof schema.positions.$inferSelect;
type BalanceRow = typeof schema.balances.$inferSelect;
/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** UNIQUE (user_id, idempotency_key) on orders (migration 0009). */
export const ORDER_IDEMPOTENCY_UNIQUE = 'orders_user_id_idempotency_key_unique';

/**
 * Thrown inside the trade transaction when the key turns out to be taken under the market
 * lock (or on the unique index, as a backstop): rolls the transaction back, and the caller
 * answers through the same replay path a key found before the transaction takes.
 */
class ReplayNeeded extends Error {
  constructor() {
    super('idempotency key already used');
    this.name = 'ReplayNeeded';
  }
}

/** What the market row carries for the order and position DTOs. */
type MarketRef = Pick<
  MarketRow,
  'id' | 'slug' | 'title' | 'status' | 'lastPrice' | 'resolvedResult'
>;

const EMPTY_POSITION: PositionState = { qty: 0, costBasisP: 0n, realizedPnlP: 0n };

export function toOrder(
  row: OrderRow,
  fill: Pick<FillRow, 'amountP' | 'priceAvgBp'> | null,
  market: Pick<MarketRow, 'slug' | 'title'>,
): Order {
  return {
    id: row.id,
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    outcome: row.outcome,
    side: row.side,
    type: row.type,
    qty: row.qty,
    filledQty: row.filledQty,
    status: row.status,
    amountP: fill ? serializePAmount(fill.amountP) : null,
    priceAvgBp: fill ? fill.priceAvgBp : null,
    maxCostP: row.maxCostP === null ? null : serializePAmount(row.maxCostP),
    minProceedsP: row.minProceedsP === null ? null : serializePAmount(row.minProceedsP),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Anonymous on purpose (PLAN 7.1): the row's user is never part of the DTO. */
export function toFill(row: FillRow): Fill {
  return {
    id: row.id.toString(),
    outcome: row.outcome,
    side: row.side,
    qty: row.qty,
    amountP: serializePAmount(row.amountP),
    priceAvgBp: row.priceAvgBp,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPosition(row: PositionRow, market: MarketRef): Position {
  return {
    marketId: row.marketId,
    marketSlug: market.slug,
    marketTitle: market.title,
    marketStatus: market.status,
    marketLastPrice: market.lastPrice,
    resolvedResult: market.resolvedResult,
    outcome: row.outcome,
    qty: row.qty,
    costBasisP: serializePAmount(row.costBasisP),
    realizedPnlP: serializePAmount(row.realizedPnlP),
    settled: row.settled,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The LMSR state a market row holds (numeric columns cross drizzle as strings). */
export function stateOf(market: Pick<MarketRow, 'qYes' | 'qNo' | 'liquidityB'>): LmsrState {
  return {
    qYes: parseQuantity(market.qYes),
    qNo: parseQuantity(market.qNo),
    b: parseQuantity(market.liquidityB),
  };
}

function toMarketStats(market: MarketRow, pYesBp: number): MarketStats {
  return {
    id: market.id,
    lastPrice: market.lastPrice,
    pYesBp,
    volumeP: serializePAmount(market.volumeP),
    tradeCount: market.tradeCount,
    traderCount: market.traderCount,
  };
}

/** The terms an order row was placed with, in the wire shape a fresh body compares against. */
function termsOf(row: OrderRow): TradeTerms {
  return {
    marketId: row.marketId,
    outcome: row.outcome,
    side: row.side,
    shares: row.qty,
    maxCostP: row.maxCostP === null ? null : serializePAmount(row.maxCostP),
    minProceedsP: row.minProceedsP === null ? null : serializePAmount(row.minProceedsP),
  };
}

/** What the transaction hands back: the answer, plus the events to publish after COMMIT. */
interface Executed {
  result: TradeResult;
  marketEvents: MarketRealtimeEvent[];
  userEvents: UserRealtimeEvent[];
}

/**
 * Trading against the AMM (PLAN 5.4, M3 design 3.3) and the caller's own positions and orders
 * (3.5).
 *
 * One trade is one transaction under `pg_advisory_xact_lock(hashtext(market_id))` (PLAN 0.2):
 * the LMSR state is read and written by one trade at a time, the balance moves with a
 * conditional UPDATE in the same transaction as its `ledger_entries` INSERT, and every
 * statement between the lock and COMMIT goes through the transaction handle. Idempotency is
 * DB-only (ADR-0027, the same choice as charges): the order, its fill and its ledger entry
 * already hold the first answer and never expire.
 */
@Injectable()
export class TradeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
  ) {}

  async trade(userId: string, body: TradeBody, idempotencyKey: string): Promise<TradeResult> {
    // First of all (see assertExpectedAccount): traded for the cookie's account while the
    // screen shows another, the client's key would also sit under the wrong account.
    assertExpectedAccount(userId, body.expectedAccountId);
    const terms = tradeTerms(body);
    const earlier = await this.orderByKey(userId, idempotencyKey);
    if (earlier) return this.replay(earlier, terms);

    let executed: Executed;
    try {
      executed = await this.db.transaction((tx) => this.execute(tx, userId, body, idempotencyKey));
    } catch (error) {
      if (error instanceof ReplayNeeded) {
        // The key was taken between the lookup above and the lock (a concurrent twin of this
        // request). Same path as a key found up front, so a twin with different terms still
        // gets DUPLICATE_REQUEST instead of the other request's answer.
        const raced = await this.orderByKey(userId, idempotencyKey);
        if (raced) return this.replay(raced, terms);
        throw new AppError('INTERNAL', { message: 'Order vanished after its key was taken' });
      }
      throw error;
    }

    // COMMITted. Best effort from here (MarketPublisher swallows and logs). Issued back to
    // back and awaited together: ioredis writes them in this order on the one connection —
    // the tick first, so a client that only keeps the newest price sees the stats before the
    // fill that produced them — and a Redis that stops answering costs the response one
    // command timeout, not one per event. On the row's id, like the admin status publish:
    // the channel name is a string, and the body's id is not the source of truth.
    const marketId = executed.result.market.id;
    await Promise.all([
      ...executed.marketEvents.map((event) => this.publisher.publishMarket(marketId, event)),
      ...executed.userEvents.map((event) => this.publisher.publishUser(userId, event)),
    ]);
    return executed.result;
  }

  /** PLAN 5.4 steps 2..13 of the design, all on `tx`. */
  private async execute(
    tx: Tx,
    userId: string,
    body: TradeBody,
    idempotencyKey: string,
  ): Promise<Executed> {
    await lockMarket(tx, body.marketId);

    // Re-check under the lock: a twin that raced past the lookup in `trade` and committed
    // while this request waited is answered by replaying it, never by trading twice.
    const [taken] = await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.userId, userId), eq(schema.orders.idempotencyKey, idempotencyKey)),
      )
      .limit(1);
    if (taken) throw new ReplayNeeded();

    const [market] = await tx
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, body.marketId))
      .limit(1)
      .for('update');
    // A draft is invisible outside the admin (design 3.2): the same 404 as no market at all.
    if (!market || market.status === 'draft') {
      throw new AppError('NOT_FOUND', { message: 'Market not found' });
    }
    if (market.status !== 'open') {
      throw new AppError('MARKET_NOT_OPEN', { message: `Market is ${market.status}` });
    }

    // Locked for the rest of the transaction on both sides. Missing means a broken account
    // (the "user" trigger creates the row at sign-up), like the charge's 404: no field named.
    const [balanceBefore] = await tx
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId))
      .limit(1)
      .for('update');
    if (!balanceBefore) throw new AppError('NOT_FOUND', { message: 'Balance not found' });

    // The position row, if any, locked too: a sell needs it now, a buy writes it below.
    const [positionBefore] = await tx
      .select()
      .from(schema.positions)
      .where(
        and(
          eq(schema.positions.userId, userId),
          eq(schema.positions.marketId, market.id),
          eq(schema.positions.outcome, body.outcome),
        ),
      )
      .limit(1)
      .for('update');

    // Taken AFTER the last lock this trade can wait on, and once: one instant for the order,
    // fill, ledger row, tick and events. Transaction-start `now()` would invert the
    // timestamps of two trades that waited on the market lock in the other order, so charts
    // and "newest fills" would disagree with execution order. Read before the balance lock,
    // the same inversion happens between one account's trades on two markets: they queue on
    // the balance row, not on a market lock, and the one that commits last would carry the
    // older instant — `/me/ledger` would list its balance_after_p out of order and a client
    // keeping the newest `user:balance` by ts would keep the stale one.
    const executedAt = await clockTimestamp(tx);
    // The same guard the quote route runs, on the same clock (market.service.ts). The status
    // was already checked before the balance lock so a refused trade locks nothing; here it
    // cannot have changed — the market row is held FOR UPDATE — and the close time is what
    // this re-checks.
    assertTradable(market, executedAt);

    const mechanism = mechanismFor(market.mechanism);
    const state = stateOf(market);
    const quote: Quote =
      body.side === 'buy'
        ? mechanism.quoteBuy(state, body.outcome, body.shares)
        : mechanism.quoteSell(state, body.outcome, body.shares);
    // PLAN 5.3: the slippage guard is what the client saw on its quote; the recomputed number
    // is the price now. Fees are 0 in the MVP (PLAN 5.7 hook point: fee_p on the fill).
    if (body.side === 'buy' && body.maxCostP !== undefined && quote.amountP > body.maxCostP) {
      throw new AppError('PRICE_MOVED', {
        message: `Cost is now ${quote.amountP.toString()} P, above maxCostP`,
      });
    }
    if (
      body.side === 'sell' &&
      body.minProceedsP !== undefined &&
      quote.amountP < body.minProceedsP
    ) {
      throw new AppError('PRICE_MOVED', {
        message: `Proceeds are now ${quote.amountP.toString()} P, below minProceedsP`,
      });
    }

    let balance: BalanceRow;
    if (body.side === 'buy') {
      // Conditional, not read-modify-write: the row is locked, but the guard is what makes
      // `available_p >= 0` a property of the statement rather than of this code path.
      const [debited] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} - ${quote.amountP}`,
          updatedAt: executedAt,
        })
        .where(
          and(eq(schema.balances.userId, userId), gte(schema.balances.availableP, quote.amountP)),
        )
        .returning();
      if (!debited) {
        throw new AppError('INSUFFICIENT_BALANCE', {
          message: `Insufficient balance: ${(quote.amountP - balanceBefore.availableP).toString()} P short`,
        });
      }
      balance = debited;
    } else {
      if (!positionBefore || positionBefore.qty < body.shares) {
        throw new AppError('INSUFFICIENT_POSITION', {
          message: `Cannot sell ${String(body.shares)} of ${String(positionBefore?.qty ?? 0)} contracts`,
        });
      }
      const [credited] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${quote.amountP}`,
          updatedAt: executedAt,
        })
        .where(eq(schema.balances.userId, userId))
        .returning();
      if (!credited) throw new AppError('NOT_FOUND', { message: 'Balance not found' });
      balance = credited;
    }

    let order: OrderRow | undefined;
    try {
      [order] = await tx
        .insert(schema.orders)
        .values({
          userId,
          marketId: market.id,
          outcome: body.outcome,
          side: body.side,
          type: 'market',
          qty: body.shares,
          filledQty: body.shares,
          status: 'filled',
          timeInForce: 'ioc',
          idempotencyKey,
          maxCostP: body.maxCostP ?? null,
          minProceedsP: body.minProceedsP ?? null,
          createdAt: executedAt,
          updatedAt: executedAt,
        })
        .returning();
    } catch (error) {
      // Backstop for the re-check above (unreachable while every writer takes the market
      // lock first; a key re-used on another market takes another lock).
      if (isPgError(error, PG_UNIQUE_VIOLATION, ORDER_IDEMPOTENCY_UNIQUE)) throw new ReplayNeeded();
      throw error;
    }
    if (!order) throw new AppError('INTERNAL', { message: 'Order insert failed' });

    const [fill] = await tx
      .insert(schema.fills)
      .values({
        marketId: market.id,
        orderId: order.id,
        counterpartyType: 'amm',
        outcome: body.outcome,
        side: body.side,
        qty: body.shares,
        amountP: quote.amountP,
        priceAvgBp: quote.priceAvgBp,
        feeP: 0n,
        createdAt: executedAt,
      })
      .returning();
    if (!fill) throw new AppError('INTERNAL', { message: 'Fill insert failed' });

    const [entry] = await tx
      .insert(schema.ledgerEntries)
      .values({
        userId,
        type: body.side === 'buy' ? 'TRADE_BUY' : 'TRADE_SELL',
        amountP: body.side === 'buy' ? -quote.amountP : quote.amountP,
        balanceAfterP: balance.availableP,
        refType: 'fill',
        refId: fill.id.toString(),
        createdAt: executedAt,
      })
      .returning();
    if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });

    // Positions: cost-basis accounting from @buddha/shared (the worker settles with the same
    // functions). Select-then-write under the market lock, so no ON CONFLICT is needed.
    let nextPosition: PositionState;
    try {
      nextPosition =
        body.side === 'buy'
          ? applyBuy(positionBefore ?? EMPTY_POSITION, body.shares, quote.amountP)
          : applySell(positionBefore ?? EMPTY_POSITION, body.shares, quote.amountP);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new AppError('VALIDATION_ERROR', {
          message: error.message,
          details: [{ path: ['shares'], message: 'position would exceed the maximum' }],
          cause: error,
        });
      }
      throw error;
    }
    let position: PositionRow | undefined;
    let newTrader = false;
    if (positionBefore) {
      [position] = await tx
        .update(schema.positions)
        .set({
          qty: nextPosition.qty,
          costBasisP: nextPosition.costBasisP,
          realizedPnlP: nextPosition.realizedPnlP,
          updatedAt: executedAt,
        })
        .where(
          and(
            eq(schema.positions.userId, userId),
            eq(schema.positions.marketId, market.id),
            eq(schema.positions.outcome, body.outcome),
          ),
        )
        .returning();
    } else {
      // trader_count counts accounts, not rows: a first row in this market for this account
      // (the other outcome may already have one). Exact and cheap under the lock, so the PLAN
      // §9 debounce job is not needed (ADR-0027).
      const [held] = await tx
        .select({ rows: count() })
        .from(schema.positions)
        .where(and(eq(schema.positions.userId, userId), eq(schema.positions.marketId, market.id)));
      newTrader = (held?.rows ?? 0) === 0;
      [position] = await tx
        .insert(schema.positions)
        .values({
          userId,
          marketId: market.id,
          outcome: body.outcome,
          qty: nextPosition.qty,
          costBasisP: nextPosition.costBasisP,
          realizedPnlP: nextPosition.realizedPnlP,
          settled: false,
          updatedAt: executedAt,
        })
        .returning();
    }
    if (!position) throw new AppError('INTERNAL', { message: 'Position write failed' });

    const [updatedMarket] = await tx
      .update(schema.markets)
      .set({
        qYes: serializeQuantity(quote.next.qYes),
        qNo: serializeQuantity(quote.next.qNo),
        lastPrice: mechanism.priceOf(quote.next),
        volumeP: sql`${schema.markets.volumeP} + ${quote.amountP}`,
        tradeCount: sql`${schema.markets.tradeCount} + 1`,
        traderCount: sql`${schema.markets.traderCount} + ${newTrader ? 1 : 0}`,
        updatedAt: executedAt,
      })
      .where(eq(schema.markets.id, market.id))
      .returning();
    if (!updatedMarket) throw new AppError('INTERNAL', { message: 'Market update failed' });

    await tx.insert(schema.priceTicks).values({
      marketId: market.id,
      ts: executedAt,
      pYesBp: quote.priceAfterBp,
      trigger: 'trade',
    });

    const ts = executedAt.toISOString();
    return {
      result: {
        order: toOrder(order, fill, updatedMarket),
        fill: toFill(fill),
        balance: toBalance(balance),
        position: toPosition(position, updatedMarket),
        market: toMarketStats(updatedMarket, quote.priceAfterBp),
      },
      marketEvents: [
        {
          type: 'market:tick',
          marketId: market.id,
          pYesBp: quote.priceAfterBp,
          lastPrice: updatedMarket.lastPrice,
          volumeP: serializePAmount(updatedMarket.volumeP),
          tradeCount: updatedMarket.tradeCount,
          // From the row this transaction just wrote, so it costs no extra read: `traderCount`
          // moves with the same trade when the buyer held nothing here before.
          traderCount: updatedMarket.traderCount,
          ts,
        },
        {
          type: 'market:trade',
          marketId: market.id,
          fillId: fill.id.toString(),
          outcome: fill.outcome,
          side: fill.side,
          qty: fill.qty,
          priceAvgBp: fill.priceAvgBp,
          ts,
        },
      ],
      // The keys (realtime.ts): the ledger row of this balance change, the position row's
      // version — strict where two serialised trades could share a millisecond `ts`.
      userEvents: [
        {
          type: 'user:balance',
          availableP: serializePAmount(balance.availableP),
          lockedP: serializePAmount(balance.lockedP),
          ledgerEntryId: entry.id.toString(),
          ts,
        },
        {
          type: 'user:position',
          marketId: market.id,
          outcome: position.outcome,
          qty: position.qty,
          costBasisP: serializePAmount(position.costBasisP),
          realizedPnlP: serializePAmount(position.realizedPnlP),
          settled: position.settled,
          version: position.version,
          ts,
        },
      ],
    };
  }

  private async orderByKey(userId: string, idempotencyKey: string): Promise<OrderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(eq(schema.orders.userId, userId), eq(schema.orders.idempotencyKey, idempotencyKey)),
      )
      .limit(1);
    return row;
  }

  /**
   * The answer for a key this account has used before (PLAN 5.4). The order and its fill are
   * the first answer verbatim; balance, position and market stats are current — the same
   * split as the charge replay (the client shows the current ones anyway).
   */
  private async replay(earlier: OrderRow, terms: TradeTerms): Promise<TradeResult> {
    // Same key, different terms: a client bug or a re-used key, never a lost answer (PLAN
    // 7.4). No detail, so the client spends the key: the trade this key names has happened.
    if (!sameTradeTerms(termsOf(earlier), terms)) {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'This Idempotency-Key was already used for a different trade',
      });
    }
    // Written in the same transaction as the order, so a miss is corruption, not a race.
    const [fill] = await this.db
      .select()
      .from(schema.fills)
      .where(eq(schema.fills.orderId, earlier.id))
      .limit(1);
    if (!fill) throw new AppError('INTERNAL', { message: 'Fill missing for order' });

    const [market] = await this.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, earlier.marketId))
      .limit(1);
    if (!market) throw new AppError('INTERNAL', { message: 'Market missing for order' });
    const [balance] = await this.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, earlier.userId))
      .limit(1);
    if (!balance) throw new AppError('NOT_FOUND', { message: 'Balance not found' });
    // A row outlives its contracts (a full sell leaves qty 0; void and settlement close it
    // out but keep it), so the trade's row is still there.
    const [position] = await this.db
      .select()
      .from(schema.positions)
      .where(
        and(
          eq(schema.positions.userId, earlier.userId),
          eq(schema.positions.marketId, earlier.marketId),
          eq(schema.positions.outcome, earlier.outcome),
        ),
      )
      .limit(1);
    if (!position) throw new AppError('INTERNAL', { message: 'Position missing for order' });

    return {
      order: toOrder(earlier, fill, market),
      fill: toFill(fill),
      balance: toBalance(balance),
      position: toPosition(position, market),
      market: toMarketStats(market, mechanismFor(market.mechanism).probabilityBp(stateOf(market))),
    };
  }

  /**
   * Every position row of the account (design 3.5): `open` = not yet settled (qty may be 0,
   * the row still carries realised PnL), `settled` = settled, omitted = all. No cursor: the
   * set is bounded by the markets one account has touched (MVP).
   */
  async listPositions(userId: string, status: PositionStatus | undefined): Promise<Position[]> {
    const rows = await this.db
      .select({
        position: schema.positions,
        market: {
          id: schema.markets.id,
          slug: schema.markets.slug,
          title: schema.markets.title,
          status: schema.markets.status,
          lastPrice: schema.markets.lastPrice,
          resolvedResult: schema.markets.resolvedResult,
        },
      })
      .from(schema.positions)
      .innerJoin(schema.markets, eq(schema.markets.id, schema.positions.marketId))
      .where(
        and(
          eq(schema.positions.userId, userId),
          status === undefined ? undefined : eq(schema.positions.settled, status === 'settled'),
        ),
      )
      .orderBy(
        desc(schema.positions.updatedAt),
        asc(schema.positions.marketId),
        asc(schema.positions.outcome),
      );
    return rows.map((row) => toPosition(row.position, row.market));
  }

  /** Newest first, keyset-paginated over (created_at, id) like the wallet lists. */
  async listOrders(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<Order>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select({
        order: schema.orders,
        // One fill per market order in the MVP; null while nothing filled (a CLOB later).
        fill: { amountP: schema.fills.amountP, priceAvgBp: schema.fills.priceAvgBp },
        market: { slug: schema.markets.slug, title: schema.markets.title },
      })
      .from(schema.orders)
      .leftJoin(schema.fills, eq(schema.fills.orderId, schema.orders.id))
      .innerJoin(schema.markets, eq(schema.markets.id, schema.orders.marketId))
      .where(
        and(
          eq(schema.orders.userId, userId),
          keyset
            ? or(
                lt(schema.orders.createdAt, keyset.createdAt),
                and(eq(schema.orders.createdAt, keyset.createdAt), lt(schema.orders.id, keyset.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toOrder(row.order, row.fill, row.market)),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.order.createdAt, id: last.order.id })
          : null,
    };
  }
}
