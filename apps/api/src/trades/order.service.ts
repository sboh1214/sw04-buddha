import { Inject, Injectable } from '@nestjs/common';
import {
  cancelOrder,
  findOrderByRequest,
  lockMarket,
  placeOrder,
  placeOrderChangedBook,
  schema,
  type CancelTouched,
  type Db,
  type OrderRow,
  type PlaceOrderTouched,
  type PositionRow,
} from '@buddha/db';
import {
  decodeTupleCursor,
  encodeTupleCursor,
  isPublicMarketStatus,
  LIVE_ORDER_STATUSES,
  ownFillPrice,
  serializeCoinAmount,
  type MyFill,
  type MyFillsQuery,
  type MyOrdersQuery,
  type Order,
  type PlaceOrderBody,
  type PlaceOrderResult,
  type ReleaseSettingsRegistry,
  type UserPositionEvent,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { assertCanTrade } from '../moderation/restrictions.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { RELEASE_SETTINGS_REGISTRY } from '../release-settings/release-settings.registry.js';
import { balanceEvent, type Page } from '../wallet/wallet.service.js';
import { priceProtectionClosed } from './price-protection-closed.js';

const { fills, markets, orders, profiles } = schema;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The live states (대기·부분 체결), the one shared list (`LIVE_ORDER_STATUSES`). */
const LIVE = [...LIVE_ORDER_STATUSES];

/** What the order DTO carries of its market, and the status that says whether it may. */
type MarketRef = Pick<typeof markets.$inferSelect, 'slug' | 'title' | 'status'>;

/** The columns of `MarketRef`, for the reads that join an order's market. */
const MARKET_REF = { slug: markets.slug, title: markets.title, status: markets.status };

/**
 * The owner's view of an order (`Order`, #119): its terms as sent and as taken, what filled and
 * its state with the reason. Never the reference quote or the width the intake used, nor anyone's
 * account type (ADR-0107 결정 5 '#179·#119'). `cancelledQty` is what a 취소 완료 or 만료 quantity
 * order left unfilled. The market's slug and title only while it is public
 * (`isPublicMarketStatus`): a SCHEDULED market's rejected order outlives #78's 되돌리기, and the
 * draft being fixed is the admin's alone — the rule ADR-0099's owner answer (2026-11-01) gave posts
 * (`postMarketOf`), which this PR extends to the owner's orders (ADR-0112 10-18).
 */
export function toOrder(row: OrderRow, market: MarketRef): Order {
  const ended = row.status === 'cancelled' || row.status === 'expired';
  const shown = isPublicMarketStatus(market.status);
  return {
    id: row.id,
    requestId: row.idempotencyKey,
    marketId: row.marketId,
    marketSlug: shown ? market.slug : null,
    marketTitle: shown ? market.title : null,
    outcome: row.outcome,
    side: row.side,
    timeInForce: row.timeInForce,
    limitPriceCoin: row.limitPrice,
    protectedLimitPriceCoin: row.protectedLimitPrice,
    qty: row.qty,
    budgetCoin: row.budgetCoin === null ? null : serializeCoinAmount(row.budgetCoin),
    filledQty: row.filledQty,
    filledAmountCoin: serializeCoinAmount(row.filledAmountCoin),
    cancelledQty: ended && row.qty !== null ? row.qty - row.filledQty : 0,
    unspentCoin: row.unspentCoin === null ? null : serializeCoinAmount(row.unspentCoin),
    status: row.status,
    rejectReason: row.rejectReason,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** The `user:position` event of one position row after a write (PLAN 8), keyed by its version. */
export function positionEvent(row: PositionRow): UserPositionEvent {
  return {
    type: 'user:position',
    marketId: row.marketId,
    outcome: row.outcome,
    qty: row.qty,
    costBasisCoin: serializeCoinAmount(row.costBasisCoin),
    realizedPnlCoin: serializeCoinAmount(row.realizedPnlCoin),
    settled: row.settled,
    version: row.version,
    ts: row.updatedAt.toISOString(),
  };
}

const notFound = (what: 'Market' | 'Order') =>
  new AppError('NOT_FOUND', { message: `${what} not found` });

/**
 * 주문 접수와 본인의 주문·체결 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9·11·15항, 결정 3
 * '주문 접수', 결정 5 #119 rows). The intake itself is `placeOrder` (@buddha/db orders.ts); this
 * service makes the checks that answer an error and write no order row, in the transaction the
 * intake runs in, and publishes what it changed:
 *
 * - 제출 (`place`), in this lock order (ADR-0112 10-16): the account restriction first
 *   (`assertCanTrade`, #139: RESTRICTED; a writing restriction does not stop trading), which holds
 *   the account's profile FOR KEY SHARE — a restriction or closure takes it FOR UPDATE, so one in
 *   flight commits first and one after waits for the order. Then the market's lock (`lockMarket`),
 *   and only under it the same profile row FOR SHARE with its role: a role grant's or revoke's
 *   `UPDATE profiles SET role` conflicts with that, so a grant in flight commits before the order
 *   reads the role and one that comes after waits for the order — per account, with no global
 *   admin-roles lock (one order waiting on a busy market would queue a grant, and every later
 *   order on every market behind it). An order waiting on a market's lock holds only the KEY
 *   SHARE, which a grant's update does not wait for; were it to hold the FOR SHARE there, a grant
 *   to it (holding the admin-roles lock) and an admin's market action that holds that market's
 *   lock and then asks for the admin-roles lock would wait on each other in a circle (40P01).
 *   Then FORBIDDEN for an admin, who never orders while holding the role (결정 5 '#119·#143
 *   관리자의 거래'; the database refuses the row too, `orders_refuse_admin_owner`), then the
 *   onboarding held to the commit (`assertOnboarded`: ONBOARDING_REQUIRED, a pending re-consent
 *   included). Then the intake:
 *   a request id that named an order before answers that order as it stands now (`replayed`) or
 *   DUPLICATE_REQUEST with other terms; ORDER_INTAKE_CLOSED while `order.accepting` is not true
 *   (결정 3) or an immediate order meets a market with no 가격 보호 폭 (details `priceProtection`);
 *   NOT_FOUND for a market that is not public. Every other answer is an order row — taken, or
 *   rejected with its reason (#177 7항) — in 200. After COMMIT, best effort, `user:balance` for
 *   each person whose ledger the fills moved and `user:position` for each position row they or a
 *   sell lock wrote; the 운영 마켓메이커 has no room. A buy that only rests publishes no `user:`
 *   event (no ledger entry; the submitter reads its own answer); a sell that only rests publishes
 *   its position row's `user:position` (its lock is on that row). An order that rested or filled
 *   publishes `market:book` in its market's room (#179, ADR-0114: the public book changed); one
 *   rejected, or an immediate one that filled nothing, changed no live order and publishes none.
 * - 취소 (`cancel`, #178, ADR-0113): the whole remainder of one of the session's live orders, ended
 *   in one transaction by `cancelOrder` (@buddha/db order-cancel.ts: the market's lock, the order
 *   again under it, the owner's Coin account, then the release and the row as 취소 완료(본인 취소))
 *   and answered in its final state — one that had ended (filled, cancelled, expired, rejected)
 *   as it is, so a repeat answers the same and releases nothing. No restriction, role, onboarding,
 *   intake or order-limit check: a cancel only gives back what the order locked. Another
 *   account's order is NOT_FOUND, as in the reads; a live one in a market held for a ledger
 *   failure is MARKET_NOT_OPEN 'paused' with nothing written (ADR-0107 결정 4 #178 rows: the
 *   recovery approval ends it — 취소 완료(일시 중단) at a resume or early close, 만료 when the
 *   market closed before its recovery, #93's kind). After COMMIT, best effort, a sell's
 *   `user:position` (its lock was on that row) — a buy's release writes no ledger entry and
 *   publishes no `user:` event, as its resting — and `market:book` (#179). An order that had
 *   ended, or a held one, changed nothing and publishes nothing.
 * - The owner's reads (`listMine`, `mine`, `mineByRequest`, `listMyFills`): the session's own
 *   rows only — another account's order is NOT_FOUND, as if it did not exist (N04 §7) — and a
 *   fill as the caller's own order took it, the counterparty anonymous (결정 5 '#179·#119').
 */
@Injectable()
export class OrderService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
    private readonly publisher: MarketPublisher,
  ) {}

  /** `POST /markets/:id/orders`: the class doc's 제출. */
  async place(
    userId: string,
    marketId: string,
    requestId: string,
    body: WithoutExpectedAccount<PlaceOrderBody>,
  ): Promise<PlaceOrderResult> {
    const { answer, touched, book } = await this.db.transaction(async (tx) => {
      await assertCanTrade(tx, userId);
      await lockMarket(tx, marketId);
      const [profile] = await tx
        .select({ role: profiles.role })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1)
        .for('share');
      if (profile?.role === 'admin') {
        throw new AppError('FORBIDDEN', { message: 'An admin does not trade' });
      }
      await assertOnboarded(tx, userId);
      const result = await placeOrder(
        tx,
        {
          ownerId: userId,
          marketId,
          requestId,
          outcome: body.outcome,
          side: body.side,
          timeInForce: body.timeInForce,
          limitPriceCoin: body.limitPriceCoin,
          qty: body.qty ?? null,
          budgetCoin: body.budgetCoin ?? null,
        },
        { registry: this.registry },
      );
      switch (result.kind) {
        case 'not_found':
          throw notFound('Market');
        case 'conflict':
          // No details: the request id is spent on the order it named (the charge's rule).
          throw new AppError('DUPLICATE_REQUEST', {
            message: 'This Idempotency-Key was already used for a different order',
          });
        case 'closed':
          throw result.why === 'intake'
            ? new AppError('ORDER_INTAKE_CLOSED', { message: 'Orders are not taken now' })
            : priceProtectionClosed();
        case 'replayed':
        case 'placed': {
          const market = await this.marketRef(tx, result.order.marketId);
          const answer: PlaceOrderResult = {
            order: toOrder(result.order, market),
            replayed: result.kind === 'replayed',
          };
          const placed = result.kind === 'placed' ? result : null;
          return {
            answer,
            touched: placed?.touched ?? null,
            // At the order's own instant (the database clock's), the signal's display time.
            book:
              placed && placeOrderChangedBook(placed)
                ? { marketId: placed.order.marketId, at: placed.order.createdAt }
                : null,
          };
        }
      }
    });
    if (touched) await this.publish(touched, book);
    return answer;
  }

  /** `POST /me/orders/:id/cancel`: the class doc's 취소. */
  async cancel(userId: string, orderId: string): Promise<Order> {
    const { answer, touched } = await this.db.transaction(async (tx) => {
      const result = await cancelOrder(tx, { ownerId: userId, orderId, reason: 'by_owner' });
      switch (result.kind) {
        case 'not_found':
          throw notFound('Order');
        case 'held':
          throw new AppError('MARKET_NOT_OPEN', {
            message: 'The market is paused',
            details: [{ path: ['market'], message: 'paused' }],
          });
        case 'ended':
        case 'cancelled': {
          const market = await this.marketRef(tx, result.order.marketId);
          const answer = toOrder(result.order, market);
          return { answer, touched: result.kind === 'cancelled' ? result.touched : null };
        }
      }
    });
    if (touched) await this.publishCancel(answer.marketId, touched, new Date(answer.endedAt!));
    return answer;
  }

  /**
   * `GET /me/orders`: the account's orders, newest first by arrival (`arrival_seq`, the index
   * `orders_user_id_arrival_seq_idx`), rejected ones included; one market's, and the live or the
   * ended ones, when asked. Reads the order rows alone: what filled is stored on them.
   */
  async listMine(userId: string, query: MyOrdersQuery): Promise<Page<Order>> {
    const cursor = decodeTupleCursor(query.cursor, [], 'int');
    const rows = await this.db
      .select({ order: orders, market: MARKET_REF })
      .from(orders)
      .innerJoin(markets, eq(markets.id, orders.marketId))
      .where(
        and(
          eq(orders.userId, userId),
          query.marketId === undefined ? undefined : eq(orders.marketId, query.marketId),
          query.state === undefined
            ? undefined
            : query.state === 'live'
              ? inArray(orders.status, LIVE)
              : notInArray(orders.status, LIVE),
          cursor === undefined ? undefined : lt(orders.arrivalSeq, Number(cursor.id)),
        ),
      )
      .orderBy(desc(orders.arrivalSeq))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toOrder(row.order, row.market)),
      nextCursor: hasMore && last ? encodeTupleCursor([], String(last.order.arrivalSeq)) : null,
    };
  }

  /** `GET /me/orders/:id`: the account's order; another account's is NOT_FOUND. */
  async mine(userId: string, orderId: string): Promise<Order> {
    const [row] = await this.db
      .select({ order: orders, market: MARKET_REF })
      .from(orders)
      .innerJoin(markets, eq(markets.id, orders.marketId))
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
      .limit(1);
    if (!row) throw notFound('Order');
    return toOrder(row.order, row.market);
  }

  /**
   * `GET /me/orders/request/:requestId`: the order the account's request id named — how a client
   * whose answer was lost learns what became of it, while intake is closed too. NOT_FOUND when it
   * named none (a refusal that wrote no row leaves the id free); another account's id is never
   * read.
   */
  async mineByRequest(userId: string, requestId: string): Promise<Order> {
    const row = await findOrderByRequest(this.db, userId, requestId);
    if (!row) throw notFound('Order');
    return toOrder(row, await this.marketRef(this.db, row.marketId));
  }

  /**
   * `GET /me/fills`: the account's fills, newest first by id, each as its own order took it — its
   * order, outcome and side, its price per contract (`ownFillPrice` of the recorded YES price)
   * and Coin. One read per side of a fill (the owner indexes `fills_incoming_owner_id_id_idx`,
   * `fills_resting_owner_id_id_idx`; an account is never both sides of one fill), merged: the
   * other side's order, owner and account type are never selected.
   */
  async listMyFills(userId: string, query: MyFillsQuery): Promise<Page<MyFill>> {
    const cursor = decodeTupleCursor(query.cursor, [], 'int');
    const leg = (as: 'incoming' | 'resting') => {
      const owner = as === 'incoming' ? fills.incomingOwnerId : fills.restingOwnerId;
      const order = as === 'incoming' ? fills.incomingOrderId : fills.restingOrderId;
      return this.db
        .select({
          id: fills.id,
          orderId: orders.id,
          marketId: fills.marketId,
          marketSlug: markets.slug,
          marketTitle: markets.title,
          outcome: orders.outcome,
          side: orders.side,
          qty: fills.qty,
          yesPriceCoin: fills.yesPriceCoin,
          feeCoin: fills.feeCoin,
          createdAt: fills.createdAt,
        })
        .from(fills)
        .innerJoin(orders, eq(orders.id, order))
        .innerJoin(markets, eq(markets.id, fills.marketId))
        .where(
          and(
            eq(owner, userId),
            query.marketId === undefined ? undefined : eq(fills.marketId, query.marketId),
            cursor === undefined ? undefined : lt(fills.id, Number(cursor.id)),
          ),
        )
        .orderBy(desc(fills.id))
        .limit(query.limit + 1);
    };
    const [incoming, resting] = await Promise.all([leg('incoming'), leg('resting')]);
    const rows = [...incoming, ...resting].sort((a, b) => b.id - a.id).slice(0, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        const priceCoin = ownFillPrice(row.outcome, row.yesPriceCoin);
        return {
          id: String(row.id),
          orderId: row.orderId,
          marketId: row.marketId,
          marketSlug: row.marketSlug,
          marketTitle: row.marketTitle,
          outcome: row.outcome,
          side: row.side,
          qty: row.qty,
          priceCoin,
          amountCoin: serializeCoinAmount(BigInt(priceCoin) * BigInt(row.qty)),
          yesPriceCoin: row.yesPriceCoin,
          feeCoin: serializeCoinAmount(row.feeCoin),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: hasMore && last ? encodeTupleCursor([], String(last.id)) : null,
    };
  }

  /** The market an order names (an order's market is never deleted: the FK restricts it). */
  private async marketRef(executor: Db | Tx, id: string): Promise<MarketRef> {
    const [market] = await executor
      .select(MARKET_REF)
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);
    if (!market) throw new AppError('INTERNAL', { message: `Market ${id} of an order is gone` });
    return market;
  }

  /**
   * A cancel's realtime, after COMMIT and best effort: each person's position row a sell freed,
   * then the market's `market:book` at the cancel's instant.
   */
  private async publishCancel(marketId: string, touched: CancelTouched, at: Date): Promise<void> {
    await this.publish({ balances: [], positions: touched.positions }, { marketId, at });
  }

  /**
   * The intake's realtime, after COMMIT and best effort (`MarketPublisher` logs a failed send):
   * each person's balance with the last ledger entry of the intake as its key, then each position
   * row, then — when the live book changed — the market's `market:book`. Issued together, awaited
   * together (realtime.ts).
   */
  private async publish(
    touched: PlaceOrderTouched,
    book: { marketId: string; at: Date } | null,
  ): Promise<void> {
    await Promise.all([
      ...touched.balances.map(({ userId, balance, entry }) =>
        this.publisher.publishUser(userId, balanceEvent(balance, entry)),
      ),
      ...touched.positions.map((row) => this.publisher.publishUser(row.userId, positionEvent(row))),
      book && this.publisher.publishBook([book.marketId], book.at),
    ]);
  }
}
