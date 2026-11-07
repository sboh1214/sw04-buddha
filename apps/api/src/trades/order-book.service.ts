import { Inject, Injectable } from '@nestjs/common';
import { ownerOf, readHoldings, readMarketTradingFacts, readPublicBook, type Db } from '@buddha/db';
import {
  marketTradingRejectReason,
  orderBookOf,
  orderQuoteOf,
  quoteOrder,
  quoteTermsOf,
  sellableContractOf,
  sellableOf,
  type BookOrder,
  type MarketTradingFacts,
  type OrderBook,
  type OrderQuote,
  type QuoteOrderBody,
  type Sellable,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { priceProtectionClosed } from './price-protection-closed.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const marketNotFound = () => new AppError('NOT_FOUND', { message: 'Market not found' });

/**
 * 공개 호가와 견적 (#179, ADR-0114; ADR-0107 결정 1 #177 2·3·4·10·12·15항, 결정 3 '주문 접수', 결정
 * 4 #179 '비로그인 견적', 결정 5 '#179·#119'): three reads of one market, built by @buddha/shared
 * `order-book.ts` on #117's line and walk.
 *
 * - 공개 호가 (`book`): both contracts' every level, price and summed quantity only. A market that
 *   takes no order now (SCHEDULED, PAUSED, CLOSED and after; #120's past `close_at` — the intake
 *   gate's own `marketTradingRejectReason`) shows empty sides with the reason, and its orders are
 *   not read: a ledger hold's locked ones cannot trade (`orderBookOf`).
 * - 견적 (`quote`): the intake's own market gate and plan with no owner (`quoteOrder`) on the
 *   public book — no session, no personal data, no request id, no `order.accepting` (a closed
 *   intake still quotes, 결정 3) and no asset check. An immediate order on a market with no width
 *   answers ORDER_INTAKE_CLOSED as the intake does (`priceProtectionClosed`).
 * - 매도 가능액 (`sellable`): the session's own two holdings, each unlocked quantity quoted as the
 *   holder's own immediate sell (`sellableOf`, the holder as the walk's owner, so a stop at their
 *   own bid shows as the intake would make it).
 *
 * Each runs in one REPEATABLE READ READ ONLY transaction (`snapshot`): the status, the width, the
 * book and the holdings are one snapshot, it takes no lock (never `lockMarket`: a read neither
 * waits on an intake nor delays one), and Postgres refuses any write in it. A DRAFT, REVIEW or
 * unknown market is NOT_FOUND, as every public market read.
 */
@Injectable()
export class OrderBookService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `GET /markets/:id/book`: the class doc's 공개 호가. */
  book(marketId: string): Promise<OrderBook> {
    return this.snapshot(async (tx) => {
      const market = await this.facts(tx, marketId);
      return orderBookOf(marketId, market, await this.liveBook(tx, marketId, market));
    });
  }

  /** `POST /markets/:id/quote`: the class doc's 견적. */
  quote(marketId: string, body: QuoteOrderBody): Promise<OrderQuote> {
    return this.snapshot(async (tx) => {
      const market = await this.facts(tx, marketId);
      const book = await this.liveBook(tx, marketId, market);
      const answer = quoteOrder(book, market, quoteTermsOf(body), null);
      if (answer.kind === 'closed') throw priceProtectionClosed();
      return orderQuoteOf(answer.figures);
    });
  }

  /** `GET /me/markets/:id/sellable`: the class doc's 매도 가능액, `userId`'s own. */
  sellable(userId: string, marketId: string): Promise<Sellable> {
    return this.snapshot(async (tx) => {
      const market = await this.facts(tx, marketId);
      const owner = await ownerOf(tx, userId);
      if (!owner) throw new AppError('INTERNAL', { message: `Account ${userId} is gone` });
      const book = await this.liveBook(tx, marketId, market);
      const holdings = await readHoldings(tx, userId, marketId);
      return {
        marketId,
        contracts: holdings.map((holding) =>
          sellableContractOf(
            sellableOf(book, market, holding, { id: owner.id, human: owner.human }),
          ),
        ),
      };
    });
  }

  /** The market's status and width; NOT_FOUND for an unknown, DRAFT or REVIEW market. */
  private async facts(tx: Tx, marketId: string): Promise<MarketTradingFacts> {
    const market = await readMarketTradingFacts(tx, marketId);
    if (!market) throw marketNotFound();
    return market;
  }

  /**
   * The live book of a market that takes orders now; none for any other, whose orders cannot
   * trade. The check is the intake gate's own (`marketTradingRejectReason`), so #120's `close_at`
   * refusal leaves the book unread as it refuses the quote and the order. #128's trim
   * of the 운영 마켓메이커's quantities is not inherited from the intake's: it goes here too, as
   * after `placeOrder`'s `readLiveBook`, or the quote parts from the fill (ADR-0114 결과 5 #128;
   * whether the public depth shows the trimmed quantities is #128's call).
   */
  private async liveBook(
    tx: Tx,
    marketId: string,
    market: MarketTradingFacts,
  ): Promise<BookOrder[]> {
    return marketTradingRejectReason(market) === null ? readPublicBook(tx, marketId) : [];
  }

  private snapshot<T>(read: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(read, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
}
