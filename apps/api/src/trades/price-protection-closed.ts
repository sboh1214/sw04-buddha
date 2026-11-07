import { AppError } from '../common/errors/app-error.js';

/**
 * ORDER_INTAKE_CLOSED for an immediate order on a market with no 가격 보호 폭 (ADR-0112: a market
 * sent to review before #119 may have none), details `priceProtection`. One answer for the intake
 * (`OrderService.place`) and the public quote (`OrderBookService.quote`, #179, ADR-0114): the
 * quote takes no order the intake would refuse this way. A GTC order is taken and quoted. Only an
 * OPEN market's: a market not OPEN answers its own rejection first, with or without a width.
 */
export function priceProtectionClosed(): AppError {
  return new AppError('ORDER_INTAKE_CLOSED', {
    message: 'This market takes no immediate order before it has a width',
    details: [{ path: ['priceProtection'], message: 'undecided' }],
  });
}
