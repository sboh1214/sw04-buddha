import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  orderBookSchema,
  orderQuoteSchema,
  quoteOrderBodySchema,
  uuidParamSchema,
  type OrderBook,
  type OrderQuote,
  type QuoteOrderBody,
} from '@buddha/shared';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OrderBookService } from './order-book.service.js';

/**
 * 공개 호가와 견적 (#179, ADR-0114; ADR-0107 결정 4 #179 '비로그인 견적', 결정 5 '#179·#119'):
 * public, like the market's other reads — no guard, so anyone reaches them, signed in or not, and
 * the address bucket alone limits them (never `order.rate_limit`, which counts a member's
 * submissions). Not on MarketOrdersController, whose class guards are the member's. Both answer
 * the same to every caller: nothing here reads the session. OrderBookService has the rest.
 */
@ApiTags('orders')
@Controller('markets')
export class MarketBookController {
  constructor(private readonly books: OrderBookService) {}

  @Get(':id/book')
  @ApiOperation({
    operationId: 'getOrderBook',
    summary:
      'The public order book, YES then NO: every price level of each side with its summed ' +
      'quantity — asks (what a buyer meets: the direct sells and the other outcome’s buys at ' +
      '100 − their price, merged per price, cheapest first) and bids (the direct buys only, ' +
      'highest first) — and the best of each, null when the side is empty. No order, account ' +
      'or order count. A market not open, or past its trading close, shows empty sides with ' +
      'marketRejectReason (not_open_yet, paused, closed)',
  })
  @ApiData(orderBookSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  getOrderBook(@Param('id', { schema: uuidParamSchema }) id: string): Promise<OrderBook> {
    return this.books.book(id);
  }

  @Post(':id/quote')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'quoteOrder',
    summary:
      'Quote an order on the book as it stands, as the order intake would match it, writing ' +
      'nothing: the limit it would match with (an immediate order’s narrowed to the best ' +
      'opposite quote ± the market’s price-protection width; with none sent, 99 for a buy and 1 ' +
      'for a sell — send it as the order’s limit), the contracts filling at once and their Coin, ' +
      'what is left, a buy’s whole lock, the fee (0), why the walk stopped and the state the ' +
      'order would end in. A market not open, or past its trading close, answers a rejected ' +
      'quote with its reason. Public: ' +
      'no session, and open while order intake is closed',
  })
  @ApiData(orderQuoteSchema)
  // VALIDATION_ERROR: the body (outcome, side, timeInForce, limitPriceCoin 1–99 — required for
  // gtc — exactly one of qty 1–1,000,000 and budgetCoin 1–1,000,000, a budget for an ioc buy only,
  // and no other field). NOT_FOUND: no public market of that id. ORDER_INTAKE_CLOSED: an immediate
  // order on an OPEN market with no width (path priceProtection), as the intake answers; a market
  // not OPEN, or an OPEN one past its close_at by the DB clock (#120), answers its rejected quote
  // first.
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR', 'ORDER_INTAKE_CLOSED')
  quoteOrder(
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: quoteOrderBodySchema }) body: QuoteOrderBody,
  ): Promise<OrderQuote> {
    return this.books.quote(id, body);
  }
}
