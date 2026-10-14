import { type CanActivate, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';

/**
 * Injection token for whether paid Coin is on sale: PAID_COIN_SALES_ENABLED from @buddha/shared
 * (payments.module.ts). A token rather than the constant read in place, so the suites of the
 * code it closes can open it for their own app (`createTestApp({ paidCoinSales: true })`).
 */
export const PAID_COIN_SALES = Symbol('PAID_COIN_SALES');

/**
 * Closes a route of paid Coin while sales are off (ADR-0049): the charge and its catalogue, the
 * provider info, coupon redemption and the admin refund. It answers 404 NOT_FOUND — the code a
 * flow that does not exist has always answered with — naming no feature, before anything the
 * handler reads or writes. On the member routes it comes first in `@UseGuards`, so signed in or
 * not the answer is the same 404; the global rate limit still counts the attempt (it runs ahead
 * of every controller guard, and reads the session for a per-account bucket).
 */
@Injectable()
export class PaidCoinSalesGuard implements CanActivate {
  constructor(@Inject(PAID_COIN_SALES) private readonly enabled: boolean) {}

  canActivate(): boolean {
    if (!this.enabled) throw new AppError('NOT_FOUND', { message: 'Not available' });
    return true;
  }
}
