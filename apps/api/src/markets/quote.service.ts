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
import { MarketService, assertTradable, lmsrStateOf } from './market.service.js';

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
    // The market and the database clock in one statement: the close time is decided on the
    // clock the trade will use, not the API host's (A-M3-16).
    const { market, now } = await this.markets.requirePublicAt(body.marketId);
    assertTradable(market, now);

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
