import { Injectable } from '@nestjs/common';
import {
  PAYOUT_PER_CONTRACT_P,
  mechanismFor,
  quoteValue,
  serializePAmount,
  type Quote,
  type QuoteBody,
  type QuoteResult,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { MarketService, lmsrStateOf, type MarketRow } from './market.service.js';

/**
 * Refuses a trade or a quote on a market that is not taking orders (PLAN 5.2, design 3.6):
 * MARKET_NOT_OPEN for any status but `open`, MARKET_CLOSED for an open market whose close
 * time has passed (the M5 close job has not run yet, or is about to). A draft never gets
 * here: `requirePublic` answers NOT_FOUND for it first.
 */
export function assertTradable(market: Pick<MarketRow, 'status' | 'closeAt'>, now: Date): void {
  if (market.status !== 'open') {
    throw new AppError('MARKET_NOT_OPEN', { message: `Market is ${market.status}` });
  }
  if (market.closeAt.getTime() <= now.getTime()) {
    throw new AppError('MARKET_CLOSED', { message: 'Market has passed its close time' });
  }
}

/**
 * `POST /quotes` (PLAN 7.1): a read-only price check, public and side-effect free. The
 * numbers come from the same engine and the same stored state the trade transaction uses,
 * so a quote is exactly what `POST /trades` would charge a moment later — the difference
 * being the slippage guard the trade carries (PLAN 5.3).
 */
@Injectable()
export class QuoteService {
  constructor(private readonly markets: MarketService) {}

  async quote(body: QuoteBody): Promise<QuoteResult> {
    const market = await this.markets.requirePublic(body.marketId);
    assertTradable(market, new Date());

    const mechanism = mechanismFor(market.mechanism);
    const state = lmsrStateOf(market);
    const value = quoteValue(body);

    if ('spendP' in value) {
      // The body schema already refuses spend + sell (naming `mode`).
      const shares = mechanism.sharesForSpend(state, body.outcome, value.spendP);
      if (shares === 0) {
        // Not even one contract for that much: nothing to buy, the price stays where it is.
        const priceBeforeBp = mechanism.probabilityBp(state);
        return {
          shares: 0,
          amountP: '0',
          priceAvgBp: priceBeforeBp,
          priceBeforeBp,
          priceAfterBp: priceBeforeBp,
          maxPayoutP: '0',
        };
      }
      return toQuoteResult(mechanism.quoteBuy(state, body.outcome, shares), 'buy');
    }

    const quote =
      body.side === 'buy'
        ? mechanism.quoteBuy(state, body.outcome, value.shares)
        : // The engine does not know the caller's holdings and the route needs no login:
          // a sell quote is a price, not a promise (INSUFFICIENT_POSITION is the trade's).
          mechanism.quoteSell(state, body.outcome, value.shares);
    return toQuoteResult(quote, body.side);
  }
}

function toQuoteResult(quote: Quote, side: 'buy' | 'sell'): QuoteResult {
  return {
    shares: quote.shares,
    amountP: serializePAmount(quote.amountP),
    priceAvgBp: quote.priceAvgBp,
    priceBeforeBp: quote.priceBeforeBp,
    priceAfterBp: quote.priceAfterBp,
    maxPayoutP:
      side === 'buy' ? serializePAmount(BigInt(quote.shares) * PAYOUT_PER_CONTRACT_P) : '0',
  };
}
