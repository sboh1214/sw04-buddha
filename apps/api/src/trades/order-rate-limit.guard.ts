import { createHash } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import { ORDER_RATE_LIMIT_SETTING, RATE_LIMIT_WINDOW_SECONDS } from '@buddha/shared';
import { type AuthenticatedRequest } from '../auth/session.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { rateLimited } from '../rate-limit/rate-limit.guard.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';

/** The storage's throttler name of the order limit: its keys are `rl:order:<digest>`. */
export const ORDER_THROTTLER = 'order';

/**
 * The order limit's key of one account, hashed as every rate-limit key is (rate-limit.guard.ts
 * `rateLimitKey`: an account id stays out of a `KEYS rl:*`). One key per account across every
 * market and route: the limit is the account's (#177 9항).
 */
export function orderRateLimitKey(userId: string): string {
  return createHash('sha256').update(`order:${userId}`).digest('hex').slice(0, 32);
}

/**
 * 주문 속도 제한 (#119, ADR-0112; ADR-0107 결정 1 #177 9항): the release setting `order.rate_limit`
 * order submissions per account per minute, over every market, read on each request (a changed
 * value counts from the next one). Unset, there is no account limit: the address bucket
 * (address-limit.ts) still counts the request, as on every route. Not a row of PLAN 7.5's table
 * (`RATE_LIMIT_BUCKETS`): the number is the owner's to enter after deploy.
 *
 * Apply it after SessionGuard and OnboardedGuard on the order submission only: it counts every
 * submission that reaches it — one the body validation then refuses, and a re-sent request id
 * that answers its order again, too — and never a cancel (#178) or a read. The 운영 마켓메이커
 * places its orders through no route (M10 #129) and is never counted. In the same Redis window
 * store as the named buckets (`RedisThrottlerStorage`, fixed one-minute window, failing open),
 * refused with the same envelope (`rateLimited`: RATE_LIMITED, `details.retryAfterSeconds`,
 * `Retry-After`).
 */
@Injectable()
export class OrderRateLimitGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly settings: ReleaseSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    // Only meaningful after SessionGuard (OnboardedGuard's rule).
    if (!request.auth) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    const reading = await this.settings.get(ORDER_RATE_LIMIT_SETTING);
    if (reading.status === 'undecided') return true;
    const ttl = RATE_LIMIT_WINDOW_SECONDS * 1_000;
    const record = await this.storage.increment(
      orderRateLimitKey(request.auth.user.id),
      ttl,
      reading.value,
      ttl,
      ORDER_THROTTLER,
    );
    if (record.isBlocked) throw rateLimited(http.getResponse(), record.timeToBlockExpire);
    return true;
  }
}
